import { afterEach, describe, expect, it, vi } from "vitest";
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

function mockRuntimeEnv() {
	const first = vi.fn(async () => ({
		endpoint_url: "https://runner.example.test",
		token_plaintext: "runner-token",
		token_ciphertext: null,
		token_dek_wrapped: null,
		token_iv: null,
	}));
	const bind = vi.fn(() => ({ first, run: vi.fn(async () => ({})), all: vi.fn(async () => ({ results: [] })) }));
	const prepare = vi.fn(() => ({ bind }));
	const create = vi.fn(async () => ({ id: "wf_123" }));
	return {
		env: { DB: { prepare } as unknown as D1Database, JOB_APPLY: { create }, SESSION_SIGNING_KEY: "test-secret" } as unknown as { DB: D1Database },
		prepare,
		bind,
		first,
		create,
	};
}

describe("storage tools", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

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

	it("allows missing required fields (soft for AI tools)", async () => {
		const engine = makeEngine();
		await engine.collectionCreate("strict", [{ name: "title", type: "string", required: true }]);

		const result = await executeStorageTool(
			{ name: "insert_record", input: { collection: "strict", data: JSON.stringify({}) } },
			engine,
		);
		// Required is soft — succeeds, field just omitted
		expect(result.success).toBe(true);
	});

	it("creates job application task with caller-provided candidate details", async () => {
		const engine = makeEngine();
		const runtime = mockRuntimeEnv();
		const fetchMock = vi.fn(async () => new Response(
			JSON.stringify({ id: "task_123", status: "needs_approval" }),
			{ status: 200, headers: { "content-type": "application/json" } },
		));
		vi.stubGlobal("fetch", fetchMock);

		const result = await executeStorageTool(
			{
				name: "submit_job_application",
				input: {
					url: "https://example.com/jobs/1",
					resume_path: "/tmp/test-candidate-resume.pdf",
					full_name: "Test Candidate",
					email: "candidate@example.com",
					phone: "+1 555 0100",
					location: "Test City",
					linkedin: "https://linkedin.example/test-candidate",
					work_authorization: "Authorized to work",
					cover_note: "Interested in the role.",
				},
			},
			engine,
			{ env: runtime.env, agentId: "instance-1", userId: "user-1" },
		);

		// New behavior: starts the LLM-driven JobApplyWorkflow (no legacy selector task).
		expect(result.success).toBe(true);
		expect(result.content).toContain("Application started");
		expect(result.content).toContain("task_123"); // runner task id
		expect(runtime.create).toHaveBeenCalledTimes(1); // JOB_APPLY.create — the brain started
		// It creates the agent-driven task (job.apply_agent), not a legacy approval task.
		expect(fetchMock).toHaveBeenCalledWith("https://runner.example.test/tasks", expect.any(Object));
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(String(init.body));
		expect(body.type).toBe("job.apply_agent");
		expect(body.input.url).toBe("https://example.com/jobs/1");
	});

	it("does not create job application task without local resume path", async () => {
		const engine = makeEngine();
		const runtime = mockRuntimeEnv();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await executeStorageTool(
			{
				name: "submit_job_application",
				input: {
					url: "https://example.com/jobs/1",
					full_name: "Test Candidate",
					email: "candidate@example.com",
				},
			},
			engine,
			{ env: runtime.env, agentId: "instance-1", userId: "user-1" },
		);

		expect(result.success).toBe(false);
		expect(result.content).toContain("resume_path required");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("knowledge base edit tools (editable via chat)", () => {
	it("add → list → read → update → delete round-trips through the engine", async () => {
		const engine = makeEngine();

		const add = await executeStorageTool({ name: "add_knowledge", input: { title: "Resume", content: "Senior PM, 20 years" } }, engine);
		expect(add.success).toBe(true);
		const id = add.content.match(/id (\S+)\)/)?.[1];
		expect(id).toBeTruthy();

		const list = await executeStorageTool({ name: "list_knowledge", input: {} }, engine);
		expect(list.content).toContain("Resume");

		const read = await executeStorageTool({ name: "read_knowledge", input: { id } }, engine);
		expect(read.content).toContain("Senior PM");

		const upd = await executeStorageTool({ name: "update_knowledge", input: { id, content: "Senior PM, 21 years, AWS" } }, engine);
		expect(upd.success).toBe(true);
		const read2 = await executeStorageTool({ name: "read_knowledge", input: { id } }, engine);
		expect(read2.content).toContain("21 years");

		const del = await executeStorageTool({ name: "delete_knowledge", input: { id } }, engine);
		expect(del.success).toBe(true);
		const list2 = await executeStorageTool({ name: "list_knowledge", input: {} }, engine);
		expect(list2.content).toMatch(/empty/i);
	});

	it("fails clearly on missing id and unknown document", async () => {
		const engine = makeEngine();
		expect((await executeStorageTool({ name: "read_knowledge", input: {} }, engine)).success).toBe(false);
		const d = await executeStorageTool({ name: "delete_knowledge", input: { id: "nope" } }, engine);
		expect(d.success).toBe(false);
		expect(d.content).toMatch(/No knowledge document/i);
	});
});
