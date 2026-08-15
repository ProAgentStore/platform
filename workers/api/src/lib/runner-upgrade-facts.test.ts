import { beforeEach, describe, expect, it, vi } from "vitest";

// The I/O half of #524, mocked at the two seams it reads through: the connectivity record (which
// machine answered, what it runs, is there a pin) and the relay (is a candidate machine actually
// up). Kept in its own file because `runner-upgrade.test.ts` asserts the PURE sentence and must
// not be able to pass on a mock.
const { runtimeConnectivity } = vi.hoisted(() => ({ runtimeConnectivity: vi.fn() }));
const { getRunnerConn } = vi.hoisted(() => ({ getRunnerConn: vi.fn() }));
vi.mock("./instance-connectivity.js", () => ({ runtimeConnectivity }));
vi.mock("./runner-client.js", () => ({ getRunnerConn }));

import { runnerUpgradeFacts } from "./runner-upgrade.js";
import type { Env } from "../types.js";

const MINI = "Sergeys-Mac-mini.local";
const AIR = "RLs-MacBook-Air";
const opts = { what: "search this repository", minCli: "0.4.49" };

/** A D1 stub whose one `.all()` answers the account-wide node query. */
const envWith = (nodes: Array<{ runner_node: string | null; runner_version: string | null; last_seen_at: string | null }>) =>
	({
		DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: nodes }) }) }) },
	}) as unknown as Env;

beforeEach(() => {
	runtimeConnectivity.mockReset();
	getRunnerConn.mockReset();
	getRunnerConn.mockResolvedValue(null);
	// The measured shape of #524: the call routed to the Mac mini on 0.4.45, and it is pinned there.
	runtimeConnectivity.mockResolvedValue({
		hasRuntimeRow: true,
		relayConnected: true,
		node: MINI,
		runnerVersion: "0.4.45",
		lastSeenAt: null,
		pinnedNode: MINI,
		liveNodeExcludedByPin: null,
	});
});

describe("runnerUpgradeFacts (#524)", () => {
	it("reports the machine that answered, its version, and that a pin holds it there", async () => {
		const facts = await runnerUpgradeFacts(envWith([]), "i1", "u1", opts);
		expect(facts).toMatchObject({ node: MINI, nodeVersion: "0.4.45", pinned: true });
		expect(facts.alternative ?? null).toBeNull();
	});

	it("names a capable machine, and calls it connected only when the relay says so", async () => {
		getRunnerConn.mockResolvedValue({ runnerNode: AIR });
		const facts = await runnerUpgradeFacts(
			envWith([
				{ runner_node: MINI, runner_version: "0.4.45", last_seen_at: "2026-08-12 04:16:00" },
				{ runner_node: AIR, runner_version: "0.4.51", last_seen_at: "2026-08-12 04:16:00" },
			]),
			"i1",
			"u1",
			opts,
		);
		expect(facts.alternative).toEqual({ node: AIR, version: "0.4.51", connected: true });
	});

	it("still names it when no socket answers, but does NOT claim it is connected", async () => {
		// `status` is never cleared on disconnect (#238). A machine known only from a registration
		// row is worth naming and is not evidence of a live runner.
		const facts = await runnerUpgradeFacts(
			envWith([{ runner_node: AIR, runner_version: "0.4.51", last_seen_at: "2026-08-12 04:16:00" }]),
			"i1",
			"u1",
			opts,
		);
		expect(facts.alternative).toEqual({ node: AIR, version: "0.4.51", connected: false });
	});

	it("does not offer a machine that is no newer than the one that just refused", async () => {
		const facts = await runnerUpgradeFacts(
			envWith([
				{ runner_node: AIR, runner_version: "0.4.45", last_seen_at: "2026-08-12 04:16:00" },
				{ runner_node: "old-laptop", runner_version: null, last_seen_at: "2026-08-01 00:00:00" },
			]),
			"i1",
			"u1",
			opts,
		);
		expect(facts.alternative ?? null).toBeNull();
	});

	it("never offers the machine that just refused, even if the row claims it is capable", async () => {
		// Two rows for one node (the legacy `instance_runtimes` row and the per-machine one) can
		// disagree. Naming the failing machine as its own alternative is a loop.
		const facts = await runnerUpgradeFacts(
			envWith([{ runner_node: MINI, runner_version: "0.4.51", last_seen_at: "2026-08-12 04:16:00" }]),
			"i1",
			"u1",
			opts,
		);
		expect(facts.alternative ?? null).toBeNull();
	});

	it("degrades to the bare facts when the diagnosis read fails, rather than turning a refusal into a 500", async () => {
		runtimeConnectivity.mockRejectedValue(new Error("D1_ERROR: network"));
		const facts = await runnerUpgradeFacts(envWith([]), "i1", "u1", opts);
		expect(facts).toEqual(opts);
	});
});
