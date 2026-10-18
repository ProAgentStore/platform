/**
 * The owner's Slack bot and its per-instance channel grants (#1217) — the Discord grant model
 * (`routes/discord.ts`, #1132) for Slack, used to deliver release notes (#1216).
 *
 * Two ways to connect, one stored credential (vault provider `slack`, a `xoxb-` bot token):
 *   • OAuth — `GET /oauth/start` → Slack → `GET /oauth/callback`, when the platform's Slack app is
 *     configured (`SLACK_CLIENT_ID` + `SLACK_CLIENT_SECRET`). Not the generic connector flow
 *     (lib/connector-oauth-flow.ts): that one stores a REFRESH token, and Slack's v2 exchange returns
 *     a long-lived bot ACCESS token instead. It reuses that flow's signed, expiring, browser-bound
 *     state (`signConnectorState` + the single-use nonce cookie), so the security properties are the
 *     same ones, in the same code.
 *   • A pasted bot token — `PUT /bot`, from the owner's own Slack app, as Discord connects.
 *
 * Grants are checked against Slack before they are stored, and a grant names one channel for one
 * instance. Replacing the bot with one in a DIFFERENT workspace revokes every Slack grant, as a
 * Discord bot change does (#357): the owner approved those channels for the other workspace's bot.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { clipMarked } from "../lib/clip-marked.js";
import { connectorGrantReach, deleteConnectorGrant, listConnectorGrants, revokeUserConnectorGrants, upsertConnectorGrant } from "../lib/connector-grants.js";
import { signConnectorState, verifyConnectorState } from "../lib/connector-oauth.js";
import { OAUTH_STATE_TTL_SECONDS } from "../lib/connector-oauth-flow.js";
import { logEvent } from "../lib/events.js";
import { clearOauthBindCookie, newOauthNonce, OAUTH_BIND_ERROR, oauthBindCookie, readOauthBindCookie } from "../lib/oauth-nonce.js";
import { listSlackChannels, SLACK_CHANNEL_ID, SLACK_NOT_CONNECTED, type SlackBot, slackBotIdentity, slackChannelInfo } from "../lib/slack.js";
import { safeFetch } from "../lib/ssrf.js";
import { getUserProviderKey } from "../lib/user-ai.js";
import { hasUserProviderKey, upsertUserProviderKey } from "../lib/user-api-key-store.js";
import type { SlackBotConnectResponse, SlackBotDisconnectResponse, SlackBotStatusResponse, SlackChannelListResponse, SlackGrantListResponse, SlackGrantResponse, SlackOauthStartResponse } from "../agent-types.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

export const slackRoutes = new Hono<{ Bindings: Env }>();

const PROVIDER = "slack";
/** What a release-note bot needs: post, and list the channels it can be granted. */
export const SLACK_BOT_SCOPES = ["chat:write", "channels:read", "groups:read"];
const CALLBACK_PATH = "/v1/slack/oauth/callback";

const oauthConfigured = (env: Env) => !!(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET);

async function botToken(env: Env, userId: string): Promise<string> {
	const token = await getUserProviderKey(env, userId, PROVIDER);
	if (!token) throw new HttpError(409, SLACK_NOT_CONNECTED);
	return token;
}

/** The lifecycle audit row: ids and names only — never the token, never message content. */
const audit = (env: Env, uid: string, event: string, message: string, context: Record<string, unknown>, instanceId?: string) =>
	logEvent(env, { source: "slack", event, level: "info", message, userId: uid, instanceId, context });

/** Store a verified bot, revoking every Slack grant when it is a different workspace's bot. */
async function connectBot(env: Env, uid: string, token: string, bot: SlackBot, via: "token" | "oauth") {
	const had = await hasUserProviderKey(env, uid, PROVIDER);
	const previous = had ? await slackBotIdentity(await botToken(env, uid)).catch(() => null) : null;
	const changed = had && previous?.teamId !== bot.teamId;
	const revoked = changed ? await revokeUserConnectorGrants(env, uid, PROVIDER) : { grants: 0, instances: 0 };
	await upsertUserProviderKey(env, uid, PROVIDER, token);
	const event = !had ? "slack.bot_connect" : changed ? "slack.bot_replace" : "slack.bot_rotate";
	await audit(env, uid, event, `${had ? (changed ? "Replaced" : "Rotated") : "Connected"} the Slack bot for ${bot.team}`, { teamId: bot.teamId, previousTeamId: previous?.teamId ?? null, revokedGrants: revoked.grants, via });
	return { connected: true, rotated: had, bot, revoked } satisfies SlackBotConnectResponse;
}

/** Is a bot connected, does its token still work (checked live), which workspace is it in. Never the token. */
slackRoutes.get("/bot", async (c) => {
	const session = await requireUser(c);
	const reach = await connectorGrantReach(c.env, session.uid, PROVIDER);
	const base = { oauthConfigured: oauthConfigured(c.env), reach };
	if (!(await hasUserProviderKey(c.env, session.uid, PROVIDER))) return c.json({ ...base, connected: false, valid: false, bot: null } satisfies SlackBotStatusResponse);
	try {
		return c.json({ ...base, connected: true, valid: true, bot: await slackBotIdentity(await botToken(c.env, session.uid)) } satisfies SlackBotStatusResponse);
	} catch (e) {
		if (!(e instanceof HttpError)) throw e;
		return c.json({ ...base, connected: true, valid: false, bot: null, error: e.message } satisfies SlackBotStatusResponse);
	}
});

/** Connect or rotate by pasting a bot token. Checked with Slack BEFORE it is stored. */
slackRoutes.put("/bot", async (c) => {
	const session = await requireUser(c);
	const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
	const token = typeof body.token === "string" ? body.token.trim() : "";
	if (!token || token.length > 512 || /\s/.test(token)) throw new HttpError(400, "token must be one Slack bot token (xoxb-…).");
	const bot = await slackBotIdentity(token).catch((e: unknown) => {
		// Slack's invalid_auth here is about the token being OFFERED, not one already stored.
		if (e instanceof HttpError && e.status === 409) throw new HttpError(400, "Slack rejected that token. Copy the Bot User OAuth Token again from api.slack.com/apps → your app → OAuth & Permissions.");
		throw e;
	});
	const result = await connectBot(c.env, session.uid, token, bot, "token");
	return c.json(result, result.rotated ? 200 : 201);
});

/** Disconnect: the token AND every Slack channel grant, on every instance. Grants go first. */
slackRoutes.delete("/bot", async (c) => {
	const session = await requireUser(c);
	const revoked = await revokeUserConnectorGrants(c.env, session.uid, PROVIDER);
	const res = await c.env.DB.prepare("DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = 'slack'").bind(session.uid).run();
	const disconnected = (res.meta?.changes ?? 0) > 0;
	if (disconnected || revoked.grants > 0) await audit(c.env, session.uid, "slack.bot_disconnect", "Disconnected the Slack bot", { revokedGrants: revoked.grants, revokedInstances: revoked.instances });
	return c.json({ disconnected, revoked } satisfies SlackBotDisconnectResponse);
});

/** Begin "Add to Slack": the authorize URL, with a signed state bound to this browser. */
slackRoutes.get("/oauth/start", async (c) => {
	const session = await requireUser(c);
	if (!oauthConfigured(c.env)) throw new HttpError(501, "Slack OAuth is not configured on this platform. Connect Slack by pasting your Slack app's bot token instead (PUT /v1/slack/bot, MCP connect_slack_bot).");
	const nonce = newOauthNonce();
	const state = await signConnectorState(session.uid, Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SECONDS, c.env.SESSION_SIGNING_KEY, { nonce, provider: PROVIDER });
	c.header("Set-Cookie", oauthBindCookie(nonce, PROVIDER));
	const url = new URL("https://slack.com/oauth/v2/authorize");
	url.searchParams.set("client_id", c.env.SLACK_CLIENT_ID ?? "");
	url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
	url.searchParams.set("redirect_uri", new URL(CALLBACK_PATH, c.req.url).toString());
	url.searchParams.set("state", state);
	return c.json({ url: url.toString() } satisfies SlackOauthStartResponse);
});

/** Finish "Add to Slack": verify the state, exchange the code for the bot token, store it. */
slackRoutes.get("/oauth/callback", async (c) => {
	const code = c.req.query("code");
	const stateRaw = c.req.query("state");
	if (c.req.query("error")) return c.text(`Slack did not connect: ${c.req.query("error")}`, 400);
	if (!code || !stateRaw) return c.text("missing code or state", 400);
	if (!oauthConfigured(c.env)) return c.text("Slack OAuth is not configured on this platform.", 503);
	const uid = await verifyConnectorState(stateRaw, c.env.SESSION_SIGNING_KEY, { cookieNonce: readOauthBindCookie(c.req.header("cookie"), PROVIDER), provider: PROVIDER });
	c.header("Set-Cookie", clearOauthBindCookie(PROVIDER)); // single-use, whatever the outcome
	if (!uid) return c.text(OAUTH_BIND_ERROR, 400);
	const res = await safeFetch("https://slack.com/api/oauth.v2.access", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: c.env.SLACK_CLIENT_ID ?? "", client_secret: c.env.SLACK_CLIENT_SECRET ?? "", code, redirect_uri: new URL(CALLBACK_PATH, c.req.url).toString() }).toString(),
	}).catch(() => null);
	const tok = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string; access_token?: string } | null;
	if (!tok?.ok || typeof tok.access_token !== "string") return c.text(`Slack token exchange failed (${tok?.error ?? res?.status ?? "unreachable"})`, 400);
	let bot: SlackBot;
	try {
		bot = await slackBotIdentity(tok.access_token);
	} catch (e) {
		return c.text(e instanceof HttpError ? e.message : "Slack returned a token that could not be verified.", 400);
	}
	await connectBot(c.env, uid, tok.access_token, bot, "oauth");
	const team = bot.team.replace(/[<>&"']/g, "");
	return c.html(
		`<!doctype html><title>Slack connected</title><body style='font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center'><h1>Slack connected</h1><p>${team} is connected. You can close this tab and return to ProAgentStore.</p></div></body>`,
	);
});

/** The channels the bot can see, for the grant picker. */
slackRoutes.get("/channels", async (c) => {
	const session = await requireUser(c);
	return c.json((await listSlackChannels(await botToken(c.env, session.uid))) satisfies SlackChannelListResponse);
});

slackRoutes.get("/instances/:instanceId/grants", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return c.json({ grants: await listConnectorGrants(c.env, instanceId, session.uid, PROVIDER) } satisfies SlackGrantListResponse);
});

/**
 * Grant one instance one channel, after asking Slack for its metadata with the owner's bot. The
 * caller supplies only the id; the verified metadata becomes the grant. A channel the bot is not in
 * is still granted — Slack refuses its posts until the bot is invited — and the answer says so.
 */
slackRoutes.post("/instances/:instanceId/grants", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { channelId?: unknown };
	const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
	if (!SLACK_CHANNEL_ID.test(channelId)) throw new HttpError(400, "channelId must be a Slack channel id (C… or G…), from GET /v1/slack/channels.");
	const channel = await slackChannelInfo(await botToken(c.env, session.uid), channelId);
	const existing = (await listConnectorGrants(c.env, instanceId, session.uid, PROVIDER)).find((g) => g.resourceId === channelId);
	const grant = await upsertConnectorGrant(c.env, instanceId, session.uid, {
		provider: PROVIDER,
		resourceId: channelId,
		resourceName: clipMarked(`#${channel.name}`, 500, { within: true, what: "characters in Slack channel name" }),
		resourceType: "slack_channel",
	});
	if (!existing) await audit(c.env, session.uid, "slack.grant", `Granted Slack channel ${grant.resourceName}`, { grantId: grant.id, channelId }, instanceId);
	const note = channel.isMember ? null : `The bot is not in ${grant.resourceName} yet, so Slack will refuse its posts. In Slack, run /invite @<your bot> in that channel.`;
	// Granting the same channel twice returns the SAME grant id: the id is the stable handle.
	return c.json({ grant, botInChannel: channel.isMember, note } satisfies SlackGrantResponse, existing ? 200 : 201);
});

slackRoutes.delete("/instances/:instanceId/grants/:grantId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const grantId = c.req.param("grantId");
	if (!(await deleteConnectorGrant(c.env, instanceId, session.uid, PROVIDER, grantId))) {
		throw new HttpError(404, `This instance holds no Slack grant "${grantId}" — it was already revoked, or belongs to another instance.`);
	}
	await audit(c.env, session.uid, "slack.revoke", "Revoked a Slack channel grant", { grantId }, instanceId);
	return c.json({ success: true });
});
