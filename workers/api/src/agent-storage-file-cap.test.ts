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

/**
 * D1 double: records every prepared statement with its bind args, so a test can assert WHAT reached
 * `error_log` rather than that "something was logged".
 *
 * `resolveMeterIds` reads `first()` on `agent_instances` (answered as "no row" → this DO is a
 * template and its own name IS the agent id), `logError` collapses via an UPDATE whose
 * `meta.changes` of 0 falls through to the INSERT, and its 2% retention prune runs UNBOUND — so
 * `run` exists on the statement itself as well as after `bind`.
 */
function mockDb() {
	const calls: Array<{ sql: string; args: unknown[] }> = [];
	const db = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						calls.push({ sql, args });
						return { run: async () => ({ meta: { changes: 0 } }), first: async () => null };
					},
					run: async () => ({ meta: { changes: 0 } }),
				};
			},
		},
	};
	return { db, calls, errorRows: () => calls.filter((c) => c.sql.includes("INSERT INTO error_log")) };
}

function engineWith(opts: { r2?: ReturnType<typeof mockR2>; ai?: unknown; vectorize?: unknown; db?: unknown } = {}) {
	const storage = mockDoStorage();
	const r2 = opts.r2 ?? mockR2();
	const engine = new AgentStorageEngine(storage as never, r2 as never, (opts.vectorize ?? null) as never, (opts.ai ?? null) as never, "agent-1", (opts.db ?? null) as never);
	return { engine, storage, r2 };
}

/** Positions of the `error_log` INSERT binds, in schema order. */
const ERR = { userId: 1, source: 2, status: 3, message: 4, context: 5 } as const;

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

		it("is false when vectorization threw — previously only a non-persisted console line", async () => {
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

		// The METADATA arm of the pair asserted below. Nothing pinned it on its own before: a change
		// that dropped `vectorized: false` while keeping the log would still leave the file claiming
		// to `list_instance_files` that it is searchable.
		it("writes `vectorized: false` even when there is no durable log to write to", async () => {
			const brokenAi = { run: async () => { throw new Error("AI provider 500"); } };
			const { engine, storage } = engineWith({ ai: brokenAi, vectorize: vectorizeOk(), db: null });
			const meta = await engine.fileUpload({ name: "note.txt", mimeType: "text/plain", data: "hello ".repeat(200) });
			expect(meta.vectorized).toBe(false);
			expect((storage._m.get(`file:${meta.id}`) as FileMeta).vectorized).toBe(false);
		});
	});

	/**
	 * #637, surviving arm — the state was durable and unfindable.
	 *
	 * `vectorized: false` says of ONE file that it is not searchable, and you only read it if you
	 * already suspect that file. `list_errors` and the admin Errors tile are where an operator
	 * actually looks, and a Worker console reaches neither. Both assertions are made together on
	 * purpose: the metadata without the row is the bug being closed, and the row without the
	 * metadata would be a file that reports itself as indexed.
	 */
	describe("the failure reaches the durable error log, on both upload paths", () => {
		const brokenAi = () => ({ run: async () => { throw new Error("AI provider 500"); } });

		it("fileUpload writes an error_log row naming the file and the agent", async () => {
			const { db, errorRows } = mockDb();
			const { engine, storage } = engineWith({ ai: brokenAi(), vectorize: vectorizeOk(), db });
			const meta = await engine.fileUpload({ name: "note.txt", mimeType: "text/plain", data: "hello ".repeat(200), userId: "u-1" });

			// Both arms of the pair, in one test.
			expect(meta.vectorized).toBe(false);
			expect((storage._m.get(`file:${meta.id}`) as FileMeta).vectorized).toBe(false);

			const rows = errorRows();
			expect(rows.length).toBe(1);
			const args = rows[0].args;
			expect(args[ERR.source]).toBe("storage");
			expect(args[ERR.userId]).toBe("u-1");
			expect(String(args[ERR.message])).toContain(meta.id);
			// The reason survives, not just the fact — and it is vectorizeStore's OWN aggregate
			// ("3/3 chunks could not be embedded"), which is the sentence that says how much of the
			// file is missing, not the raw provider string one chunk happened to throw.
			expect(String(args[ERR.message])).toContain("chunks could not be embedded");
			// AC2: actionable without a second lookup.
			const ctx = JSON.parse(String(args[ERR.context]));
			expect(ctx.fileId).toBe(meta.id);
			expect(ctx.name).toBe("note.txt");
			expect(ctx.agentId).toBe("agent-1");
			expect(ctx.phase).toBe("upload");
		});

		it("fileRegister — the resumable multipart path — writes the same row", async () => {
			const { db, errorRows } = mockDb();
			const r2 = mockR2(2_000);
			await r2.put("agents/agent-1/files/m/notes.txt", "hello ".repeat(200));
			const { engine, storage } = engineWith({ r2, ai: brokenAi(), vectorize: vectorizeOk(), db });
			const meta = await engine.fileRegister({ id: "m", name: "notes.txt", r2Key: "agents/agent-1/files/m/notes.txt", mimeType: "text/plain", userId: "u-2" });

			expect(meta?.vectorized).toBe(false);
			expect((storage._m.get("file:m") as FileMeta).vectorized).toBe(false);

			const rows = errorRows();
			expect(rows.length).toBe(1);
			expect(rows[0].args[ERR.source]).toBe("storage");
			expect(String(rows[0].args[ERR.message])).toContain("chunks could not be embedded");
			const ctx = JSON.parse(String(rows[0].args[ERR.context]));
			expect(ctx.fileId).toBe("m");
			expect(ctx.phase).toBe("register");
		});

		it("stays quiet when the file really was indexed", async () => {
			const { db, errorRows } = mockDb();
			const { engine } = engineWith({ ai: workingAi(), vectorize: vectorizeOk(), db });
			const meta = await engine.fileUpload({ name: "note.txt", mimeType: "text/plain", data: "hello ".repeat(200) });
			expect(meta.vectorized).toBe(true);
			expect(errorRows().length).toBe(0);
		});

		// Indexing being OFF is a configuration, not a failure — `vectorizeStore` no-ops without
		// throwing (#22). Logging it would file a row on every upload of an install that has
		// indexing disabled, which is how an error log stops being read at all.
		it("stays quiet when indexing is off, which is not a failure", async () => {
			const { db, errorRows } = mockDb();
			const { engine } = engineWith({ db });
			const meta = await engine.fileUpload({ name: "note.txt", mimeType: "text/plain", data: "hello ".repeat(200) });
			expect(meta.vectorized).toBe(false);
			expect(errorRows().length).toBe(0);
		});

		// The bytes are already committed to R2. A logger that throws must not turn a completed
		// upload into a 500 — that would make the observability fix worse than the silence.
		it("a D1 that throws does not fail the upload", async () => {
			// `logError`'s own last resort writes `[error-log] failed to persist` to the console when
			// its INSERT throws. That is correct, and it is the one line this suite emits that would
			// read as a failure in a CI log — silenced here, asserted rather than suppressed.
			const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
			const exploding = { DB: { prepare() { throw new Error("D1 unavailable"); } } };
			const { engine, storage } = engineWith({ ai: brokenAi(), vectorize: vectorizeOk(), db: exploding });
			const meta = await engine.fileUpload({ name: "note.txt", mimeType: "text/plain", data: "hello ".repeat(200) });
			expect(meta.vectorized).toBe(false);
			expect((storage._m.get(`file:${meta.id}`) as FileMeta).vectorized).toBe(false);
			expect(quiet).toHaveBeenCalled();
			quiet.mockRestore();
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
