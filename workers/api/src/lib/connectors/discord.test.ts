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
			"discord_search_messages",
			"discord_read_reactions",
			"discord_list_members",
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

	describe("discord_send_message mention allowlist (#1663)", () => {
		const U1 = "123456789012345678";
		const U2 = "223456789012345678";
		const ROLE = "987654321098765432";
		const REPLY = "345678901234567890";
		const send = (input: Record<string, unknown>) => tool("discord_send_message").handler(ctx(), { grantId: "grant-1", ...input });
		const posted = (fetch: { mock: { calls: unknown[][] } }) => {
			const post = fetch.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
			return JSON.parse(String((post?.[1] as RequestInit).body)) as { content: string; allowed_mentions: Record<string, unknown> };
		};
		const stub = (authorId = U1) => {
			const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
				init?.method === "POST" ? new Response(JSON.stringify({ id: "234567890123456789" }), { status: 200 }) : new Response(JSON.stringify({ author: { id: authorId } }), { status: 200 }),
			);
			vi.stubGlobal("fetch", fetch);
			return fetch;
		};

		it("a default send names nobody: parse [] and no users or roles", async () => {
			const fetch = stub();
			await send({ content: `hi <@${U1}> @everyone @here` });
			expect(posted(fetch).allowed_mentions).toEqual({ parse: [] });
		});

		it("forwards a listed and tagged user", async () => {
			const fetch = stub();
			const result = await send({ content: `hello <@${U1}>`, mentionUserIds: [U1] });
			expect(posted(fetch)).toEqual({ content: `hello <@${U1}>`, allowed_mentions: { parse: [], users: [U1] } });
			expect(JSON.parse((result as { content: string }).content)).toMatchObject({ sent: true, mentionedUserIds: [U1] });
		});

		it("accepts the <@!id> nickname form for users", async () => {
			const fetch = stub();
			await send({ content: `hello <@!${U1}>`, mentionUserIds: [U1] });
			expect(posted(fetch).allowed_mentions).toEqual({ parse: [], users: [U1] });
		});

		it("forwards a listed and tagged role", async () => {
			const fetch = stub();
			await send({ content: `hey <@&${ROLE}>`, mentionRoleIds: [ROLE] });
			expect(posted(fetch).allowed_mentions).toEqual({ parse: [], roles: [ROLE] });
		});

		it("forwards users and roles together", async () => {
			const fetch = stub();
			await send({ content: `<@${U1}> and <@&${ROLE}>`, mentionUserIds: [U1], mentionRoleIds: [ROLE] });
			expect(posted(fetch).allowed_mentions).toEqual({ parse: [], users: [U1], roles: [ROLE] });
		});

		it("drops a listed id that content does not tag, and reports it", async () => {
			const fetch = stub();
			const result = await send({ content: "hello world", mentionUserIds: [U1], mentionRoleIds: [ROLE] });
			expect(posted(fetch).allowed_mentions).toEqual({ parse: [] });
			expect(JSON.parse((result as { content: string }).content)).toMatchObject({ sent: true, ignoredMentionUserIds: [U1], ignoredMentionRoleIds: [ROLE] });
		});

		it("a user tag does not enable a role of the same digits, nor the reverse", async () => {
			const fetch = stub();
			await send({ content: `<@${U1}> <@&${U2}>`, mentionUserIds: [U2], mentionRoleIds: [U1] });
			expect(posted(fetch).allowed_mentions).toEqual({ parse: [] });
		});

		it("collapses duplicate ids to one", async () => {
			const fetch = stub();
			await send({ content: `<@${U1}> <@${U1}>`, mentionUserIds: [U1, U1] });
			expect(posted(fetch).allowed_mentions).toEqual({ parse: [], users: [U1] });
		});

		it("never pings @everyone or @here, even beside a listed user", async () => {
			const fetch = stub();
			await send({ content: `@everyone @here <@${U1}>`, mentionUserIds: [U1] });
			const allowed = posted(fetch).allowed_mentions;
			expect(allowed.parse).toEqual([]);
			expect(allowed).not.toHaveProperty("everyone");
		});

		it("refuses invalid ids before the token is read or Discord is called", async () => {
			const fetch = stub();
			const token = vi.fn(async () => "bot-secret");
			const c = { ...ctx(), connectorClient: () => ({ token, requireGrant: async () => GRANT, fetch: async () => new Response(), connector: DISCORD_CONNECTOR }) } as RegistryToolCtx;
			for (const bad of [["123"], ["1".repeat(21)], [`<@${U1}>`], [Number(U1)], "123456789012345678", [{}]]) {
				const result = await tool("discord_send_message").handler(c, { grantId: "grant-1", content: `<@${U1}>`, mentionUserIds: bad });
				expect(result).toMatchObject({ success: false, content: expect.stringMatching(/mentionUserIds/) });
			}
			expect(await tool("discord_send_message").handler(c, { grantId: "grant-1", content: "x", mentionRoleIds: ["abc"] })).toMatchObject({ success: false, content: expect.stringMatching(/mentionRoleIds/) });
			expect(token).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		});

		it("refuses more than 100 distinct ids, but counts duplicates once", async () => {
			const fetch = stub();
			const ids = (n: number) => Array.from({ length: n }, (_, i) => String(100000000000000000n + BigInt(i)));
			const over = await send({ content: "x", mentionUserIds: ids(101) });
			expect(over).toMatchObject({ success: false, content: expect.stringMatching(/at most 100/) });
			expect(fetch).not.toHaveBeenCalled();
			const ok = await send({ content: "x", mentionUserIds: [...ids(100), ...ids(100)] });
			expect(ok).toMatchObject({ success: true });
		});

		it("a reply pings its author only when the author is listed", async () => {
			const listed = stub(U1);
			await send({ content: "welcome", replyToMessageId: REPLY, mentionUserIds: [U1] });
			expect(posted(listed).allowed_mentions).toEqual({ parse: [], replied_user: true });

			vi.unstubAllGlobals();
			const other = stub(U2);
			await send({ content: "welcome", replyToMessageId: REPLY, mentionUserIds: [U1] });
			expect(posted(other).allowed_mentions).toEqual({ parse: [], replied_user: false });

			vi.unstubAllGlobals();
			const none = stub(U1);
			await send({ content: "welcome", replyToMessageId: REPLY });
			expect(posted(none).allowed_mentions).toEqual({ parse: [], replied_user: false });
			expect(none).toHaveBeenCalledTimes(1);
		});

		it("a reply still keeps the reply ping off when the author lookup fails", async () => {
			const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => (init?.method === "POST" ? new Response(JSON.stringify({ id: "234567890123456789" }), { status: 200 }) : new Response("{}", { status: 403 })));
			vi.stubGlobal("fetch", fetch);
			await send({ content: "welcome", replyToMessageId: REPLY, mentionUserIds: [U1] });
			expect(posted(fetch).allowed_mentions).toEqual({ parse: [], replied_user: false });
		});

		it("the schema and description tell agents how to ping", () => {
			const t = tool("discord_send_message");
			expect(t.description).toMatch(/tag them as <@id>.*AND list the ids in mentionUserIds\/mentionRoleIds/);
			expect(t.description).toMatch(/@everyone\/@here never ping/);
			expect(t.description).not.toMatch(/Mentions are disabled/);
			expect(t.jsonSchema).toMatchObject({ properties: { mentionUserIds: { type: "array" }, mentionRoleIds: { type: "array" } }, required: ["grantId", "content"] });
		});
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

	it("pages back with before, and refuses a malformed before without calling Discord (#1415)", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("[]", { status: 200 }));
		vi.stubGlobal("fetch", fetch);
		expect((await tool("discord_read_messages").handler(ctx(), { grantId: "grant-1", before: "1503315098650022058" })).success).toBe(true);
		expect(fetch.mock.calls[0][0]).toBe(`https://discord.com/api/v10/channels/${GRANT.resourceId}/messages?limit=20&before=1503315098650022058`);
		fetch.mockClear();
		for (const before of ["1&after=2", 42]) {
			const result = await tool("discord_read_messages").handler(ctx(), { grantId: "grant-1", before });
			expect(result.success).toBe(false);
		}
		expect(fetch).not.toHaveBeenCalled();
	});
});
