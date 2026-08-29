import { beforeEach, describe, expect, it, vi } from "vitest";

// Record every authedCall so we can assert the instance-scoped tools hit the
// right REST route + method (the tools are thin proxies over the API).
const calls: Array<{ path: string; token: string; opts?: RequestInit }> = [];

vi.mock("./http.js", async () => {
	const actual = await vi.importActual<typeof import("./http.js")>("./http.js");
	return {
		...actual,
		authedCall: vi.fn(async (path: string, token: string, opts?: RequestInit) => {
			calls.push({ path, token, opts });
			return { ok: true };
		}),
	};
});

// Control the permission gate: default allow; flip `deny` to simulate a
// missing scope / read-only mode.
const gate = { deny: false };
vi.mock("./safety.js", () => ({
	requirePermission: vi.fn(async (_ctx: unknown, scope: string, name: string) =>
		gate.deny ? { content: [{ type: "text", text: `denied ${scope} ${name}` }] } : undefined,
	),
	audit: vi.fn(async () => {}),
}));

import { registerStorageTools } from "./storage-tools.js";
import { requirePermission } from "./safety.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

function collectTools(): Map<string, { scopes: Record<string, unknown>; handler: Handler }> {
	const tools = new Map<string, { scopes: Record<string, unknown>; handler: Handler }>();
	const fakeServer = {
		tool(name: string, _desc: string, scopes: Record<string, unknown>, handler: Handler) {
			tools.set(name, { scopes, handler });
		},
	};
	registerStorageTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake server for handler capture
		fakeServer as any,
		{} as never,
		() => "session-token",
		() => ({}) as never,
	);
	return tools;
}

describe("instance-scoped collection tools", () => {
	beforeEach(() => {
		calls.length = 0;
		gate.deny = false;
		vi.mocked(requirePermission).mockClear();
	});

	it("registers the three instance collection tools", () => {
		const tools = collectTools();
		expect(tools.has("list_instance_collections")).toBe(true);
		expect(tools.has("query_instance_records")).toBe(true);
		expect(tools.has("insert_instance_record")).toBe(true);
	});

	it("list_instance_collections GETs the instance collections route (read scope)", async () => {
		const tools = collectTools();
		await tools.get("list_instance_collections")!.handler({ instance_id: "inst-1" });
		expect(requirePermission).toHaveBeenCalledWith(
			expect.anything(),
			"read",
			"list_instance_collections",
			{ instance_id: "inst-1" },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe("/v1/instances/inst-1/collections");
		expect(calls[0].opts).toEqual({});
	});

	it("query_instance_records builds query params on the records route (read scope)", async () => {
		const tools = collectTools();
		await tools.get("query_instance_records")!.handler({
			instance_id: "inst-1",
			collection: "leads",
			where: '{"status":"new"}',
			order_by: "created_at",
			limit: 25,
		});
		expect(requirePermission).toHaveBeenCalledWith(
			expect.anything(),
			"read",
			"query_instance_records",
			{ instance_id: "inst-1", collection: "leads" },
		);
		expect(calls).toHaveLength(1);
		const url = new URL(`https://x${calls[0].path}`);
		expect(url.pathname).toBe("/v1/instances/inst-1/collections/leads/records");
		expect(url.searchParams.get("where")).toBe('{"status":"new"}');
		expect(url.searchParams.get("order_by")).toBe("created_at");
		expect(url.searchParams.get("limit")).toBe("25");
	});

	it("insert_instance_record POSTs {data} to the records route (write scope)", async () => {
		const tools = collectTools();
		await tools.get("insert_instance_record")!.handler({
			instance_id: "inst-1",
			collection: "leads",
			data: '{"email":"a@b.com"}',
		});
		expect(requirePermission).toHaveBeenCalledWith(
			expect.anything(),
			"write",
			"insert_instance_record",
			{ instance_id: "inst-1", collection: "leads" },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe("/v1/instances/inst-1/collections/leads/records");
		expect(calls[0].opts?.method).toBe("POST");
		expect(JSON.parse(calls[0].opts?.body as string)).toEqual({ data: { email: "a@b.com" } });
	});

	it("insert_instance_record rejects invalid JSON without calling the API", async () => {
		const tools = collectTools();
		const res = await tools.get("insert_instance_record")!.handler({
			instance_id: "inst-1",
			collection: "leads",
			data: "not json",
		});
		expect(res.content[0].text).toBe("Invalid data JSON");
		expect(calls).toHaveLength(0);
	});

	it("blocks the write tool when the scope gate denies it", async () => {
		gate.deny = true;
		const tools = collectTools();
		const res = await tools.get("insert_instance_record")!.handler({
			instance_id: "inst-1",
			collection: "leads",
			data: '{"email":"a@b.com"}',
		});
		expect(res.content[0].text).toContain("denied write insert_instance_record");
		expect(calls).toHaveLength(0);
	});
});

describe("upload_agent_file base64 support", () => {
	beforeEach(() => {
		calls.length = 0;
		gate.deny = false;
		vi.mocked(requirePermission).mockClear();
	});

	it("upload_agent_file passes contentBase64 through to the API route", async () => {
		const tools = collectTools();
		await tools.get("upload_agent_file")!.handler({
			agent_id: "agent-1",
			name: "form.docx",
			content_base64: "aGVsbG8=",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe("/v1/agents/agent-1/files");
		const body = JSON.parse(calls[0].opts?.body as string);
		expect(body.contentBase64).toBe("aGVsbG8=");
		expect(body.content).toBeUndefined();
	});

	it("upload_agent_file passes content through to the API route (text path unchanged)", async () => {
		const tools = collectTools();
		await tools.get("upload_agent_file")!.handler({
			agent_id: "agent-1",
			name: "notes.txt",
			content: "hello world",
		});
		expect(calls).toHaveLength(1);
		const body = JSON.parse(calls[0].opts?.body as string);
		expect(body.content).toBe("hello world");
		expect(body.contentBase64).toBeUndefined();
	});

	it("upload_agent_file rejects when both content and content_base64 are provided", async () => {
		const tools = collectTools();
		const res = await tools.get("upload_agent_file")!.handler({
			agent_id: "agent-1",
			name: "test.txt",
			content: "hello",
			content_base64: "aGVsbG8=",
		});
		expect(res.content[0].text).toContain("not both");
		expect(calls).toHaveLength(0);
	});

	it("upload_agent_file rejects when neither content nor content_base64 is provided", async () => {
		const tools = collectTools();
		const res = await tools.get("upload_agent_file")!.handler({
			agent_id: "agent-1",
			name: "test.txt",
		});
		expect(res.content[0].text).toContain("content");
		expect(calls).toHaveLength(0);
	});
});
