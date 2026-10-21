// Cloudflare mail identities for the worker-backed email connector (#1270).
//
// A Cloudflare Email Sending + Email Routing setup is a customer-account BRIDGE Worker speaking the
// same `email-worker/v1` contract as any other worker (#1269). What is different is that Cloudflare
// keeps three things apart that a generic worker blurs together, and so must PAGS:
//
//   sender         an address Email Sending will send AS (its domain is onboarded and verified);
//   route          an address Email Routing accepts mail for — inbound only, with a destination;
//   reply identity the sender an agent answers FROM.
//
// THE RULE THIS FILE EXISTS TO HOLD: an inbound route does not make an address send-capable. Mail
// sent "from" a routed-only alias is refused by Cloudflare at best and, at worst, sent under an
// identity the owner never approved. So a send is allowed only for an address that BOTH the bridge
// reports as a sender (read from the customer's own Cloudflare account, never asserted by the owner
// here) AND the owner has approved for this connection. Either alone is not enough.
//
// The decision functions are PURE — they take the snapshot and the approvals and return a verdict —
// so every refusal is testable without a database, and the handlers cannot reach the wire past one.
//
// A `generic` connection (no `provider: "cloudflare"` in its identity reply) has no sender policy at
// all and behaves exactly as #1269 shipped it: nothing here applies to it.
import type { Env } from "../types.js";

export type EmailProvider = "generic" | "cloudflare";

export interface EmailRoute {
	/** The address Email Routing accepts mail for. */
	address: string;
	/** Where the route delivers it (a verified destination address or a Worker name); null if unreported. */
	destination: string | null;
}

/** What the bridge reported about the customer's Cloudflare account on its last identity probe. */
export interface IdentitySnapshot {
	provider: EmailProvider;
	contractVersion: string;
	accountAddress: string | null;
	/** Onboarded domains. Every identity below must sit in one of them. */
	domains: string[];
	senders: string[];
	replyIdentities: string[];
	routes: EmailRoute[];
	reportedAt: string;
}

export type FailureClass = "auth" | "transient" | "protocol" | "bridge_unavailable" | null;

export interface ConnectionProfile {
	provider: EmailProvider;
	snapshot: IdentitySnapshot | null;
	approvedSenders: string[];
	replyIdentity: string | null;
	health: { lastProbeAt: string | null; lastProbeOk: boolean | null; lastFailureClass: string | null };
}

export const GENERIC_PROFILE: ConnectionProfile = {
	provider: "generic",
	snapshot: null,
	approvedSenders: [],
	replyIdentity: null,
	health: { lastProbeAt: null, lastProbeOk: null, lastFailureClass: null },
};

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────

const ADDRESS = /^[a-z0-9._%+-]{1,64}@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;

/** A normalized (trimmed, lower-cased) mailbox address, or null. A display name is not accepted. */
export function normalizeAddress(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const a = raw.trim().toLowerCase();
	return a.length <= 254 && ADDRESS.test(a) ? a : null;
}

export function domainOf(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1);
}

const MAX_IDENTITIES = 100;
const MAX_DOMAINS = 50;

function addressList(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const item of raw) {
		const a = normalizeAddress(item);
		if (a && !out.includes(a)) out.push(a);
		if (out.length >= MAX_IDENTITIES) break;
	}
	return out;
}

/**
 * Read an identity reply into a snapshot. Tolerant of a generic worker (no `provider`, no lists →
 * `generic`) and strict about a Cloudflare one: every address must be well-formed, and an identity
 * outside the reported domains is DROPPED rather than trusted, so a bridge cannot widen what the
 * owner can approve past the domains it claims to own.
 */
export function parseIdentity(res: Record<string, unknown>, now = new Date().toISOString()): IdentitySnapshot {
	const provider: EmailProvider = res.provider === "cloudflare" ? "cloudflare" : "generic";
	const account = (res.account ?? {}) as { address?: unknown };
	// A list cap by loop, not by cut: a bridge reporting more than MAX_DOMAINS domains keeps the first ones it listed.
	const domains: string[] = [];
	if (Array.isArray(res.domains)) {
		for (const d of res.domains as unknown[]) {
			const name = typeof d === "string" ? d.trim().toLowerCase() : "";
			if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) && !domains.includes(name)) domains.push(name);
			if (domains.length >= MAX_DOMAINS) break;
		}
	}
	const inDomains = (a: string) => domains.includes(domainOf(a));
	const routes: EmailRoute[] = [];
	if (Array.isArray(res.routes)) {
		for (const r of res.routes as unknown[]) {
			const o = (r ?? {}) as { address?: unknown; destination?: unknown };
			const address = normalizeAddress(o.address);
			if (!address || !inDomains(address) || routes.some((x) => x.address === address)) continue;
			routes.push({ address, destination: typeof o.destination === "string" && /^\S{1,254}$/.test(o.destination.trim()) ? o.destination.trim() : null });
			if (routes.length >= MAX_IDENTITIES) break;
		}
	}
	return {
		provider,
		contractVersion: typeof res.contractVersion === "string" ? res.contractVersion : "unknown",
		accountAddress: normalizeAddress(account.address),
		domains,
		senders: addressList(res.senders).filter(inDomains),
		replyIdentities: addressList(res.replyIdentities).filter(inDomains),
		routes,
		reportedAt: now,
	};
}

// ── Decisions (pure) ────────────────────────────────────────────────────────────────────────

export type SenderRefusalReason = "invalid_address" | "wrong_domain" | "routed_only" | "not_reported" | "not_approved" | "no_approved_sender" | "no_snapshot";

export type SenderDecision = { ok: true; from: string | null } | { ok: false; reason: SenderRefusalReason; message: string };

const FIX_APPROVE = "Approve it for this connection in the console (Connections → Worker-backed email → Approved senders).";

/**
 * May this connection send AS `requested`? For a generic connection, always — there is no policy and
 * `from` (if given) is the adapter's to judge. For Cloudflare, `requested` must be an approved,
 * reported sender; with none given the connection's first approved sender is used, and with none
 * approved nothing is sent: an unconfigured sender is a refusal, never a guess.
 */
export function senderDecision(profile: ConnectionProfile, requested: unknown): SenderDecision {
	if (profile.provider !== "cloudflare") {
		const a = normalizeAddress(requested);
		return { ok: true, from: a };
	}
	const snap = profile.snapshot;
	if (!snap) return { ok: false, reason: "no_snapshot", message: "This Cloudflare connection has not reported its sender identities yet. Test the connection in the console first." };
	let from: string;
	if (requested === undefined || requested === null || requested === "") {
		const first = profile.approvedSenders.find((a) => snap.senders.includes(a));
		if (!first) return { ok: false, reason: "no_approved_sender", message: `No sender is approved for this connection, so nothing is sent. ${FIX_APPROVE}` };
		from = first;
	} else {
		const a = normalizeAddress(requested);
		if (!a) return { ok: false, reason: "invalid_address", message: "from must be a plain email address (no display name)." };
		from = a;
	}
	if (!snap.domains.includes(domainOf(from))) {
		return { ok: false, reason: "wrong_domain", message: `${from} is not on a domain this Cloudflare connection sends for (${snap.domains.join(", ") || "none reported"}), so it was not sent.` };
	}
	if (!snap.senders.includes(from)) {
		const routed = snap.routes.some((r) => r.address === from);
		return routed
			? { ok: false, reason: "routed_only", message: `${from} is an Email Routing address only — Cloudflare routes mail TO it but it is not a send-capable identity, so nothing was sent from it. Send from one of: ${snap.senders.join(", ") || "(none reported)"}.` }
			: { ok: false, reason: "not_reported", message: `${from} is not a sender identity the Cloudflare bridge reports, so it was not sent. Reported senders: ${snap.senders.join(", ") || "(none)"}.` };
	}
	if (!profile.approvedSenders.includes(from)) {
		return { ok: false, reason: "not_approved", message: `${from} is a Cloudflare sender but the owner has not approved it for this connection, so it was not sent. ${FIX_APPROVE}` };
	}
	return { ok: true, from };
}

/** The identity a reply is sent FROM: the configured reply identity, which must itself be an approved sender. */
export function replyDecision(profile: ConnectionProfile): SenderDecision {
	if (profile.provider !== "cloudflare") return { ok: true, from: null };
	if (!profile.replyIdentity) {
		return { ok: false, reason: "no_approved_sender", message: `No reply identity is configured for this connection, so nothing was sent. Choose one in the console (Connections → Worker-backed email → Reply identity).` };
	}
	return senderDecision(profile, profile.replyIdentity);
}

export type RouteDecision = { ok: true; route: EmailRoute } | { ok: false; reason: "no_snapshot" | "unknown_domain" | "unrouted_recipient" };

/**
 * Correlate an inbound message's ORIGINAL recipient to a configured route of THIS connection. A
 * recipient on another domain, or on this domain but with no route here, does not belong to this
 * connection and is a routing failure — the event is recorded as such and never as mail received.
 */
export function routeDecision(profile: ConnectionProfile, recipient: unknown): RouteDecision {
	const snap = profile.snapshot;
	if (profile.provider !== "cloudflare" || !snap) return { ok: false, reason: "no_snapshot" };
	const to = normalizeAddress(recipient);
	if (!to || !snap.domains.includes(domainOf(to))) return { ok: false, reason: "unknown_domain" };
	const route = snap.routes.find((r) => r.address === to);
	return route ? { ok: true, route } : { ok: false, reason: "unrouted_recipient" };
}

/**
 * Validate an owner's approval request against what the bridge reported. Approving an address the
 * bridge does not report as a sender is refused with the reason — in particular a routed-only one.
 */
export function validateApproval(
	snap: IdentitySnapshot | null,
	input: { approvedSenders: unknown; replyIdentity: unknown },
): { ok: true; approvedSenders: string[]; replyIdentity: string | null } | { ok: false; message: string } {
	if (snap?.provider !== "cloudflare") return { ok: false, message: "Only a Cloudflare connection has sender identities to approve. Test the connection first." };
	if (!Array.isArray(input.approvedSenders)) return { ok: false, message: "approvedSenders must be a list of addresses." };
	const approved: string[] = [];
	for (const raw of input.approvedSenders) {
		const a = normalizeAddress(raw);
		if (!a) return { ok: false, message: "approvedSenders contains an entry that is not a plain email address." };
		if (!snap.senders.includes(a)) {
			const why = snap.routes.some((r) => r.address === a) ? "it is an Email Routing address only, not a send-capable identity" : "the bridge does not report it as a sender";
			return { ok: false, message: `${a} cannot be approved: ${why}.` };
		}
		if (!approved.includes(a)) approved.push(a);
	}
	let replyIdentity: string | null = null;
	if (input.replyIdentity !== undefined && input.replyIdentity !== null && input.replyIdentity !== "") {
		replyIdentity = normalizeAddress(input.replyIdentity);
		if (!replyIdentity || !approved.includes(replyIdentity)) return { ok: false, message: "replyIdentity must be one of the approved senders." };
	}
	return { ok: true, approvedSenders: approved, replyIdentity };
}

// ── Storage ─────────────────────────────────────────────────────────────────────────────────

interface ProfileRow {
	provider?: string | null;
	identity_snapshot?: string | null;
	approved_senders?: string | null;
	reply_identity?: string | null;
	last_probe_at?: string | null;
	last_probe_ok?: number | null;
	last_failure_class?: string | null;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

export function profileFromRow(r: ProfileRow | null | undefined): ConnectionProfile {
	if (!r) return GENERIC_PROFILE;
	const snapshot = parseJson<IdentitySnapshot | null>(r.identity_snapshot, null);
	return {
		provider: r.provider === "cloudflare" ? "cloudflare" : "generic",
		snapshot,
		approvedSenders: parseJson<string[]>(r.approved_senders, []).filter((a): a is string => typeof a === "string"),
		replyIdentity: r.reply_identity ?? null,
		health: { lastProbeAt: r.last_probe_at ?? null, lastProbeOk: r.last_probe_ok === null || r.last_probe_ok === undefined ? null : r.last_probe_ok === 1, lastFailureClass: r.last_failure_class ?? null },
	};
}

const PROFILE_COLUMNS = "provider, identity_snapshot, approved_senders, reply_identity, last_probe_at, last_probe_ok, last_failure_class";

/** The connection's sender policy. A missing row, or one from before 0271, is a generic profile. */
export async function loadProfile(env: Env, userId: string, endpoint: string, accountId: string): Promise<ConnectionProfile> {
	try {
		const row = await env.DB.prepare(`SELECT ${PROFILE_COLUMNS} FROM email_worker_connections WHERE user_id = ?1 AND endpoint = ?2 AND account_id = ?3`).bind(userId, endpoint, accountId).first<ProfileRow>();
		return profileFromRow(row);
	} catch {
		return GENERIC_PROFILE;
	}
}

/**
 * Record a successful identity probe: the bridge's own report, and health. When the SET OF SENDERS
 * the bridge reports shrinks, owner approvals for addresses it no longer reports are dropped — an
 * approval must never outlive the bridge's own statement that the address can send.
 */
export async function recordProbeSuccess(env: Env, userId: string, endpoint: string, accountId: string, snap: IdentitySnapshot): Promise<void> {
	const current = await loadProfile(env, userId, endpoint, accountId);
	const approved = current.approvedSenders.filter((a) => snap.senders.includes(a));
	const reply = current.replyIdentity && approved.includes(current.replyIdentity) ? current.replyIdentity : null;
	await env.DB.prepare(
		`UPDATE email_worker_connections SET provider = ?4, identity_snapshot = ?5, approved_senders = ?6, reply_identity = ?7,
		   last_probe_at = datetime('now'), last_probe_ok = 1, last_failure_class = NULL, updated_at = datetime('now')
		 WHERE user_id = ?1 AND endpoint = ?2 AND account_id = ?3`,
	)
		.bind(userId, endpoint, accountId, snap.provider, JSON.stringify(snap), JSON.stringify(approved), reply)
		.run();
}

/** Record that the bridge could not be reached / refused. Health only — the last good snapshot stays. */
export async function recordProbeFailure(env: Env, userId: string, endpoint: string, accountId: string, failureClass: string): Promise<void> {
	await env.DB.prepare(
		`UPDATE email_worker_connections SET last_probe_at = datetime('now'), last_probe_ok = 0, last_failure_class = ?4
		 WHERE user_id = ?1 AND endpoint = ?2 AND account_id = ?3`,
	)
		.bind(userId, endpoint, accountId, failureClass)
		.run()
		.catch(() => undefined);
}

export async function saveApproval(env: Env, userId: string, endpoint: string, accountId: string, approvedSenders: string[], replyIdentity: string | null): Promise<void> {
	await env.DB.prepare(
		`UPDATE email_worker_connections SET approved_senders = ?4, reply_identity = ?5, updated_at = datetime('now') WHERE user_id = ?1 AND endpoint = ?2 AND account_id = ?3`,
	)
		.bind(userId, endpoint, accountId, JSON.stringify(approvedSenders), replyIdentity)
		.run();
}
