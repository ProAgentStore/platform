/**
 * A repin moves the agent (#850): the issue's own machines, driven through a fake relay whose
 * sockets open and close only when a runner is actually asked to sync — so "attached" can only
 * pass if the command was sent to the right machine over a socket that exists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Live relay sockets, keyed `instanceId@node`. */
const live = new Set<string>();
/** What each machine's runner does when asked to sync: open/close sockets, or refuse. */
let onSync: (node: string) => { status: number; error?: string } = () => ({ status: 200 });
const synced: Array<{ via: string; node: string }> = [];

vi.mock("./runner-client.js", () => ({
	relayConnected: async (_env: unknown, id: string, node: string) => live.has(`${id}@${node}`),
	getRunnerConnIgnoringLiveness: async (_env: unknown, id: string, _uid: string, node: string) => ({ instanceId: id, runnerNode: node, relayName: `${id}:node:${node}` }),
	callRunner: async (conn: { instanceId: string; runnerNode: string }, path: string) => {
		expect(path).toBe("/pags/membership/sync");
		synced.push({ via: conn.instanceId, node: conn.runnerNode });
		const r = onSync(conn.runnerNode);
		if (r.status !== 200) throw new Error(`Runner ${path} → ${r.status}: ${JSON.stringify({ error: r.error })}`);
		return { attached: [] };
	},
}));

const { attachOnRepin, MEMBERSHIP_SYNC_PATH } = await import("./runner-repin.js");

const AGENT = "f8ddc272"; // Heartfull App Coder
const OTHER = "coder-2"; // already hosted on Macmini
const rows = [
	{ node: "Macmini", machineId: "m-mini", instanceId: OTHER, lastSeenAt: "2026-09-25 22:00:00" },
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
	it("no runner on the target machine: not attached, named, and no waiting", async () => {
		live.clear();
		const out = await repin();
		expect(out.attached).toBe(false);
		expect(out.detail).toMatch(/No `pags up` is connected on Macmini/);
		expect(slept).toEqual([]);
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
