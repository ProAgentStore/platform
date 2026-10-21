// The store behind the account approval gate (#1268): a held change, its decision and its audit trail.
//
// Every transition is ONE conditional UPDATE (`... WHERE status = <from>`) whose affected-row count is the answer, so two
// taps, a retried approval and a racing expiry cannot both win. The lifecycle:
//
//   pending ─approve→ approved ─claim→ (applied_at set) ─replay→ applied | failed
//      ├─deny→ denied     ├─cancel→ cancelled     └─(expires_at passes)→ expired
//
// `applied_at` is set by the claim BEFORE the stored change runs, never after: a worker that dies mid-replay leaves a row
// that reads "approved, claimed" and is never run a second time. At-most-once is the property an irreversible config
// change needs; the owner can see the stuck state in the audit and ask again.
import type { Env } from "../types.js";
import { decryptKey, encryptKey } from "./crypto.js";
import { stableStringify } from "./stable-json.js";
import type { DiffPreview } from "./approval-gate.js";

export type ChangeStatus = "pending" | "approved" | "denied" | "cancelled" | "applied" | "expired" | "failed";

export interface ChangeRequest {
	id: string;
	userId: string;
	actorUserId: string;
	action: string;
	targetDescription: string;
	method: string;
	path: string;
	bodyEncrypted: string;
	diffPreview: DiffPreview | Record<string, never>;
	beforeFingerprint: string;
	requestFingerprint: string;
	status: ChangeStatus;
	expiresAt: number;
	decidedByDevice: string | null;
	createdAt: number;
	decidedAt: number | null;
	appliedAt: number | null;
	applyStatus: number | null;
	applyResult: string | null;
}

const b64 = (bytes: Uint8Array): string => {
	let s = "";
	for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return btoa(s);
};
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** What a replay needs besides the path: the exact body and the headers that change how a route behaves. */
export interface HeldPayload {
	body: string;
	contentType: string | null;
	/** `X-PAGS-Client` as the original caller sent it, so a coding-API policy that treats MCP differently still does. */
	client: string | null;
}

export async function sealPayload(env: Env, payload: HeldPayload): Promise<string | null> {
	if (!env.KEY_ENCRYPTION_KEY) return null;
	const sealed = await encryptKey(JSON.stringify(payload), env.KEY_ENCRYPTION_KEY);
	return JSON.stringify({ c: b64(sealed.ciphertext), d: b64(sealed.dekWrapped), i: b64(sealed.iv) });
}

export async function openPayload(env: Env, sealed: string): Promise<HeldPayload | null> {
	if (!env.KEY_ENCRYPTION_KEY) return null;
	try {
		const { c, d, i } = JSON.parse(sealed) as { c: string; d: string; i: string };
		return JSON.parse(await decryptKey(unb64(c), unb64(d), unb64(i), env.KEY_ENCRYPTION_KEY)) as HeldPayload;
	} catch {
		return null;
	}
}

function asRequest(r: Record<string, unknown>): ChangeRequest {
	let preview: ChangeRequest["diffPreview"] = {};
	try {
		preview = JSON.parse(String(r.diff_preview ?? "{}")) as ChangeRequest["diffPreview"];
	} catch {
		preview = {};
	}
	const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
	return {
		id: String(r.id),
		userId: String(r.user_id),
		actorUserId: String(r.actor_user_id),
		action: String(r.action),
		targetDescription: String(r.target_description ?? ""),
		method: String(r.method),
		path: String(r.path),
		bodyEncrypted: String(r.body_encrypted),
		diffPreview: preview,
		beforeFingerprint: String(r.before_fingerprint),
		requestFingerprint: String(r.request_fingerprint),
		status: String(r.status) as ChangeStatus,
		expiresAt: Number(r.expires_at),
		decidedByDevice: r.decided_by_device ? String(r.decided_by_device) : null,
		createdAt: Number(r.created_at),
		decidedAt: num(r.decided_at),
		appliedAt: num(r.applied_at),
		applyStatus: num(r.apply_status),
		applyResult: r.apply_result ? String(r.apply_result) : null,
	};
}

export async function recordEvent(env: Env, req: Pick<ChangeRequest, "id" | "userId">, event: string, actor: string, detail: Record<string, unknown> = {}, now = Date.now()): Promise<void> {
	await env.DB.prepare("INSERT INTO account_change_events (id, request_id, user_id, event, actor, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
		.bind(crypto.randomUUID(), req.id, req.userId, event, actor, stableStringify(detail), now)
		.run();
}

export async function getChange(env: Env, id: string, userId: string): Promise<ChangeRequest | null> {
	const row = await env.DB.prepare("SELECT * FROM account_change_requests WHERE id = ?1 AND user_id = ?2").bind(id, userId).first<Record<string, unknown>>();
	return row ? asRequest(row) : null;
}

export async function listChanges(env: Env, userId: string, limit = 30): Promise<ChangeRequest[]> {
	const { results } = await env.DB.prepare("SELECT * FROM account_change_requests WHERE user_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2").bind(userId, limit).all<Record<string, unknown>>();
	return (results ?? []).map(asRequest);
}

export async function listEvents(env: Env, requestId: string, userId: string): Promise<Array<{ event: string; actor: string; detail: unknown; at: number }>> {
	const { results } = await env.DB.prepare("SELECT event, actor, detail, created_at FROM account_change_events WHERE request_id = ?1 AND user_id = ?2 ORDER BY created_at, rowid").bind(requestId, userId).all<{ event: string; actor: string; detail: string; created_at: number }>();
	return (results ?? []).map((e) => ({ event: e.event, actor: e.actor, detail: safeJson(e.detail), at: e.created_at }));
}

const safeJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
};

export interface NewChange {
	userId: string;
	actorUserId: string;
	action: string;
	targetDescription: string;
	method: string;
	path: string;
	bodyEncrypted: string;
	diffPreview: DiffPreview;
	beforeFingerprint: string;
	requestFingerprint: string;
	expiresAt: number;
}

/** One pending request per exact change: a retry (or an agent asking again) gets the same id back, not a second push. */
export async function createChange(env: Env, x: NewChange, now = Date.now()): Promise<{ request: ChangeRequest; reused: boolean }> {
	const find = () => env.DB.prepare("SELECT * FROM account_change_requests WHERE user_id = ?1 AND request_fingerprint = ?2 AND status = 'pending' AND expires_at > ?3").bind(x.userId, x.requestFingerprint, now).first<Record<string, unknown>>();
	const existing = await find();
	if (existing) {
		const request = asRequest(existing);
		await recordEvent(env, request, "request.reused", x.actorUserId, {}, now);
		return { request, reused: true };
	}
	// A pending row whose time ran out still holds the unique slot until something notices; free it first.
	await env.DB.prepare("UPDATE account_change_requests SET status = 'expired', decided_at = ?3 WHERE user_id = ?1 AND request_fingerprint = ?2 AND status = 'pending' AND expires_at <= ?3").bind(x.userId, x.requestFingerprint, now).run();
	const id = crypto.randomUUID();
	try {
		await env.DB.prepare(
			`INSERT INTO account_change_requests (id, user_id, actor_user_id, action, target_description, method, path, body_encrypted, diff_preview, before_fingerprint, request_fingerprint, status, expires_at, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, ?13)`,
		).bind(id, x.userId, x.actorUserId, x.action, x.targetDescription, x.method, x.path, x.bodyEncrypted, JSON.stringify(x.diffPreview), x.beforeFingerprint, x.requestFingerprint, x.expiresAt, now).run();
	} catch {
		const raced = await find();
		if (raced) return { request: asRequest(raced), reused: true };
		throw new Error("The approval request could not be saved.");
	}
	const request = (await getChange(env, id, x.userId))!;
	await recordEvent(env, request, "request.created", x.actorUserId, { action: x.action, target: x.targetDescription, expiresAt: x.expiresAt }, now);
	return { request, reused: false };
}

const changed = (r: { meta?: { changes?: number } }): boolean => (r.meta?.changes ?? 0) === 1;

/** Lazily expire one request that ran out of time. True when THIS call expired it. */
export async function expireIfDue(env: Env, req: ChangeRequest, now = Date.now()): Promise<ChangeRequest> {
	if (req.status !== "pending" || req.expiresAt > now) return req;
	const res = await env.DB.prepare("UPDATE account_change_requests SET status = 'expired', decided_at = ?3 WHERE id = ?1 AND user_id = ?2 AND status = 'pending' AND expires_at <= ?3").bind(req.id, req.userId, now).run();
	if (changed(res)) await recordEvent(env, req, "request.expired", "system", {}, now);
	return (await getChange(env, req.id, req.userId)) ?? req;
}

/** Expire every due pending request for an owner — run on list/poll so the audit and the status never lag. */
export async function expireDueFor(env: Env, userId: string, now = Date.now()): Promise<void> {
	const { results } = await env.DB.prepare("SELECT * FROM account_change_requests WHERE user_id = ?1 AND status = 'pending' AND expires_at <= ?2").bind(userId, now).all<Record<string, unknown>>();
	for (const row of results ?? []) await expireIfDue(env, asRequest(row), now);
}

/** pending → approved, only while unexpired. False when it was not pending or time ran out (the caller re-reads to say which). */
export async function approveChange(env: Env, req: ChangeRequest, device: string, now = Date.now()): Promise<boolean> {
	const res = await env.DB.prepare("UPDATE account_change_requests SET status = 'approved', decided_at = ?3, decided_by_device = ?4 WHERE id = ?1 AND user_id = ?2 AND status = 'pending' AND expires_at > ?3").bind(req.id, req.userId, now, device).run();
	if (!changed(res)) return false;
	await recordEvent(env, req, "decision.approved", req.userId, { device }, now);
	return true;
}

export async function denyChange(env: Env, req: ChangeRequest, device: string, now = Date.now()): Promise<boolean> {
	const res = await env.DB.prepare("UPDATE account_change_requests SET status = 'denied', decided_at = ?3, decided_by_device = ?4 WHERE id = ?1 AND user_id = ?2 AND status = 'pending'").bind(req.id, req.userId, now, device).run();
	if (!changed(res)) return false;
	await recordEvent(env, req, "decision.denied", req.userId, { device }, now);
	return true;
}

export async function cancelChange(env: Env, req: ChangeRequest, actor: string, now = Date.now()): Promise<boolean> {
	const res = await env.DB.prepare("UPDATE account_change_requests SET status = 'cancelled', decided_at = ?3 WHERE id = ?1 AND user_id = ?2 AND status = 'pending'").bind(req.id, req.userId, now).run();
	if (!changed(res)) return false;
	await recordEvent(env, req, "request.cancelled", actor, {}, now);
	return true;
}

/** The exactly-once claim: only one caller ever gets true for a request, and only from `approved`. */
export async function claimApply(env: Env, req: ChangeRequest, now = Date.now()): Promise<boolean> {
	const res = await env.DB.prepare("UPDATE account_change_requests SET applied_at = ?3 WHERE id = ?1 AND user_id = ?2 AND status = 'approved' AND applied_at IS NULL").bind(req.id, req.userId, now).run();
	if (!changed(res)) return false;
	await recordEvent(env, req, "apply.started", req.userId, {}, now);
	return true;
}

export async function finishApply(env: Env, req: ChangeRequest, outcome: { ok: boolean; status: number; result: string }, now = Date.now()): Promise<void> {
	await env.DB.prepare("UPDATE account_change_requests SET status = ?3, apply_status = ?4, apply_result = ?5 WHERE id = ?1 AND user_id = ?2 AND status = 'approved'")
		.bind(req.id, req.userId, outcome.ok ? "applied" : "failed", outcome.status, outcome.result)
		.run();
	await recordEvent(env, req, outcome.ok ? "apply.succeeded" : "apply.failed", req.userId, { status: outcome.status }, now);
}

/** An approved request whose target moved is never applied; it ends `failed` with the reason on the record. */
export async function failApproved(env: Env, req: ChangeRequest, reason: string, now = Date.now()): Promise<void> {
	const res = await env.DB.prepare("UPDATE account_change_requests SET status = 'failed', apply_status = 409, apply_result = ?3 WHERE id = ?1 AND user_id = ?2 AND status = 'approved' AND applied_at IS NULL").bind(req.id, req.userId, reason).run();
	if (changed(res)) await recordEvent(env, req, "apply.refused", "system", { reason }, now);
}

/** The owner-facing view: never the body, never the ciphertext. */
export function changeView(req: ChangeRequest, pollBase = "/v1/approvals") {
	return {
		id: req.id,
		status: req.status,
		action: req.action,
		target: req.targetDescription,
		method: req.method,
		path: req.path,
		diff: req.diffPreview,
		expiresAt: new Date(req.expiresAt).toISOString(),
		createdAt: new Date(req.createdAt).toISOString(),
		decidedAt: req.decidedAt ? new Date(req.decidedAt).toISOString() : null,
		decidedByDevice: req.decidedByDevice,
		applying: req.status === "approved" && req.appliedAt !== null,
		appliedAt: req.appliedAt ? new Date(req.appliedAt).toISOString() : null,
		result: req.applyStatus === null ? null : { status: req.applyStatus, detail: req.applyResult },
		poll: `${pollBase}/${req.id}`,
	};
}
