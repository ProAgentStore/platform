/**
 * #1181: "same machine" is one answer. The machines list reads an id-less registration under a hostname that only ever carried one id as
 * that machine; the router used to look only at explicit ids, so an agent could show attached to a machine it would not route to.
 * Over the real schema: only the relay (which sockets are live) is faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { aliasNodesFor, withAdoptedIds, type NodeRegistration } from "./machine-identity.js";
import { getBoundRunnerConn } from "./runner-client.js";
import type { Env } from "../types.js";

const row = (node: string, machineId: string | null, instanceId = "x", lastSeenAt = "2026-10-22 10:00:00"): NodeRegistration => ({ node, machineId, instanceId, lastSeenAt });

describe("withAdoptedIds / aliasNodesFor", () => {
	it("an id-less row takes the one id its hostname carries elsewhere; an ambiguous hostname lends nothing", () => {
		const rows = [row("A", "mid-AAAAAAAA", "y"), row("A", null, "x"), row("B", "mid-BBBBBBBB", "y"), row("B", "mid-CCCCCCCC", "z"), row("B", null, "x"), row("C", null, "x")];
		expect(withAdoptedIds(rows).map((r) => r.machineId)).toEqual(["mid-AAAAAAAA", "mid-AAAAAAAA", "mid-BBBBBBBB", "mid-CCCCCCCC", null, null]);
	});

	it("this instance's id-less registration under another name of the pinned machine is an alias for it", () => {
		const rows = [row("N", "mid-AAAAAAAA", "y"), row("A", "mid-AAAAAAAA", "y"), row("A", null, "x")];
		// Before: the id-less (x, A) row was invisible, and the id'd (y, A) row belongs to another instance - so x had NO alias.
		expect(aliasNodesFor("N", rows, "x")).toEqual(["A"]);
	});

	it("still fail-closed: no id on the pinned name, an ambiguous alias name, or another instance's alone gives nothing", () => {
		expect(aliasNodesFor("N", [row("N", null), row("A", "mid-AAAAAAAA", "y")], "x")).toEqual([]);
		const ambiguous = [row("N", "mid-AAAAAAAA", "y"), row("A", "mid-AAAAAAAA", "y"), row("A", "mid-BBBBBBBB", "z"), row("A", null, "x")];
		expect(aliasNodesFor("N", ambiguous, "x")).toEqual([]);
		expect(aliasNodesFor("N", [row("N", "mid-AAAAAAAA", "y"), row("A", "mid-AAAAAAAA", "y")], "x")).toEqual([]);
	});
});

describe("the router follows the same identity (getBoundRunnerConn)", () => {
	let d1: RealSchemaD1;
	let live: Set<string>;
	const env = () => ({ DB: d1.DB, RELAY: { idFromName: (n: string) => n, get: (n: string) => ({ fetch: async () => Response.json({ connected: live.has(n) }) }) } }) as unknown as Env;
	const node = (inst: string, name: string, machine: string | null) =>
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, token_plaintext, machine_id, status, last_seen_at) VALUES ('${inst}', 'u1', '${name}', 'relay://', 't', ${machine ? `'${machine}'` : "NULL"}, 'online', '2026-10-22 10:00:00')`);

	beforeEach(() => {
		d1 = realSchemaD1();
		live = new Set();
		d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
		d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't1181-agent', 'A', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('x', 'ag', 'u1', 'active', '{"runnerNode":"old-name"}'), ('y', 'ag', 'u1', 'active', '{}')`);
		node("x", "old-name", "mid-MINI0001"); // x's pin: the dead name, which carries the id
		node("y", "new-name", "mid-MINI0001"); // another agent registered on the same machine under its current name, with the id
		node("x", "new-name", null); // x registered under the current name too - the machine's pags up never stamped it
	});
	afterEach(() => d1.close());

	it("routes x to the machine's current name through its id-less registration - the answer the machines list gives", async () => {
		live.add("x:node:new-name");
		const conn = await getBoundRunnerConn(env(), "x", "u1");
		expect(conn?.runnerNode).toBe("new-name");
	});

	it("does not route to a name of a DIFFERENT machine, and a dead machine stays unreachable (fail closed)", async () => {
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, token_plaintext, machine_id, status, last_seen_at) VALUES ('x', 'u1', 'other-box', 'relay://', 't', 'mid-OTHER001', 'online', '2026-10-22 10:00:00')`);
		live.add("x:node:other-box");
		expect(await getBoundRunnerConn(env(), "x", "u1")).toBeNull();
	});
});
