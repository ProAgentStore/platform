/**
 * #990 — a runner update is a DURABLE operation, over the real schema.
 *
 * The live failure: `runner_update` on an idle `Macmini.modem` answered `outcome: "unknown"`,
 * `confirmation.reason: "deadline-exceeded"` twice, and the node stayed connected, idle and on
 * `0.4.84` with no outcome and no error recorded anywhere. The route awaited ~205s of work behind a
 * 20s client deadline; the seam aborted, cancelling the Worker, and the work died mid-flight having
 * written nothing. These tests hold the properties that make that impossible: a state is claimed
 * before the machine is contacted, exactly one update runs per machine, every path ends terminal,
 * and a row that stops reporting is failed rather than left `running` forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Live sockets, `instanceId@node`, and what the machine answers.
 *
 * IDLE is a connected runner with no active coding session — not a runner with no socket. `pags up`
 * holds a socket for every instance it serves, which is exactly why the live node read as
 * "connected, idle" while the update went nowhere. `dropped` is the restart: every socket on the
 * machine goes, and the agent reconnects a couple of polls later, as a respawned runner does.
 */
const live = new Set<string>();
let dropped = false;
let comesBack = true;
let pollsAfterRestart = 0;
let reply: () => unknown = () => ({ action: "restarting", current: "0.4.84", latest: "0.4.85", restartedBy: "pags-up" });

vi.mock("./runner-client.js", () => ({
	relayConnected: async (_e: unknown, id: string, node: string) => {
		if (!dropped) return live.has(`${id}@${node}`);
		pollsAfterRestart++;
		return comesBack && pollsAfterRestart > 2;
	},
	evictStaleRunnerSocket: async () => ({ sockets: 0, alive: false, evicted: 0 }),
	getRunnerConnIgnoringLiveness: async (_e: unknown, id: string, _uid: string, node: string) => ({ instanceId: id, runnerNode: node }),
	callRunner: async (conn: { instanceId: string }, path: string) => {
		if (path !== "/pags/runner/update") return { attached: [], target: conn.instanceId };
		const r = reply();
		if (r instanceof Error) throw r;
		// The restart: every socket on the machine drops.
		if ((r as { action?: string }).action === "restarting") dropped = true;
		return r;
	},
}));

const { realSchemaD1 } = await import("./d1-sqlite.js");
const { claimUpdateOp, advanceUpdateOp, failStaleUpdateOps, latestUpdateOp, latestUpdateOps, liveUpdateOp, UPDATE_OP_STALE_MS } = await import("./runner-update-ops.js");
const { startRunnerUpdate } = await import("./runner-update.js");
type D1 = ReturnType<typeof realSchemaD1>;

let d1: D1;
const NODE = "Macmini.modem";
const env = () => ({ DB: d1.DB }) as never;
/** No sleeping, and a clock that ADVANCES — otherwise the re-attach wait never reaches its deadline. */
const fast = { sleep: async () => undefined, now: () => (NOW += 2_000) };
let NOW = Date.parse("2026-10-09T01:00:00Z");

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('a1', 'u1', 't990-coder', 'Repo Coder', '{}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'a1', 'u1', 'active', '{}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, status, last_seen_at, updated_at)
	         VALUES ('i1', 'u1', 'Macmini.modem', 'relay://', '0.4.84', 'online', '2026-10-09 01:00:00', '2026-10-09 01:00:00')`);
	live.clear();
	// The machine is CONNECTED and serving one agent, with nothing running on it.
	live.add(`i1@${NODE}`);
	dropped = false;
	comesBack = true;
	pollsAfterRestart = 0;
	reply = () => ({ action: "restarting", current: "0.4.84", latest: "0.4.85", restartedBy: "pags-up" });
	NOW = Date.parse("2026-10-09T01:00:00Z");
});
afterEach(() => d1.close());

const row = async (id: string) => await d1.DB.prepare("SELECT state, reason, ended_at, final_version FROM runner_update_ops WHERE id = ?1").bind(id).first<Record<string, unknown>>();

describe("the operation record (#990)", () => {
	it("claims a state BEFORE the machine is contacted, so there is always something to poll", async () => {
		const { op, claimed } = await claimUpdateOp(env(), "u1", NODE);
		expect(claimed).toBe(true);
		expect(op).toMatchObject({ node: NODE, state: "running", dryRun: false });
		expect(op.detail).toMatch(/update its `pags` CLI/);
		// And it is readable by the two paths a caller has: the machine's latest, and the live one.
		expect((await latestUpdateOp(env(), "u1", NODE))?.id).toBe(op.id);
		// Node names are matched EXACTLY (`normalizeRunnerNode` only trims), as the relay's own slot
		// keys are — so a name with stray whitespace is the same machine and a different case is not.
		expect((await liveUpdateOp(env(), "u1", `  ${NODE}  `))?.id).toBe(op.id);
	});

	it("runs ONE update per machine: a retry after a lost reply joins the operation in flight", async () => {
		const first = await claimUpdateOp(env(), "u1", NODE);
		const second = await claimUpdateOp(env(), "u1", NODE);
		expect(second.claimed, "a second install must not start on somebody's laptop").toBe(false);
		expect(second.op.id).toBe(first.op.id);
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM runner_update_ops").first<{ n: number }>())?.n).toBe(1);
		// Once it is terminal, a new attempt is allowed — the claim is on the LIVE row only.
		await advanceUpdateOp(env(), "u1", first.op.id, { state: "restarted" });
		expect((await claimUpdateOp(env(), "u1", NODE)).claimed).toBe(true);
	});

	it("writes a terminal outcome once, stamps when it ended, and refuses a late overwrite", async () => {
		const { op } = await claimUpdateOp(env(), "u1", NODE);
		await advanceUpdateOp(env(), "u1", op.id, { state: "restarted", finalVersion: "0.4.85", detail: "done", reason: "restarted" });
		expect(await row(op.id)).toMatchObject({ state: "restarted", final_version: "0.4.85" });
		expect((await row(op.id))?.ended_at).toBeTruthy();
		// A late phase of the same attempt cannot rewrite the verdict.
		await advanceUpdateOp(env(), "u1", op.id, { state: "failed", detail: "late" });
		expect(await row(op.id)).toMatchObject({ state: "restarted" });
	});

	it("a non-terminal phase keeps the operation open and readable", async () => {
		const { op } = await claimUpdateOp(env(), "u1", NODE);
		await advanceUpdateOp(env(), "u1", op.id, { state: "running", detail: "installing" });
		expect(await row(op.id)).toMatchObject({ state: "running", ended_at: null });
		expect((await liveUpdateOp(env(), "u1", NODE))?.detail).toBe("installing");
	});

	it("fails an operation that stopped reporting, so `running` cannot become the new unknown", async () => {
		const { op } = await claimUpdateOp(env(), "u1", NODE, { now: NOW });
		expect(await failStaleUpdateOps(env(), NOW + 1000)).toBe(0);
		expect(await failStaleUpdateOps(env(), NOW + UPDATE_OP_STALE_MS + 1000)).toBe(1);
		const after = await latestUpdateOp(env(), "u1", NODE);
		expect(after).toMatchObject({ id: op.id, state: "failed", reason: "abandoned" });
		expect(after?.detail).toMatch(/never recorded|check its version/);
		expect(after?.endedAt).toBeTruthy();
	});

	it("reads the latest per machine for a list of machines, newest wins", async () => {
		const a = await claimUpdateOp(env(), "u1", NODE, { now: NOW });
		await advanceUpdateOp(env(), "u1", a.op.id, { state: "failed", reason: "unreachable" }, NOW);
		const b = await claimUpdateOp(env(), "u1", NODE, { now: NOW + 5_000 });
		await advanceUpdateOp(env(), "u1", b.op.id, { state: "restarted" }, NOW + 6_000);
		const ops = await latestUpdateOps(env(), "u1", [NODE, "other-machine"]);
		expect(ops.get(NODE)).toMatchObject({ id: b.op.id, state: "restarted" });
		expect(ops.has("other-machine")).toBe(false);
	});

	it("never reads another owner's operation", async () => {
		d1.exec(`INSERT INTO users (id, github_login) VALUES ('u2', 'u2')`);
		const mine = await claimUpdateOp(env(), "u1", NODE);
		expect(await latestUpdateOp(env(), "u2", NODE)).toBeNull();
		// …and u2 may claim the same machine name without joining u1's operation.
		expect((await claimUpdateOp(env(), "u2", NODE)).claimed).toBe(true);
		expect((await liveUpdateOp(env(), "u1", NODE))?.id).toBe(mine.op.id);
	});
});

describe("the idle-node update path, end to end (#990)", () => {
	it("THE LIVE CASE: an idle connected node installs, restarts, and records the outcome", async () => {
		// IDLE as the issue reports it: `pags up` connected and serving its agent, with no active
		// coding session — not a machine with no socket, which is `unreachable` and says so.
		const { op, started } = await startRunnerUpdate(env(), "u1", NODE, fast);
		expect(started).toBe(true);
		// The caller leaves with a state immediately, which is the property the 20s deadline needs.
		expect(op.state).toBe("running");
		const final = await latestUpdateOp(env(), "u1", NODE);
		expect(final).toMatchObject({ id: op.id, state: "restarted", currentVersion: "0.4.84", latestVersion: "0.4.85", restartedBy: "pags-up" });
		// It held one agent — an idle machine still has a socket — and that agent is back.
		expect(final?.held).toEqual(["i1"]);
		expect(final?.missing).toEqual([]);
		expect(final?.endedAt).toBeTruthy();
		expect(final?.detail).toMatch(/updated 0\.4\.84 → 0\.4\.85/);
	});

	it("records the version the machine registers after it comes back", async () => {
		await startRunnerUpdate(env(), "u1", NODE, fast);
		// The runner re-registers on the new release, as `pags up` does on reconnect.
		d1.exec(`UPDATE instance_runtime_nodes SET runner_version = '0.4.85' WHERE instance_id = 'i1'`);
		const again = await startRunnerUpdate(env(), "u1", NODE, fast);
		expect((await latestUpdateOp(env(), "u1", NODE))?.finalVersion).toBe("0.4.85");
		expect(again.started).toBe(true);
	});

	it.each([
		["up-to-date", { action: "up-to-date", current: "0.4.85" }, "up_to_date"],
		["refused", { action: "refused", current: "0.4.84", reason: "nothing here would restart it" }, "refused"],
		["waiting for a busy engine", { action: "wait", current: "0.4.84", latest: "0.4.85", waitingFor: ["session-1"] }, "scheduled"],
	] as const)("propagates the machine's own %s verdict as a terminal state", async (_label, machineReply, state) => {
		reply = () => machineReply;
		const { op } = await startRunnerUpdate(env(), "u1", NODE, fast);
		expect(await latestUpdateOp(env(), "u1", NODE)).toMatchObject({ id: op.id, state });
		expect((await row(op.id))?.ended_at, "a terminal state is finished").toBeTruthy();
	});

	it("records a CLI too old to update itself as `unsupported`, with the one manual step", async () => {
		reply = () => new Error("Runner /pags/runner/update → 404: not found");
		const { op } = await startRunnerUpdate(env(), "u1", NODE, fast);
		const final = await latestUpdateOp(env(), "u1", NODE);
		expect(final).toMatchObject({ id: op.id, state: "unsupported" });
		expect(final?.detail).toMatch(/npm i -g @proagentstore\/cli/);
	});

	it("records an unreachable machine rather than nothing at all", async () => {
		d1.exec(`DELETE FROM instance_runtime_nodes`);
		const { op } = await startRunnerUpdate(env(), "u1", NODE, fast);
		expect(await latestUpdateOp(env(), "u1", NODE)).toMatchObject({ id: op.id, state: "unreachable" });
	});

	it("A THROWN ERROR IS THE RECORDED OUTCOME — the path that used to lose everything", async () => {
		reply = () => {
			throw new Error("relay exploded");
		};
		const { op } = await startRunnerUpdate(env(), "u1", NODE, fast);
		const final = await latestUpdateOp(env(), "u1", NODE);
		// It reaches `failed` with the reason on it, instead of dying with the request.
		expect(final).toMatchObject({ id: op.id, state: "failed" });
		expect(final?.detail).toMatch(/relay exploded/);
	});

	it("the work does not need the caller: it finishes after the response was handed back", async () => {
		// This is `waitUntil` in the route, modelled: the caller returns as soon as the operation is
		// claimed, and the update completes on the background promise.
		let background: Promise<unknown> | null = null;
		const { op, started } = await startRunnerUpdate(env(), "u1", NODE, { ...fast, background: (p) => { background = p; } });
		expect(started).toBe(true);
		// At the moment the caller leaves, the work has not finished — and the state says so.
		expect(op.state).toBe("running");
		expect(background).not.toBeNull();
		await background;
		expect(await latestUpdateOp(env(), "u1", NODE)).toMatchObject({ state: "restarted" });
	});

	it("a second call while one is in flight does not contact the machine again", async () => {
		let calls = 0;
		reply = () => {
			calls++;
			return { action: "restarting", current: "0.4.84", latest: "0.4.85" };
		};
		let background: Promise<unknown> | null = null;
		await startRunnerUpdate(env(), "u1", NODE, { ...fast, background: (p) => { background = p; } });
		const second = await startRunnerUpdate(env(), "u1", NODE, fast);
		expect(second.started).toBe(false);
		await background;
		expect(calls, "one install, however many times the owner asks").toBe(1);
	});
});
