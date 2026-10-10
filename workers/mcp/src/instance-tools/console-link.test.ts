/**
 * get_console_link forwards exactly the target it was given and returns the API's link (#938).
 * The link itself is built and checked API-side (`lib/console-deep-link.ts`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
