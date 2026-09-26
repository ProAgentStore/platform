/**
 * `runner_update` over a fake relay (#859): the agents a machine held before its restart are held
 * again after it — on their own, or through #856's attach path — and every other outcome says what
 * happened and what to do.
 *
 * The machine's side (install, wait for busy engines, exit for a respawn) is `self-update.ts` and is
 * tested there; here its REPLY is scripted, and the restart is simulated by dropping every socket on
 * the machine the moment it answers `restarting`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Live sockets, `instanceId@node`. */
const live = new Set<string>();
/** Carriers whose runner is frozen. */
const frozen = new Set<string>();
/** Agents that come back on their own after the restart, and after how many 2s polls. */
let comesBack: Record<string, number> = {};
/** What the machine answers the update command with. */
let reply: () => unknown = () => ({ action: "up-to-date", current: "0.4.62" });
/** Agents a targeted membership sync (#856) brings back. */
let syncAttaches = new Set<string>();
const sent: Array<{ via: string; path: string; body: unknown }> = [];
let polls = 0;

vi.mock("./runner-client.js", () => ({
	relayConnected: async (_env: unknown, id: string, node: string) => live.has(`${id}@${node}`),
	evictStaleRunnerSocket: async (_env: unknown, id: string, node: string) => (live.has(`${id}@${node}`) ? { sockets: 1, alive: true, evicted: 0 } : { sockets: 0, alive: false, evicted: 0 }),
	getRunnerConnIgnoringLiveness: async (_env: unknown, id: string, _uid: string, node: string) => ({ instanceId: id, runnerNode: node }),
	callRunner: async (conn: { instanceId: string; runnerNode: string }, path: string, body: unknown) => {
		if (frozen.has(conn.instanceId)) {
			const { RunnerUnreachableError } = await import("./runner-unreachable.js");
			throw new RunnerUnreachableError("Runner relay is connected but not responding");
		}
		sent.push({ via: conn.instanceId, path, body });
		if (path === "/pags/runner/update") {
			const r = reply();
			if (r instanceof Error) throw r;
			// The restart: every socket on the machine drops.
			if ((r as { action?: string }).action === "restarting") for (const k of [...live]) if (k.endsWith("@Macmini")) live.delete(k);
			return r;
		}
		if (path === "/pags/membership/sync") {
			const target = (body as { attach: string }).attach;
			if (syncAttaches.has(target)) live.add(`${target}@Macmini`);
			return { attached: [], target, holding: syncAttaches.has(target) };
		}
		throw new Error(`unexpected ${path}`);
	},
}));

const { updateRunnerNode } = await import("./runner-update.js");

const CODER = "22ce95b9"; // Grass Karma coder
const OTHER = "coder-2";
const THIRD = "coder-3";
const rows = [CODER, OTHER, THIRD].map((instanceId) => ({ node: "Macmini", machineId: "m-mini", instanceId, lastSeenAt: "2026-09-26 10:00:00" }));
const env = {
	DB: {
		prepare: (sql: string) => ({
			bind: () => ({
				all: async () => ({ results: rows }),
				first: async () => (/runner_version/.test(sql) ? { runner_version: "0.4.63" } : null),
			}),
		}),
	},
} as never;

let clock = 0;
const deps = {
	now: () => clock,
	sleep: async (ms: number) => {
		clock += ms;
		polls++;
		for (const [id, after] of Object.entries(comesBack)) if (polls >= after) live.add(`${id}@Macmini`);
	},
};
const update = (dryRun = false) => updateRunnerNode(env, "u1", "Macmini", { ...deps, dryRun });

beforeEach(() => {
	live.clear();
	frozen.clear();
	sent.length = 0;
	syncAttaches = new Set();
	comesBack = {};
	polls = 0;
	clock = 0;
	for (const id of [CODER, OTHER, THIRD]) live.add(`${id}@Macmini`);
	reply = () => ({ action: "restarting", current: "0.4.61", latest: "0.4.63" });
});

describe("runner_update — the restart gives back every agent it held (#859)", () => {
	it("all three agents come back on their own after the restart — verified, none needed help", async () => {
		comesBack = { [CODER]: 2, [OTHER]: 3, [THIRD]: 3 };
		const out = await update();
		expect(out).toMatchObject({ action: "restarted", current: "0.4.61", latest: "0.4.63", version: "0.4.63", reattached: [], missing: [] });
		expect(out.held.sort()).toEqual([CODER, OTHER, THIRD].sort());
		expect(out.detail).toMatch(/all 3 agent\(s\) it held are attached again/);
		for (const id of [CODER, OTHER, THIRD]) expect(live.has(`${id}@Macmini`)).toBe(true);
	});

	it("an agent that did not come back is re-attached through #856's attach path", async () => {
		comesBack = { [OTHER]: 2, [THIRD]: 2 };
		syncAttaches = new Set([CODER]);
		const out = await update();
		expect(out).toMatchObject({ action: "restarted", reattached: [CODER], missing: [] });
		// The #856 path: a targeted membership sync naming that agent.
		expect(sent.some((s) => s.path === "/pags/membership/sync" && (s.body as { attach: string }).attach === CODER)).toBe(true);
		expect(live.has(`${CODER}@Macmini`)).toBe(true);
	});

	it("an agent that cannot be re-attached is reported MISSING with its reason — never silently dropped", async () => {
		comesBack = { [OTHER]: 2, [THIRD]: 2 };
		const out = await update();
		expect(out.action).toBe("restarted");
		expect(out.missing).toEqual([{ instanceId: CODER, detail: expect.stringMatching(/force_runner_attach|did not attach/) }]);
		expect(out.detail).toMatch(/1 of 3 agent\(s\) did not re-attach/);
	});
});

describe("runner_update — every other outcome says what happened (#859)", () => {
	it("busy engines: SCHEDULED, naming them — the machine restarts when their turns end, no run is cut off", async () => {
		reply = () => ({ action: "wait", current: "0.4.61", latest: "0.4.63", waitingFor: ["csess_59b45061"] });
		const out = await update();
		expect(out).toMatchObject({ action: "scheduled", waitingFor: ["csess_59b45061"] });
		expect(out.detail).toMatch(/as soon as these engines finish their turns — no run is cut off/);
		expect(live.size).toBe(3);
	});

	it("dry run asks the machine without acting, and says what it would do", async () => {
		reply = () => ({ action: "wait", current: "0.4.61", latest: "0.4.63", waitingFor: [], dryRun: true });
		const out = await update(true);
		expect(sent[0]).toMatchObject({ path: "/pags/runner/update", body: { dryRun: true } });
		expect(out.action).toBe("would-update");
	});

	it("already current: up-to-date, nothing restarted", async () => {
		reply = () => ({ action: "up-to-date", current: "0.4.63" });
		expect(await update()).toMatchObject({ action: "up-to-date", detail: expect.stringMatching(/already runs 0\.4\.63/) });
	});

	it("refused by the machine: its reason is passed through", async () => {
		reply = () => ({ action: "refused", current: "0.4.62", reason: "This runner was not started by a `pags up` that can restart it." });
		expect(await update()).toMatchObject({ action: "refused", detail: expect.stringMatching(/not started by a `pags up`/) });
	});

	it("a CLI that predates runner_update says the FIRST update needs the machine, and later ones do not", async () => {
		reply = () => new Error('Runner /pags/runner/update → 404: {"error":"Not found"}');
		const out = await update();
		expect(out.action).toBe("unsupported");
		expect(out.detail).toMatch(/predates runner_update.*Update it once at the machine.*every later update can be done remotely/);
	});

	it("a frozen socket is skipped for the next one; no connected runner at all is unreachable", async () => {
		frozen.add(CODER);
		reply = () => ({ action: "up-to-date", current: "0.4.63" });
		expect((await update()).action).toBe("up-to-date");
		expect(sent[0].via).not.toBe(CODER);
		live.clear();
		expect(await update()).toMatchObject({ action: "unreachable", detail: expect.stringMatching(/No `pags up` is connected on Macmini/) });
	});
});
