import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CleanupManager, GENTLE_BEHAVIOURS, HARSH_BEHAVIOURS, sessionTmpDir } from "./cleanup.js";
import { HeadlessSession } from "./headless.js";

/**
 * #1265 — against REAL processes: an engine that leaks a background child (the shape of a build, a dev
 * server or a watcher an agent started), stopped, timed out and aborted, with and without cleanup.
 *
 * The control case is the bug being fixed: without cleanup the engine dies and its child lives on, which
 * is how a machine ended up at load 283. Every other case asserts the child is gone.
 */

/** Persistent (stream-json) engine: leaks `sleep 300`, records its pid and its environment, then waits on stdin. */
const LEAKY_PERSISTENT = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn("sleep", ["300"], { stdio: "ignore" });
fs.writeFileSync(process.env.LEAK_FILE, String(child.pid));
fs.writeFileSync(process.env.ENV_FILE, JSON.stringify({ session: process.env.PAGS_SESSION_ID || null, tmp: process.env.TMPDIR || null }));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }) + "\\n");
process.stdin.resume();
setInterval(() => {}, 1000);
`;

/** One-shot (raw) engine: per turn, leaks `sleep 300`, then never exits. */
const LEAKY_ONESHOT = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn("sleep", ["300"], { stdio: "ignore" });
const file = process.env.LEAK_FILE + "." + Date.now() + "-" + process.pid;
fs.writeFileSync(file, String(child.pid));
fs.writeFileSync(process.env.ENV_FILE, JSON.stringify({ session: process.env.PAGS_SESSION_ID || null, tmp: process.env.TMPDIR || null }));
process.stdout.write("working\\n");
setInterval(() => {}, 1000);
`;

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function until(cond: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

const leakedPids = (dir: string, prefix: string): number[] => {
	const { readdirSync } = require("node:fs") as typeof import("node:fs");
	return readdirSync(dir)
		.filter((n) => n === prefix || n.startsWith(`${prefix}.`))
		.map((n) => Number(readFileSync(join(dir, n), "utf8")))
		.filter((n) => Number.isFinite(n) && n > 1);
};

describe.skipIf(process.platform === "win32")("post-run cleanup against real processes (#1265)", () => {
	let dir: string;
	let persistent: string;
	let oneshot: string;
	const strays = new Set<number>();

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-hc-"));
		persistent = join(dir, "leaky-claude");
		oneshot = join(dir, "leaky-codex");
		writeFileSync(persistent, LEAKY_PERSISTENT);
		writeFileSync(oneshot, LEAKY_ONESHOT);
		chmodSync(persistent, 0o755);
		chmodSync(oneshot, 0o755);
	});
	afterAll(() => {
		for (const pid of strays) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* gone */
			}
		}
		rmSync(dir, { recursive: true, force: true });
	});

	function manager(mode: "gentle" | "harsh"): CleanupManager {
		const m = new CleanupManager({ baseDir: join(dir, `cfg-${mode}-${Math.random().toString(36).slice(2, 7)}`), reposBaseDir: join(dir, "repos"), log: () => undefined, registerExitHook: false });
		m.setPolicy({ mode, behaviours: mode === "harsh" ? HARSH_BEHAVIOURS : GENTLE_BEHAVIOURS });
		return m;
	}

	function files(tag: string) {
		return { leak: join(dir, `leak-${tag}`), env: join(dir, `env-${tag}`) };
	}

	function session(opts: { id: string; tag: string; bin: string; client: "claude" | "codex"; cleanup?: CleanupManager; maxTurnMs?: number }) {
		const f = files(opts.tag);
		const s = new HeadlessSession({
			id: opts.id,
			workDir: dir,
			clientType: opts.client,
			...(opts.client === "codex" ? { command: "codex" } : {}),
			bin: opts.bin,
			env: { LEAK_FILE: f.leak, ENV_FILE: f.env },
			cleanup: opts.cleanup,
			maxTurnMs: opts.maxTurnMs,
		});
		return { s, f };
	}

	const leaked = (tag: string): number[] => {
		const pids = leakedPids(dir, `leak-${tag}`);
		for (const p of pids) strays.add(p);
		return pids;
	};

	for (const mode of ["gentle", "harsh"] as const) {
		it(`${mode}: stop() ends the engine AND the background process it started`, async () => {
			const { s } = session({ id: `stop-${mode}`, tag: `stop-${mode}`, bin: persistent, client: "claude", cleanup: manager(mode) });
			s.start();
			await until(() => leaked(`stop-${mode}`).length === 1, 8000, "the engine to leak its child");
			const [child] = leaked(`stop-${mode}`);
			expect(alive(child)).toBe(true);
			s.stop();
			await until(() => !alive(child), 8000, `${mode}: the leaked child to be ended`);
		}, 20_000);

		it(`${mode}: the turn timeout ends the engine AND what it started`, async () => {
			// 8s, not 1.5s (#1342): the ceiling starts at spawn, and under full-suite load a 1.5s ceiling fired before the fake
			// engine had forked its child — no leak, or a child forked after gentle's process-table read. Still the real ceiling.
			const { s } = session({ id: `to-${mode}`, tag: `to-${mode}`, bin: oneshot, client: "codex", cleanup: manager(mode), maxTurnMs: 8000 });
			s.start();
			s.input("hang");
			await until(() => leaked(`to-${mode}`).length === 1, 8000, "the turn to leak its child");
			const [child] = leaked(`to-${mode}`);
			await until(() => !alive(child), 20_000, `${mode}: the timeout to end the leaked child`);
			s.stop();
		}, 40_000);

		it(`${mode}: aborting a turn for its successor ends what the aborted turn started`, async () => {
			const { s } = session({ id: `ab-${mode}`, tag: `ab-${mode}`, bin: oneshot, client: "codex", cleanup: manager(mode) });
			s.start();
			s.input("first");
			await until(() => leaked(`ab-${mode}`).length === 1, 8000, "the first turn to leak its child");
			const [first] = leaked(`ab-${mode}`);
			s.input("second"); // aborts the first turn while it is still running
			await until(() => leaked(`ab-${mode}`).length === 2, 8000, "the second turn to start");
			await until(() => !alive(first), 8000, `${mode}: the aborted turn's child to be ended`);
			const second = leaked(`ab-${mode}`).find((p) => p !== first) as number;
			expect(alive(second)).toBe(true); // the live turn's own child is untouched
			s.stop();
			await until(() => !alive(second), 8000, "stop to end the second turn's child");
		}, 30_000);
	}

	it("CONTROL — without cleanup the engine dies and its child lives on (the defect #1265 fixes)", async () => {
		const { s } = session({ id: "control", tag: "control", bin: persistent, client: "claude" });
		s.start();
		await until(() => leaked("control").length === 1, 8000, "the engine to leak its child");
		const [child] = leaked("control");
		s.stop();
		await new Promise((r) => setTimeout(r, 1500));
		expect(alive(child)).toBe(true); // the leak
		process.kill(child, "SIGKILL");
	}, 20_000);

	it("the engine runs with the session marker and a per-run TMPDIR, and ending the session deletes that folder", async () => {
		const cleanup = manager("gentle");
		const { s, f } = session({ id: "env-1", tag: "env", bin: persistent, client: "claude", cleanup });
		s.start();
		await until(() => existsSync(f.env), 8000, "the engine to report its environment");
		const seen = JSON.parse(readFileSync(f.env, "utf8")) as { session: string; tmp: string };
		expect(seen.session).toBe("env-1");
		expect(seen.tmp).toBe(sessionTmpDir((cleanup as unknown as { opts: { baseDir: string } }).opts.baseDir, "env-1"));
		expect(existsSync(seen.tmp)).toBe(true);
		s.stop();
		await cleanup.endSession("env-1", new Set(), []);
		expect(existsSync(seen.tmp)).toBe(false);
	}, 20_000);

	it("two sessions get two different temp folders", async () => {
		const cleanup = manager("harsh");
		const a = session({ id: "iso-a", tag: "iso-a", bin: persistent, client: "claude", cleanup });
		const b = session({ id: "iso-b", tag: "iso-b", bin: persistent, client: "claude", cleanup });
		a.s.start();
		b.s.start();
		await until(() => existsSync(a.f.env) && existsSync(b.f.env), 8000, "both engines to report");
		const ta = (JSON.parse(readFileSync(a.f.env, "utf8")) as { tmp: string }).tmp;
		const tb = (JSON.parse(readFileSync(b.f.env, "utf8")) as { tmp: string }).tmp;
		expect(ta).not.toBe(tb);
		a.s.stop();
		await cleanup.endSession("iso-a", new Set(["iso-b"]), []);
		expect(existsSync(ta)).toBe(false);
		expect(existsSync(tb)).toBe(true); // the other, live session's folder is untouched
		b.s.stop();
		await cleanup.endSession("iso-b", new Set(), []);
		expect(existsSync(tb)).toBe(false);
	}, 25_000);

	it("with cleanup attached, an engine group never contains the runner (the runner survives its own cleanup)", async () => {
		const { s } = session({ id: "self", tag: "self", bin: persistent, client: "claude", cleanup: manager("harsh") });
		s.start();
		await until(() => leaked("self").length === 1, 8000, "the engine to start");
		s.stop();
		await until(() => !alive(leaked("self")[0]), 8000, "the child to end");
		expect(alive(process.pid)).toBe(true); // this very test process is the "runner" here
		mkdirSync(join(dir, "ok"), { recursive: true });
	}, 20_000);
});
