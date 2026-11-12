import { describe, expect, it, vi } from "vitest";
import { realSchemaD1 } from "./d1-sqlite.js";
import { ownerRuntimeNodes, type OwnerRuntimeNode } from "./owner-runtime-nodes.js";
import { nodeRegistrations } from "./runner-repin.js";
import type { Env } from "../types.js";

const row = (node: string): OwnerRuntimeNode => ({ instance_id: "i1", runner_node: node, machine_id: "machine-0001", runner_version: "0.6.0", last_seen_at: null, updated_at: "2026-11-13 00:00:00" });

function pendingDatabase() {
	const reads: Array<{ owner: string; resolve: (value: { results: OwnerRuntimeNode[] }) => void; reject: (reason: Error) => void }> = [];
	const prepare = vi.fn(() => ({ bind: (owner: string) => ({ all: () => new Promise<{ results: OwnerRuntimeNode[] }>((resolve, reject) => reads.push({ owner, resolve, reject })) }) }));
	return { DB: { prepare } as unknown as D1Database, prepare, reads };
}

describe("owner runtime registration read coalescing (#1646)", () => {
	it("deduplicates the real repin registration reader with another metadata consumer", async () => {
		const db = pendingDatabase();
		const repin = nodeRegistrations(db as unknown as Env, "u1");
		const metadata = ownerRuntimeNodes(db, "u1");
		expect(db.prepare).toHaveBeenCalledTimes(1);
		db.reads[0].resolve({ results: [row("machine")] });
		expect(await repin).toEqual([{ node: "machine", machineId: "machine-0001", instanceId: "i1", lastSeenAt: null }]);
		expect((await metadata)[0].runner_node).toBe("machine");
	});

	it("keeps the first 200 named repin registrations in newest-first query order", async () => {
		const db = pendingDatabase();
		const registrations = nodeRegistrations(db as unknown as Env, "u1");
		// Empty names are excluded before the cap, matching the previous SQL WHERE/LIMIT.
		const valid = Array.from({ length: 205 }, (_, i) => ({ ...row(`node-${i}`), instance_id: `instance-${i}`, machine_id: `machine-${i}`, last_seen_at: `seen-${i}` }));
		db.reads[0].resolve({ results: [row(""), ...valid] });
		const result = await registrations;
		expect(result).toHaveLength(200);
		expect(result[0]).toEqual({ node: "node-0", machineId: "machine-0", instanceId: "instance-0", lastSeenAt: "seen-0" });
		expect(result.at(-1)?.node).toBe("node-199");
		expect(result.some((r) => r.node === "node-200")).toBe(false);
	});

	it("shares one pending D1 call across concurrent owner readers and isolates returned objects", async () => {
		const db = pendingDatabase();
		const first = ownerRuntimeNodes(db, "u1");
		const second = ownerRuntimeNodes(db, "u1");
		expect(db.prepare).toHaveBeenCalledTimes(1);
		db.reads[0].resolve({ results: [row("first"), row("second")] });
		const [a, b] = await Promise.all([first, second]);
		a.reverse();
		a[0].runner_node = "changed";
		expect(b.map((r) => r.runner_node)).toEqual(["first", "second"]);
	});

	it("never shares a pending read across owners or database bindings", async () => {
		const a = pendingDatabase();
		const b = pendingDatabase();
		const calls = [ownerRuntimeNodes(a, "u1"), ownerRuntimeNodes(a, "u2"), ownerRuntimeNodes(b, "u1")];
		expect(a.reads.map((r) => r.owner)).toEqual(["u1", "u2"]);
		expect(b.reads.map((r) => r.owner)).toEqual(["u1"]);
		a.reads[0].resolve({ results: [row("a1")] });
		a.reads[1].resolve({ results: [row("a2")] });
		b.reads[0].resolve({ results: [row("b1")] });
		expect((await Promise.all(calls)).map((r) => r[0].runner_node)).toEqual(["a1", "a2", "b1"]);
	});

	it("reads fresh identity evidence after a completed lookup", async () => {
		const db = pendingDatabase();
		const first = ownerRuntimeNodes(db, "u1");
		db.reads[0].resolve({ results: [row("old")] });
		await first;
		const next = ownerRuntimeNodes(db, "u1");
		expect(db.prepare).toHaveBeenCalledTimes(2);
		db.reads[1].resolve({ results: [row("new")] });
		expect((await next)[0].runner_node).toBe("new");
	});

	it("propagates failed evidence to every reader and retries the next lookup", async () => {
		const db = pendingDatabase();
		const first = ownerRuntimeNodes(db, "u1");
		const second = ownerRuntimeNodes(db, "u1");
		const failed = Promise.allSettled([first, second]);
		const error = new Error("D1 unavailable");
		db.reads[0].reject(error);
		expect(await failed).toEqual([{ status: "rejected", reason: error }, { status: "rejected", reason: error }]);
		const retry = ownerRuntimeNodes(db, "u1");
		expect(db.prepare).toHaveBeenCalledTimes(2);
		db.reads[1].resolve({ results: [] });
		expect(await retry).toEqual([]);
	});

	it("uses the migrated user index and preserves tenant scope and newest-first order", async () => {
		const d1 = realSchemaD1();
		try {
			d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2'); INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 'cost1646', 'A'); INSERT INTO agent_instances (id, agent_id, user_id, status) VALUES ('i1', 'ag', 'u1', 'active'), ('i2', 'ag', 'u2', 'active')");
			d1.exec("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, updated_at) VALUES ('i1', 'u1', 'older', 'relay://', '2026-11-01'), ('i1', 'u1', 'newer', 'relay://', '2026-11-13'), ('i2', 'u2', 'foreign', 'relay://', '2026-11-14')");
			const prepare = vi.spyOn(d1.DB, "prepare");
			expect((await ownerRuntimeNodes(d1, "u1")).map((r) => r.runner_node)).toEqual(["newer", "older"]);
			const sql = prepare.mock.calls[0][0];
			const plan = d1.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("u1") as Array<{ detail: string }>;
			expect(plan.some((p) => p.detail.includes("SEARCH instance_runtime_nodes USING INDEX") && p.detail.includes("(user_id=?)"))).toBe(true);
		} finally {
			d1.close();
		}
	});
});
