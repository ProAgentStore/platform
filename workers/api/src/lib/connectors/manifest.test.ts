import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the shared executor so we can assert exactly what request each compiled tool builds.
const { executeHttpRequest } = vi.hoisted(() => ({ executeHttpRequest: vi.fn() }));
vi.mock("./http.js", () => ({ executeHttpRequest }));

import { compileConnector, sanitizeConnectorManifest, type ConnectorManifest } from "./manifest.js";

const ctx = () => ({ env: {}, userId: "u1", instanceId: "i1", agentId: "i1" }) as never;

const SLACK: ConnectorManifest = {
	id: "slack",
	label: "Slack",
	auth: { type: "api-key", key: { in: "header", name: "Authorization" } },
	baseUrl: "https://slack.com/api",
	tools: [
		{
			name: "slack_post_message",
			description: "Post a message.",
			scope: "write",
			request: { method: "POST", path: "/chat.postMessage", body: { channel: "{{channel}}", text: "{{text}}" }, responseMap: "ts" },
			params: { channel: { type: "string", required: true }, text: { type: "string", required: true, maxLength: 10 } },
		},
		{
			name: "slack_list_channels",
			description: "List channels.",
			request: { method: "GET", path: "/conversations.list" },
		},
	],
};

beforeEach(() => {
	executeHttpRequest.mockReset();
	executeHttpRequest.mockResolvedValue({ content: "{}", success: true });
});

describe("compileConnector", () => {
	it("produces a Connector with mapped auth + scopes derived from its tools", () => {
		const { connector, tools } = compileConnector(SLACK);
		expect(connector.id).toBe("slack");
		expect(connector.auth).toBe("token"); // api-key → token
		expect(connector.grantModel).toBe("user");
		expect(connector.scopes).toEqual({ read: true, write: true }); // has both a read + a write tool
		expect(tools.map((t) => t.name)).toEqual(["slack_post_message", "slack_list_channels"]);
	});

	it("maps each auth type to the registry auth kind", () => {
		expect(compileConnector({ ...SLACK, auth: { type: "app" } }).connector.auth).toBe("app");
		expect(compileConnector({ ...SLACK, auth: { type: "oauth2", authUrl: "https://x/a", tokenUrl: "https://x/t" } }).connector.auth).toBe("oauth");
		expect(compileConnector({ ...SLACK, auth: { type: "none" } }).connector.auth).toBe("none");
	});

	it("stamps tier/connector/scope and builds the JSON schema from params", () => {
		const { tools } = compileConnector(SLACK);
		const post = tools[0];
		expect(post.tier).toBe("connector");
		expect(post.connector).toBe("slack");
		expect(post.scope).toBe("write");
		expect(post.jsonSchema.properties.channel).toEqual({ type: "string" });
		expect(post.jsonSchema.required).toEqual(["channel", "text"]);
		expect(tools[1].scope).toBe("read"); // default
	});

	it("tool handler feeds base+path+auth+inputs into the shared executor, scoped to this connector's key", async () => {
		const { tools } = compileConnector(SLACK);
		await tools[0].handler(ctx(), { channel: "C1", text: "hi" });
		expect(executeHttpRequest).toHaveBeenCalledTimes(1);
		const [, reqInput, opts] = executeHttpRequest.mock.calls[0];
		expect(reqInput).toMatchObject({
			method: "POST",
			base: "https://slack.com/api",
			path: "/chat.postMessage",
			responseMap: "ts",
			auth: { mode: "api-key", key: { in: "header", name: "Authorization" } },
			inputs: { channel: "C1", text: "hi" },
		});
		expect(opts).toEqual({ connectorId: "slack" }); // uses slack's OWN vault slot, not "http"
	});

	it("clamps a string arg to its declared maxLength before it hits the wire", async () => {
		const { tools } = compileConnector(SLACK);
		await tools[0].handler(ctx(), { channel: "C1", text: "0123456789ABCDEF" }); // maxLength 10
		const [, reqInput] = executeHttpRequest.mock.calls[0];
		expect((reqInput as { inputs: { text: string } }).inputs.text).toBe("0123456789");
	});

	it("app/oauth2 connectors send the minted token as bearer", async () => {
		const { tools } = compileConnector({ ...SLACK, auth: { type: "app" } });
		await tools[0].handler(ctx(), { channel: "C1", text: "hi" });
		const [, reqInput] = executeHttpRequest.mock.calls[0];
		expect((reqInput as { auth: unknown }).auth).toEqual({ mode: "bearer" });
	});

	it("prefers request.url over base+path when present", async () => {
		const m: ConnectorManifest = { ...SLACK, tools: [{ name: "t_ping", description: "d", request: { url: "https://api.x/ping" } }] };
		await compileConnector(m).tools[0].handler(ctx(), {});
		const [, reqInput] = executeHttpRequest.mock.calls[0];
		expect(reqInput).toMatchObject({ url: "https://api.x/ping" });
		expect((reqInput as Record<string, unknown>).path).toBeUndefined();
	});
});

describe("sanitizeConnectorManifest", () => {
	const valid = () => JSON.parse(JSON.stringify(SLACK));

	it("accepts + normalizes a valid manifest", () => {
		const m = sanitizeConnectorManifest(valid());
		expect(m?.id).toBe("slack");
		expect(m?.tools).toHaveLength(2);
		expect(m?.auth).toEqual({ type: "api-key", key: { in: "header", name: "Authorization" } });
	});

	it("rejects bad id / missing label", () => {
		expect(sanitizeConnectorManifest({ ...valid(), id: "Slack!" })).toBeNull();
		expect(sanitizeConnectorManifest({ ...valid(), id: "" })).toBeNull();
		expect(sanitizeConnectorManifest({ ...valid(), label: "" })).toBeNull();
	});

	it("rejects an unknown auth type and a bad api-key", () => {
		expect(sanitizeConnectorManifest({ ...valid(), auth: { type: "magic" } })).toBeNull();
		expect(sanitizeConnectorManifest({ ...valid(), auth: { type: "api-key", key: {} } })).toBeNull();
	});

	it("requires https for oauth2 urls and baseUrl", () => {
		expect(sanitizeConnectorManifest({ ...valid(), auth: { type: "oauth2", authUrl: "http://x/a", tokenUrl: "https://x/t" } })).toBeNull();
		expect(sanitizeConnectorManifest({ ...valid(), baseUrl: "http://slack.com/api" })).toBeNull();
	});

	it("drops tools with no url/path (and no baseUrl) and returns null if none survive", () => {
		const noBase = { ...valid(), baseUrl: undefined, tools: [{ name: "t_x", description: "d", request: {} }] };
		expect(sanitizeConnectorManifest(noBase)).toBeNull();
	});

	it("caps tools at 24", () => {
		const many = { ...valid(), tools: Array.from({ length: 40 }, (_, i) => ({ name: `t_${i}`, description: "d", request: { path: "/x" } })) };
		expect(sanitizeConnectorManifest(many)?.tools.length).toBe(24);
	});
});
