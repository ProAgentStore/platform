import { describe, expect, it, vi } from "vitest";
import { AgentStorageEngine } from "./agent-storage.js";
import type { VectorMeta } from "./agent-storage-types.js";

/** Minimal in-memory DO storage mock (mirrors agent-storage.test.ts). */
function mockDoStorage() {
	const store = new Map<string, unknown>();
	const api = {
		_store: store,
		get: vi.fn(async <T>(key: string) => (store.get(key) as T) ?? null),
		put: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
		delete: vi.fn(async (keyOrKeys: string | string[]) => {
			const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
			for (const k of keys) store.delete(k);
			return keys.length > 0;
		}),
		list: vi.fn(async <T>(opts?: { prefix?: string }) => {
			const entries = [...store.entries()].filter(([k]) => !opts?.prefix || k.startsWith(opts.prefix));
			return new Map(entries) as Map<string, T>;
		}),
	};
	return api as unknown as DurableObjectStorage & { _store: Map<string, unknown> };
}

/** AI mock: one embedding per input text. */
function mockAi() {
	return {
		run: vi.fn(async (_model: string, body: { text: string[] }) => ({
			data: body.text.map((_, i) => [0.1 * (i + 1), 0.2, 0.3]),
		})),
	} as unknown as Ai;
}

/** Vectorize mock recording upserts/deletes. */
function mockVectorize() {
	const upserted: string[] = [];
	const deleted: string[] = [];
	const api = {
		_upserted: upserted,
		_deleted: deleted,
		upsert: vi.fn(async (vectors: Array<{ id: string }>) => { for (const v of vectors) upserted.push(v.id); }),
		deleteByIds: vi.fn(async (ids: string[]) => { for (const id of ids) deleted.push(id); }),
		query: vi.fn(async () => ({ matches: [] })),
	};
	return api as unknown as VectorizeIndex & { _upserted: string[]; _deleted: string[] };
}

function repoVecMetas(storage: DurableObjectStorage & { _store: Map<string, unknown> }): VectorMeta[] {
	return [...storage._store.entries()]
		.filter(([k]) => k.startsWith("vec:"))
		.map(([, v]) => v as VectorMeta)
		.filter((m) => m.sourceType === "repo");
}

describe("AgentStorageEngine repo vectors", () => {
	// chunkText drops fragments ≤20 chars, so test content is realistically sized.
	const FILE_A = "export const answer = 42; // the canonical example value for this module";
	const FILE_B = "function greet(name) { return `hello ${name}, welcome to the project`; }";

	it("namespaces vectors by repo and labels every chunk with repo + path", async () => {
		const storage = mockDoStorage();
		const vectorize = mockVectorize();
		const engine = new AgentStorageEngine(storage, null, vectorize, mockAi(), "inst-1");

		const n = await engine.vectorizeRepoFile("octo/repoA", "src/index.ts", FILE_A);
		expect(n).toBe(1);
		const metas = repoVecMetas(storage);
		expect(metas).toHaveLength(1);
		expect(metas[0].sourceId).toBe("octo/repoA::src/index.ts");
		expect(metas[0].text).toContain("File: octo/repoA/src/index.ts");
		expect(vectorize._upserted).toHaveLength(1);
	});

	it("keeps same-path files in different repos distinct", async () => {
		const storage = mockDoStorage();
		const engine = new AgentStorageEngine(storage, null, mockVectorize(), mockAi(), "inst-1");

		await engine.vectorizeRepoFile("octo/repoA", "README.md", FILE_A);
		await engine.vectorizeRepoFile("octo/repoB", "README.md", FILE_B);

		const sourceIds = repoVecMetas(storage).map((m) => m.sourceId).sort();
		expect(sourceIds).toEqual(["octo/repoA::README.md", "octo/repoB::README.md"]);
	});

	it("clearRepoVectors(key) removes only that repo; others remain", async () => {
		const storage = mockDoStorage();
		const vectorize = mockVectorize();
		const engine = new AgentStorageEngine(storage, null, vectorize, mockAi(), "inst-1");

		await engine.vectorizeRepoFile("octo/repoA", "a.ts", FILE_A);
		await engine.vectorizeRepoFile("octo/repoB", "b.ts", FILE_B);
		expect(repoVecMetas(storage)).toHaveLength(2);

		await engine.clearRepoVectors("octo/repoA");

		const remaining = repoVecMetas(storage);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].sourceId).toBe("octo/repoB::b.ts");
		expect(vectorize._deleted).toHaveLength(1); // only repoA's vector id
	});

	it("does not confuse a repo whose name is a prefix of another (a/b vs a/bc)", async () => {
		const storage = mockDoStorage();
		const engine = new AgentStorageEngine(storage, null, mockVectorize(), mockAi(), "inst-1");

		await engine.vectorizeRepoFile("a/b", "x.ts", FILE_A);
		await engine.vectorizeRepoFile("a/bc", "y.ts", FILE_B);

		await engine.clearRepoVectors("a/b");

		const remaining = repoVecMetas(storage).map((m) => m.sourceId);
		expect(remaining).toEqual(["a/bc::y.ts"]); // a/bc untouched
	});

	it("clearRepoVectors() with no key wipes all repo vectors", async () => {
		const storage = mockDoStorage();
		const engine = new AgentStorageEngine(storage, null, mockVectorize(), mockAi(), "inst-1");

		await engine.vectorizeRepoFile("octo/repoA", "a.ts", FILE_A);
		await engine.vectorizeRepoFile("octo/repoB", "b.ts", FILE_B);
		await engine.clearRepoVectors();

		expect(repoVecMetas(storage)).toHaveLength(0);
	});

	it("chunks a large file into multiple labeled vectors", async () => {
		const storage = mockDoStorage();
		const engine = new AgentStorageEngine(storage, null, mockVectorize(), mockAi(), "inst-1");

		const big = "const line = 'data value here';\n".repeat(120); // many full chunks
		const n = await engine.vectorizeRepoFile("octo/repoA", "big.ts", big);
		expect(n).toBeGreaterThanOrEqual(2);
		// Every chunk carries the file label
		expect(repoVecMetas(storage).every((m) => m.text.startsWith("File: octo/repoA/big.ts"))).toBe(true);
	});

	it("returns 0 and stores nothing when AI/Vectorize are unavailable", async () => {
		const storage = mockDoStorage();
		const engine = new AgentStorageEngine(storage, null, null, null, "inst-1");
		const n = await engine.vectorizeRepoFile("octo/repoA", "a.ts", FILE_A);
		expect(n).toBe(0);
		expect(repoVecMetas(storage)).toHaveLength(0);
	});
});
