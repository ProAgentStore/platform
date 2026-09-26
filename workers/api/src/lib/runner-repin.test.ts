/**
 * A repin moves the agent (#850): the issue's own machines, driven through a fake relay whose
 * sockets open and close only when a runner is actually asked to sync — so "attached" can only
 * pass if the command was sent to the right machine over a socket that exists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Live relay sockets, keyed `instanceId@node`. */
const live = new Set<string>();
/** Sockets that are IN the slot and look live to the optimistic `/status`, but answer no ping (#856). */
const stale = new Set<string>();
/** Carriers whose runner is frozen: the command's own probe fails (#856, pink-laptop). */
const frozen = new Set<string>();
/** The body each sync was sent with, in order. */
const bodies: unknown[] = [];
/** What each machine's runner does when asked to sync: open/close sockets, or refuse. */
let onSync: (node: string, body?: unknown) => { status: number; error?: string; reply?: unknown } = () => ({ status: 200 });
const synced: Array<{ via: string; node: string }> = [];
/** Carriers whose runner never answers: the command runs to its own timeout, then the relay gives up (#853 finding 12). */
const hangs = new Set<string>();
/** The timeout every runner command was sent with, in order. */
const timeouts: number[] = [];

vi.mock("./runner-client.js", () => ({
	relayConnected: async (_env: unknown, id: string, node: string) => live.has(`${id}@${node}`) || stale.has(`${id}@${node}`),
	evictStaleRunnerSocket: async (_env: unknown, id: string, node: string) => {
		const key = `${id}@${node}`;
		if (stale.has(key)) {
			stale.delete(key);
			return { sockets: 1, alive: false, evicted: 1 };
		}
		return live.has(key) ? { sockets: 1, alive: true, evicted: 0 } : { sockets: 0, alive: false, evicted: 0 };
	},
	getRunnerConnIgnoringLiveness: async (_env: unknown, id: string, _uid: string, node: string) => ({ instanceId: id, runnerNode: node, relayName: `${id}:node:${node}` }),
	callRunner: async (conn: { instanceId: string; runnerNode: string }, path: string, body?: unknown, opts?: { timeoutMs?: number }) => {
		expect(path).toBe("/pags/membership/sync");
		timeouts.push(opts?.timeoutMs ?? Number.NaN);
		if (hangs.has(`${conn.instanceId}@${conn.runnerNode}`)) {
			clock += opts?.timeoutMs ?? 0;
			throw new Error(`Runner ${path} → 504: {"error":"Runner timed out"}`);
		}
		if (frozen.has(conn.instanceId)) {
			const { RunnerUnreachableError } = await import("./runner-unreachable.js");
			throw new RunnerUnreachableError("Runner relay is connected but not responding — the relay has no live socket for this agent.");
		}
		synced.push({ via: conn.instanceId, node: conn.runnerNode });
		bodies.push(body);
		const r = onSync(conn.runnerNode, body);
		if (r.status !== 200) throw new Error(`Runner ${path} → ${r.status}: ${JSON.stringify({ error: r.error })}`);
		return r.reply ?? { attached: [] };
	},
}));

const { attachAgentOnNode, attachOnRepin, MEMBERSHIP_SYNC_PATH, REPIN_BUDGET_MS } = await import("./runner-repin.js");

const AGENT = "f8ddc272"; // Heartfull App Coder
const OTHER = "coder-2"; // already hosted on Macmini
const rows = [
	{ node: "Macmini", machineId: "m-mini", instanceId: OTHER, lastSeenAt: "2026-09-25 22:00:00" },
	// A second agent on Macmini — the carrier a frozen first one must fall through to (#856).
	{ node: "Macmini", machineId: "m-mini", instanceId: "coder-3", lastSeenAt: "2026-09-25 21:30:00" },
	{ node: "Mac.modem", machineId: "m-air", instanceId: AGENT, lastSeenAt: "2026-09-25 21:00:00" },
	{ node: "RLs-MacBook-Air", machineId: "m-air", instanceId: AGENT, lastSeenAt: "2026-09-20 21:00:00" },
];
const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } } as never;

let clock = 0;
const slept: number[] = [];
const deps = { now: () => clock, sleep: async (ms: number) => { slept.push(ms); clock += ms; } };
const repin = () => attachOnRepin(env, AGENT, "u1", "Macmini", deps);

beforeEach(() => {
	live.clear();
	stale.clear();
	frozen.clear();
	hangs.clear();
	timeouts.length = 0;
	bodies.length = 0;
	synced.length = 0;
	slept.length = 0;
	clock = 0;
	live.add(`${OTHER}@Macmini`);
	// A current runner: a sync on Macmini attaches the agent; one on the old machine drops it.
	onSync = (node) => {
		if (node === "Macmini") live.add(`${AGENT}@Macmini`);
		else live.delete(`${AGENT}@${node}`);
		return { status: 200 };
	};
});

describe("repinning an idle agent to an online machine (#850)", () => {
	it("attaches it on the new machine through a socket another agent holds there — no pags up", async () => {
		const out = await repin();
		expect(synced).toEqual([{ via: OTHER, node: "Macmini" }]);
		expect(out).toEqual({ node: "Macmini", attached: true, detachedFrom: [], stillAttachedOn: [] });
		expect(live.has(`${AGENT}@Macmini`)).toBe(true);
	});

	it("detaches it from the stale machine in the same call", async () => {
		live.add(`${AGENT}@Mac.modem`);
		const out = await repin();
		expect(out.attached).toBe(true);
		expect(out.detachedFrom).toEqual(["Mac.modem"]);
		expect(synced).toContainEqual({ via: AGENT, node: "Mac.modem" });
		expect(live.has(`${AGENT}@Mac.modem`)).toBe(false);
	});

	it("does nothing to a machine that is already attached, and asks no runner", async () => {
		live.add(`${AGENT}@Macmini`);
		expect(await repin()).toMatchObject({ attached: true });
		expect(synced).toEqual([]);
	});

	it("says a stale machine still holds it when that runner does not let go", async () => {
		live.add(`${AGENT}@Mac.modem`);
		onSync = (node) => {
			if (node === "Macmini") live.add(`${AGENT}@Macmini`);
			return { status: 200 };
		};
		expect(await repin()).toMatchObject({ attached: true, detachedFrom: [], stillAttachedOn: ["Mac.modem"] });
	});
});

describe("when the move cannot complete, the repin says why (#850)", () => {
	// #853 finding 14. "No socket on X" is not "no `pags up` on X": a runner whose agents are all pinned
	// elsewhere holds no socket and sends no heartbeat, yet takes a newly pinned agent on its own 20s
	// poll. When it last reported is the one fact that tells the two apart.
	const LAST_SEEN = Date.parse("2026-09-25T22:00:00Z"); // Macmini's freshest registration above

	it("no runner on the target machine for hours: says it is not running, when it was last seen, and no waiting", async () => {
		live.clear();
		clock = LAST_SEEN + 10 * 3_600_000;
		const out = await repin();
		expect(out.attached).toBe(false);
		expect(out.detail).toMatch(/^No `pags up` is running on Macmini \(last seen 10 h ago\)/);
		expect(out.detail).toMatch(/Start it there/);
		expect(slept).toEqual([]);
	});

	it("a runner seen moments ago but holding no socket: NOT called absent — it picks the agent up on its own poll (#853 finding 14)", async () => {
		live.clear();
		clock = LAST_SEEN + 30_000;
		const out = await repin();
		expect(out.attached).toBe(false);
		expect(out.unconfirmed).toBe(true);
		expect(out.detail).toMatch(/`pags up` on Macmini reported in 30 s ago but holds no relay socket/);
		expect(out.detail).toMatch(/picks this agent up on its own within about 20 s.*instance_runner_node/);
		expect(out.detail).not.toMatch(/No `pags up` is/);
		expect(slept).toEqual([]);
	});

	it("a machine never registered at all: not running, with no last-seen claim", async () => {
		live.clear();
		const out = await attachOnRepin(env, AGENT, "u1", "NewBox", deps);
		expect(out.detail).toMatch(/^No `pags up` is running on NewBox — /);
		expect(out.detail).not.toMatch(/last seen/);
	});

	it("a runner started with --instance: refused by name, no waiting", async () => {
		onSync = () => ({ status: 409, error: "This machine's `pags up` was started with --instance, so it serves only that agent." });
		const out = await repin();
		expect(out.attached).toBe(false);
		expect(out.detail).toMatch(/--instance/);
		expect(slept).toEqual([]);
	});

	it("a runner too old to answer: waits out one discovery poll and reports what the relay shows", async () => {
		let polls = 0;
		onSync = () => ({ status: 404, error: "Not found" });
		const original = deps.sleep;
		deps.sleep = async (ms) => {
			await original(ms);
			// Its own 20s poll attaches the agent.
			if (++polls === 20) live.add(`${AGENT}@Macmini`);
		};
		const out = await repin();
		deps.sleep = original;
		expect(out.attached).toBe(true);
		expect(clock).toBe(20_000);
	});

	it("uses the path the CLI answers", () => {
		expect(MEMBERSHIP_SYNC_PATH).toBe("/pags/membership/sync");
	});
});

// #853 finding 12: the route awaits the whole move, and every step had its own timeout but nothing
// bounded the SUM — 15s per carrier sync, a 22s poll wait, 8–23s per stale machine. A client with a
// ~60s tool timeout reported failure while the pin had been written and the move might have worked.
describe("a repin answers within its budget, whatever the machines do (#853 finding 12)", () => {
	it("the budget sits well inside a typical 60s MCP tool timeout", () => {
		expect(REPIN_BUDGET_MS).toBeLessThanOrEqual(30_000);
	});

	it("every machine hanging — both carriers on the target, both stale machines — still answers inside the budget, UNCONFIRMED, saying the pin holds", async () => {
		hangs.add(`${OTHER}@Macmini`);
		hangs.add("coder-3@Macmini");
		live.add("coder-3@Macmini");
		for (const n of ["Mac.modem", "RLs-MacBook-Air"]) {
			live.add(`${AGENT}@${n}`);
			hangs.add(`${AGENT}@${n}`);
		}
		const out = await repin();
		expect(clock).toBeLessThanOrEqual(REPIN_BUDGET_MS);
		expect(timeouts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(REPIN_BUDGET_MS);
		expect(out).toMatchObject({ node: "Macmini", attached: false, unconfirmed: true });
		expect(out.detail).toMatch(/pin to Macmini is saved.*instance_runner_node/);
		// A stale machine it had no time to ask is still reported, not silently dropped.
		expect(out.stillAttachedOn.sort()).toEqual(["Mac.modem", "RLs-MacBook-Air"]);
	});

	it("a hanging target carrier costs only what the budget has left — the next carrier is still asked in time", async () => {
		hangs.add(`${OTHER}@Macmini`);
		live.add("coder-3@Macmini");
		const out = await repin();
		expect(out.attached).toBe(true);
		expect(out.unconfirmed).toBeUndefined();
		expect(clock).toBeLessThanOrEqual(REPIN_BUDGET_MS);
	});

	it("attached in time, but a stale machine it could not reach in time: attached, and the unconfirmed release is named", async () => {
		hangs.add(`${OTHER}@Macmini`);
		live.add("coder-3@Macmini");
		live.add(`${AGENT}@Mac.modem`);
		hangs.add(`${AGENT}@Mac.modem`);
		const out = await repin();
		expect(out).toMatchObject({ attached: true, stillAttachedOn: ["Mac.modem"], unconfirmed: true });
		expect(out.detail).toMatch(/^Attached on Macmini\. Mac\.modem did not confirm letting it go/);
		expect(clock).toBeLessThanOrEqual(REPIN_BUDGET_MS);
	});

	it("a quick repin says nothing about a budget", async () => {
		expect(await repin()).toEqual({ node: "Macmini", attached: true, detachedFrom: [], stillAttachedOn: [] });
	});
});

describe("remote reattach — the platform's `pags up --force` for one agent (#856)", () => {
	const force = () => attachAgentOnNode(env, AGENT, "u1", "Macmini", { force: true, ...deps });

	it("connected-but-no-socket: a FROZEN carrier is skipped for one that answers, and the agent attaches (pink-laptop)", async () => {
		// The repin used to ask the first socket that looked live, get "connected but not responding",
		// and stop with "check that machine's runner window".
		frozen.add(OTHER);
		live.add("coder-3@Macmini");
		const out = await repin();
		expect(out.attached).toBe(true);
		expect(synced).toEqual([{ via: "coder-3", node: "Macmini" }]);
		// The agent is NAMED, so a runner that blocked it after a 4409 lets go of the block.
		expect(bodies[0]).toEqual({ attach: AGENT, force: false });
	});

	it("says so, specifically, when EVERY socket on the machine is frozen — nothing there can be asked", async () => {
		frozen.add(OTHER);
		frozen.add("coder-3");
		live.add("coder-3@Macmini");
		const out = await repin();
		expect(out.attached).toBe(false);
		expect(out.detail).toMatch(/connected but not answering \(2 tried\)/);
		expect(out.detail).not.toMatch(/runner window/);
	});

	it("a stale duplicate socket holding the agent's slot is EVICTED, so the machine's runner can take it (Macmini)", async () => {
		// The slot answers the optimistic status — "online" — but no ping: a duplicate or frozen runner.
		stale.add(`${AGENT}@Macmini`);
		const out = await attachAgentOnNode(env, AGENT, "u1", "Macmini", { force: false, ...deps });
		expect(out).toEqual({ node: "Macmini", attached: true, evicted: 1 });
		expect(synced).toEqual([{ via: OTHER, node: "Macmini" }]);
	});

	it("a live socket in the slot IS the agent attached — a plain attach touches nothing", async () => {
		live.add(`${AGENT}@Macmini`);
		expect(await attachAgentOnNode(env, AGENT, "u1", "Macmini", { force: false, ...deps })).toEqual({ node: "Macmini", attached: true, evicted: 0 });
		expect(synced).toEqual([]);
	});

	it("force asks the runner to take the slot over even from a socket that answers, and reports it attached", async () => {
		live.add(`${AGENT}@Macmini`);
		onSync = (_node, body) => ({ status: 200, reply: { attached: [AGENT], target: (body as { attach: string }).attach, holding: true } });
		const out = await force();
		expect(out.attached).toBe(true);
		expect(bodies).toEqual([{ attach: AGENT, force: true }]);
	});

	it("a runner that answers but does not attach names force_runner_attach — never 'check the runner window'", async () => {
		onSync = () => ({ status: 200, reply: { attached: [], target: AGENT, holding: false } });
		const out = await repin();
		expect(out.attached).toBe(false);
		expect(out.detail).toMatch(/Call force_runner_attach to take its slot on Macmini over/);
		expect(out.detail).not.toMatch(/runner window/);
	});

	it("a FORCED attach the runner still refuses says why: the machine may not run this agent", async () => {
		onSync = () => ({ status: 200, reply: { attached: [], target: AGENT, holding: false } });
		const out = await force();
		expect(out.attached).toBe(false);
		expect(out.detail).toMatch(/not one that machine may run \(pinned to another machine, paused, or without a runtime\)/);
	});
});
