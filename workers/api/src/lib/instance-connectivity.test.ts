/**
 * The facts a connectivity answer is built from — and, since #461, the "Runs on" pin among them.
 *
 * The defect this pins was not in any diagnosis: `diagnoseAttachment` had the pinned-machine
 * branch, correct and tested, since #380. It was that nothing put the pin INTO the facts, so the
 * adapter every surface reads them through had nothing to forward and each one fell back to
 * `machine-online-agent-detached` — telling an owner pinned at a switched-off laptop to run
 * `pags up --force`.
 *
 * The two costs the issue named as regression risk are asserted here too, because the batched
 * form of this function is what `subordinate_status` fans out over: the pin is ONE statement for
 * the whole set, and the "which machine is up instead" scan happens only where it can change the
 * answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getBoundRunnerConn, liveNodeIgnoringPin } = vi.hoisted(() => ({
	getBoundRunnerConn: vi.fn(),
	liveNodeIgnoringPin: vi.fn(),
}));
vi.mock("./runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./runner-client.js")>()),
	getBoundRunnerConn,
	liveNodeIgnoringPin,
}));

import { MAX_RELAY_PROBES, runtimeConnectivity, runtimeConnectivityMany, runtimeConnectivityWithConn } from "./instance-connectivity.js";
import type { Env } from "../types.js";

const UID = "user-1";

interface Registration {
	instance_id: string;
	runner_node: string | null;
	runner_version: string | null;
	last_seen_at: string | null;
}

function db(opts: { pins?: Record<string, string>; registrations?: Registration[] }) {
	const issued: string[] = [];
	const DB = {
		prepare(sql: string) {
			const flat = sql.replace(/\s+/g, " ").trim();
			const stmt = {
				bind: (..._binds: unknown[]) => {
					issued.push(flat);
					return stmt;
				},
				all: async () => {
					if (flat.startsWith("SELECT id, config FROM agent_instances")) {
						return { results: Object.entries(opts.pins ?? {}).map(([id, runnerNode]) => ({ id, config: JSON.stringify({ runnerNode }) })) };
					}
					return { results: opts.registrations ?? [] };
				},
				first: async () => null,
				run: async () => ({ meta: { changes: 1 } }),
			};
			return stmt;
		},
	};
	return { env: { DB } as unknown as Env, issued };
}

const reg = (id: string, node: string): Registration => ({
	instance_id: id,
	runner_node: node,
	runner_version: "0.4.44",
	last_seen_at: new Date(Date.now() - 5_000).toISOString().slice(0, 19).replace("T", " "),
});

beforeEach(() => {
	getBoundRunnerConn.mockReset();
	liveNodeIgnoringPin.mockReset();
	getBoundRunnerConn.mockResolvedValue(null);
	liveNodeIgnoringPin.mockResolvedValue(null);
});

describe("runtimeConnectivity — the pin is a fact about connectivity (#461)", () => {
	it("carries the pin and the machine that is up instead", async () => {
		liveNodeIgnoringPin.mockResolvedValue("Mac");
		const { env } = db({ pins: { i1: "Sergeys-Mac-mini.local" }, registrations: [reg("i1", "Sergeys-Mac-mini.local")] });
		const facts = await runtimeConnectivity(env, "i1", UID);
		expect(facts).toMatchObject({
			hasRuntimeRow: true,
			relayConnected: false,
			pinnedNode: "Sergeys-Mac-mini.local",
			liveNodeExcludedByPin: "Mac",
		});
	});

	it("reports no pin as null rather than as an empty string", async () => {
		const { env } = db({ registrations: [reg("i1", "Mac")] });
		const facts = await runtimeConnectivity(env, "i1", UID);
		expect(facts.pinnedNode).toBeNull();
		expect(facts.liveNodeExcludedByPin).toBeNull();
	});

	// The scan behind `liveNodeExcludedByPin` is a relay probe per instance. Asking for it when a
	// socket already resolved, or when there is no pin to be excluded BY, would be spend that can
	// never change the sentence.
	it("does not go looking for another machine unless a pin is the reason there is no socket", async () => {
		const live = db({ pins: { i1: "Mac" }, registrations: [reg("i1", "Mac")] });
		getBoundRunnerConn.mockResolvedValue({ runnerNode: "Mac" });
		await runtimeConnectivity(live.env, "i1", UID);
		expect(liveNodeIgnoringPin).not.toHaveBeenCalled();

		const unpinned = db({ registrations: [reg("i2", "Mac")] });
		await runtimeConnectivity(unpinned.env, "i2", UID);
		expect(liveNodeIgnoringPin).not.toHaveBeenCalled();
	});

	it("reads every instance's pin in ONE statement, whatever the fan-out", async () => {
		const ids = Array.from({ length: MAX_RELAY_PROBES + 4 }, (_, i) => `i${i}`);
		const { env, issued } = db({ pins: { i0: "mini" } });
		await runtimeConnectivityMany(env, UID, ids);
		expect(issued.filter((s) => s.startsWith("SELECT id, config FROM agent_instances"))).toHaveLength(1);
	});

	// Past MAX_RELAY_PROBES nothing is probed, so the "other machine" is unknown. Both fields are
	// needed for the pinned diagnosis, so the tail degrades to exactly its previous answer rather
	// than to a half-diagnosis built from one of them.
	// The chat prompt needs BOTH halves of this read: the facts, to say why there is no runner, and
	// the connection, to fan out `/coding/capture` on the turn where there is one. Before #530 it
	// resolved the connection itself and inferred the facts from it, which is how the pin got lost.
	// Handing the connection back is what makes going through this module cost nothing extra.
	it("returns the connection it resolved, not just the verdict about it", async () => {
		const conn = { runnerNode: "Air", instanceId: "i1" };
		getBoundRunnerConn.mockResolvedValue(conn);
		const { env } = db({ registrations: [reg("i1", "Air")] });
		const out = await runtimeConnectivityWithConn(env, "i1", UID);
		expect(out.conn).toBe(conn);
		expect(out.facts).toMatchObject({ relayConnected: true, node: "Air" });
		// One resolution, not two: `getBoundRunnerConn` has already live-checked the relay before it
		// returns a connection, so re-asking would be a second DO fetch for a fact we hold.
		expect(getBoundRunnerConn).toHaveBeenCalledTimes(1);
		expect(liveNodeIgnoringPin).not.toHaveBeenCalled();
	});

	it("gives the single-instance read the same facts whichever entry point asks", async () => {
		// `runtimeConnectivity` delegates to the with-conn form, so a caller that wants only the
		// facts cannot get a different answer from one that wants both.
		liveNodeIgnoringPin.mockResolvedValue("Air");
		const { env } = db({ pins: { i1: "mini" }, registrations: [reg("i1", "mini")] });
		const facts = await runtimeConnectivity(env, "i1", UID);
		const both = await runtimeConnectivityWithConn(env, "i1", UID);
		expect(both.facts).toEqual(facts);
		expect(both.conn).toBeNull();
		expect(facts).toMatchObject({ pinnedNode: "mini", liveNodeExcludedByPin: "Air" });
	});

	it("gives the unprobed tail its pin but never invents a live machine for it", async () => {
		const ids = Array.from({ length: MAX_RELAY_PROBES + 1 }, (_, i) => `i${i}`);
		const tail = ids[ids.length - 1];
		const { env } = db({ pins: { [tail]: "mini" } });
		const facts = await runtimeConnectivityMany(env, UID, ids);
		expect(facts.get(tail)).toMatchObject({ pinnedNode: "mini", liveNodeExcludedByPin: null });
		expect(liveNodeIgnoringPin).toHaveBeenCalledTimes(0);
	});
});
