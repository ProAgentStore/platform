import { describe, expect, it, vi } from "vitest";
import { AgentStorageEngine } from "./agent-storage.js";

/** Minimal DO storage mock. */
function mockDoStorage() {
	const store = new Map<string, unknown>();
	return {
		get: vi.fn(async <T>(key: string) => (store.get(key) as T) ?? null),
		put: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
		delete: vi.fn(async (keyOrKeys: string | string[]) => {
			const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
			for (const k of keys) store.delete(k);
			return keys.length > 0;
		}),
		list: vi.fn(async <T>(opts?: { prefix?: string; reverse?: boolean; limit?: number; startAfter?: string }) => {
			let entries = [...store.entries()]
				.filter(([k]) => !opts?.prefix || k.startsWith(opts.prefix))
				.filter(([k]) => !opts?.startAfter || k > opts.startAfter);
			if (opts?.reverse) entries.reverse();
			if (opts?.limit) entries = entries.slice(0, opts.limit);
			return new Map(entries) as Map<string, T>;
		}),
	} as unknown as DurableObjectStorage;
}

describe("AgentStorageEngine", () => {
	describe("collections", () => {
		it("creates a collection with schema and inserts/queries records", async () => {
			const storage = mockDoStorage();
			const engine = new AgentStorageEngine(storage, null, null, null, "agent-1");

			const schema = await engine.collectionCreate("candidates", [
				{ name: "name", type: "string", required: true, indexed: true },
				{ name: "email", type: "string", required: true, indexed: true },
				{ name: "score", type: "number" },
				{ name: "applied_at", type: "date" },
			]);

			expect(schema.name).toBe("candidates");
			expect(schema.fields).toHaveLength(4);
			expect(schema.recordCount).toBe(0);

			// Insert records
			const r1 = await engine.recordInsert("candidates", {
				name: "Alice",
				email: "alice@example.com",
				score: 85,
				applied_at: "2026-06-20T00:00:00Z",
			});
			expect(r1.id).toBeDefined();
			expect(r1.data.name).toBe("Alice");

			const r2 = await engine.recordInsert("candidates", {
				name: "Bob",
				email: "bob@example.com",
				score: 92,
			});

			// Query all
			const all = await engine.recordQuery("candidates");
			expect(all.total).toBe(2);
			expect(all.records).toHaveLength(2);

			// Query with filter
			const filtered = await engine.recordQuery("candidates", {
				where: { name: "Alice" },
			});
			expect(filtered.total).toBe(1);
			expect(filtered.records[0].data.email).toBe("alice@example.com");

			// Update
			const updated = await engine.recordUpdate("candidates", r1.id, { score: 90 });
			expect(updated?.data.score).toBe(90);
			expect(updated?.data.name).toBe("Alice");

			// Delete
			const deleted = await engine.recordDelete("candidates", r2.id);
			expect(deleted).toBe(true);

			const afterDelete = await engine.recordQuery("candidates");
			expect(afterDelete.total).toBe(1);
		});

		it("rejects duplicate collection names", async () => {
			const storage = mockDoStorage();
			const engine = new AgentStorageEngine(storage, null, null, null, "agent-1");

			await engine.collectionCreate("items", [{ name: "title", type: "string" }]);
			await expect(engine.collectionCreate("items", [])).rejects.toThrow("already exists");
		});

		it("allows missing required fields (soft validation for AI tools)", async () => {
			const storage = mockDoStorage();
			const engine = new AgentStorageEngine(storage, null, null, null, "agent-1");

			await engine.collectionCreate("tasks", [
				{ name: "title", type: "string", required: true },
			]);

			// Required is soft — insert succeeds, field just omitted
			const record = await engine.recordInsert("tasks", {});
			expect(record.id).toBeDefined();
			expect(record.data.title).toBeUndefined();
		});

		it("enforces unique constraints", async () => {
			const storage = mockDoStorage();
			const engine = new AgentStorageEngine(storage, null, null, null, "agent-1");

			await engine.collectionCreate("users", [
				{ name: "email", type: "string", required: true, unique: true, indexed: true },
				{ name: "name", type: "string" },
			]);

			await engine.recordInsert("users", { email: "alice@example.com", name: "Alice" });
			await expect(
				engine.recordInsert("users", { email: "alice@example.com", name: "Alice 2" }),
			).rejects.toThrow("Duplicate value for unique field");

			// Different email should work
			const bob = await engine.recordInsert("users", { email: "bob@example.com", name: "Bob" });
			expect(bob.data.email).toBe("bob@example.com");
		});

		it("handles index values with colons correctly", async () => {
			const storage = mockDoStorage();
			const engine = new AgentStorageEngine(storage, null, null, null, "agent-1");

			await engine.collectionCreate("events", [
				{ name: "timestamp", type: "string", indexed: true },
				{ name: "title", type: "string" },
			]);

			await engine.recordInsert("events", {
				timestamp: "2026-06-22T10:00:00Z",
				title: "Meeting",
			});

			const result = await engine.recordQuery("events", {
				where: { timestamp: "2026-06-22T10:00:00Z" },
			});
			expect(result.total).toBe(1);
			expect(result.records[0].data.title).toBe("Meeting");
		});
	});

	describe("file storage (no R2)", () => {
		it("returns error when R2 is not available", async () => {
			const storage = mockDoStorage();
			const engine = new AgentStorageEngine(storage, null, null, null, "agent-1");

			await expect(
				engine.fileUpload({ name: "test.txt", mimeType: "text/plain", data: "hello" }),
			).rejects.toThrow("R2 storage not available");
		});
	});

	describe("activity log", () => {
		it("logs and retrieves events", async () => {
			const storage = mockDoStorage();
			const engine = new AgentStorageEngine(storage, null, null, null, "agent-1");

			await engine.logEvent("chat.message", "user-1", { messageId: "msg-1" });
			await engine.logEvent("tool.called", "user-1", { tool: "search_knowledge" });
			await engine.logEvent("file.uploaded", undefined, { fileId: "f-1" });

			const events = await engine.getEvents();
			expect(events).toHaveLength(3);
			expect(events[0].type).toBe("file.uploaded");

			const filtered = await engine.getEvents({ type: "chat.message" });
			expect(filtered).toHaveLength(1);
			expect(filtered[0].userId).toBe("user-1");
		});
	});

	describe("user context", () => {
		it("creates and updates user context", async () => {
			const storage = mockDoStorage();
			const engine = new AgentStorageEngine(storage, null, null, null, "agent-1");

			const ctx = await engine.getUserContext("user-1");
			expect(ctx.userId).toBe("user-1");
			expect(ctx.messageCount).toBe(0);

			await engine.touchUserContext("user-1");
			const updated = await engine.getUserContext("user-1");
			expect(updated.messageCount).toBe(1);

			await engine.setUserPreference("user-1", "timezone", "US/Pacific");
			const withPref = await engine.getUserContext("user-1");
			expect(withPref.preferences.timezone).toBe("US/Pacific");
		});
	});

	describe("vector search (no Vectorize)", () => {
		it("returns empty results when Vectorize is not available", async () => {
			const storage = mockDoStorage();
			const engine = new AgentStorageEngine(storage, null, null, null, "agent-1");

			const results = await engine.vectorSearch("test query");
			expect(results).toEqual([]);
		});

		it("vectorizeStore returns empty when not available", async () => {
			const storage = mockDoStorage();
			const engine = new AgentStorageEngine(storage, null, null, null, "agent-1");

			const ids = await engine.vectorizeStore("knowledge", "doc-1", "Hello world");
			expect(ids).toEqual([]);
		});
	});

	describe("conversation summarization (no AI)", () => {
		it("returns null when AI is not available", async () => {
			const storage = mockDoStorage();
			const engine = new AgentStorageEngine(storage, null, null, null, "agent-1");

			const summary = await engine.maybeSummarize("@cf/meta/llama-3.2-3b-instruct");
			expect(summary).toBeNull();
		});
	});

	describe("RAG context builder", () => {
		it("returns empty string when no vectorize or summaries", async () => {
			const storage = mockDoStorage();
			const engine = new AgentStorageEngine(storage, null, null, null, "agent-1");

			const context = await engine.buildRAGContext("What is TypeScript?");
			expect(context).toBe("");
		});
	});
});
