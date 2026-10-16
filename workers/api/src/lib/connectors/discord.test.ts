import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorGrant } from "../connector-grants.js";
import { DISCORD_CONNECTOR } from "./discord.js";
import type { RegistryToolCtx } from "./types.js";

const GRANT: ConnectorGrant = {
	id: "grant-1",
	instanceId: "instance-1",
	userId: "owner-1",
	provider: "discord",
	resourceId: "123456789012345678",
	resourceName: "test-channel",
	resourceType: "discord_channel",
	resourceUrl: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

function tool(name: string) {
	const found = DISCORD_CONNECTOR.tools.find((t) => t.name === name);
	if (!found) throw new Error(`missing ${name}`);
	return found;
}

function ctx(token = "bot-secret"): RegistryToolCtx {
	return {
		env: {} as RegistryToolCtx["env"],
		instanceId: "instance-1",
		userId: "owner-1",
		connectorClient: () => ({
			token: async () => token,
			requireGrant: async () => GRANT,
			fetch: async () => new Response(),
			connector: DISCORD_CONNECTOR,
		}),
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("Discord bot connector", () => {
	it("declares a channel-granted bot with an honest write surface", () => {
		expect(DISCORD_CONNECTOR).toMatchObject({ id: "discord", auth: "token", grantModel: "instance-resource", scopes: { read: true, write: true } });
		expect(DISCORD_CONNECTOR.tools.map((t) => t.name)).toEqual([
			"discord_list_granted_channels",
			"discord_read_messages",
			"discord_send_message",
			"discord_add_reaction",
		]);
		expect(tool("discord_read_messages").untrustedOutput).toBe(true);
		expect(tool("discord_send_message")).toMatchObject({ scope: "write", mutates: true, untrustedOutput: true });
	});

	it("sends only to the server-resolved granted channel, as a bot, with mentions disabled", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ id: "234567890123456789" }), { status: 200 }));
		vi.stubGlobal("fetch", fetch);
		const result = await tool("discord_send_message").handler(ctx(), { grantId: "grant-1", content: "hello <@123>" });
		expect(result).toEqual({ content: JSON.stringify({ sent: true, channelId: GRANT.resourceId, messageId: "234567890123456789" }, null, 2), success: true });
		expect(fetch).toHaveBeenCalledWith(
			`https://discord.com/api/v10/channels/${GRANT.resourceId}/messages`,
			expect.objectContaining({ method: "POST", body: JSON.stringify({ content: "hello <@123>", allowed_mentions: { parse: [] } }) }),
		);
		const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
		expect(headers.get("Authorization")).toBe("Bot bot-secret");
	});

	it("refuses an oversized message before it reads the bot token or calls Discord", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const result = await tool("discord_send_message").handler(ctx(), { grantId: "grant-1", content: "x".repeat(2001) });
		expect(result.success).toBe(false);
		expect(result.content).toContain("2000");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("reads a bounded recent-message window only after resolving a channel grant", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify([{ id: "m1", content: "untrusted" }]), { status: 200 }));
		vi.stubGlobal("fetch", fetch);
		const result = await tool("discord_read_messages").handler(ctx(), { grantId: "grant-1", limit: 999 });
		expect(result).toEqual({ content: JSON.stringify([{ id: "m1", content: "untrusted" }], null, 2), success: true });
		expect(fetch.mock.calls[0][0]).toBe(`https://discord.com/api/v10/channels/${GRANT.resourceId}/messages?limit=50`);
	});
});
