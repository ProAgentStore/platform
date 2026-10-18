/**
 * #499 — `pags up --background` start: what the detached runner is given, and what the owner is told.
 *
 * The spawn and the lock reads are injected; `background.test.ts` runs a real detached process.
 * Invariants: the runner is NOT marked as supervised (nothing waits on it), it IS given a restart
 * command so a remote update brings it back, it records `launch: background` through its env, and
 * success is claimed only once the child holds the lock — otherwise the log's tail is shown.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backgroundLogPath, backgroundStatePath, readBackgroundState } from "../background.js";
import type { RunnerLockFile } from "../runner-lock.js";
import { type BackgroundDeps, startInBackground } from "./up-background.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-upbg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness(over: { verdict?: "live" | "dead"; alive?: boolean } = {}) {
	const spawned: Array<{ command: string; args: string[]; opts: { env: NodeJS.ProcessEnv; detached: boolean } }> = [];
	const out: string[] = [];
	const deps: BackgroundDeps = {
		env: { PAGS_CONFIG_DIR: dir, PAGS_UP_SUPERVISED: "2", HOME: dir },
		execPath: "/usr/bin/node",
		platform: "darwin",
		spawn: ((command: string, args: string[], opts: { env: NodeJS.ProcessEnv; detached: boolean }) => {
			spawned.push({ command, args, opts });
			return { pid: 4242, unref() {} };
		}) as unknown as BackgroundDeps["spawn"],
		alive: () => over.alive ?? true,
		inspect: async () => ({ lock: { pid: 4242 } as RunnerLockFile, verdict: over.verdict ?? "live" }),
		timeoutMs: 50,
		log: (line) => out.push(line),
		step: (text, status) => out.push(`[${status}] ${text}`),
	};
	const start = {
		session: { token: "session-token", user: { login: "serge-ivo" } },
		opts: { instance: undefined, headless: false, force: false },
		runnerArgs: ["/opt/pags/bin/pags", "runner", "connect", "i1", "i2", "--watch-instances"],
		instances: [{ id: "i1-aaaaaaaa", name: "Repo Coder" }, { id: "i2-bbbbbbbb", name: "Scout" }],
		lockFile: join(dir, "up.lock"),
		watching: true,
	};
	return { deps, start, spawned, out };
}

describe("pags up --background", () => {
	it("starts the same `runner connect` a foreground start would, detached, unsupervised, restartable", async () => {
		const h = harness();
		expect(await startInBackground(h.start, h.deps)).toBe(0);
		expect(h.spawned).toHaveLength(1);
		const [{ command, args, opts }] = h.spawned;
		expect(command).toBe("/usr/bin/node");
		expect(args).toEqual(h.start.runnerArgs);
		expect(opts.detached).toBe(true);
		// The account session is in NO environment (#1163): the runner reads session.json itself.
		expect(opts.env.PAGS_TOKEN).toBeUndefined();
		expect(opts.env.PAGS_LOCK_ACCOUNT).toBe("serge-ivo");
		expect(opts.env.PAGS_BACKGROUND).toBe("1");
		expect(opts.env.PAGS_BACKGROUND_LOG).toBe(backgroundLogPath("serge-ivo", h.deps.env));
		// Nothing waits on this process, so it must not believe a `pags up` will restart it (#860).
		expect(opts.env.PAGS_UP_SUPERVISED).toBeUndefined();
		expect(opts.env.PAGS_RESTART_COMMAND).toBe("PAGS_BACKGROUND_RESTART=1 /usr/bin/node /opt/pags/bin/pags up --background");
	});

	it("drops a PAGS_TOKEN the shell exported, so the runner's runtime and engines cannot inherit it (#1163)", async () => {
		const h = harness();
		h.deps.env = { ...h.deps.env, PAGS_TOKEN: "ambient-session" };
		await startInBackground(h.start, h.deps);
		expect(h.spawned[0].opts.env.PAGS_TOKEN).toBeUndefined();
		expect(JSON.stringify(h.spawned[0].opts.env)).not.toContain("session-token");
	});

	it("records what it serves, for `pags status`", async () => {
		const h = harness();
		await startInBackground(h.start, h.deps);
		expect(readBackgroundState(backgroundStatePath("serge-ivo", h.deps.env))).toMatchObject({ pid: 4242, args: ["up", "--background"], instances: h.start.instances, watching: true });
	});

	it("says it is running only once it is, and how to see and stop it", async () => {
		const h = harness();
		await startInBackground(h.start, h.deps);
		const text = h.out.join("\n");
		expect(text).toMatch(/\[ok\] Running in the background \(pid 4242\)/);
		expect(text).toMatch(/does not start by itself/);
		expect(text).toMatch(/pags status/);
		expect(text).toMatch(/pags logs/);
		expect(text).toMatch(/pags down +— stop it/);
	});

	it("a runner that dies before it is ready: exit 1, and the log's tail instead of a success claim", async () => {
		const h = harness({ alive: false });
		const log = backgroundLogPath("serge-ivo", h.deps.env);
		mkdirSync(dirname(log), { recursive: true });
		writeFileSync(log, "Relay conflict: another machine holds this agent\n");
		const code = await startInBackground(h.start, h.deps);
		expect(code).toBe(1);
		const text = h.out.join("\n");
		expect(text).toMatch(/\[fail\] The background runner stopped before it was ready/);
		expect(text).toMatch(/Relay conflict: another machine holds this agent/);
		expect(text).not.toMatch(/Running in the background/);
	});

	it("a runner that never proves itself: exit 1, pointing at `pags status` / `pags down` rather than starting another", async () => {
		const h = harness({ verdict: "dead" });
		expect(await startInBackground(h.start, h.deps)).toBe(1);
		expect(h.out.join("\n")).toMatch(/may still be starting \(pid 4242\)/);
	});
});
