import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HeadlessSession } from "./headless.js";

/**
 * #1493 — an engine turn is not replaced by an instruction that merely arrives while it runs, and a turn that is
 * still producing output is not killed for being long. Real child processes (small fake engines), no network.
 */

let dir: string;
let lingerBin: string; // prints which instruction it got, lives 1.5s, exits 0
let chattyBin: string; // never stops writing
let silentBin: string; // writes once, then hangs

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-busy-"));
	lingerBin = join(dir, "linger.js");
	chattyBin = join(dir, "chatty.js");
	silentBin = join(dir, "silent.js");
	const arg = `String(process.argv[process.argv.length - 1]).split("\\n").pop()`;
	writeFileSync(lingerBin, `#!/usr/bin/env node\nprocess.stdout.write("started: " + ${arg} + "\\n");\nsetTimeout(() => { process.stdout.write("finished: " + ${arg} + "\\n"); process.exit(0); }, 1500);\n`);
	writeFileSync(chattyBin, `#!/usr/bin/env node\nsetInterval(() => process.stdout.write("test output line\\n"), 80);\n`);
	writeFileSync(silentBin, `#!/usr/bin/env node\nprocess.stdout.write("one line, then nothing\\n");\nsetTimeout(() => {}, 600000);\n`);
	for (const f of [lingerBin, chattyBin, silentBin]) chmodSync(f, 0o755);
	// A shebang script is not directly executable on Windows: launch each fake through a .cmd shim there.
	if (process.platform === "win32") {
		for (const f of [lingerBin, chattyBin, silentBin]) writeFileSync(`${f}.cmd`, `@echo off\r\n"${process.execPath}" "${f}" %*\r\n`);
		lingerBin += ".cmd";
		chattyBin += ".cmd";
		silentBin += ".cmd";
	}
});
afterAll(() => {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
	} catch {
		/* Windows can still hold the directory as a just-killed engine's cwd; the OS temp cleaner owns it then */
	}
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms: number, what: string): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return;
		await wait(40);
	}
	throw new Error(`timed out waiting for ${what}`);
}
const session = (id: string, bin: string, extra: Partial<ConstructorParameters<typeof HeadlessSession>[0]> = {}) =>
	new HeadlessSession({ id, workDir: dir, clientType: "codex", command: "codex", bin, ...extra });

describe("a busy engine turn is never replaced by a plain instruction (#1493)", () => {
	it("queues the instruction, says so, leaves the running turn alone, and delivers it when the turn ends", async () => {
		const s = session("queue", lingerBin);
		s.start();
		s.input("first");
		await until(() => s.snapshot().includes("started: first"), 30_000, "the first turn to start");
		s.input("second"); // e.g. the Pilot's "wait for the test run" — an observation, not an interrupt
		expect(s.queuedInstructionCount).toBe(1);
		expect(s.snapshot()).toMatch(/instruction is queued .* the running turn was not interrupted/);
		await wait(300);
		expect(s.snapshot()).not.toMatch(/turn aborted/);
		expect(s.snapshot()).not.toContain("exited with code 143");
		expect(s.snapshot()).not.toContain("started: second"); // not yet: turn one is still running
		expect(s.runState()).toBe("thinking");
		// Turn one finishes untouched, THEN the queued instruction runs.
		await until(() => s.snapshot().includes("finished: first"), 30_000, "the first turn to finish");
		await until(() => s.snapshot().includes("started: second"), 30_000, "the queued instruction to be delivered");
		expect(s.snapshot().indexOf("finished: first")).toBeLessThan(s.snapshot().indexOf("started: second"));
		expect(s.queuedInstructionCount).toBe(0);
		s.stop();
	}, 60_000);

	it("a retry carrying the same input id waits once, and instructions are delivered in order", async () => {
		const s = session("queue-order", lingerBin);
		s.start();
		s.input("a");
		await until(() => s.snapshot().includes("started: a"), 30_000, "turn a");
		s.input("b", { inputId: "in-b" });
		s.input("b", { inputId: "in-b" }); // a lost-reply retry
		s.input("c");
		expect(s.queuedInstructionCount).toBe(2);
		await until(() => s.snapshot().includes("started: c"), 40_000, "turn c");
		const snap = s.snapshot();
		expect(snap.match(/started: b/g)).toHaveLength(1);
		expect(snap.indexOf("started: b")).toBeLessThan(snap.indexOf("started: c"));
		s.stop();
	}, 70_000);

	it("an explicit interrupt still replaces the running turn, and records the abort", async () => {
		const s = session("interrupt", lingerBin);
		s.start();
		s.input("one");
		await until(() => s.snapshot().includes("started: one"), 30_000, "turn one");
		s.input("two", { whenBusy: "interrupt" });
		await until(() => s.snapshot().includes("started: two"), 30_000, "the replacement turn");
		expect(s.snapshot()).toMatch(/turn aborted — a new instruction arrived/);
		expect(s.queuedInstructionCount).toBe(0);
		s.stop();
	}, 60_000);

	it("refuses loudly, without interrupting, once the queue is full", async () => {
		const s = session("queue-full", lingerBin);
		s.start();
		s.input("hold");
		await until(() => s.snapshot().includes("started: hold"), 30_000, "the running turn");
		for (let i = 0; i < 12; i++) s.input(`later ${i}`);
		expect(s.queuedInstructionCount).toBe(8);
		expect(s.snapshot()).toMatch(/was NOT accepted \(nothing was interrupted\)/);
		expect(s.snapshot()).not.toMatch(/turn aborted/);
		s.stop();
		expect(s.queuedInstructionCount).toBe(0); // an ended session delivers nothing
	}, 60_000);
});

describe("a long turn is told apart from a wedged one (#1493)", () => {
	it("does not end a turn that keeps writing, however long it runs past the silence limit", async () => {
		const s = session("chatty-ok", chattyBin, { maxTurnMs: 700, maxTurnAbsoluteMs: 60_000 });
		s.start();
		s.input("run the full suite");
		await until(() => s.snapshot().includes("test output line"), 30_000, "the engine's first output");
		await wait(2500); // > 3x the silence limit, with output the whole time
		expect(s.runState()).toBe("thinking");
		expect(s.snapshot()).not.toMatch(/turn ended/);
		s.stop();
	}, 60_000);

	it("still ends a runaway that never goes quiet, at the absolute cap, and says that is why", async () => {
		const s = session("chatty-cap", chattyBin, { maxTurnMs: 700, maxTurnAbsoluteMs: 1800 });
		s.start();
		s.input("never stops");
		await until(() => s.runState() === "idle", 30_000, "the absolute cap to end the turn");
		expect(s.snapshot()).toMatch(/turn ended at the .* absolute limit although it was still producing output/);
		expect(s.snapshot()).not.toMatch(/with no output/);
		expect(s.alive).toBe(true); // the session survives; only the turn was ended
		s.stop();
	}, 60_000);

	it("ends a silent hang at the silence limit, measured from its LAST output, and says that is why", async () => {
		const s = session("silent", silentBin, { maxTurnMs: 900, maxTurnAbsoluteMs: 60_000 });
		s.start();
		s.input("hang");
		await until(() => s.snapshot().includes("one line, then nothing"), 30_000, "the engine's only output");
		const wrote = Date.now();
		await until(() => s.runState() === "idle", 30_000, "the silence limit to end the turn");
		expect(Date.now() - wrote).toBeGreaterThanOrEqual(600); // silence is counted from the last byte, not the spawn
		expect(s.snapshot()).toMatch(/turn ended after .* with no output — the engine never exited/);
		expect(s.snapshot()).not.toMatch(/absolute limit/);
		s.stop();
	}, 60_000);
});
