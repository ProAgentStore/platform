import { describe, expect, it, vi } from "vitest";
import { executeStorageTool } from "./storage-tools.js";
import { AgentStorageEngine } from "../agent-storage.js";

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
		list: vi.fn(async <T>(opts?: { prefix?: string; reverse?: boolean; limit?: number }) => {
			let entries = [...store.entries()]
				.filter(([k]) => !opts?.prefix || k.startsWith(opts.prefix));
			if (opts?.reverse) entries.reverse();
			if (opts?.limit) entries = entries.slice(0, opts.limit);
			return new Map(entries) as Map<string, T>;
		}),
	} as unknown as DurableObjectStorage;
}

function makeEngine() {
	return new AgentStorageEngine(mockDoStorage(), null, null, null, "test-agent");
}

describe("storage tools", () => {
	it("create_collection + insert_record + query_records round-trip", async () => {
		const engine = makeEngine();

		const createResult = await executeStorageTool(
			{ name: "create_collection", input: { name: "jobs", fields: JSON.stringify([
				{ name: "company", type: "string", required: true, indexed: true },
				{ name: "role", type: "string" },
				{ name: "status", type: "string", indexed: true },
			]) } },
			engine,
		);
		expect(createResult.success).toBe(true);
		expect(createResult.content).toContain("jobs");

		const insertResult = await executeStorageTool(
			{ name: "insert_record", input: { collection: "jobs", data: JSON.stringify({ company: "Acme", role: "PM", status: "queued" }) } },
			engine,
		);
		expect(insertResult.success).toBe(true);
		expect(insertResult.content).toContain("inserted");

		const queryResult = await executeStorageTool(
			{ name: "query_records", input: { collection: "jobs" } },
			engine,
		);
		expect(queryResult.success).toBe(true);
		const parsed = JSON.parse(queryResult.content);
		expect(parsed.total).toBe(1);
		expect(parsed.records[0].data.company).toBe("Acme");
	});

	it("list_collections shows created collections", async () => {
		const engine = makeEngine();
		await engine.collectionCreate("tasks", [{ name: "title", type: "string" }]);
		await engine.collectionCreate("notes", [{ name: "body", type: "string" }]);

		const result = await executeStorageTool({ name: "list_collections", input: {} }, engine);
		expect(result.success).toBe(true);
		expect(result.content).toContain("tasks");
		expect(result.content).toContain("notes");
	});

	it("update_record modifies existing data", async () => {
		const engine = makeEngine();
		await engine.collectionCreate("items", [{ name: "name", type: "string" }]);
		const rec = await engine.recordInsert("items", { name: "old" });

		const result = await executeStorageTool(
			{ name: "update_record", input: { collection: "items", id: rec.id, data: JSON.stringify({ name: "new" }) } },
			engine,
		);
		expect(result.success).toBe(true);

		const updated = await engine.recordGet("items", rec.id);
		expect(updated?.data.name).toBe("new");
	});

	it("delete_record removes the record", async () => {
		const engine = makeEngine();
		await engine.collectionCreate("items", [{ name: "x", type: "string" }]);
		const rec = await engine.recordInsert("items", { x: "1" });

		const result = await executeStorageTool(
			{ name: "delete_record", input: { collection: "items", id: rec.id } },
			engine,
		);
		expect(result.success).toBe(true);

		const gone = await engine.recordGet("items", rec.id);
		expect(gone).toBeNull();
	});

	it("upload_file fails without R2", async () => {
		const engine = makeEngine();
		const result = await executeStorageTool(
			{ name: "upload_file", input: { name: "test.txt", content: "hello" } },
			engine,
		);
		expect(result.success).toBe(false);
		expect(result.content).toContain("R2");
	});

	it("search_knowledge returns empty without vectorize", async () => {
		const engine = makeEngine();
		const result = await executeStorageTool(
			{ name: "search_knowledge", input: { query: "test" } },
			engine,
		);
		expect(result.success).toBe(true);
		expect(result.content).toContain("No relevant results");
	});

	it("get_activity returns events", async () => {
		const engine = makeEngine();
		await engine.logEvent("chat.message", "user-1", { test: true });

		const result = await executeStorageTool({ name: "get_activity", input: {} }, engine);
		expect(result.success).toBe(true);
		expect(result.content).toContain("chat.message");
	});

	it("get_user_context + set_user_preference round-trip", async () => {
		const engine = makeEngine();

		const setResult = await executeStorageTool(
			{ name: "set_user_preference", input: { user_id: "u1", key: "tz", value: "UTC" } },
			engine,
		);
		expect(setResult.success).toBe(true);

		const getResult = await executeStorageTool(
			{ name: "get_user_context", input: { user_id: "u1" } },
			engine,
		);
		expect(getResult.success).toBe(true);
		const ctx = JSON.parse(getResult.content);
		expect(ctx.preferences.tz).toBe("UTC");
	});

	it("rejects unknown tool names", async () => {
		const engine = makeEngine();
		const result = await executeStorageTool({ name: "nonexistent", input: {} }, engine);
		expect(result.success).toBe(false);
	});

	it("validates required fields on insert", async () => {
		const engine = makeEngine();
		await engine.collectionCreate("strict", [{ name: "title", type: "string", required: true }]);

		const result = await executeStorageTool(
			{ name: "insert_record", input: { collection: "strict", data: JSON.stringify({}) } },
			engine,
		);
		expect(result.success).toBe(false);
		expect(result.content).toContain("required");
	});
});
