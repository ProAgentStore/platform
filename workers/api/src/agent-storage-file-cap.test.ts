/**
 * #637 — a document indexed to 100k characters must not report itself as fully extracted.
 *
 * The cap is not the bug; the silence was. A 400,000-character PDF was stored with
 * `extractionStatus: "extracted"` and `extractedTextLength: 400000` while 300,000 characters
 * existed in no store the agent could reach — not `filetext:` (so `read_file` could not see
 * them) and not the vector index (so RAG could not). Nothing on `FileMeta` distinguished it
 * from a document that fit.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentStorageEngine } from "./agent-storage.js";
import type { FileMeta } from "./agent-storage-types.js";

const CAP = 100_000;

function mockDoStorage() {
	const store = new Map<string, unknown>();
	return {
		_m: store,
		get: vi.fn(async <T>(key: string) => (store.get(key) as T) ?? null),
		put: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
		delete: vi.fn(async (k: string | string[]) => { for (const x of Array.isArray(k) ? k : [k]) store.delete(x); return true; }),
		list: vi.fn(async <T>(opts?: { prefix?: string }) =>
			new Map([...store.entries()].filter(([k]) => !opts?.prefix || k.startsWith(opts.prefix))) as Map<string, T>),
	};
}

/** R2 double: remembers what was put, answers head() with a size. */
function mockR2(size = 1_000) {
	const objects = new Map<string, unknown>();
	return {
		_o: objects,
		put: vi.fn(async (key: string, data: unknown) => { objects.set(key, data); return {}; }),
		head: vi.fn(async (key: string) => (objects.has(key) ? { size } : null)),
		get: vi.fn(async (key: string) => (objects.has(key) ? { arrayBuffer: async () => new TextEncoder().encode(String(objects.get(key))).buffer } : null)),
		delete: vi.fn(async () => undefined),
	};
}

const workingAi = () => ({ run: vi.fn(async () => ({ data: [new Array(8).fill(0)] })) });
const vectorizeOk = () => ({ upsert: vi.fn(async () => ({})), query: vi.fn(async () => ({ matches: [] })) });

function engineWith(opts: { r2?: ReturnType<typeof mockR2>; ai?: unknown; vectorize?: unknown } = {}) {
	const storage = mockDoStorage();
	const r2 = opts.r2 ?? mockR2();
	const engine = new AgentStorageEngine(storage as never, r2 as never, (opts.vectorize ?? null) as never, (opts.ai ?? null) as never, "agent-1");
	return { engine, storage, r2 };
}

describe("#637 — the caller learns the document was capped", () => {
	it("records the INDEXED length beside the extracted one, and flags the truncation", async () => {
		const { engine, storage } = engineWith();
		const text = "a".repeat(400_000);
		const meta = await engine.fileUpload({ name: "handbook.txt", mimeType: "text/plain", data: text });

		// The document's real length is still recorded — that field was never wrong, it was alone.
		expect(meta.extractedTextLength).toBe(400_000);
		// What is actually reachable, which nothing used to say.
		expect(meta.indexedTextLength).toBe(CAP);
		expect(meta.textTruncated).toBe(true);
		// And it matches what `read_file` will actually serve.
		expect((storage._m.get("filetext:" + meta.id) as string).length).toBe(CAP);
	});

	it("reports a document that fits as NOT truncated, so the flag stays meaningful", async () => {
		const { engine } = engineWith();
		const meta = await engine.fileUpload({ name: "note.txt", mimeType: "text/plain", data: "b".repeat(500) });
		expect(meta.extractedTextLength).toBe(500);
		expect(meta.indexedTextLength).toBe(500);
		expect(meta.textTruncated).toBe(false);
	});

	it("persists the truncation on the stored metadata, not just the returned object", async () => {
		const { engine, storage } = engineWith();
		const meta = await engine.fileUpload({ name: "handbook.txt", mimeType: "text/plain", data: "c".repeat(250_000) });
		const stored = storage._m.get(`file:${meta.id}`) as FileMeta;
		expect(stored.textTruncated).toBe(true);
		expect(stored.indexedTextLength).toBe(CAP);
	});

	it("puts the truncation in the activity event too — the record that outlives the request", async () => {
		const { engine, storage } = engineWith();
		await engine.fileUpload({ name: "handbook.txt", mimeType: "text/plain", data: "d".repeat(250_000) });
		const events = [...storage._m.entries()].filter(([k]) => k.startsWith("evt:")).map(([, v]) => v as { type: string; data?: Record<string, unknown> });
		const uploaded = events.find((e) => e.type === "file.uploaded");
		expect(uploaded?.data?.textTruncated).toBe(true);
		expect(uploaded?.data?.indexedTextLength).toBe(CAP);
	});

	describe("`vectorized` — the file that uploaded fine and is invisible to search", () => {
		it("is true when the text really was indexed", async () => {
			const { engine } = engineWith({ ai: workingAi(), vectorize: vectorizeOk() });
			const meta = await engine.fileUpload({ name: "note.txt", mimeType: "text/plain", data: "hello ".repeat(200) });
			expect(meta.vectorized).toBe(true);
		});

		it("is false when vectorization threw — previously only a non-persisted console.error", async () => {
			const brokenAi = { run: async () => { throw new Error("AI provider 500"); } };
			const { engine, storage } = engineWith({ ai: brokenAi, vectorize: vectorizeOk() });
			const meta = await engine.fileUpload({ name: "note.txt", mimeType: "text/plain", data: "hello ".repeat(200) });
			expect(meta.vectorized).toBe(false);
			expect((storage._m.get(`file:${meta.id}`) as FileMeta).vectorized).toBe(false);
		});

		it("is false when indexing is off, because vectorizeStore no-ops without throwing (#22)", async () => {
			const { engine } = engineWith();
			const meta = await engine.fileUpload({ name: "note.txt", mimeType: "text/plain", data: "hello ".repeat(200) });
			expect(meta.vectorized).toBe(false);
		});
	});

	describe("the multipart path behaves identically", () => {
		it("caps and flags the same way", async () => {
			const r2 = mockR2(2_000);
			await r2.put("agents/agent-1/files/x/big.txt", "e".repeat(300_000));
			const { engine } = engineWith({ r2 });
			const meta = await engine.fileRegister({ id: "x", name: "big.txt", r2Key: "agents/agent-1/files/x/big.txt", mimeType: "text/plain" });
			expect(meta?.extractedTextLength).toBe(300_000);
			expect(meta?.indexedTextLength).toBe(CAP);
			expect(meta?.textTruncated).toBe(true);
		});

		it("says WHY a big file was skipped, instead of calling a valid PDF 'unsupported' in silence", async () => {
			const r2 = mockR2(40 * 1024 * 1024); // 40 MB — inside the 2 GB upload cap, past the 32 MiB extract cap
			await r2.put("agents/agent-1/files/y/huge.pdf", "ignored");
			const { engine } = engineWith({ r2 });
			const meta = await engine.fileRegister({ id: "y", name: "huge.pdf", r2Key: "agents/agent-1/files/y/huge.pdf", mimeType: "application/pdf" });
			// `extractionError` exists to carry a reason; the size skip used to leave it undefined.
			expect(meta?.extractionError).toBeDefined();
			expect(meta?.extractionError).toMatch(/capped at 32 MB/);
			expect(meta?.extractionError).toMatch(/40 MB/);
		});

		it("leaves extractionError alone for a file that is genuinely an unsupported format", async () => {
			const r2 = mockR2(1_000);
			await r2.put("agents/agent-1/files/z/thing.bin", "not text");
			const { engine } = engineWith({ r2 });
			const meta = await engine.fileRegister({ id: "z", name: "thing.bin", r2Key: "agents/agent-1/files/z/thing.bin", mimeType: "application/octet-stream" });
			expect(meta?.extractionStatus).toBe("unsupported");
			// A format skip must not acquire a size reason it does not have.
			expect(String(meta?.extractionError ?? "")).not.toMatch(/capped at/);
		});
	});
});
