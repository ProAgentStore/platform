/**
 * Cloudflare Email bridge (PAGS #1270) — the Worker a customer deploys IN THEIR OWN Cloudflare account
 * to give a private PAGS agent a mailbox on a Cloudflare-routed domain, with no Google account and no
 * Cloudflare API key anywhere in PAGS.
 *
 * WHY A BRIDGE. Cloudflare Workers' email bindings are account-scoped: `send_email` and the Email
 * Routing `email()` handler can only be attached to a Worker in the SAME account as the domain. A
 * PAGS Worker cannot hold them. So this Worker holds them, and speaks to PAGS over the published
 * `email-worker/v1` contract (platform-docs/email-worker-adapter.md) with ONE bearer secret the owner
 * pastes into PAGS. The secret is the only credential PAGS holds; it is stored encrypted and is never
 * placed in a prompt, instruction, tool argument or log.
 *
 * THREE THINGS CLOUDFLARE KEEPS APART, AND SO DOES THIS FILE:
 *   SENDERS    addresses Email Sending will send as (SENDERS) — the ONLY identities this Worker sends from;
 *   ROUTES     addresses Email Routing accepts mail for (ROUTES) — inbound only, each with a destination;
 *   REPLY      the sender replies go out from (REPLY_IDENTITIES) — must itself be a sender.
 * A routed address is NOT a sender. `/messages/send` refuses it with `sender_not_allowed` even if PAGS
 * asked, because the check is made here, in the customer's account, as well as in PAGS.
 *
 * Plain functions over a tiny `Env`, with no Cloudflare types imported, so the same code runs under the
 * PAGS test suite (against in-memory fakes) and as the deployed Worker (src/index.ts wires the real
 * bindings). Nothing here logs a body, a secret or a header value.
 */

export interface SendBinding {
	/** Cloudflare Email Sending: `env.EMAIL.send({...})` → `{ messageId }`. */
	send(message: { from: string; to: string | string[]; subject: string; text: string; cc?: string | string[]; headers?: Record<string, string> }): Promise<{ messageId?: string } | undefined>;
}

export interface StoreBinding {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
	list(opts: { prefix: string; limit?: number }): Promise<{ keys: Array<{ name: string }> }>;
}

export interface BridgeEnv {
	/** The bearer PAGS presents. Set with `wrangler secret put BRIDGE_SECRET`. */
	BRIDGE_SECRET: string;
	/** `https://api.proagentstore.online/v1/email-worker/inbound/<token>` — shown once in the PAGS console. */
	PAGS_INBOUND_URL?: string;
	/** Domains onboarded to Email Sending / Routing in this account (comma-separated). */
	DOMAINS: string;
	/** Send-capable identities (comma-separated). */
	SENDERS: string;
	/** The identity replies are sent from (comma-separated; usually one). Each must also be a sender. */
	REPLY_IDENTITIES?: string;
	/** Routed addresses, `address=destination` pairs (comma-separated). A destination is a verified address. */
	ROUTES?: string;
	EMAIL: SendBinding;
	MAIL: StoreBinding;
}

export interface InboundMessage {
	/** The Message-ID header, or a generated id. Stable: the same mail always yields the same id. */
	messageId: string;
	/** The envelope sender and the ORIGINAL recipient as Email Routing delivered them. */
	from: string;
	to: string;
	subject: string;
	text: string;
	date: string;
	threadId: string;
	inReplyTo?: string;
}

const csv = (v: string | undefined): string[] => (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const domainOf = (a: string): string => a.slice(a.lastIndexOf("@") + 1);

export function routesOf(env: BridgeEnv): Array<{ address: string; destination: string | null }> {
	return csv(env.ROUTES).map((pair) => {
		const [address, destination] = pair.split("=");
		return { address, destination: destination?.trim() || null };
	});
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const error = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status);

/** A constant-time-ish comparison; the bearer is the only thing standing between the internet and the mailbox. */
function sameSecret(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

const MESSAGE_PREFIX = "msg:";
const IDEM_PREFIX = "idem:";

async function loadMessage(env: BridgeEnv, id: string): Promise<InboundMessage | null> {
	const raw = await env.MAIL.get(MESSAGE_PREFIX + id);
	return raw ? (JSON.parse(raw) as InboundMessage) : null;
}

/** Handle one PAGS → bridge call (the `email-worker/v1` contract). */
export async function handleRequest(req: Request, env: BridgeEnv): Promise<Response> {
	const url = new URL(req.url);
	if (req.method !== "POST") return error(405, "method_not_allowed", "POST only.");
	const auth = req.headers.get("authorization") ?? "";
	if (!env.BRIDGE_SECRET || !sameSecret(auth, `Bearer ${env.BRIDGE_SECRET}`)) return error(401, "unauthorized", "Bad credential.");
	const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
	const path = url.pathname.replace(/^.*?(\/v1\/email-worker\/.*)$/, "$1");

	const senders = csv(env.SENDERS);
	const domains = csv(env.DOMAINS);
	const replyIdentities = csv(env.REPLY_IDENTITIES).filter((a) => senders.includes(a));

	if (path === "/v1/email-worker/identity") {
		return json({
			contractVersion: "email-worker/v1",
			provider: "cloudflare",
			account: { address: replyIdentities[0] ?? senders[0] ?? null },
			domains,
			senders,
			replyIdentities,
			routes: routesOf(env),
		});
	}

	if (path === "/v1/email-worker/messages/list") {
		const limit = Math.max(1, Math.min(50, typeof body.limit === "number" ? body.limit : 10));
		const { keys } = await env.MAIL.list({ prefix: MESSAGE_PREFIX, limit: 200 });
		const all = (await Promise.all(keys.map((k) => loadMessage(env, k.name.slice(MESSAGE_PREFIX.length))))).filter((m): m is InboundMessage => m !== null);
		all.sort((a, b) => b.date.localeCompare(a.date));
		return json({
			messages: all.slice(0, limit).map((m) => ({ id: m.messageId, threadId: m.threadId, from: m.from, to: m.to, subject: m.subject, date: m.date, snippet: m.text.slice(0, 120), hasAttachments: false })),
			nextCursor: null,
		});
	}

	if (path === "/v1/email-worker/messages/get") {
		const m = typeof body.id === "string" ? await loadMessage(env, body.id) : null;
		return m ? json({ id: m.messageId, threadId: m.threadId, from: m.from, to: m.to, subject: m.subject, date: m.date, body: m.text, attachments: [] }) : error(404, "not_found", "No such message.");
	}

	if (path === "/v1/email-worker/messages/send" || path === "/v1/email-worker/messages/reply") {
		const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
		if (!key) return error(400, "idempotency_key_required", "idempotencyKey is required.");
		// A repeated key is the SAME send: answer with the first result and deliver nothing.
		const earlier = await env.MAIL.get(IDEM_PREFIX + key);
		if (earlier) return json(JSON.parse(earlier));

		const isReply = path.endsWith("/reply");
		const from = typeof body.from === "string" ? body.from.trim().toLowerCase() : (isReply ? replyIdentities[0] : senders[0]) ?? "";
		// THE SENDER CHECK, made here as well as in PAGS: only a configured sender may send, never a routed-only alias.
		if (!from || !senders.includes(from)) {
			const routed = routesOf(env).some((r) => r.address === from);
			return error(403, "sender_not_allowed", routed ? "That address is an Email Routing alias, not a send-capable identity." : "That address is not a configured sender.");
		}
		if (!domains.includes(domainOf(from))) return error(403, "sender_not_allowed", "That address is on a domain this bridge does not send for.");

		let to: string;
		let subject: string;
		let threadId: string;
		let inReplyTo: string | undefined;
		if (isReply) {
			const parent = typeof body.messageId === "string" ? await loadMessage(env, body.messageId) : null;
			if (!parent) return error(404, "not_found", "No such message to reply to.");
			// The recipient comes from the PARENT message — the caller cannot name one.
			if (typeof body.to === "string") return error(400, "recipient_not_allowed", "A reply goes to the original sender.");
			to = parent.from;
			subject = /^re:/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`;
			threadId = parent.threadId;
			inReplyTo = parent.messageId;
		} else {
			to = typeof body.to === "string" ? body.to.trim() : "";
			subject = typeof body.subject === "string" ? body.subject : "";
			if (!to || !subject) return error(400, "invalid_request", "to and subject are required.");
			threadId = `t_${key.slice(0, 24)}`;
		}
		const text = typeof body.body === "string" ? body.body : "";
		let sent: { messageId?: string } | undefined;
		try {
			sent = await env.EMAIL.send({ from, to, subject, text, ...(typeof body.cc === "string" && body.cc ? { cc: body.cc } : {}), ...(inReplyTo ? { headers: { "In-Reply-To": inReplyTo } } : {}) });
		} catch {
			return error(502, "send_failed", "Cloudflare Email Sending refused the message.");
		}
		const result = { id: `out_${key.slice(0, 32)}`, threadId, providerReceiptId: sent?.messageId ?? null };
		await env.MAIL.put(IDEM_PREFIX + key, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 7 });
		await env.MAIL.put(MESSAGE_PREFIX + result.id, JSON.stringify({ messageId: result.id, from, to, subject, text, date: new Date().toISOString(), threadId } satisfies InboundMessage));
		return json(result);
	}

	return error(404, "not_found", `No such endpoint: ${path}`);
}

/** The slice of Cloudflare's `ForwardableEmailMessage` this bridge uses. */
export interface RoutedEmail {
	from: string;
	to: string;
	headers: { get(name: string): string | null };
	raw: ReadableStream | null;
	forward(destination: string): Promise<void>;
}

async function readText(raw: ReadableStream | null, max = 200_000): Promise<string> {
	if (!raw) return "";
	const text = await new Response(raw).text();
	const split = text.search(/\r?\n\r?\n/);
	return (split >= 0 ? text.slice(split).trim() : text).slice(0, max);
}

async function sha256Hex(s: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Handle one inbound Email Routing event: keep the message, forward it to the route's destination, and
 * tell PAGS. The ORIGINAL sender and recipient are passed through untouched — PAGS correlates the
 * recipient to a configured route and refuses anything it does not recognise. A failure to reach PAGS
 * never loses the mail (it is already stored and forwarded) and is retried by PAGS-side replay.
 */
export async function handleInbound(msg: RoutedEmail, env: BridgeEnv, fetchImpl: typeof fetch = fetch): Promise<{ stored: boolean; notified: boolean }> {
	const to = msg.to.trim().toLowerCase();
	const from = msg.from.trim().toLowerCase();
	const headerId = msg.headers.get("message-id")?.trim();
	// Stable id: the same mail always maps to the same id, so a redelivery is the same event.
	const messageId = headerId || `in_${(await sha256Hex(`${from}|${to}|${msg.headers.get("date") ?? ""}|${msg.headers.get("subject") ?? ""}`)).slice(0, 32)}`;
	const inReplyTo = msg.headers.get("in-reply-to")?.trim() || undefined;
	const stored: InboundMessage = {
		messageId,
		from,
		to,
		subject: msg.headers.get("subject") ?? "",
		text: await readText(msg.raw),
		date: new Date().toISOString(),
		threadId: `t_${(await sha256Hex(inReplyTo ?? messageId)).slice(0, 24)}`,
		...(inReplyTo ? { inReplyTo } : {}),
	};
	await env.MAIL.put(MESSAGE_PREFIX + messageId, JSON.stringify(stored));

	const route = routesOf(env).find((r) => r.address === to);
	if (route?.destination) await msg.forward(route.destination).catch(() => undefined);

	if (!env.PAGS_INBOUND_URL) return { stored: true, notified: false };
	const event = { type: "message.received", eventId: `in:${messageId}`, messageId, threadId: stored.threadId, from, to };
	try {
		const res = await fetchImpl(env.PAGS_INBOUND_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) });
		return { stored: true, notified: res.ok || res.status === 422 };
	} catch {
		return { stored: true, notified: false };
	}
}
