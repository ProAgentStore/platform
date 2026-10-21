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
	/** Workers KV `list`: keys come back in lexicographic order; `cursor` continues a page. */
	list(opts: { prefix: string; limit?: number; cursor?: string }): Promise<{ keys: Array<{ name: string }>; list_complete?: boolean; cursor?: string }>;
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
	/**
	 * The mailbox(es) this bridge serves PAGS (comma-separated, #1278). Mail addressed to anything else is never stored, listed,
	 * read or replied to, whatever else this account routes to the Worker. Unset = every routed address (the #1270 behaviour);
	 * a dedicated single-mailbox bridge sets exactly one.
	 */
	MAILBOX?: string;
	EMAIL: SendBinding;
	MAIL: StoreBinding;
}

/** Hard bounds, enforced here whatever the caller asks for (#1278). */
export const LIMITS = {
	/** Most summaries one list call returns. */
	listMax: 25,
	listDefault: 10,
	/** Characters of body one get call returns, and the default. */
	bodyMax: 20_000,
	bodyDefault: 6_000,
	/** Characters of one message body kept at all. */
	storedBody: 50_000,
	/** Bytes of a raw inbound message read off the stream. */
	rawBytes: 262_144,
	snippet: 120,
	subject: 200,
	/** Characters of a body a send or reply may carry. */
	sendBody: 20_000,
} as const;

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
	/** Length of the full body before the stored copy was bounded; absent = nothing was cut. */
	bodyChars?: number;
}

const csv = (v: string | undefined): string[] => (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const domainOf = (a: string): string => a.slice(a.lastIndexOf("@") + 1);

export function routesOf(env: BridgeEnv): Array<{ address: string; destination: string | null }> {
	return csv(env.ROUTES).map((pair) => {
		const [address, destination] = pair.split("=");
		return { address, destination: destination?.trim() || null };
	});
}

const clip = (v: string, max: number): string => (v.length > max ? `${v.slice(0, max)}…` : v);
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
/** `idx:<mailbox>:<inverted time>:<id>` — one listing prefix per mailbox, newest first, stable under new arrivals. */
const INDEX_PREFIX = "idx:";

/** The mailboxes this bridge serves: MAILBOX, else (legacy) every routed address. */
export function mailboxesOf(env: BridgeEnv): string[] {
	const set = csv(env.MAILBOX);
	return set.length ? set : routesOf(env).map((r) => r.address);
}

const inScope = (env: BridgeEnv, address: string | undefined): boolean => !!address && mailboxesOf(env).includes(address.trim().toLowerCase());

const INVERT = 9_000_000_000_000_000;
function indexKey(mailbox: string, date: string, id: string): string {
	return `${INDEX_PREFIX}${mailbox}:${String(INVERT - Date.parse(date)).padStart(16, "0")}:${id}`;
}

interface Cursor {
	/** Index into the mailbox list. */
	a: number;
	/** Workers KV's own cursor within that mailbox. */
	c?: string;
}
const encodeCursor = (c: Cursor): string => btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function decodeCursor(raw: unknown, mailboxes: number): Cursor | null {
	if (raw === undefined || raw === null || raw === "") return { a: 0 };
	if (typeof raw !== "string" || raw.length > 600) return null;
	try {
		const c = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))) as Cursor;
		return Number.isInteger(c.a) && c.a >= 0 && c.a < mailboxes && (c.c === undefined || typeof c.c === "string") ? c : null;
	} catch {
		return null;
	}
}

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
			mailboxes: mailboxesOf(env),
		});
	}

	if (path === "/v1/email-worker/messages/list") {
		// Only the inbox exists: a folder this bridge does not have is refused, not silently ignored (#1278).
		if (body.folder !== undefined && body.folder !== null && body.folder !== "" && String(body.folder).toLowerCase() !== "inbox") return error(400, "unsupported_folder", "This bridge has one folder, inbox.");
		const limit = Math.max(1, Math.min(LIMITS.listMax, Math.floor(typeof body.limit === "number" && Number.isFinite(body.limit) ? body.limit : LIMITS.listDefault)));
		const boxes = mailboxesOf(env);
		const cursor = decodeCursor(body.cursor, Math.max(1, boxes.length));
		if (!cursor) return error(400, "invalid_cursor", "That cursor was not issued by this bridge.");
		const messages: Array<Record<string, unknown>> = [];
		let a = cursor.a;
		let kvCursor = cursor.c;
		let next: Cursor | null = null;
		// Each KV page is requested with exactly the room left, so a page boundary is always a place a cursor can resume from.
		while (a < boxes.length && messages.length < limit) {
			const page = await env.MAIL.list({ prefix: `${INDEX_PREFIX}${boxes[a]}:`, limit: limit - messages.length, ...(kvCursor ? { cursor: kvCursor } : {}) });
			for (const k of page.keys) {
				const raw = await env.MAIL.get(k.name);
				if (raw) messages.push(JSON.parse(raw) as Record<string, unknown>);
			}
			if (page.list_complete === false && page.cursor) {
				next = { a, c: page.cursor };
				break;
			}
			a++;
			kvCursor = undefined;
		}
		if (!next && a < boxes.length) next = { a };
		return json({ messages, nextCursor: next ? encodeCursor(next) : null });
	}

	if (path === "/v1/email-worker/messages/get") {
		const m = typeof body.id === "string" ? await loadMessage(env, body.id) : null;
		// A message outside this bridge's mailbox is indistinguishable from one that does not exist (#1278: no direct-ID bypass).
		const readable = m && (inScope(env, m.to) || (m.messageId.startsWith("out_") && inScope(env, m.from)));
		if (!m || !readable) return error(404, "not_found", "No such message.");
		const max = Math.max(1, Math.min(LIMITS.bodyMax, Math.floor(typeof body.maxChars === "number" && Number.isFinite(body.maxChars) ? body.maxChars : LIMITS.bodyDefault)));
		const offset = Math.max(0, Math.floor(typeof body.offset === "number" && Number.isFinite(body.offset) ? body.offset : 0));
		const end = Math.min(m.text.length, offset + max);
		const total = m.bodyChars ?? m.text.length;
		return json({
			id: m.messageId,
			threadId: m.threadId,
			from: m.from,
			to: m.to,
			subject: clip(m.subject, LIMITS.subject),
			date: m.date,
			body: m.text.slice(offset, end),
			bodyChars: total,
			offset,
			// Truncated = more of the body exists than this response carries (continue from nextOffset), or the stored copy itself was bounded.
			truncated: end < m.text.length || total > m.text.length,
			...(end < m.text.length ? { nextOffset: end } : {}),
			attachments: [],
		});
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

		const text = typeof body.body === "string" ? body.body : "";
		if (text.length > LIMITS.sendBody) return error(413, "body_too_large", `A message body may carry at most ${LIMITS.sendBody} characters.`);
		if (isReply && !replyIdentities.includes(from)) return error(403, "reply_identity_not_allowed", "Replies go out only from a configured reply identity.");
		let to: string;
		let subject: string;
		let threadId: string;
		let inReplyTo: string | undefined;
		if (isReply) {
			const parent = typeof body.messageId === "string" ? await loadMessage(env, body.messageId) : null;
			// The parent must be mail this bridge serves: another recipient's message cannot be replied to by id (#1278).
			if (!parent || !inScope(env, parent.to) || parent.messageId.startsWith("out_")) return error(404, "not_found", "No such message to reply to.");
			if (!/^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(parent.from)) return error(400, "invalid_parent_sender", "The original sender is not a plain address, so there is nobody safe to reply to.");
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

/** Read at most `LIMITS.rawBytes` of the raw message, then the body part of it. The stream is cancelled, not drained. */
async function readText(raw: ReadableStream | null): Promise<{ text: string; chars: number }> {
	if (!raw) return { text: "", chars: 0 };
	const reader = raw.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	while (bytes < LIMITS.rawBytes) {
		const { done, value } = await reader.read();
		if (done || !value) break;
		chunks.push(value);
		bytes += value.length;
	}
	await reader.cancel().catch(() => undefined);
	const all = new Uint8Array(bytes);
	let at = 0;
	for (const c of chunks) {
		all.set(c, at);
		at += c.length;
	}
	const text = new TextDecoder().decode(all);
	const split = text.search(/\r?\n\r?\n/);
	const bodyText = (split >= 0 ? text.slice(split).trim() : text).trim();
	return { text: bodyText.slice(0, LIMITS.storedBody), chars: bodyText.length };
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
	let stored = false;
	// RECIPIENT SCOPE FIRST (#1278): mail for any address this bridge does not serve is neither stored nor forwarded, however the
	// account routes it. It is still reported, so PAGS records a routing failure instead of the mail silently vanishing.
	if (inScope(env, to)) {
		const { text, chars } = await readText(msg.raw);
		const date = new Date().toISOString();
		const message: InboundMessage = {
			messageId,
			from,
			to,
			subject: msg.headers.get("subject") ?? "",
			text,
			date,
			threadId: `t_${(await sha256Hex(inReplyTo ?? messageId)).slice(0, 24)}`,
			...(inReplyTo ? { inReplyTo } : {}),
			...(chars > text.length ? { bodyChars: chars } : {}),
		};
		// A redelivery keeps its first index entry: the index key is derived from the FIRST arrival's time.
		const first = await env.MAIL.get(MESSAGE_PREFIX + messageId);
		if (first) {
			stored = true;
		} else {
			await env.MAIL.put(MESSAGE_PREFIX + messageId, JSON.stringify(message));
			await env.MAIL.put(indexKey(to, date, messageId), JSON.stringify({ id: messageId, threadId: message.threadId, from, to, subject: clip(message.subject, LIMITS.subject), date, snippet: text.slice(0, LIMITS.snippet), hasAttachments: false }));
			stored = true;
		}
		const route = routesOf(env).find((r) => r.address === to);
		if (route?.destination) await msg.forward(route.destination).catch(() => undefined);
	}
	const threadId = `t_${(await sha256Hex(inReplyTo ?? messageId)).slice(0, 24)}`;

	if (!env.PAGS_INBOUND_URL) return { stored, notified: false };
	const event = { type: "message.received", eventId: `in:${messageId}`, messageId, threadId, from, to };
	try {
		const res = await fetchImpl(env.PAGS_INBOUND_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) });
		return { stored, notified: res.ok || res.status === 422 };
	} catch {
		return { stored, notified: false };
	}
}
