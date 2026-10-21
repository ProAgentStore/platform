// Append-only receipts for the worker-backed email connector (#1270) — table
// `email_worker_receipts` (migration 0271), whose triggers abort every UPDATE and DELETE.
//
// A receipt says which connection did what, to which stable ids, and how it ended. It is the audit
// trail the issue asks for ("sends, delivery outcomes, inbound messages, and routing/bridge
// failures") and the substrate for outbound idempotency: an accepted send is the one `sent` row per
// (owner, endpoint, account, idempotency_key), so a retry finds it and is answered from it instead
// of reaching the wire again.
//
// What a receipt may hold is fixed by `ReceiptInput`, which has NO free-text field: ids, addresses
// (the issue requires the ORIGINAL sender and recipient be preserved), an outcome and a failure
// class. A message body, a subject, a secret and adapter response text cannot be passed in.
//
// Only INSERT and SELECT exist in this module on purpose. A retry is a new `deduped` row, never an
// edit of the first.
import type { Env } from "../types.js";

export type ReceiptKind = "list" | "read" | "identities" | "send" | "reply" | "inbound" | "delivery" | "routing_failure" | "bridge_failure" | "refusal";
export type ReceiptOutcome = "ok" | "sent" | "failed" | "refused" | "deduped";

export interface ReceiptInput {
	userId: string;
	instanceId?: string | null;
	endpoint?: string;
	accountId?: string;
	kind: ReceiptKind;
	outcome: ReceiptOutcome;
	failureClass?: string | null;
	messageId?: string | null;
	threadId?: string | null;
	/** The provider's own id for an accepted send (Cloudflare Email Sending's message id). */
	providerReceiptId?: string | null;
	eventId?: string | null;
	fromAddress?: string | null;
	toAddress?: string | null;
	idempotencyKey?: string | null;
}

export interface ReceiptView {
	id: string;
	createdAt: string;
	instanceId: string;
	endpoint: string;
	accountId: string;
	kind: ReceiptKind;
	outcome: ReceiptOutcome;
	failureClass: string | null;
	messageId: string | null;
	threadId: string | null;
	providerReceiptId: string | null;
	eventId: string | null;
	fromAddress: string | null;
	toAddress: string | null;
	idempotencyKey: string | null;
}

type Row = {
	id: string;
	created_at: string;
	instance_id: string;
	endpoint: string;
	account_id: string;
	kind: ReceiptKind;
	outcome: ReceiptOutcome;
	failure_class: string | null;
	message_id: string | null;
	thread_id: string | null;
	provider_receipt_id: string | null;
	event_id: string | null;
	from_address: string | null;
	to_address: string | null;
	idempotency_key: string | null;
};

const COLUMNS = "id, created_at, instance_id, endpoint, account_id, kind, outcome, failure_class, message_id, thread_id, provider_receipt_id, event_id, from_address, to_address, idempotency_key";

const view = (r: Row): ReceiptView => ({
	id: r.id,
	createdAt: r.created_at,
	instanceId: r.instance_id,
	endpoint: r.endpoint,
	accountId: r.account_id,
	kind: r.kind,
	outcome: r.outcome,
	failureClass: r.failure_class,
	messageId: r.message_id,
	threadId: r.thread_id,
	providerReceiptId: r.provider_receipt_id,
	eventId: r.event_id,
	fromAddress: r.from_address,
	toAddress: r.to_address,
	idempotencyKey: r.idempotency_key,
});

/** Insert one receipt. Throws on a store error — callers decide whether that is fatal. */
export async function insertReceipt(env: Env, r: ReceiptInput): Promise<string> {
	const id = `ewr_${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO email_worker_receipts
		   (id, user_id, instance_id, endpoint, account_id, kind, outcome, failure_class, message_id, thread_id, provider_receipt_id, event_id, from_address, to_address, idempotency_key)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
	)
		.bind(id, r.userId, r.instanceId ?? "", r.endpoint ?? "", r.accountId ?? "", r.kind, r.outcome, r.failureClass ?? null, r.messageId ?? null, r.threadId ?? null, r.providerReceiptId ?? null, r.eventId ?? null, r.fromAddress ?? null, r.toAddress ?? null, r.idempotencyKey ?? null)
		.run();
	return id;
}

/** A receipt that must never fail the call it describes (a read, a refusal, a failure). Reports whether it landed. */
export async function recordReceipt(env: Env, r: ReceiptInput): Promise<boolean> {
	try {
		await insertReceipt(env, r);
		return true;
	} catch {
		return false;
	}
}

/** The earlier ACCEPTED send for this intent, if any. */
export async function findSentReceipt(env: Env, userId: string, endpoint: string, accountId: string, idempotencyKey: string): Promise<ReceiptView | null> {
	const row = await env.DB.prepare(
		`SELECT ${COLUMNS} FROM email_worker_receipts WHERE user_id = ?1 AND endpoint = ?2 AND account_id = ?3 AND idempotency_key = ?4 AND outcome = 'sent' LIMIT 1`,
	)
		.bind(userId, endpoint, accountId, idempotencyKey)
		.first<Row>();
	return row ? view(row) : null;
}

/** Is this the partial unique index refusing a second accepted receipt for one intent? */
export function isDuplicateSend(e: unknown): boolean {
	return e instanceof Error && /UNIQUE|constraint/i.test(e.message);
}

export interface ReceiptFilter {
	userId: string;
	endpoint?: string;
	accountId?: string;
	kind?: string;
	outcome?: string;
	since?: string;
	until?: string;
	/** Keyset cursor `created_at|rowid` from the previous page's `nextBefore`. */
	before?: string;
	limit?: number;
}

const sqlTime = (iso: string): string => iso.replace("T", " ").replace(/\.\d+Z?$/, "").replace(/Z$/, "");

/** Newest first, owner-scoped. Ties within a second break on insertion order (rowid), not on the random id. */
export async function listReceipts(env: Env, f: ReceiptFilter): Promise<{ receipts: ReceiptView[]; nextBefore: string | null }> {
	const where = ["user_id = ?1"];
	const args: unknown[] = [f.userId];
	const add = (clause: string, v: unknown) => {
		args.push(v);
		where.push(clause.replace("?", `?${args.length}`));
	};
	if (f.endpoint) add("endpoint = ?", f.endpoint);
	if (f.accountId !== undefined) add("account_id = ?", f.accountId);
	if (f.kind) add("kind = ?", f.kind);
	if (f.outcome) add("outcome = ?", f.outcome);
	if (f.since) add("created_at >= ?", sqlTime(f.since));
	if (f.until) add("created_at < ?", sqlTime(f.until));
	if (f.before) {
		const [at, rid] = f.before.split("|");
		if (at && /^\d+$/.test(rid ?? "")) {
			args.push(at, Number(rid));
			where.push(`(created_at < ?${args.length - 1} OR (created_at = ?${args.length - 1} AND rowid < ?${args.length}))`);
		}
	}
	const limit = Math.max(1, Math.min(200, f.limit ?? 50));
	const rows = await env.DB.prepare(`SELECT rowid AS rid, ${COLUMNS} FROM email_worker_receipts WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ${limit + 1}`)
		.bind(...args)
		.all<Row & { rid: number }>();
	const page = rows.results ?? [];
	const shown = page.slice(0, limit);
	const last = shown[shown.length - 1];
	return { receipts: shown.map(view), nextBefore: page.length > limit && last ? `${last.created_at}|${last.rid}` : null };
}
