// Per-instance Gmail identity (#1279): which VERIFIED send-as alias an instance writes as, and which inbound
// recipient address(es) its mail is scoped to.
//
// The pin lives in `agent_instances.config.gmailIdentity` — owner-set through the API/MCP, never by the model — and is
// absent for an instance that never configured it. An absent pin changes NOTHING: the instance keeps sending as the
// connected account's default and reading its whole mailbox. A PRESENT pin is enforced, and fails closed: a pin that
// cannot be read, parsed or verified refuses rather than falling back to the global default.
//
// Nothing here touches a credential. Alias discovery (`sendAs.list`) runs with gmail.readonly on the token the connector
// already holds; this module only decides what the answer means.
import type { Env } from "../types.js";

export const GMAIL_IDENTITY_KEY = "gmailIdentity";

/** Default body preview for a scoped instance, and the hard ceiling for any read. */
export const DEFAULT_PREVIEW_CHARS = 8_000;
export const MAX_READ_CHARS = 40_000;
export const MAX_SCOPE_ADDRESSES = 10;
/** A scoped instance's search listing clips each sender / subject / snippet to this, marking the cut. */
export const SUMMARY_FIELD_CHARS = 300;

export interface GmailIdentityPin {
	/** The verified send-as address this instance writes as; null = none chosen, so a scoped instance cannot send. */
	sendAs: string | null;
	/** Addresses the instance's inbound mail is scoped to (To / Cc / X-Original-To / the receiving Delivered-To). Empty = unscoped. */
	inboundScope: string[];
	/** Body characters returned by one read before the caller must continue with `offset`. */
	previewChars: number;
}

export type GmailIdentityState =
	| { state: "none" }
	| { state: "configured"; pin: GmailIdentityPin }
	| { state: "invalid"; reason: string };

const ADDRESS = /^[a-z0-9._%+'-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/** A plain mailbox address, lower-cased, or null. A display name, angle brackets or whitespace are not accepted. */
export function normalizeAddress(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const a = raw.trim().toLowerCase();
	return a.length <= 254 && ADDRESS.test(a) ? a : null;
}

/**
 * Every mailbox address in a To/Cc/Reply-To style header, display names and comments NOT parsed as addresses.
 *
 * Quoted strings and comments are removed first, so `"admin@scope.test" <attacker@evil.test>` yields only the real
 * mailbox — a display name must never be able to pose as a recipient in a scope check.
 */
export function addressesIn(header: string): string[] {
	if (!header) return [];
	const stripped = header.replace(/"(?:\\.|[^"\\])*"/g, " ").replace(/\((?:\\.|[^)\\])*\)/g, " ");
	const out: string[] = [];
	for (const segment of stripped.split(/[,;]/)) {
		const angle = /<([^<>]*)>/.exec(segment);
		const candidate = normalizeAddress(angle ? angle[1] : segment);
		if (candidate && !out.includes(candidate)) out.push(candidate);
	}
	return out;
}

function parseConfig(raw: string | null | undefined): { ok: true; value: Record<string, unknown> } | { ok: false } {
	if (!raw) return { ok: true, value: {} };
	try {
		const v = JSON.parse(raw) as unknown;
		return v && typeof v === "object" && !Array.isArray(v) ? { ok: true, value: v as Record<string, unknown> } : { ok: false };
	} catch {
		return { ok: false };
	}
}

/** Read the pin out of an instance config blob. Present-but-malformed is `invalid`, never "unconfigured". */
export function gmailIdentityFromConfig(raw: string | null | undefined): GmailIdentityState {
	const cfg = parseConfig(raw);
	if (!cfg.ok) return { state: "invalid", reason: "The instance configuration could not be read." };
	const node = cfg.value[GMAIL_IDENTITY_KEY];
	if (node === undefined || node === null) return { state: "none" };
	if (typeof node !== "object" || Array.isArray(node)) return { state: "invalid", reason: "The Gmail identity setting is malformed." };
	const o = node as Record<string, unknown>;
	let sendAs: string | null = null;
	if (o.sendAs !== undefined && o.sendAs !== null) {
		sendAs = normalizeAddress(o.sendAs);
		if (!sendAs) return { state: "invalid", reason: "The pinned sender is not a valid address." };
	}
	const scope: string[] = [];
	if (o.inboundScope !== undefined) {
		if (!Array.isArray(o.inboundScope) || o.inboundScope.length > MAX_SCOPE_ADDRESSES) return { state: "invalid", reason: "The inbound scope is malformed." };
		for (const item of o.inboundScope) {
			const a = normalizeAddress(item);
			if (!a) return { state: "invalid", reason: "The inbound scope holds an invalid address." };
			if (!scope.includes(a)) scope.push(a);
		}
	}
	let previewChars = DEFAULT_PREVIEW_CHARS;
	if (o.previewChars !== undefined) {
		if (typeof o.previewChars !== "number" || !Number.isInteger(o.previewChars) || o.previewChars < 500 || o.previewChars > MAX_READ_CHARS) {
			return { state: "invalid", reason: "The body preview size is out of range." };
		}
		previewChars = o.previewChars;
	}
	return { state: "configured", pin: { sendAs, inboundScope: scope, previewChars } };
}

/** The instance's pin. A database failure is `invalid` (refuse), not `none` (carry on unrestricted). */
export async function loadGmailIdentity(env: Env, instanceId: string | undefined): Promise<GmailIdentityState> {
	if (!instanceId) return { state: "none" };
	try {
		const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1").bind(instanceId).first<{ config: string | null }>();
		return gmailIdentityFromConfig(row?.config);
	} catch {
		return { state: "invalid", reason: "The instance's Gmail identity could not be read." };
	}
}

export const IDENTITY_UNREADABLE = (reason: string): string => `${reason} Mail access for this agent is paused until the owner re-saves its Gmail identity (set_instance_gmail_identity).`;

/** The headers a scope decision reads. `deliveredTo` must be the FIRST Delivered-To (the receiving server's own). */
export interface RecipientHeaders {
	to: string;
	cc: string;
	deliveredTo: string;
	xOriginalTo: string;
}

/**
 * Is this message addressed to the scope?
 *
 * True when ANY scope address is among To, Cc, X-Original-To or the receiving Delivered-To. A message copied to the scope
 * address AND to others is in scope — it was delivered to that address — while mail that never names it is not, however
 * the id was obtained. Matching is on parsed mailboxes, so a display name or a lookalike domain never qualifies.
 */
export function recipientInScope(scope: readonly string[], h: RecipientHeaders): boolean {
	if (scope.length === 0) return true;
	const seen = new Set([...addressesIn(h.to), ...addressesIn(h.cc), ...addressesIn(h.xOriginalTo), ...addressesIn(h.deliveredTo)]);
	return scope.some((s) => seen.has(s));
}

/** The Gmail search clause that narrows a query to the scope. The caller still post-filters by header. */
export function scopeQueryClause(scope: readonly string[]): string {
	return `(${scope.map((a) => `to:${a} OR cc:${a} OR deliveredto:${a}`).join(" OR ")})`;
}

/** Combine the owner's scope with the agent's own query: the agent's query can only narrow it, never widen it. */
export function scopedQuery(scope: readonly string[], query: string): string {
	if (scope.length === 0) return query;
	return query.trim() ? `${scopeQueryClause(scope)} (${query})` : scopeQueryClause(scope);
}

export interface SendAsAlias {
	email: string;
	displayName: string;
	replyToAddress: string;
	isPrimary: boolean;
	isDefault: boolean;
	verificationStatus: string;
	/** The primary address, or an alias Google reports `accepted`. Anything else would be silently rewritten to the primary at send time. */
	verified: boolean;
}

export type SenderResolution =
	| { ok: true; alias: SendAsAlias }
	| { ok: false; code: "no_sender_pinned" | "alias_missing" | "alias_unverified"; message: string };

export function resolveSender(aliases: readonly SendAsAlias[], pinned: string | null): SenderResolution {
	if (!pinned) {
		return { ok: false, code: "no_sender_pinned", message: "This agent has no sender address chosen, so it will not send. The owner pins a verified send-as address with set_instance_gmail_identity." };
	}
	const alias = aliases.find((a) => a.email === pinned);
	if (!alias) {
		return { ok: false, code: "alias_missing", message: `${pinned} is not a send-as address of the connected Gmail account, so nothing was sent. Add and verify it in Gmail → Settings → Accounts, or pin a different sender.` };
	}
	if (!alias.verified) {
		return { ok: false, code: "alias_unverified", message: `${pinned} is a send-as address of the connected Gmail account but Google has not verified it (${alias.verificationStatus || "unverified"}), so nothing was sent — Gmail would rewrite the From to the primary address. Finish the verification in Gmail → Settings → Accounts.` };
	}
	return { ok: true, alias };
}

/**
 * Who a reply goes to, for a scoped instance. The parent's Reply-To is honoured when it is ONE valid address that is not
 * this agent's own; anything else (several, malformed, a self-loop) falls back to the From. The model never supplies it.
 */
export function replyRecipient(parent: { from: string; replyTo: string }, ownAddresses: readonly string[]): { to: string; viaReplyTo: boolean } {
	const rt = addressesIn(parent.replyTo);
	if (rt.length === 1 && !ownAddresses.includes(rt[0])) return { to: rt[0], viaReplyTo: true };
	return { to: parent.from, viaReplyTo: false };
}

/** A body window that never splits a surrogate pair, and says whether more follows. */
export function textWindow(full: string, offset: number, maxChars: number): { text: string; offset: number; length: number; truncated: boolean; nextOffset: number | null } {
	const start = Math.max(0, Math.min(full.length, Math.floor(offset)));
	let end = Math.min(full.length, start + Math.max(0, Math.floor(maxChars)));
	if (end < full.length && end > start) {
		const code = full.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	}
	const truncated = end < full.length;
	return { text: full.slice(start, end), offset: start, length: full.length, truncated, nextOffset: truncated ? end : null };
}

/** Gmail page tokens are opaque but URL-safe; anything else is not one we were given. */
export function validPageToken(raw: unknown): string | null {
	return typeof raw === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(raw) ? raw : null;
}
