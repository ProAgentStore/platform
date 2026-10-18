/**
 * Slack as a NOTIFICATION connector (#1217): the owner connects a Slack bot, grants an instance
 * individual channels, and the platform posts that instance's release notes there (#1216).
 *
 * It mirrors the Discord grant model — one credential per owner (vault provider `slack`), one
 * `instance_connector_grants` row per channel per instance (`resourceType: "slack_channel"`) — with
 * one deliberate difference: the AGENT gets no Slack tools. Only the platform posts, and only what
 * the owner configured, so Slack is not a registry connector and grants need no tool declaration.
 *
 * Slack answers HTTP 200 with `{ok:false, error}` for almost every failure, so success is read off
 * `ok`, never off the status.
 */
import { HttpError } from "./auth.js";
import { safeFetch } from "./ssrf.js";
import type { SlackBot, SlackChannel } from "../agent-types.js";

export type { SlackBot, SlackChannel } from "../agent-types.js";

const API = "https://slack.com/api";
/** Slack's own limit is 40,000 characters; a release note is far below it. */
export const SLACK_MAX_TEXT = 4_000;
/** Public (`C…`) and private (`G…`) channel ids. DMs are not grantable. */
export const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/;

export const SLACK_NOT_CONNECTED = "No Slack bot is connected. Connect one with the MCP tool connect_slack_bot, or in the console: agent → Permissions → Release notes → Connect Slack.";

/** One wording per Slack error code, with the status the platform answers with. */
export function slackFailure(error: string): { status: 403 | 404 | 409 | 429 | 502; message: string } {
	if (["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"].includes(error)) {
		// Never a 401: that reads as "your PAGS session expired" and signs the owner out (#1132).
		return { status: 409, message: `Slack rejected the connected bot token — it was revoked or the app was uninstalled. Reconnect Slack. (Slack: ${error})` };
	}
	if (error === "not_in_channel") return { status: 403, message: "The Slack bot is not in that channel. In Slack, run /invite @<your bot> in the channel, then try again. (Slack: not_in_channel)" };
	if (error === "missing_scope") return { status: 403, message: "The Slack bot lacks a permission it needs (chat:write, channels:read, groups:read). Add the scopes to the Slack app and reinstall it. (Slack: missing_scope)" };
	if (error === "channel_not_found") return { status: 404, message: "Slack has no such channel visible to this bot. (Slack: channel_not_found)" };
	if (error === "ratelimited") return { status: 429, message: "Slack rate-limited the bot — retry shortly. (Slack: ratelimited)" };
	return { status: 502, message: `Slack returned an error: ${error}` };
}

type SlackReply = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

/** Call one Slack Web API method with the bot token. */
export async function slackCall(token: string, method: string, body: Record<string, string | number | boolean> = {}): Promise<SlackReply> {
	let res: Response;
	try {
		// Form-encoded, not JSON: every Web API method accepts a form body, and several read methods
		// (conversations.info, conversations.list) do not accept JSON.
		const form = new URLSearchParams(Object.entries(body).map(([k, v]): [string, string] => [k, String(v)]));
		res = await safeFetch(`${API}/${method}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
			body: form.toString(),
		});
	} catch {
		return { ok: false, error: "unreachable" };
	}
	if (res.status === 429) return { ok: false, error: "ratelimited" };
	const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!data) return { ok: false, error: `http_${res.status}` };
	return data.ok === true ? { ok: true, data } : { ok: false, error: typeof data.error === "string" ? data.error : "unknown_error" };
}

/** `slackCall`, as an HttpError the routes can throw. */
export async function slackJson(token: string, method: string, body: Record<string, string | number | boolean> = {}): Promise<Record<string, unknown>> {
	const r = await slackCall(token, method, body);
	if (r.ok) return r.data;
	if (r.error === "unreachable") throw new HttpError(502, "Slack could not be reached.");
	const f = slackFailure(r.error);
	throw new HttpError(f.status, f.message);
}

/** Who a token is. Only a BOT token (`xoxb-`) is accepted: this connector never posts as a person. */
export async function slackBotIdentity(token: string): Promise<SlackBot> {
	if (!token.startsWith("xoxb-")) throw new HttpError(400, "That is not a Slack BOT token. Use the app's Bot User OAuth Token (it starts with xoxb-), from api.slack.com/apps → your app → OAuth & Permissions.");
	const me = await slackJson(token, "auth.test");
	if (typeof me.team_id !== "string" || typeof me.team !== "string") throw new HttpError(502, "Slack returned no workspace identity.");
	return { teamId: me.team_id, team: me.team, botUserId: typeof me.user_id === "string" ? me.user_id : null };
}

function toChannel(raw: unknown): SlackChannel | null {
	const c = raw as { id?: unknown; name?: unknown; is_private?: unknown; is_member?: unknown; is_archived?: unknown } | null;
	if (typeof c?.id !== "string" || typeof c.name !== "string" || !SLACK_CHANNEL_ID.test(c.id) || c.is_archived === true) return null;
	return { id: c.id, name: c.name, isPrivate: c.is_private === true, isMember: c.is_member === true };
}

/** The channels the bot can see — the grant picker's list. One page of 200; `hasMore` says when there are more. */
export async function listSlackChannels(token: string): Promise<{ channels: SlackChannel[]; hasMore: boolean }> {
	const data = await slackJson(token, "conversations.list", { types: "public_channel,private_channel", exclude_archived: true, limit: 200 });
	const channels = (Array.isArray(data.channels) ? data.channels : []).map(toChannel).filter((c): c is SlackChannel => c !== null);
	const next = (data.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
	return { channels, hasMore: typeof next === "string" && next.length > 0 };
}

/** One channel's verified metadata, for a grant. */
export async function slackChannelInfo(token: string, channelId: string): Promise<SlackChannel> {
	const data = await slackJson(token, "conversations.info", { channel: channelId });
	const channel = toChannel(data.channel);
	if (!channel) throw new HttpError(400, "Grant a Slack channel (public or private) that is not archived.");
	return channel;
}

/** Post one plain-text message. Links are not unfurled and nobody is pinged by a mention. */
export async function postSlackMessage(token: string, channelId: string, text: string): Promise<{ ok: true; ts: string | null } | { ok: false; message: string }> {
	const r = await slackCall(token, "chat.postMessage", { channel: channelId, text, unfurl_links: false, unfurl_media: false, parse: "none", link_names: false });
	if (r.ok) return { ok: true, ts: typeof r.data.ts === "string" ? r.data.ts : null };
	return { ok: false, message: r.error === "unreachable" ? "Slack could not be reached." : slackFailure(r.error).message };
}
