/**
 * get_console_link forwards exactly the target it was given and returns the API's link (#938).
 * The link itself is built and checked API-side (`lib/console-deep-link.ts`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
// Test-only import: the MCP worker cannot import workers/api at runtime (workers/mcp/CLAUDE.md), a test can.
import { CONSOLE_SECTIONS } from "../../../api/src/lib/console-deep-link.js";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerConsoleLinkTools } from "./console-link.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function getConsoleLink(answer: { status: number; body: unknown }) {
	const seen: string[] = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		seen.push(String(input));
		return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } });
	});
	const handlers = new Map<string, Handler>();
	const env: McpEnv = { API_BASE: "https://api.test" };
	registerConsoleLinkTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) } as never, {
		env,
		tokenFor: (p?: string) => p || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read"] }),
		groups: new Set(),
	});
	return { seen, call: (args: Record<string, unknown>) => (handlers.get("get_console_link") as Handler)(args).then((r) => r.content[0].text) };
}

afterEach(() => vi.unstubAllGlobals());

describe("get_console_link (#938)", () => {
	it("asks for the instance alone when given no target, and returns url, path and lands", async () => {
		const link = { url: "https://proagentstore.online/console/instances/i1", path: "/console/instances/i1", lands: "the instance" };
		const { seen, call } = getConsoleLink({ status: 200, body: link });
		expect(JSON.parse(await call({ instance_id: "i1" }))).toEqual(link);
		expect(seen).toEqual(["https://api.test/v1/instances/i1/console-link"]);
	});

	it("passes only the targets given, as query parameters", async () => {
		const { seen, call } = getConsoleLink({ status: 200, body: { url: "u", path: "p", lands: "l" } });
		await call({ instance_id: "i1", run_id: "run 1" });
		expect(seen[0]).toBe("https://api.test/v1/instances/i1/console-link?run_id=run+1");
	});

	it("forwards an exact permission request only through the verified API target", async () => {
		const { seen, call } = getConsoleLink({ status: 200, body: { url: "u", path: "p", lands: "Permissions & Connections" } });
		await call({ instance_id: "i1", permission_request_id: "pr 1" });
		expect(seen[0]).toBe("https://api.test/v1/instances/i1/console-link?permission_request_id=pr+1");
	});

	it("forwards section=permissions to the console-link route", async () => {
		const link = { url: "https://proagentstore.online/console/instances/i1/permissions", path: "/console/instances/i1/permissions", lands: "the Permissions tab" };
		const { seen, call } = getConsoleLink({ status: 200, body: link });
		expect(JSON.parse(await call({ instance_id: "i1", section: "permissions" }))).toEqual(link);
		expect(seen).toEqual(["https://api.test/v1/instances/i1/console-link?section=permissions"]);
	});

	it("returns the API-verified Files uploader link through the read-only console-link tool", async () => {
		const link = {
			url: "https://proagentstore.online/console/instances/i1/knowledge?subtab=files",
			path: "/console/instances/i1/knowledge?subtab=files",
			lands: "the Knowledge Files tab, ready to upload a file",
		};
		const { seen, call } = getConsoleLink({ status: 200, body: link });
		expect(JSON.parse(await call({ instance_id: "i1", target: "files-upload" }))).toEqual(link);
		expect(seen).toEqual(["https://api.test/v1/instances/i1/console-link?target=files-upload"]);
		expect(link.url).not.toMatch(/token|session|credential/i);
	});

	it("reports the API's refusal as an error rather than a link", async () => {
		const { call } = getConsoleLink({ status: 400, body: { error: "This instance does not show the Coding tab" } });
		expect(await call({ instance_id: "i1", section: "coding" })).toMatch(/^Error: This instance does not show the Coding tab/);
	});
});

describe("get_console_link section description", () => {
	it("lists exactly the ids in CONSOLE_SECTIONS, read from the registered tool schema", () => {
		let schema: Record<string, { description?: string }> | undefined;
		const env: McpEnv = { API_BASE: "https://api.test" };
		registerConsoleLinkTools(
			{
				tool: (name: string, _d: string, s: Record<string, { description?: string }>) => {
					if (name === "get_console_link") schema = s;
				},
			} as never,
			{ env, tokenFor: () => "t", safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read"] }), groups: new Set() },
		);
		const description = schema?.section?.description ?? "";
		expect(description).not.toBe("");
		const listed = description.replace(/^[^:]*:\s*/, "").replace(/\.$/, "").split(/,\s*|\s+or\s+/).filter(Boolean);
		expect(listed.sort()).toEqual(CONSOLE_SECTIONS.map((s) => s.id).sort());
	});
});

describe("list_instance_permission_requests (#1009)", () => {
	function listTool(answer: { status: number; body: unknown }) {
		const seen: Array<{ url: string; method: string }> = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(input), method: init?.method ?? "GET" });
			return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } });
		});
		const handlers = new Map<string, Handler>();
		const env: McpEnv = { API_BASE: "https://api.test" };
		registerConsoleLinkTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) } as never, {
			env,
			tokenFor: (p?: string) => p || "session-token",
			safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read"] }),
			groups: new Set(),
		});
		return { seen, call: (args: Record<string, unknown>) => (handlers.get("list_instance_permission_requests") as Handler)(args).then((r) => r.content[0].text) };
	}

	it("reads the owner's requests with one GET and returns each verified link and blocker as the API gave them", async () => {
		const body = { requests: [{ id: "pr-1", status: "pending", control: "connector_consent", link: "/console/instances/i1/permissions?focus=permissions&permission_request=pr-1", blocker: { requestId: "pr-1", remedy: "…Opening the link grants nothing…" } }] };
		const { seen, call } = listTool({ status: 200, body });
		expect(JSON.parse(await call({ instance_id: "i 1" }))).toEqual(body);
		expect(seen).toEqual([{ url: "https://api.test/v1/instances/i%201/permission-requests", method: "GET" }]);
	});

	it("reports a refusal as an error, never as an empty list", async () => {
		const { call } = listTool({ status: 404, body: { error: "Instance not found" } });
		expect(await call({ instance_id: "theirs" })).toMatch(/^Error: /);
	});
});
