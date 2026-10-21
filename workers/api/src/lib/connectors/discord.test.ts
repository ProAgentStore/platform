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
			"discord_read_reactions",
			"discord_send_message",
			"discord_add_reaction",
		]);
		expect(tool("discord_read_messages").untrustedOutput).toBe(true);
		expect(tool("discord_read_reactions")).toMatchObject({ scope: "read", mutates: false, untrustedOutput: true });
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

	it("replies to a message by id (#1273): a message_reference in the granted channel, no mention and no reply ping", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ id: "234567890123456789" }), { status: 200 }));
		vi.stubGlobal("fetch", fetch);
		const result = await tool("discord_send_message").handler(ctx(), { grantId: "grant-1", content: "welcome <@123> @everyone", replyToMessageId: "345678901234567890" });
		expect(result).toEqual({ content: JSON.stringify({ sent: true, channelId: GRANT.resourceId, messageId: "234567890123456789", repliedTo: "345678901234567890" }, null, 2), success: true });
		expect(fetch).toHaveBeenCalledWith(
			`https://discord.com/api/v10/channels/${GRANT.resourceId}/messages`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					content: "welcome <@123> @everyone",
					allowed_mentions: { parse: [], replied_user: false },
					message_reference: { message_id: "345678901234567890", channel_id: GRANT.resourceId, fail_if_not_exists: true },
				}),
			}),
		);
	});

	it("a plain send carries no message_reference, and an empty replyToMessageId is a plain send", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ id: "234567890123456789" }), { status: 200 }));
		vi.stubGlobal("fetch", fetch);
		await tool("discord_send_message").handler(ctx(), { grantId: "grant-1", content: "hi", replyToMessageId: "" });
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ content: "hi", allowed_mentions: { parse: [] } });
	});

	it("refuses a malformed reply target before it reads the bot token or calls Discord", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		for (const bad of ["abc", "123", "12345678901234567890123", "../channels/1/messages", Number("345678901234567890")]) {
			const result = await tool("discord_send_message").handler(ctx(), { grantId: "grant-1", content: "hi", replyToMessageId: bad });
			expect(result).toMatchObject({ success: false, content: expect.stringMatching(/replyToMessageId must be a Discord message id/) });
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it("a reply whose target is gone fails with Discord's reason, not a quiet plain message", async () => {
		vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ message: "Unknown message" }), { status: 404 })));
		const result = await tool("discord_send_message").handler(ctx(), { grantId: "grant-1", content: "hi", replyToMessageId: "345678901234567890" });
		expect(result).toMatchObject({ success: false, content: expect.stringMatching(/no such server, channel or message.*Unknown message/) });
	});

	describe("discord_read_reactions (#1274)", () => {
		const MSG = "345678901234567890";
		const run = (input: Record<string, unknown>) => tool("discord_read_reactions").handler(ctx(), { grantId: "grant-1", messageId: MSG, ...input });
		const json = (r: { content: string }) => JSON.parse(r.content) as { reactions: Array<Record<string, unknown>>; emojiCount: number; emojiOmitted?: number; usersOmittedAfterEmoji?: number };
		const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

		it("returns each emoji with its count and the users who reacted, keeping only id, name and bot flag", async () => {
			const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
				const u = String(url);
				if (u.endsWith(`/messages/${MSG}`)) return reply({ reactions: [{ count: 2, me: true, emoji: { id: null, name: "👍" } }, { count: 1, me: false, emoji: { id: "123123123123123123", name: "pags" } }] });
				if (u.includes(`/reactions/${encodeURIComponent("👍")}?limit=2`)) return reply([{ id: "111111111111111110", username: "ana", email: "x@y.z", avatar: "h" }, { id: "111111111111111111", username: "bo", bot: true }]);
				if (u.includes("/reactions/pags%3A123123123123123123?limit=1")) return reply([{ id: "111111111111111112", username: "cy" }]);
				return reply({ message: "Unknown" }, 404);
			});
			vi.stubGlobal("fetch", fetch);
			const out = json(await run({}));
			expect(out.reactions).toEqual([
				{ emoji: "👍", custom: false, count: 2, botReacted: true, users: [{ id: "111111111111111110", username: "ana", bot: false }, { id: "111111111111111111", username: "bo", bot: true }], usersComplete: true },
				{ emoji: "pags:123123123123123123", custom: true, count: 1, botReacted: false, users: [{ id: "111111111111111112", username: "cy", bot: false }], usersComplete: true },
			]);
			expect(fetch.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true); // read only
		});

		it("includeUsers:false makes one call and returns counts only", async () => {
			const fetch = vi.fn<typeof globalThis.fetch>(async () => reply({ reactions: [{ count: 5, me: false, emoji: { id: null, name: "🎉" } }] }));
			vi.stubGlobal("fetch", fetch);
			const out = json(await run({ includeUsers: false }));
			expect(out.reactions).toEqual([{ emoji: "🎉", custom: false, count: 5, botReacted: false }]);
			expect(fetch).toHaveBeenCalledTimes(1);
		});

		it("pages the reacting users with `after` until it has the number asked for, and says when it stopped short", async () => {
			const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: String(100000000000000000n + BigInt(from + i)), username: `u${from + i}` }));
			const urls: string[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof globalThis.fetch>(async (url) => {
					const u = String(url);
					urls.push(u);
					if (u.endsWith(`/messages/${MSG}`)) return reply({ reactions: [{ count: 250, me: false, emoji: { id: null, name: "👍" } }] });
					return reply(u.includes("after=") ? ids(100, 50) : ids(0, 100));
				}),
			);
			const out = json(await run({ usersPerEmoji: 150 }));
			expect((out.reactions[0].users as unknown[]).length).toBe(150);
			expect(out.reactions[0].usersComplete).toBe(false); // 250 reacted, 150 asked for
			expect(urls[1]).toMatch(/limit=100$/);
			expect(urls[2]).toMatch(/limit=50&after=100000000000000099$/);
		});

		it("a failed users call keeps the counts and names the failure on that emoji only", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof globalThis.fetch>(async (url) => (String(url).endsWith(`/messages/${MSG}`) ? reply({ reactions: [{ count: 1, me: false, emoji: { id: null, name: "👍" } }] }) : reply({ message: "Missing Permissions" }, 403))),
			);
			const out = json(await run({}));
			expect(out.reactions[0]).toMatchObject({ emoji: "👍", count: 1, users: [], usersComplete: false, usersError: expect.stringMatching(/lacks access or permission/) });
		});

		it("lists at most 20 emoji and fetches users for the first 10, saying so", async () => {
			const reactions = Array.from({ length: 25 }, (_, i) => ({ count: 1, me: false, emoji: { id: null, name: `e${i}` } }));
			const fetch = vi.fn<typeof globalThis.fetch>(async (url) => (String(url).endsWith(`/messages/${MSG}`) ? reply({ reactions }) : reply([{ id: "111111111111111110", username: "ana" }])));
			vi.stubGlobal("fetch", fetch);
			const out = json(await run({}));
			expect(out.reactions).toHaveLength(20);
			expect(out).toMatchObject({ emojiCount: 25, emojiOmitted: 5, usersOmittedAfterEmoji: 10 });
			expect(out.reactions.filter((r) => "users" in r)).toHaveLength(10);
			expect(fetch).toHaveBeenCalledTimes(11);
		});

		it("refuses a bad message id before it reads the token or calls Discord, and a missing message surfaces Discord's answer", async () => {
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			for (const bad of [undefined, "", "abc", "../x", Number("345678901234567890")]) {
				expect(await run({ messageId: bad })).toMatchObject({ success: false, content: expect.stringMatching(/messageId must be a Discord message id/) });
			}
			expect(fetch).not.toHaveBeenCalled();
			vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async () => reply({ message: "Unknown Message" }, 404)));
			expect(await run({})).toMatchObject({ success: false, content: expect.stringMatching(/no such server, channel or message.*Unknown Message/) });
		});

		it("a message with no reactions is an empty list, not an error", async () => {
			vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async () => reply({ id: MSG })));
			expect(json(await run({}))).toMatchObject({ reactions: [], emojiCount: 0 });
		});
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
