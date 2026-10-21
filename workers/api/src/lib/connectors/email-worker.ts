// Worker-backed email connector (#1269) — a customer-owned HTTPS Worker stands in for a Google
// mailbox when there is none to OAuth against. FreeAppStore is the motivating case: its mail is
// Cloudflare Email Routing behind a Worker, not Gmail, so an owner there could never use the
// `gmail` connector no matter how much permission they granted it.
//
// THE ADAPTER CONTRACT the Worker implements is published as data, not just prose — see
// platform-docs/email-worker-adapter.md and the reference fixture `email-worker.fixture.ts` used
// by this module's own tests. Four calls, all POSTed to the owner's configured `endpoint`, all
// Bearer-authenticated with the secret the owner pasted when connecting:
//
//   POST {endpoint}/v1/email-worker/identity        → account identity + contractVersion
//   POST {endpoint}/v1/email-worker/messages/list    → { messages: [...], nextCursor }
//   POST {endpoint}/v1/email-worker/messages/get     → one message, with its attachments manifest
//   POST {endpoint}/v1/email-worker/messages/send    → a NEW message (idempotencyKey required)
//   POST {endpoint}/v1/email-worker/messages/reply   → a reply, threaded (idempotencyKey required)
//
// WHY NO ENDPOINT/ACCOUNT ARGUMENT ON THE TOOLS, unlike the generic `mcp` connector where the
// server is a tool input. A mailbox is "pin ONE to this agent instance", the same shape Gmail
// already has — so the model is never shown an endpoint or a secret, full stop. Which connection
// a call uses is resolved server-side by `resolveEmailWorkerConnection`
// (lib/email-worker-connections.ts); see that module's header for the refusal discipline.
//
// CREDENTIAL POSTURE (#1269 AC1/AC4). The bearer secret never reaches a prompt, chat history, a
// tool result or a log line: handlers read it once, inside `callAdapter`, to build an
// Authorization header, and nothing below that point ever serializes it. `logEvent` below is the
// audit receipt the issue asks for — endpoint, account, message/thread ids, outcome, failure
// class — and deliberately carries no message body and no secret.
//
// EVERY OUTBOUND CALL GOES THROUGH safeFetch (SSRF guard, https-only, redirect-revalidated), the
// same as every other connector whose target is owner-supplied — a pasted worker URL is exactly
// as attacker-reachable as a pipeline-supplied MCP endpoint.
//
// IDEMPOTENT SENDS (#1269 AC5). `send`/`reply` mint ONE idempotencyKey per logical call and reuse
// it across the (bounded) retry this module performs on a transient failure, so a retried POST
// and the original are the same request as far as the adapter contract is concerned — the spec
// requires the Worker to treat a repeated key as "return the first result", never a second send.
import type { Connector, RegistryToolCtx, RegistryToolResult, ToolDef } from "./types.js";
import { safeFetch, SsrfError } from "../ssrf.js";
import { clipMarked } from "../clip-marked.js";
import { logEvent } from "../events.js";
import { resolveEmailWorkerConnection, resolveEmailWorkerSecret } from "../email-worker-connections.js";
import { type ConnectionProfile, type IdentitySnapshot, loadProfile, parseIdentity, recordProbeFailure, replyDecision, senderDecision, type SenderDecision } from "../email-worker-identities.js";
import { findSentReceipt, insertReceipt, isDuplicateSend, listReceipts, recordReceipt, type ReceiptKind } from "../email-worker-receipts.js";

function fail(message: string): RegistryToolResult {
	return { content: message, success: false };
}

function ok(payload: unknown): RegistryToolResult {
	return { content: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2), success: true };
}

/** One call's outcome, for the audit receipt — never the body, never the secret. */
type Outcome = "ok" | "refused" | "adapter_error";
/** Why an adapter call failed, the one thing a retry loop cares about — see DeliveryFailureKind. */
type FailureClass = "auth" | "transient" | "protocol" | null;

async function auditReceipt(
	ctx: RegistryToolCtx,
	e: { event: string; endpoint?: string; accountId?: string; messageId?: string; threadId?: string; outcome: Outcome; failureClass?: FailureClass; message?: string },
): Promise<void> {
	await logEvent(ctx.env, {
		source: "email-worker",
		event: e.event,
		level: e.outcome === "ok" ? "info" : "warn",
		message: e.message,
		userId: ctx.userId ?? null,
		instanceId: ctx.instanceId ?? null,
		traceId: ctx.traceId ?? null,
		context: {
			connector: "email-worker",
			...(e.endpoint ? { endpoint: e.endpoint } : {}),
			...(e.accountId ? { accountId: e.accountId } : {}),
			...(e.messageId ? { messageId: e.messageId } : {}),
			...(e.threadId ? { threadId: e.threadId } : {}),
			outcome: e.outcome,
			...(e.failureClass ? { failureClass: e.failureClass } : {}),
		},
	}).catch(() => undefined);
}

/** The shape every adapter error response carries (AC3/AC4): a code + message, no HTML, no stack. */
interface AdapterErrorBody {
	error?: { code?: string; message?: string };
}

export class AdapterError extends Error {
	readonly failureClass: FailureClass;
	constructor(message: string, failureClass: FailureClass) {
		super(message);
		this.failureClass = failureClass;
	}
}

/** POST one adapter call. Bearer-authenticated, SSRF-guarded, JSON in and out.
 *
 * Retries EXACTLY ONCE, and only on a network failure or a 5xx — never on a 4xx, which is the
 * adapter's own considered refusal and retrying it would just ask the same question twice. The
 * caller supplies `idempotencyKey` up front (for send/reply) so the retry is indistinguishable
 * from the original request at the adapter's end. */
async function callAdapter(endpoint: string, secret: string, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const url = `${endpoint}${path}`;
	let lastErr: AdapterError | null = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await safeFetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
				body: JSON.stringify(body),
			});
			if (res.status === 401 || res.status === 403) {
				throw new AdapterError(`The worker rejected this connection's secret (HTTP ${res.status}).`, "auth");
			}
			if (res.status >= 500) {
				lastErr = new AdapterError(`The worker returned a server error (HTTP ${res.status}).`, "transient");
				continue; // one retry, same idempotencyKey already baked into `body`
			}
			if (!res.ok) {
				const parsed = (await res.json().catch(() => ({}))) as AdapterErrorBody;
				throw new AdapterError(parsed.error?.message || `The worker refused this call (HTTP ${res.status}).`, "protocol");
			}
			return (await res.json()) as Record<string, unknown>;
		} catch (e) {
			if (e instanceof AdapterError) throw e;
			if (e instanceof SsrfError) throw new AdapterError(`The configured worker address is not reachable: ${e.message}`, "protocol");
			lastErr = new AdapterError(`Could not reach the worker: ${e instanceof Error ? e.message : String(e)}`, "transient");
		}
	}
	throw lastErr ?? new AdapterError("The worker call failed.", "transient");
}

/** Probe `/v1/email-worker/identity` — the connect-time AND standalone-test call (AC1). Shared by
 *  the routes (add/test a connection) and exported so a route need not reimplement auth/parsing. */
export async function probeEmailWorkerIdentity(
	endpoint: string,
	secret: string,
): Promise<{ ok: true; contractVersion: string; address: string | null; snapshot: IdentitySnapshot } | { ok: false; error: string; failureClass: string }> {
	try {
		const res = await callAdapter(endpoint, secret, "/v1/email-worker/identity", {});
		const contractVersion = typeof res.contractVersion === "string" ? res.contractVersion : "unknown";
		const account = (res.account ?? {}) as { address?: unknown };
		// The snapshot is the bridge's own report of the customer's Cloudflare identities (#1270): which addresses
		// can SEND, which only ROUTE, and on which domains. A generic worker simply reports none of that.
		return { ok: true, contractVersion, address: typeof account.address === "string" ? account.address : null, snapshot: parseIdentity(res) };
	} catch (e) {
		const failureClass = e instanceof AdapterError ? healthClass(e.failureClass) : "bridge_unavailable";
		return { ok: false, error: e instanceof Error ? e.message : String(e), failureClass };
	}
}

/** The health label for a failed adapter call: "bridge_unavailable" is the one an owner acts on differently. */
function healthClass(c: FailureClass): string {
	return c === "transient" ? "bridge_unavailable" : (c ?? "protocol");
}

interface ResolvedConnection {
	endpoint: string;
	accountId: string;
	secret: string;
	profile: ConnectionProfile;
}

/** Resolve the pinned connection + its secret + its sender policy, or the refusal to return — AC3's
 *  "wrong instance pin" case, always caught here before any wire call is made. */
async function resolveConnection(ctx: RegistryToolCtx, kind: ReceiptKind): Promise<ResolvedConnection | { refusal: RegistryToolResult }> {
	if (!ctx.env || !ctx.userId) return { refusal: fail("This requires an authenticated user context.") };
	const resolved = await resolveEmailWorkerConnection(ctx.env, ctx.userId, ctx.instanceId);
	if (!resolved.ok) {
		await recordReceipt(ctx.env, { userId: ctx.userId, instanceId: ctx.instanceId, kind, outcome: "refused", failureClass: `pin_${resolved.reason}` });
		return { refusal: fail(resolved.message) };
	}
	const secret = await resolveEmailWorkerSecret(ctx.env, ctx.userId, resolved.endpoint, resolved.accountId);
	if (!secret) return { refusal: fail(`The connection "${resolved.label}" has no usable secret stored. Reconnect it in the console.`) };
	const profile = await loadProfile(ctx.env, ctx.userId, resolved.endpoint, resolved.accountId);
	return { endpoint: resolved.endpoint, accountId: resolved.accountId, secret, profile };
}

async function sha256Hex(s: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * The idempotency key for one send INTENT (#1270 "stable idempotency"). A caller-supplied
 * `idempotency_key` wins — the way to deliberately send identical words twice is to pass a different
 * one. Otherwise it is derived from the run and the content, so the SAME call retried (a timeout, a
 * re-delivered tool call, the model asking twice) maps to the same key and is answered from the
 * first accepted receipt, while the same words in another run do not collide. This replaces a random
 * key per call, which made every retry a new send.
 */
async function intentKey(ctx: RegistryToolCtx, r: ResolvedConnection, tool: string, parts: string[], supplied: unknown): Promise<string | { error: string }> {
	if (typeof supplied === "string" && supplied.trim()) {
		return KEY_RE.test(supplied.trim()) ? supplied.trim() : { error: "idempotency_key must be 8–128 characters of letters, digits, '.', '_', ':' or '-'." };
	}
	return `auto_${await sha256Hex([ctx.userId ?? "", ctx.instanceId ?? "", r.endpoint, r.accountId, tool, ctx.traceId ?? "", ...parts].join("\u0000"))}`;
}

function toAdapterError(e: unknown): AdapterError {
	return e instanceof AdapterError ? e : new AdapterError(String(e), "transient");
}

/**
 * A failed adapter call. Records the failure as the connection's HEALTH (so an unreachable bridge is
 * shown, not discovered), as an append-only receipt, and as the audit event, and returns the error
 * for the tool result — which carries the adapter's message only, never a secret or a body.
 */
async function adapterFailure(
	ctx: RegistryToolCtx,
	r: ResolvedConnection,
	kind: ReceiptKind,
	event: string,
	e: unknown,
	extra: { messageId?: string; idempotencyKey?: string; fromAddress?: string | null; toAddress?: string | null } = {},
): Promise<AdapterError> {
	const err = toAdapterError(e);
	const failureClass = healthClass(err.failureClass);
	await Promise.all([
		recordProbeFailure(ctx.env, ctx.userId ?? "", r.endpoint, r.accountId, failureClass),
		recordReceipt(ctx.env, { userId: ctx.userId ?? "", instanceId: ctx.instanceId, endpoint: r.endpoint, accountId: r.accountId, kind, outcome: "failed", failureClass, messageId: extra.messageId, idempotencyKey: extra.idempotencyKey, fromAddress: extra.fromAddress, toAddress: extra.toAddress }),
		auditReceipt(ctx, { event, endpoint: r.endpoint, accountId: r.accountId, messageId: extra.messageId, outcome: "adapter_error", failureClass: err.failureClass, message: err.message }),
	]);
	return err;
}

/** A sender-policy refusal: nothing reaches the wire. Recorded with its reason so the ways a send can
 *  be stopped (denied sender, routed-only alias, wrong domain, no approval) stay distinguishable. */
async function senderRefusal(ctx: RegistryToolCtx, r: ResolvedConnection, kind: ReceiptKind, d: Extract<SenderDecision, { ok: false }>, requested: unknown, toAddress?: string): Promise<RegistryToolResult> {
	await recordReceipt(ctx.env, {
		userId: ctx.userId ?? "",
		instanceId: ctx.instanceId,
		endpoint: r.endpoint,
		accountId: r.accountId,
		kind,
		outcome: "refused",
		failureClass: `sender_${d.reason}`,
		fromAddress: typeof requested === "string" ? clipMarked(requested.trim().toLowerCase(), 254) : null,
		toAddress,
	});
	return fail(d.message);
}

const listHandler: ToolDef["handler"] = async (ctx, input) => {
	const resolved = await resolveConnection(ctx, "list");
	if ("refusal" in resolved) return resolved.refusal;
	try {
		const res = await callAdapter(resolved.endpoint, resolved.secret, "/v1/email-worker/messages/list", {
			folder: typeof input.folder === "string" ? input.folder : undefined,
			cursor: typeof input.cursor === "string" ? input.cursor : undefined,
			limit: typeof input.limit === "number" ? input.limit : 10,
		});
		await Promise.all([
			auditReceipt(ctx, { event: "email.list", endpoint: resolved.endpoint, accountId: resolved.accountId, outcome: "ok" }),
			recordReceipt(ctx.env, { userId: ctx.userId ?? "", instanceId: ctx.instanceId, endpoint: resolved.endpoint, accountId: resolved.accountId, kind: "list", outcome: "ok" }),
		]);
		return ok(res);
	} catch (e) {
		return fail((await adapterFailure(ctx, resolved, "list", "email.list", e)).message);
	}
};

const readHandler: ToolDef["handler"] = async (ctx, input) => {
	const id = typeof input.message_id === "string" ? input.message_id.trim() : "";
	if (!id) return fail("message_id is required — get one from email_worker_list_messages.");
	const resolved = await resolveConnection(ctx, "read");
	if ("refusal" in resolved) return resolved.refusal;
	try {
		const res = await callAdapter(resolved.endpoint, resolved.secret, "/v1/email-worker/messages/get", { id });
		await Promise.all([
			auditReceipt(ctx, { event: "email.read", endpoint: resolved.endpoint, accountId: resolved.accountId, messageId: id, outcome: "ok" }),
			recordReceipt(ctx.env, { userId: ctx.userId ?? "", instanceId: ctx.instanceId, endpoint: resolved.endpoint, accountId: resolved.accountId, kind: "read", outcome: "ok", messageId: id, threadId: typeof res.threadId === "string" ? res.threadId : null }),
		]);
		return { ...ok(res), success: true, content: JSON.stringify(res, null, 2) };
	} catch (e) {
		return fail((await adapterFailure(ctx, resolved, "read", "email.read", e, { messageId: id })).message);
	}
};

/**
 * The shared tail of send and reply: stable idempotency, the adapter call, and the accepted receipt.
 *
 * The receipt table IS the idempotency record. A retry finds the earlier accepted receipt and is
 * answered from it WITHOUT reaching the wire; the partial unique index settles a race between two
 * retries. The same key also rides in the request body, so a bridge that accepted a send whose reply
 * was lost does not deliver twice when PAGS retries (the contract requires it).
 */
async function deliver(
	ctx: RegistryToolCtx,
	r: ResolvedConnection,
	op: { kind: "send" | "reply"; event: string; path: string; key: string; body: Record<string, unknown>; from: string | null; to: string | null; refMessageId?: string },
): Promise<RegistryToolResult> {
	const userId = ctx.userId ?? "";
	const earlier = await findSentReceipt(ctx.env, userId, r.endpoint, r.accountId, op.key);
	if (earlier) {
		await recordReceipt(ctx.env, { userId, instanceId: ctx.instanceId, endpoint: r.endpoint, accountId: r.accountId, kind: op.kind, outcome: "deduped", messageId: earlier.messageId, threadId: earlier.threadId, providerReceiptId: earlier.providerReceiptId, fromAddress: earlier.fromAddress, toAddress: earlier.toAddress, idempotencyKey: op.key });
		return ok({ sent: true, deduped: true, message_id: earlier.messageId, thread_id: earlier.threadId, provider_receipt_id: earlier.providerReceiptId, note: "This send was already accepted earlier; nothing was sent again." });
	}
	try {
		const res = await callAdapter(r.endpoint, r.secret, op.path, { ...op.body, idempotencyKey: op.key });
		const messageId = typeof res.id === "string" ? res.id : undefined;
		const threadId = typeof res.threadId === "string" ? res.threadId : undefined;
		const providerReceiptId = typeof res.providerReceiptId === "string" ? res.providerReceiptId : undefined;
		const accepted = { userId, instanceId: ctx.instanceId, endpoint: r.endpoint, accountId: r.accountId, kind: op.kind, messageId, threadId, providerReceiptId, fromAddress: op.from, toAddress: op.to, idempotencyKey: op.key } as const;
		await auditReceipt(ctx, { event: op.event, endpoint: r.endpoint, accountId: r.accountId, messageId, threadId, outcome: "ok" });
		try {
			await insertReceipt(ctx.env, { ...accepted, outcome: "sent" });
		} catch (e) {
			// Two retries raced and the other recorded first: a dedupe, not an error.
			if (isDuplicateSend(e)) {
				await recordReceipt(ctx.env, { ...accepted, outcome: "deduped" });
				return ok({ sent: true, deduped: true, message_id: messageId, thread_id: threadId, provider_receipt_id: providerReceiptId, note: "This send was already accepted by a concurrent attempt." });
			}
			// The mail went out but the audit row did not: say so rather than report a clean success.
			return ok({ sent: true, message_id: messageId, thread_id: threadId, provider_receipt_id: providerReceiptId, receipt: "not recorded", note: "The bridge accepted the message, but PAGS could not record its audit receipt." });
		}
		return ok({ sent: true, ...(op.from ? { from: op.from } : {}), ...(op.to ? { to: op.to } : {}), message_id: messageId, thread_id: threadId, ...(providerReceiptId ? { provider_receipt_id: providerReceiptId } : {}) });
	} catch (e) {
		const err = await adapterFailure(ctx, r, op.kind, op.event, e, { messageId: op.refMessageId, idempotencyKey: op.key, fromAddress: op.from, toAddress: op.to });
		return fail(`${op.kind === "send" ? "Send" : "Reply"} failed: ${err.message}`);
	}
}

const sendHandler: ToolDef["handler"] = async (ctx, input) => {
	const to = typeof input.to === "string" ? input.to.trim() : "";
	const subject = typeof input.subject === "string" ? input.subject : "";
	const body = typeof input.body === "string" ? input.body : "";
	if (!to) return fail("to is required — the recipient address.");
	if (!subject.trim()) return fail("subject is required.");
	if (!body.trim()) return fail("body is required.");
	const resolved = await resolveConnection(ctx, "send");
	if ("refusal" in resolved) return resolved.refusal;
	// Sender policy BEFORE anything else: a denied, routed-only, wrong-domain or unapproved sender never reaches the wire.
	const sender = senderDecision(resolved.profile, input.from);
	if (!sender.ok) return senderRefusal(ctx, resolved, "send", sender, input.from, to);
	const cc = typeof input.cc === "string" && input.cc.trim() ? input.cc.trim() : undefined;
	const key = await intentKey(ctx, resolved, "send", [sender.from ?? "", to, cc ?? "", subject, body], input.idempotency_key);
	if (typeof key !== "string") return fail(key.error);
	return deliver(ctx, resolved, {
		kind: "send",
		event: "email.send",
		path: "/v1/email-worker/messages/send",
		key,
		body: { ...(sender.from ? { from: sender.from } : {}), to, subject, body, cc },
		from: sender.from,
		to,
	});
};

const replyHandler: ToolDef["handler"] = async (ctx, input) => {
	const messageId = typeof input.message_id === "string" ? input.message_id.trim() : "";
	const body = typeof input.body === "string" ? input.body : "";
	if (!messageId) return fail("message_id is required — the message to reply to.");
	if (!body.trim()) return fail("body is required — the text of the reply.");
	const resolved = await resolveConnection(ctx, "reply");
	if ("refusal" in resolved) return resolved.refusal;
	// A reply is sent FROM the configured reply identity, which must itself be an approved sender; the
	// model does not choose it, and the recipient is the bridge's to derive from the parent message.
	const sender = replyDecision(resolved.profile);
	if (!sender.ok) return senderRefusal(ctx, resolved, "reply", sender, resolved.profile.replyIdentity);
	const key = await intentKey(ctx, resolved, "reply", [sender.from ?? "", messageId, body], input.idempotency_key);
	if (typeof key !== "string") return fail(key.error);
	return deliver(ctx, resolved, {
		kind: "reply",
		event: "email.reply",
		path: "/v1/email-worker/messages/reply",
		key,
		body: { messageId, body, ...(sender.from ? { from: sender.from } : {}) },
		from: sender.from,
		to: null,
		refMessageId: messageId,
	});
};

/** What this connection may send as, what it only routes, and whether the bridge is healthy — shown explicitly (#1270 AC3). */
export function describeIdentities(profile: ConnectionProfile): Record<string, unknown> {
	const snap = profile.snapshot;
	return {
		provider: profile.provider,
		health: { reachable: profile.health.lastProbeOk, lastCheckedAt: profile.health.lastProbeAt, lastFailureClass: profile.health.lastFailureClass },
		...(profile.provider === "cloudflare" && snap
			? {
					domains: snap.domains,
					senders: snap.senders.map((address) => ({ address, approved: profile.approvedSenders.includes(address), replyIdentity: profile.replyIdentity === address })),
					routes: snap.routes.map((r) => ({ address: r.address, destination: r.destination, canSend: snap.senders.includes(r.address) })),
				}
			: { note: "A generic worker reports no sender policy; the worker decides who may send." }),
	};
}

const identitiesHandler: ToolDef["handler"] = async (ctx) => {
	const resolved = await resolveConnection(ctx, "identities");
	if ("refusal" in resolved) return resolved.refusal;
	await recordReceipt(ctx.env, { userId: ctx.userId ?? "", instanceId: ctx.instanceId, endpoint: resolved.endpoint, accountId: resolved.accountId, kind: "identities", outcome: "ok" });
	return ok(describeIdentities(resolved.profile));
};

const EVENT_KINDS = ["inbound", "delivery", "send", "reply", "routing_failure", "bridge_failure"];

const eventsHandler: ToolDef["handler"] = async (ctx, input) => {
	const resolved = await resolveConnection(ctx, "list");
	if ("refusal" in resolved) return resolved.refusal;
	const kind = typeof input.kind === "string" && EVENT_KINDS.includes(input.kind) ? input.kind : undefined;
	const limit = Math.max(1, Math.min(50, typeof input.limit === "number" ? Math.floor(input.limit) : 20));
	const page = await listReceipts(ctx.env, { userId: ctx.userId ?? "", endpoint: resolved.endpoint, accountId: resolved.accountId, kind, limit });
	if (page.receipts.length === 0) return { head: "No events recorded for this connection yet.", content: "", success: true };
	// Addresses in these rows were written by whoever sent the mail, so the dispatcher fences them.
	const events = page.receipts.map(({ idempotencyKey: _k, instanceId: _i, endpoint: _e, accountId: _a, ...rest }) => rest);
	return { content: JSON.stringify({ events, nextBefore: page.nextBefore }, null, 2), success: true, origin: "this connection's audit receipts" };
};


export const EMAIL_WORKER_TOOLS: ToolDef[] = [
	{
		name: "email_worker_list_messages",
		description:
			"List messages from this agent's worker-backed mailbox (newest first). Returns message/thread ids, sender, subject, date and a snippet. Use email_worker_read_message for the full body.",
		jsonSchema: {
			type: "object",
			properties: {
				folder: { type: "string", description: "Folder/label to list, if the worker supports one. Default is the adapter's own default (usually inbox)." },
				cursor: { type: "string", description: "Pagination cursor from a previous call's nextCursor." },
				limit: { type: "number", description: "How many messages to return (adapter-defined cap, default 10)." },
			},
		},
		tier: "connector",
		connector: "email-worker",
		scope: "read",
		mutates: false,
		untrustedOutput: true,
		handler: listHandler,
	},
	{
		name: "email_worker_read_message",
		description: "Read one message in full from this agent's worker-backed mailbox, by id from email_worker_list_messages.",
		jsonSchema: { type: "object", properties: { message_id: { type: "string", description: "Message id from email_worker_list_messages." } }, required: ["message_id"] },
		tier: "connector",
		connector: "email-worker",
		scope: "read",
		mutates: false,
		untrustedOutput: true,
		handler: readHandler,
	},
	{
		name: "email_worker_send",
		description:
			"Send a NEW message from this agent's worker-backed mailbox to an address you name explicitly. Really sends — no draft step, no undo. On a Cloudflare connection the sender must be one of the connection's approved senders (see email_worker_identities); an address that only receives mail through Email Routing cannot send. A retry of the same call is recognised and not sent twice.",
		jsonSchema: {
			type: "object",
			properties: {
				from: { type: "string", description: "Sender address. Optional: defaults to the connection's first approved sender. Must be an approved sender on a Cloudflare connection." },
				to: { type: "string", description: "Recipient address." },
				cc: { type: "string", description: "Cc address." },
				subject: { type: "string", description: "Subject line." },
				body: { type: "string", description: "Message text." },
				idempotency_key: { type: "string", description: "Optional. Same key = same send; pass a different one only to deliberately send identical text again." },
			},
			required: ["to", "subject", "body"],
		},
		tier: "connector",
		connector: "email-worker",
		scope: "write",
		mutates: true,
		untrustedOutput: false,
		handler: sendHandler,
	},
	{
		name: "email_worker_reply",
		description:
			"Reply to a message in its own thread, from this agent's worker-backed mailbox. On a Cloudflare connection the reply is sent from the connection's configured reply identity and goes to the original sender; neither can be overridden. Really sends — no draft step, no undo. A retry of the same call is not sent twice.",
		jsonSchema: {
			type: "object",
			properties: {
				message_id: { type: "string", description: "The message to reply to, from email_worker_list_messages." },
				body: { type: "string", description: "The reply text." },
				idempotency_key: { type: "string", description: "Optional. Same key = same reply." },
			},
			required: ["message_id", "body"],
		},
		tier: "connector",
		connector: "email-worker",
		scope: "write",
		mutates: true,
		untrustedOutput: false,
		handler: replyHandler,
	},
	{
		name: "email_worker_identities",
		description:
			"Show what this agent's worker-backed mailbox may send as and where it receives: approved sender identities, the reply identity, the Email Routing aliases (with their destinations and whether each can send), the domains, and whether the Cloudflare bridge is reachable. A routed alias is receive-only unless it is also listed as a sender.",
		jsonSchema: { type: "object", properties: {} },
		tier: "connector",
		connector: "email-worker",
		scope: "read",
		mutates: false,
		untrustedOutput: false,
		handler: identitiesHandler,
	},
	{
		name: "email_worker_list_events",
		description:
			"List recent audit events for this agent's worker-backed mailbox, newest first: inbound messages (with the ORIGINAL sender and recipient), delivery outcomes, sends and replies with their provider receipt ids, and routing or bridge failures. Ids and outcomes only — never message bodies. Use email_worker_read_message for a message.",
		jsonSchema: {
			type: "object",
			properties: {
				kind: { type: "string", description: "Only this kind: inbound, delivery, send, reply, routing_failure or bridge_failure." },
				limit: { type: "number", description: "How many events (1-50, default 20)." },
			},
		},
		tier: "connector",
		connector: "email-worker",
		scope: "read",
		mutates: false,
		untrustedOutput: true,
		handler: eventsHandler,
	},
];

/** Compiled Connector — consumed by the registry exactly like any other connector. */
export const EMAIL_WORKER_CONNECTOR: Connector = {
	id: "email-worker",
	label: "Worker-backed email (generic)",
	// auth:"token" describes the SHAPE for the catalog; like `mcp`, resolution does NOT go
	// through `ctx.connectorClient("email-worker")` — the credential is keyed on the owner's
	// chosen endpoint, not on a fixed vault slot, so handlers resolve it directly (above).
	auth: "token" as const,
	scopes: { read: true, write: true },
	writeMeaning:
		"Send and reply to mail from the worker-backed mailbox this agent is pinned to, to anyone the agent addresses. Sent mail cannot be recalled. There is no delete, archive or filter tool.",
	grantModel: "user" as const,
	tools: EMAIL_WORKER_TOOLS,
};
