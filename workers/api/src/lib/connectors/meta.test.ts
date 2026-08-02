import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// The Meta handlers POST to graph.facebook.com via globalThis.fetch and get their
// platform token from ctx.connectorClient("meta").token() (backed by META_ACCESS_TOKEN).
// We stub fetch and inject a connectorClient in ctx — no real network, no real token.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

import { META_TOOLS } from "./meta.js";
import { getRegistryTool, registryConnectorGroups, registryToolNameSet, runRegistryTool } from "../tool-registry.js";
import type { Env } from "../../types.js";

const FAKE_TOKEN = "SECRET-meta-token-should-never-leak";

const tool = (name: string) => {
	const t = META_TOOLS.find((x) => x.name === name);
	if (!t) throw new Error(`no meta tool ${name}`);
	return t;
};

// A ctx whose connectorClient("meta").token() resolves to a fake token (or null to
// exercise the "not configured" path). Only token() is reached by the handlers.
const ctx = (over: { env?: Partial<Env>; token?: string | null } = {}) =>
	({
		env: { WHATSAPP_PHONE_NUMBER_ID: "PHONE123", META_IG_ID: "IG456", ...(over.env || {}) } as Env,
		userId: "u1",
		instanceId: "i1",
		agentId: "i1",
		connectorClient: (_provider: string) => ({
			token: async () => (over.token === undefined ? FAKE_TOKEN : over.token),
		}),
	}) as never;

// Build a Graph API Response for the mocked fetch.
const graphRes = (status: number, body: unknown) =>
	({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(graphRes(200, { messages: [{ id: "wamid.x" }] }));
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("meta connector — registration", () => {
	it("registers both messaging tools as write-scoped", () => {
		const names = registryToolNameSet();
		expect(names.has("whatsapp_send_message")).toBe(true);
		expect(names.has("instagram_send_dm")).toBe(true);
		expect(getRegistryTool("whatsapp_send_message")?.scope).toBe("write");
		expect(getRegistryTool("instagram_send_dm")?.scope).toBe("write");
	});

	it("groups both tools under the meta connector for the catalog", () => {
		const grp = registryConnectorGroups().find((g) => g.connector === "meta");
		expect(grp).toBeDefined();
		expect(grp?.tools).toEqual(
			expect.arrayContaining(["whatsapp_send_message", "instagram_send_dm"]),
		);
		expect(grp?.tools).toHaveLength(2);
	});
});

describe("meta connector — not configured", () => {
	it("whatsapp reports not configured when the token is missing (never posts)", async () => {
		const r = await tool("whatsapp_send_message").handler(ctx({ token: null }), { to: "+14155552671", text: "hi" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/not configured/i);
		expect(r.content).toMatch(/META_ACCESS_TOKEN/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("whatsapp reports not configured when WHATSAPP_PHONE_NUMBER_ID is missing", async () => {
		const r = await tool("whatsapp_send_message").handler(ctx({ env: { WHATSAPP_PHONE_NUMBER_ID: undefined } }), { to: "+14155552671", text: "hi" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/WHATSAPP_PHONE_NUMBER_ID/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("instagram reports not configured when the token is missing (never posts)", async () => {
		const r = await tool("instagram_send_dm").handler(ctx({ token: null }), { recipient_id: "IGSID1", text: "hi" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/not configured/i);
		expect(r.content).toMatch(/META_ACCESS_TOKEN/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("instagram reports not configured when META_IG_ID is missing", async () => {
		const r = await tool("instagram_send_dm").handler(ctx({ env: { META_IG_ID: undefined } }), { recipient_id: "IGSID1", text: "hi" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/META_IG_ID/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("meta connector — validation", () => {
	it("whatsapp requires a recipient `to` after phone sanitization strips it empty", async () => {
		const r = await tool("whatsapp_send_message").handler(ctx(), { to: "no-digits-here!!!", text: "hi" });
		// "no-digits-here!!!" → sanitized to "" (no [\d+]) → rejected before any POST
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/recipient|to.*required/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("whatsapp requires text OR template_name (rejects when both absent)", async () => {
		const r = await tool("whatsapp_send_message").handler(ctx(), { to: "+14155552671" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/text.*template_name|template_name.*text/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("instagram requires recipient_id AND text", async () => {
		const noText = await tool("instagram_send_dm").handler(ctx(), { recipient_id: "IGSID1" });
		expect(noText.success).toBe(false);
		expect(noText.content).toMatch(/recipient_id.*text.*required/i);
		expect(fetchMock).not.toHaveBeenCalled();

		const noRecipient = await tool("instagram_send_dm").handler(ctx(), { text: "hi" });
		expect(noRecipient.success).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("meta connector — whatsapp happy path", () => {
	it("sends a text message with the sanitized recipient and correct Graph body", async () => {
		const r = await tool("whatsapp_send_message").handler(ctx(), { to: "+1 (415) 555-2671", text: "hello there" });
		expect(r.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [url, init] = fetchMock.mock.calls[0];
		// Posts to /{phoneId}/messages on the pinned Graph version.
		expect(url).toBe("https://graph.facebook.com/v20.0/PHONE123/messages");
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);

		const body = JSON.parse(init.body);
		expect(body).toEqual({
			messaging_product: "whatsapp",
			// "+1 (415) 555-2671" → stripped to [\d+] → "+14155552671"
			to: "+14155552671",
			type: "text",
			text: { body: "hello there" },
		});
		expect(r.content).toContain("+14155552671");
	});

	it("truncates outbound text to MAX_TEXT (4096)", async () => {
		const long = "x".repeat(5000);
		await tool("whatsapp_send_message").handler(ctx(), { to: "+14155552671", text: long });
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.text.body).toHaveLength(4096);
	});

	it("sends a template message with ordered body components", async () => {
		const r = await tool("whatsapp_send_message").handler(ctx(), {
			to: "+14155552671",
			template_name: "order_update",
			template_lang: "es_ES",
			template_params: "Ada, #42, tomorrow",
		});
		expect(r.success).toBe(true);
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.type).toBe("template");
		expect(body.template.name).toBe("order_update");
		expect(body.template.language).toEqual({ code: "es_ES" });
		expect(body.template.components).toEqual([
			{
				type: "body",
				parameters: [
					{ type: "text", text: "Ada" },
					{ type: "text", text: "#42" },
					{ type: "text", text: "tomorrow" },
				],
			},
		]);
		// No free-text body when it's a template.
		expect(body.text).toBeUndefined();
	});

	it("omits components when a template has no params, and defaults language to en_US", async () => {
		await tool("whatsapp_send_message").handler(ctx(), { to: "+14155552671", template_name: "hello_world" });
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.template.language).toEqual({ code: "en_US" });
		expect(body.template.components).toBeUndefined();
	});
});

describe("meta connector — instagram happy path", () => {
	it("sends a DM with the recipient/message shape to /{igId}/messages", async () => {
		const r = await tool("instagram_send_dm").handler(ctx(), { recipient_id: "  IGSID1  ", text: "  hi there  " });
		expect(r.success).toBe(true);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://graph.facebook.com/v20.0/IG456/messages");
		expect(init.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
		const body = JSON.parse(init.body);
		expect(body).toEqual({
			recipient: { id: "IGSID1" },
			message: { text: "hi there" },
		});
		expect(r.content).toContain("IGSID1");
	});

	it("truncates DM text to MAX_TEXT (4096)", async () => {
		await tool("instagram_send_dm").handler(ctx(), { recipient_id: "IGSID1", text: "y".repeat(5000) });
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.message.text).toHaveLength(4096);
	});
});

describe("meta connector — Graph API errors are surfaced without the token", () => {
	it("whatsapp surfaces the Graph status + error message, never the token", async () => {
		fetchMock.mockResolvedValue(graphRes(400, { error: { message: "Recipient phone number not in allowed list" } }));
		const r = await tool("whatsapp_send_message").handler(ctx(), { to: "+14155552671", text: "hi" });
		expect(r.success).toBe(false);
		expect(r.content).toContain("400");
		expect(r.content).toContain("Recipient phone number not in allowed list");
		expect(r.content).not.toContain(FAKE_TOKEN);
	});

	it("instagram surfaces a fallback message when the error body has none, and never the token", async () => {
		fetchMock.mockResolvedValue(graphRes(500, {}));
		const r = await tool("instagram_send_dm").handler(ctx(), { recipient_id: "IGSID1", text: "hi" });
		expect(r.success).toBe(false);
		expect(r.content).toContain("500");
		expect(r.content).toMatch(/request failed/i);
		expect(r.content).not.toContain(FAKE_TOKEN);
	});
});

describe("meta connector — write-consent gate (runRegistryTool)", () => {
	// Fake DB whose consent SELECT returns a row (granted) or null (not granted).
	const envConsent = (granted: boolean): Env =>
		({
			WHATSAPP_PHONE_NUMBER_ID: "PHONE123",
			META_IG_ID: "IG456",
			DB: { prepare() { return { bind() { return { first: async () => (granted ? { ok: 1 } : null) }; } }; } },
		}) as unknown as Env;

	// A connectorClient that returns the fake token, injected so runRegistryTool doesn't
	// build the real one (which would need real Env auth wiring).
	const consentCtx = (granted: boolean) => ({
		env: envConsent(granted),
		userId: "u1",
		agentId: "i1",
		instanceId: "i1",
		connectorClient: (_p: string) => ({ token: async () => FAKE_TOKEN }),
	}) as never;

	it("blocks whatsapp_send_message when write consent is NOT granted (never posts)", async () => {
		const r = await runRegistryTool("whatsapp_send_message", consentCtx(false), { to: "+14155552671", text: "hi" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/permitted|consent|Connections/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("blocks instagram_send_dm when write consent is NOT granted (never posts)", async () => {
		const r = await runRegistryTool("instagram_send_dm", consentCtx(false), { recipient_id: "IGSID1", text: "hi" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/permitted|consent|Connections/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows whatsapp_send_message when write consent IS granted (posts to Graph)", async () => {
		const r = await runRegistryTool("whatsapp_send_message", consentCtx(true), { to: "+14155552671", text: "hi" });
		expect(r.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe("https://graph.facebook.com/v20.0/PHONE123/messages");
	});
});
