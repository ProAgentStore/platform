// Owner configuration and inspection of an instance's Gmail identity (#1279) — which VERIFIED send-as address it writes
// as and which inbound recipient address(es) its mail is scoped to. The MCP tools `get_instance_gmail_identity` and
// `set_instance_gmail_identity` drive exactly these two routes with the owner's own authorization; there is no second path.
//
// Nothing here accepts or returns a credential: the Gmail token is minted server-side from the owner's stored grant, used
// for ONE read-only call (`sendAs.list`), and never leaves this module.
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { connectorClient } from "../lib/connectors/client.js";
import { emailPermitted } from "../lib/connectors/gmail.js";
import { listConnectorAccounts, pinnedAccountFor, resolveConnectorAccount } from "../lib/connector-accounts.js";
import { listConsents } from "../lib/connector-consent.js";
import { logEvent } from "../lib/events.js";
import { listSendAs, scopesAllowSend } from "../lib/gmail.js";
import {
	DEFAULT_PREVIEW_CHARS,
	GMAIL_IDENTITY_KEY,
	type GmailIdentityState,
	gmailIdentityFromConfig,
	MAX_READ_CHARS,
	MAX_SCOPE_ADDRESSES,
	normalizeAddress,
	resolveSender,
	type SendAsAlias,
} from "../lib/gmail-identity.js";
import { patchInstanceConfig } from "../lib/instance-config.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

export const gmailIdentityRoutes = new Hono<{ Bindings: Env }>();

const SECRET_KEY = /token|secret|password|credential|refresh|api[_-]?key|client[_-]?id/i;

interface Blocker {
	code: string;
	message: string;
}

/** The whole picture for one instance: the pin, the account's live aliases, and every named reason mail cannot flow. */
async function identityView(env: Env, userId: string, instanceId: string, config: string | null | undefined) {
	const identity: GmailIdentityState = gmailIdentityFromConfig(config);
	const pin = identity.state === "configured" ? identity.pin : null;
	const blockers: Blocker[] = [];

	if (!(await emailPermitted(env, instanceId))) blockers.push({ code: "email_permission_off", message: "Email access is off for this agent (Permissions → Permissions & Connections)." });
	if (identity.state === "invalid") blockers.push({ code: "identity_invalid", message: identity.reason });

	const accounts = await listConnectorAccounts(env, userId, "gmail");
	const resolved = resolveConnectorAccount(accounts, await pinnedAccountFor(env, instanceId, "gmail"), "Gmail");
	let aliases: SendAsAlias[] | null = null;
	let aliasError: string | null = null;
	let mailbox: string | null = null;
	if (!resolved.ok) {
		blockers.push({ code: "no_gmail_connection", message: resolved.message });
	} else {
		mailbox = resolved.account.label?.trim() || resolved.account.accountId || null;
		if (!scopesAllowSend(resolved.account.grantedScopes)) blockers.push({ code: "send_scope_missing", message: "This Gmail connection has not been allowed to send (Preferences → Connections → Allow: Send and reply as you)." });
		try {
			const token = await connectorClient(env, "gmail", { userId, instanceId }).token({ scope: "read" });
			if (!token) throw new Error("Gmail is not connected.");
			aliases = await listSendAs(token);
		} catch (e) {
			aliasError = e instanceof Error ? e.message : "Gmail did not answer.";
			blockers.push({ code: "aliases_unreadable", message: `The account's send-as addresses could not be read: ${aliasError}` });
		}
	}

	if (pin) {
		if (!pin.sendAs) blockers.push({ code: "no_sender_pinned", message: "No sender is pinned, so this agent will not send." });
		else if (aliases) {
			const r = resolveSender(aliases, pin.sendAs);
			if (!r.ok) blockers.push({ code: r.code, message: r.message });
		}
		if (pin.inboundScope.length === 0) blockers.push({ code: "no_inbound_scope", message: "No inbound scope is set, so this agent can read the whole mailbox." });
	}

	const consent = (await listConsents(env, instanceId)).find((r) => r.connector === "gmail" && r.scope === "write");
	const writeConsent = consent ? (consent.mode === "ask" ? "ask" : "always") : "off";
	if (writeConsent === "off") blockers.push({ code: "write_consent_off", message: "Write consent for Gmail is off, so sending is refused (changed only in the console)." });
	if (writeConsent === "ask") blockers.push({ code: "write_consent_ask", message: "Every send waits for the owner's approval." });

	const hard = new Set(blockers.map((b) => b.code));
	const readBlockers = ["email_permission_off", "identity_invalid", "no_gmail_connection"];
	const sendBlockers = [...readBlockers, "send_scope_missing", "aliases_unreadable", "no_sender_pinned", "alias_missing", "alias_unverified", "write_consent_off"];
	return {
		state: identity.state,
		pin,
		mailbox,
		aliases: aliases?.map((a) => ({ email: a.email, displayName: a.displayName, isPrimary: a.isPrimary, isDefault: a.isDefault, verified: a.verified, verificationStatus: a.verificationStatus })) ?? null,
		writeConsent,
		limits: { defaultPreviewChars: DEFAULT_PREVIEW_CHARS, maxReadChars: MAX_READ_CHARS, maxScopeAddresses: MAX_SCOPE_ADDRESSES },
		blockers,
		readyToRead: !readBlockers.some((c) => hard.has(c)),
		readyToSend: pin !== null && !sendBlockers.some((c) => hard.has(c)),
	};
}

/** GET /v1/instances/:id/gmail/identity — the pin, the live send-as aliases (verified or not) and every named blocker. */
gmailIdentityRoutes.get("/:id/gmail/identity", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	return c.json(await identityView(c.env, session.uid, instance.id, instance.config));
});

/**
 * PUT /v1/instances/:id/gmail/identity { sendAs?, inboundScope?, previewChars? } | { clear: true }.
 *
 * REPLACES the stored identity. `sendAs` must be an address the connected account can write as AND Google reports verified
 * — an unverified alias is refused now, because Gmail would silently send it as the primary. `clear: true` removes the
 * identity entirely: the agent then behaves as one that never configured any (the account's default).
 */
gmailIdentityRoutes.put("/:id/gmail/identity", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	if (Object.keys(body).some((k) => SECRET_KEY.test(k))) throw new HttpError(400, "Do not send credentials here — Gmail access comes from the owner's connected account.");

	if (body.clear === true) {
		await patchInstanceConfig(c.env, instance.id, session.uid, GMAIL_IDENTITY_KEY, null);
		await logEvent(c.env, { source: "gmail", event: "gmail.identity.cleared", level: "info", userId: session.uid, message: "Gmail identity cleared", context: { instanceId: instance.id } }).catch(() => undefined);
		return c.json({ success: true, identity: await identityView(c.env, session.uid, instance.id, (await requireOwnedInstance(c.env, instance.id, session.uid)).config) });
	}

	let sendAs: string | null = null;
	if (body.sendAs !== undefined && body.sendAs !== null) {
		sendAs = normalizeAddress(body.sendAs);
		if (!sendAs) throw new HttpError(400, "sendAs must be a plain email address.");
	}
	const inboundScope: string[] = [];
	if (body.inboundScope !== undefined) {
		if (!Array.isArray(body.inboundScope) || body.inboundScope.length > MAX_SCOPE_ADDRESSES) throw new HttpError(400, `inboundScope must be a list of at most ${MAX_SCOPE_ADDRESSES} addresses.`);
		for (const item of body.inboundScope) {
			const a = normalizeAddress(item);
			if (!a) throw new HttpError(400, "inboundScope may hold plain email addresses only.");
			if (!inboundScope.includes(a)) inboundScope.push(a);
		}
	}
	let previewChars = DEFAULT_PREVIEW_CHARS;
	if (body.previewChars !== undefined) {
		if (typeof body.previewChars !== "number" || !Number.isInteger(body.previewChars) || body.previewChars < 500 || body.previewChars > MAX_READ_CHARS) {
			throw new HttpError(400, `previewChars must be a whole number from 500 to ${MAX_READ_CHARS}.`);
		}
		previewChars = body.previewChars;
	}
	if (sendAs === null && inboundScope.length === 0) throw new HttpError(400, "Give a sendAs address, an inboundScope, or {\"clear\": true}.");

	if (sendAs) {
		let aliases: SendAsAlias[];
		try {
			const token = await connectorClient(c.env, "gmail", { userId: session.uid, instanceId: instance.id }).token({ scope: "read" });
			if (!token) throw new Error("Gmail is not connected.");
			aliases = await listSendAs(token);
		} catch (e) {
			throw new HttpError(409, `The connected account's send-as addresses could not be read, so ${sendAs} was not pinned: ${e instanceof Error ? e.message : "Gmail did not answer."}`);
		}
		const r = resolveSender(aliases, sendAs);
		if (!r.ok) throw new HttpError(409, r.message);
	}

	await patchInstanceConfig(c.env, instance.id, session.uid, GMAIL_IDENTITY_KEY, { sendAs, inboundScope, previewChars });
	await logEvent(c.env, { source: "gmail", event: "gmail.identity.set", level: "info", userId: session.uid, message: "Gmail identity set", context: { instanceId: instance.id, sendAs, inboundScope } }).catch(() => undefined);
	return c.json({ success: true, identity: await identityView(c.env, session.uid, instance.id, (await requireOwnedInstance(c.env, instance.id, session.uid)).config) });
});
