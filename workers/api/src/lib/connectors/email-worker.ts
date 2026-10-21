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
import { logEvent } from "../events.js";
import { resolveEmailWorkerConnection, resolveEmailWorkerSecret } from "../email-worker-connections.js";

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
): Promise<{ ok: true; contractVersion: string; address: string | null } | { ok: false; error: string }> {
	try {
		const res = await callAdapter(endpoint, secret, "/v1/email-worker/identity", {});
		const contractVersion = typeof res.contractVersion === "string" ? res.contractVersion : "unknown";
		const account = (res.account ?? {}) as { address?: unknown };
		return { ok: true, contractVersion, address: typeof account.address === "string" ? account.address : null };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/** Resolve the pinned connection + its secret, or the refusal to return — AC3's "wrong instance
 *  pin" case, always caught here before any wire call is made. */
async function resolveConnection(
	ctx: RegistryToolCtx,
): Promise<{ endpoint: string; accountId: string; secret: string } | { refusal: RegistryToolResult }> {
	if (!ctx.env || !ctx.userId) return { refusal: fail("This requires an authenticated user context.") };
	const resolved = await resolveEmailWorkerConnection(ctx.env, ctx.userId, ctx.instanceId);
	if (!resolved.ok) return { refusal: fail(resolved.message) };
	const secret = await resolveEmailWorkerSecret(ctx.env, ctx.userId, resolved.endpoint, resolved.accountId);
	if (!secret) return { refusal: fail(`The connection "${resolved.label}" has no usable secret stored. Reconnect it in the console.`) };
	return { endpoint: resolved.endpoint, accountId: resolved.accountId, secret };
}

function idempotencyKey(): string {
	return crypto.randomUUID();
}

const listHandler: ToolDef["handler"] = async (ctx, input) => {
	const resolved = await resolveConnection(ctx);
	if ("refusal" in resolved) return resolved.refusal;
	try {
		const res = await callAdapter(resolved.endpoint, resolved.secret, "/v1/email-worker/messages/list", {
			folder: typeof input.folder === "string" ? input.folder : undefined,
			cursor: typeof input.cursor === "string" ? input.cursor : undefined,
			limit: typeof input.limit === "number" ? input.limit : 10,
		});
		await auditReceipt(ctx, { event: "email.list", endpoint: resolved.endpoint, accountId: resolved.accountId, outcome: "ok" });
		return ok(res);
	} catch (e) {
		const err = e instanceof AdapterError ? e : new AdapterError(String(e), "transient");
		await auditReceipt(ctx, { event: "email.list", endpoint: resolved.endpoint, accountId: resolved.accountId, outcome: "adapter_error", failureClass: err.failureClass, message: err.message });
		return fail(err.message);
	}
};

const readHandler: ToolDef["handler"] = async (ctx, input) => {
	const id = typeof input.message_id === "string" ? input.message_id.trim() : "";
	if (!id) return fail("message_id is required — get one from email_worker_list_messages.");
	const resolved = await resolveConnection(ctx);
	if ("refusal" in resolved) return resolved.refusal;
	try {
		const res = await callAdapter(resolved.endpoint, resolved.secret, "/v1/email-worker/messages/get", { id });
		await auditReceipt(ctx, { event: "email.read", endpoint: resolved.endpoint, accountId: resolved.accountId, messageId: id, outcome: "ok" });
		return { ...ok(res), success: true, content: JSON.stringify(res, null, 2) };
	} catch (e) {
		const err = e instanceof AdapterError ? e : new AdapterError(String(e), "transient");
		await auditReceipt(ctx, { event: "email.read", endpoint: resolved.endpoint, accountId: resolved.accountId, messageId: id, outcome: "adapter_error", failureClass: err.failureClass, message: err.message });
		return fail(err.message);
	}
};

const sendHandler: ToolDef["handler"] = async (ctx, input) => {
	const to = typeof input.to === "string" ? input.to.trim() : "";
	const subject = typeof input.subject === "string" ? input.subject : "";
	const body = typeof input.body === "string" ? input.body : "";
	if (!to) return fail("to is required — the recipient address.");
	if (!subject.trim()) return fail("subject is required.");
	if (!body.trim()) return fail("body is required.");
	const resolved = await resolveConnection(ctx);
	if ("refusal" in resolved) return resolved.refusal;
	const key = idempotencyKey();
	try {
		const cc = typeof input.cc === "string" && input.cc.trim() ? input.cc.trim() : undefined;
		const res = await callAdapter(resolved.endpoint, resolved.secret, "/v1/email-worker/messages/send", { to, subject, body, cc, idempotencyKey: key });
		const messageId = typeof res.id === "string" ? res.id : undefined;
		const threadId = typeof res.threadId === "string" ? res.threadId : undefined;
		await auditReceipt(ctx, { event: "email.send", endpoint: resolved.endpoint, accountId: resolved.accountId, messageId, threadId, outcome: "ok" });
		return ok({ sent: true, to, ...(cc ? { cc } : {}), subject, message_id: messageId, thread_id: threadId });
	} catch (e) {
		const err = e instanceof AdapterError ? e : new AdapterError(String(e), "transient");
		await auditReceipt(ctx, { event: "email.send", endpoint: resolved.endpoint, accountId: resolved.accountId, outcome: "adapter_error", failureClass: err.failureClass, message: err.message });
		return fail(`Send failed: ${err.message}`);
	}
};

const replyHandler: ToolDef["handler"] = async (ctx, input) => {
	const messageId = typeof input.message_id === "string" ? input.message_id.trim() : "";
	const body = typeof input.body === "string" ? input.body : "";
	if (!messageId) return fail("message_id is required — the message to reply to.");
	if (!body.trim()) return fail("body is required — the text of the reply.");
	const resolved = await resolveConnection(ctx);
	if ("refusal" in resolved) return resolved.refusal;
	const key = idempotencyKey();
	try {
		const res = await callAdapter(resolved.endpoint, resolved.secret, "/v1/email-worker/messages/reply", { messageId, body, idempotencyKey: key });
		const sentId = typeof res.id === "string" ? res.id : undefined;
		const threadId = typeof res.threadId === "string" ? res.threadId : undefined;
		await auditReceipt(ctx, { event: "email.reply", endpoint: resolved.endpoint, accountId: resolved.accountId, messageId: sentId, threadId, outcome: "ok" });
		return ok({ sent: true, message_id: sentId, thread_id: threadId });
	} catch (e) {
		const err = e instanceof AdapterError ? e : new AdapterError(String(e), "transient");
		await auditReceipt(ctx, { event: "email.reply", endpoint: resolved.endpoint, accountId: resolved.accountId, messageId, outcome: "adapter_error", failureClass: err.failureClass, message: err.message });
		return fail(`Reply failed: ${err.message}`);
	}
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
		description: "Send a NEW message from this agent's worker-backed mailbox to an address you name explicitly. Really sends — no draft step, no undo.",
		jsonSchema: {
			type: "object",
			properties: {
				to: { type: "string", description: "Recipient address." },
				cc: { type: "string", description: "Cc address." },
				subject: { type: "string", description: "Subject line." },
				body: { type: "string", description: "Message text." },
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
		description: "Reply to a message in its own thread, from this agent's worker-backed mailbox. Really sends — no draft step, no undo.",
		jsonSchema: {
			type: "object",
			properties: {
				message_id: { type: "string", description: "The message to reply to, from email_worker_list_messages." },
				body: { type: "string", description: "The reply text." },
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
