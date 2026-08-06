import { describe, expect, it } from "vitest";
import { AgentStorageEngine } from "../agent-storage.js";
import type { KnowledgeDoc } from "../agent-types.js";
import type { VectorMeta } from "../agent-storage-types.js";

/**
 * Deleting a knowledge document (#242).
 *
 * The old order was: delete the record, then remove the vectors, swallowing any failure. If
 * Vectorize errored the doc vanished from Knowledge → Documents while its chunks stayed in the
 * index — and the id was gone, so there was nothing left to retry against and no sweeper
 * reconciles the two stores. RAG kept retrieving the deleted document, forever, and the delete
 * reported success.
 *
 * Deleting a KB doc is what a user does when a document is WRONG or shouldn't be there. "It's
 * deleted but the agent still knows it" is the one outcome that must not happen quietly. These
 * tests run the real engine against an in-memory DO store and a Vectorize stub that can be made
 * to fail — restore the swallow and the failure tests go red.
 */

/** Minimal in-memory DurableObjectStorage: get / put / delete (single or batch) / list(prefix). */
function memStorage(seed: Record<string, unknown> = {}) {
	const map = new Map<string, unknown>(Object.entries(seed));
	const store = {
		async get(key: string) {
			return map.get(key);
		},
		async put(key: string, value: unknown) {
			map.set(key, value);
		},
		async delete(key: string | string[]) {
			const keys = Array.isArray(key) ? key : [key];
			let n = 0;
			for (const k of keys) if (map.delete(k)) n++;
			return Array.isArray(key) ? n : n > 0;
		},
		async list({ prefix }: { prefix: string }) {
			const out = new Map<string, unknown>();
			for (const [k, v] of map.entries()) if (k.startsWith(prefix)) out.set(k, v);
			return out;
		},
	};
	return { store: store as unknown as DurableObjectStorage, map };
}

const AGENT = "agent-1";

const doc = (id: string): KnowledgeDoc =>
	({ id, title: `Doc ${id}`, content: "confidential client note", source: "paste", addedAt: "2026-08-01T00:00:00.000Z" }) as KnowledgeDoc;

const vecMeta = (id: string, sourceId: string): VectorMeta =>
	({ id, agentId: AGENT, sourceType: "knowledge", sourceId, chunkIndex: 0, text: "confidential client note", createdAt: "2026-08-01T00:00:00.000Z" }) as VectorMeta;

/** Vectorize stub. `failDeletes` makes deleteByIds throw the way a transient 5xx would. */
function vectorize(failDeletes = false) {
	const deleted: string[] = [];
	const index = {
		async deleteByIds(ids: string[]) {
			if (failDeletes) throw new Error("Vectorize 503");
			deleted.push(...ids);
			return { count: ids.length };
		},
		async upsert() {
			return { count: 0 };
		},
	};
	return { index: index as unknown as VectorizeIndex, deleted };
}

function build(failDeletes = false) {
	const { store, map } = memStorage({
		"kb:d1": doc("d1"),
		"vec:v1": vecMeta("v1", "d1"),
		"vec:v2": vecMeta("v2", "d1"),
		"vec:other": vecMeta("other", "d2"),
	});
	const v = vectorize(failDeletes);
	// `ai` is only needed for embedding (writes); deletes never touch it.
	const engine = new AgentStorageEngine(store, null, v.index, null, AGENT);
	return { engine, map, v };
}

describe("deleteKnowledge — a failed vector delete must not be swallowed", () => {
	it("removes the vectors AND the record on the happy path", async () => {
		const { engine, map, v } = build();
		const removed = await engine.deleteKnowledge("d1");
		expect(removed?.id).toBe("d1");
		expect(map.has("kb:d1")).toBe(false);
		// Both of this doc's chunks left Vectorize; another doc's chunk is untouched.
		expect(v.deleted.sort()).toEqual(["v1", "v2"]);
		expect(map.has("vec:other")).toBe(true);
	});

	it("THROWS when the vectors cannot be removed, instead of reporting success", async () => {
		// Old behaviour: `.catch(() => undefined)` — this resolved with the doc, i.e. "Deleted".
		const { engine } = build(true);
		await expect(engine.deleteKnowledge("d1")).rejects.toThrow(/keep answering searches/i);
	});

	it("leaves the document in place when the vectors survive, so the delete is retryable", async () => {
		// This is the recoverable ordering. Deleting the record first strands the chunks with
		// nothing left to retry against: the user cannot delete it again, and RAG keeps citing it.
		const { engine, map } = build(true);
		await expect(engine.deleteKnowledge("d1")).rejects.toThrow();
		expect(map.has("kb:d1"), "the doc must still be listed so the user can try again").toBe(true);
		expect(await engine.readKnowledge("d1")).not.toBeNull();
		expect((await engine.listKnowledge()).map((d) => d.id)).toContain("d1");
	});

	it("a retry after the outage clears both stores", async () => {
		const { engine, map } = build(true);
		await expect(engine.deleteKnowledge("d1")).rejects.toThrow();
		// Same engine, Vectorize back up.
		const healthy = vectorize(false);
		const retried = new AgentStorageEngine(
			// biome-ignore lint/suspicious/noExplicitAny: reaching into the built store for the retry
			(engine as any).doStorage as DurableObjectStorage,
			null,
			healthy.index,
			null,
			AGENT,
		);
		expect(await retried.deleteKnowledge("d1")).not.toBeNull();
		expect(map.has("kb:d1")).toBe(false);
		expect(healthy.deleted.sort()).toEqual(["v1", "v2"]);
	});

	it("still reports 'not found' for a document that was never there", async () => {
		const { engine } = build(true);
		expect(await engine.deleteKnowledge("nope")).toBeNull();
	});
});
