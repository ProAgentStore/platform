/**
 * Gmail read-only client for the permissioned agent email tool.
 *
 * Users connect Gmail via OAuth (offline access). We store only the refresh
 * token (encrypted, in the key vault as provider "gmail"); access tokens are
 * minted on demand and never persisted. Scope is gmail.readonly — the agent
 * can search and read messages it is permitted to, nothing more.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export interface GmailEnv {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
}

export class GmailError extends Error {}

/** Exchange a stored refresh token for a short-lived access token. */
export async function mintGmailAccessToken(
	env: GmailEnv,
	refreshToken: string,
): Promise<string> {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		throw new GmailError("Gmail OAuth is not configured on this deployment");
	}
	const res = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});
	if (!res.ok) {
		throw new GmailError(
			`Could not refresh Gmail access (${res.status}). Reconnect Gmail in settings.`,
		);
	}
	const data = (await res.json()) as { access_token?: string };
	if (!data.access_token) throw new GmailError("Gmail did not return an access token");
	return data.access_token;
}

/** Decode a base64url Gmail body part into a UTF-8 string. */
function decodeBody(data: string): string {
	const padded = data.replace(/-/g, "+").replace(/_/g, "/");
	try {
		const bin = atob(padded);
		const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		return "";
	}
}

interface GmailPart {
	mimeType?: string;
	/** Present and non-empty on an attachment part; empty string on a body part. */
	filename?: string;
	body?: { data?: string; attachmentId?: string; size?: number };
	parts?: GmailPart[];
}

/** Walk the MIME tree and concatenate all text/html and text/plain bodies. */
function collectText(part: GmailPart | undefined): string {
	if (!part) return "";
	let out = "";
	if (part.body?.data && (part.mimeType === "text/html" || part.mimeType === "text/plain")) {
		out += decodeBody(part.body.data);
	}
	for (const child of part.parts ?? []) out += `\n${collectText(child)}`;
	return out;
}

/** True for image / stylesheet / font / script asset URLs — never the action link. */
const ASSET_URL = /\.(png|jpe?g|gif|svg|webp|ico|bmp|css|js|woff2?|ttf|eot)(\?|#|$)/i;

/** Pull all http(s) links out of an email body (html href + bare urls), dropping
 *  image/asset URLs (logos, tracking pixels) which are never the sign-in link. */
export function extractLinks(body: string): string[] {
	const links = new Set<string>();
	const hrefRe = /href\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi;
	const bareRe = /https?:\/\/[^\s"'<>)]+/gi;
	for (const re of [hrefRe, bareRe]) {
		let m: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
		while ((m = re.exec(body)) !== null) {
			const url = (m[1] ?? m[0]).replace(/[).,;'"]+$/, "");
			if (ASSET_URL.test(url)) continue;
			links.add(url);
		}
	}
	return [...links];
}

/**
 * Pull a one-time verification / sign-in CODE out of an email body. Tries a
 * context-anchored match first ("your code is 123456"), then bare 6/8-digit and
 * 6–8 char alphanumeric tokens. Returns null when nothing code-like is present.
 */
export function extractCode(body: string): string | null {
	const text = body.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
	// Keyword, then skip a few non-digit chars/words, then a 4–8 digit code.
	const context = text.match(/(?:code|verification|otp|pin|passcode|confirm(?:ation)?)\D{0,20}(\d{4,8})\b/i);
	if (context) return context[1];
	// A bare 6- or 8-digit OTP anywhere.
	const digits = text.match(/\b\d{6}\b|\b\d{8}\b/);
	if (digits) return digits[0];
	// An alphanumeric code that CONTAINS a digit (so plain words never match).
	const alnum = text.match(/\b(?=[A-Z0-9]*\d)[A-Z0-9]{5,8}\b/);
	return alnum ? alnum[0] : null;
}

const CONFIRM_HINTS = [
	"confirm",
	"verify",
	"verification",
	"activate",
	"activation",
	"validate",
	"validation",
	"setpassword",
	"set-password",
	"complete",
	"signup",
	"register",
	// one-time sign-in / magic-link / passwordless login (e.g. "Your one time login link")
	"login",
	"log-in",
	"signin",
	"sign-in",
	"onetime",
	"one-time",
	"magic",
	"magiclink",
	"passwordless",
	"token",
	"otl",
];

/** Rank links so the most likely confirmation/verification URL comes first. */
export function rankConfirmationLinks(links: string[], domainHint?: string): string[] {
	const score = (url: string): number => {
		const u = url.toLowerCase();
		let s = 0;
		for (const h of CONFIRM_HINTS) if (u.includes(h)) s += 3;
		if (domainHint && u.includes(domainHint.toLowerCase())) s += 2;
		// Long token-bearing links are usually the action link.
		if (/[?&/][a-z0-9]{16,}/i.test(url)) s += 1;
		// Deprioritise unsubscribe / help / privacy noise.
		if (/unsubscribe|privacy|terms|help|support|preferences/.test(u)) s -= 5;
		// An image/asset URL that slipped through is never the action link.
		if (ASSET_URL.test(u)) s -= 10;
		return s;
	};
	return [...links].sort((a, b) => score(b) - score(a));
}

export interface GmailMessageMatch {
	id: string;
	from: string;
	subject: string;
	date: string;
	links: string[];
	/** Decoded body text (html+plain), for code extraction. Truncated for safety. */
	text: string;
}

/** A deep-link that opens one specific message in the Gmail web UI. `id` is the
 *  Gmail API message id (the same hex id the web client uses in `#all/<id>`). */
export function gmailMessageUrl(id: string): string {
	return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`;
}

async function gmailFetch(accessToken: string, path: string): Promise<Response> {
	return fetch(`${GMAIL_API}${path}`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
}

/** Pull Google's actual error reason out of a failed Gmail API response — so a 403
 *  says "insufficient scopes" vs "Gmail API not enabled" instead of a bare status. */
async function gmailErrorReason(res: Response): Promise<string> {
	try {
		const raw = await res.text();
		try {
			const j = JSON.parse(raw) as { error?: { message?: string; status?: string } | string; error_description?: string };
			const e = j.error;
			if (typeof e === "object" && e?.message) return e.message;
			if (typeof e === "string") return j.error_description || e;
		} catch {
			/* not JSON */
		}
		return raw.slice(0, 200) || "no error body";
	} catch {
		return "unreadable error body";
	}
}

/**
 * Search the mailbox and return the newest matching message with its links.
 * `query` is Gmail search syntax (e.g. `from:coles newer_than:1d`).
 */
export async function findMatchingMessage(
	accessToken: string,
	query: string,
): Promise<GmailMessageMatch | null> {
	const listRes = await gmailFetch(
		accessToken,
		`/messages?q=${encodeURIComponent(query)}&maxResults=5`,
	);
	if (!listRes.ok) {
		throw new GmailError(`Gmail search failed (${listRes.status}): ${await gmailErrorReason(listRes)}`);
	}
	const list = (await listRes.json()) as { messages?: { id: string }[] };
	const first = list.messages?.[0];
	if (!first) return null;

	const msgRes = await gmailFetch(accessToken, `/messages/${first.id}?format=full`);
	if (!msgRes.ok) throw new GmailError(`Gmail message fetch failed (${msgRes.status}): ${await gmailErrorReason(msgRes)}`);
	const msg = (await msgRes.json()) as {
		id: string;
		internalDate?: string;
		payload?: GmailPart & { headers?: { name: string; value: string }[] };
	};
	const headers = msg.payload?.headers ?? [];
	const header = (name: string) =>
		headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
	const body = collectText(msg.payload);
	return {
		id: msg.id,
		from: header("from"),
		subject: header("subject"),
		date: header("date"),
		links: extractLinks(body),
		text: body.slice(0, 20000),
	};
}

/** Build a Gmail search query from structured hints. */
export function buildQuery(opts: {
	from?: string;
	subject?: string;
	withinDays?: number;
}): string {
	const parts: string[] = [];
	if (opts.from) parts.push(`from:${opts.from}`);
	if (opts.subject) parts.push(`subject:(${opts.subject})`);
	parts.push(`newer_than:${Math.max(1, Math.min(opts.withinDays ?? 1, 7))}d`);
	return parts.join(" ");
}

// ── Reading a message properly (#711) ────────────────────────────────────────
//
// Everything above this line is shaped around ONE job: find a confirmation link. That is why
// `findMatchingMessage` returns only the newest match and truncates the body — a link either is
// in the latest mail or is not worth waiting for.
//
// "Read the mail I was sent and act on what was attached" is a different job, and it needs the
// three things that shape deliberately drops: more than one match, the threading headers a reply
// has to quote, and the attachments. None of it needs a new OAuth scope — `gmail.readonly`
// already covers `messages.attachments.get`.

/** One attachment part, as named by the MIME tree. `attachmentId` is what fetches the bytes. */
export interface GmailAttachment {
	attachmentId: string;
	filename: string;
	mimeType: string;
	/** Bytes, as Gmail reports them. Not always present; 0 when absent. */
	size: number;
}

/**
 * Walk the MIME tree and collect every part that is an attachment.
 *
 * The test is `filename` being non-empty AND an `attachmentId` being present, not the mimeType:
 * an attached PDF and an inline logo are both non-text parts, but only a real attachment carries
 * a filename, and only a part Gmail stores separately carries an attachmentId. A small part can
 * arrive with its bytes inline in `body.data` and NO attachmentId — that is a legitimate
 * attachment we cannot fetch by id, so it is reported with an empty id rather than dropped
 * silently, and the download tool says why it cannot fetch it.
 */
export function collectAttachments(part: GmailPart | undefined): GmailAttachment[] {
	if (!part) return [];
	const out: GmailAttachment[] = [];
	const filename = part.filename ?? "";
	if (filename && (part.body?.attachmentId || part.body?.data)) {
		out.push({
			attachmentId: part.body?.attachmentId ?? "",
			filename,
			mimeType: part.mimeType || "application/octet-stream",
			size: part.body?.size ?? 0,
		});
	}
	for (const child of part.parts ?? []) out.push(...collectAttachments(child));
	return out;
}

/** A message as a caller who intends to REPLY needs it: threading headers included. */
export interface GmailMessage {
	id: string;
	threadId: string;
	from: string;
	to: string;
	cc: string;
	subject: string;
	date: string;
	/** RFC-2822 Message-ID of this message — what a reply's In-Reply-To must quote. */
	messageId: string;
	/** This message's own References chain, which a reply extends. */
	references: string;
	snippet: string;
	text: string;
	attachments: GmailAttachment[];
}

interface RawGmailMessage {
	id: string;
	threadId?: string;
	snippet?: string;
	payload?: GmailPart & { headers?: { name: string; value: string }[] };
}

function headerReader(msg: RawGmailMessage): (name: string) => string {
	const headers = msg.payload?.headers ?? [];
	return (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function toGmailMessage(msg: RawGmailMessage, maxChars: number): GmailMessage {
	const header = headerReader(msg);
	return {
		id: msg.id,
		threadId: msg.threadId ?? msg.id,
		from: header("from"),
		to: header("to"),
		cc: header("cc"),
		subject: header("subject"),
		date: header("date"),
		messageId: header("message-id"),
		references: header("references"),
		snippet: msg.snippet ?? "",
		text: collectText(msg.payload).slice(0, maxChars),
		attachments: collectAttachments(msg.payload),
	};
}

/** One search hit — enough to decide which message to open, without paying for every body. */
export interface GmailSearchHit {
	id: string;
	threadId: string;
	from: string;
	subject: string;
	date: string;
	snippet: string;
	/** Attachment filenames only. The manifest with ids comes from `getMessage`. */
	attachmentNames: string[];
}

/**
 * Search the mailbox and return up to `max` matches, newest first.
 *
 * Uses `format=metadata` for the per-hit fetch: headers and snippet come back, bodies do not.
 * A search over 10 messages otherwise drags 10 full bodies through the Worker to show a list.
 * `metadataHeaders` cannot filter the payload structure though, so attachment names still come
 * from the part tree Gmail returns — which it does at metadata level, without the body data.
 */
export async function listMessages(
	accessToken: string,
	query: string,
	max = 10,
): Promise<GmailSearchHit[]> {
	const capped = Math.max(1, Math.min(25, Math.floor(max)));
	const listRes = await gmailFetch(
		accessToken,
		`/messages?q=${encodeURIComponent(query)}&maxResults=${capped}`,
	);
	if (!listRes.ok) {
		throw new GmailError(`Gmail search failed (${listRes.status}): ${await gmailErrorReason(listRes)}`);
	}
	const list = (await listRes.json()) as { messages?: { id: string }[] };
	const ids = (list.messages ?? []).map((m) => m.id);
	if (ids.length === 0) return [];

	const hits: GmailSearchHit[] = [];
	for (const id of ids) {
		const res = await gmailFetch(accessToken, `/messages/${encodeURIComponent(id)}?format=metadata`);
		// One unreadable message must not fail the whole search — the others are still useful.
		if (!res.ok) continue;
		const msg = (await res.json()) as RawGmailMessage;
		const header = headerReader(msg);
		hits.push({
			id: msg.id,
			threadId: msg.threadId ?? msg.id,
			from: header("from"),
			subject: header("subject"),
			date: header("date"),
			snippet: msg.snippet ?? "",
			attachmentNames: collectAttachments(msg.payload).map((a) => a.filename),
		});
	}
	return hits;
}

/** Fetch one message in full — body, threading headers, and the attachment manifest. */
export async function getMessage(
	accessToken: string,
	id: string,
	maxChars = 40000,
): Promise<GmailMessage> {
	const res = await gmailFetch(accessToken, `/messages/${encodeURIComponent(id)}?format=full`);
	if (!res.ok) {
		throw new GmailError(`Gmail message fetch failed (${res.status}): ${await gmailErrorReason(res)}`);
	}
	return toGmailMessage((await res.json()) as RawGmailMessage, maxChars);
}

/**
 * Download one attachment's bytes.
 *
 * Returns Gmail's base64URL string UNCHANGED rather than decoded bytes. The only consumer is the
 * instance file store, whose upload route takes `contentBase64` — so decoding here just to
 * re-encode there would double peak memory on exactly the large files most likely to hit the
 * Worker's limit. `base64UrlToBase64` does the alphabet translation with no size change.
 */
export async function downloadAttachment(
	accessToken: string,
	messageId: string,
	attachmentId: string,
): Promise<{ base64url: string; size: number }> {
	const res = await gmailFetch(
		accessToken,
		`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
	);
	if (!res.ok) {
		throw new GmailError(`Gmail attachment fetch failed (${res.status}): ${await gmailErrorReason(res)}`);
	}
	const data = (await res.json()) as { data?: string; size?: number };
	if (!data.data) throw new GmailError("Gmail returned no data for that attachment");
	return { base64url: data.data, size: data.size ?? 0 };
}

/** base64url → standard base64. Gmail emits the URL alphabet; atob and the file store want the
 *  standard one. Padding is re-added because Gmail omits it and atob rejects a bare remainder. */
export function base64UrlToBase64(input: string): string {
	const swapped = input.replace(/-/g, "+").replace(/_/g, "/");
	const remainder = swapped.length % 4;
	return remainder === 0 ? swapped : swapped + "=".repeat(4 - remainder);
}

// ── Sending (#713) ───────────────────────────────────────────────────────────
//
// Everything above reads. This half writes, and it is the most consequential thing an agent on
// this platform can do: mail leaves under the owner's own name, to a real person, and cannot be
// recalled. The gates live in connectors/gmail.ts; what lives here is the part that has to be
// correct rather than merely permitted — the MIME.

/** The scope a send needs. `gmail.send` is send-only: it cannot read, delete or modify, which is
 *  why it is requested instead of the far broader `gmail.modify` that would also cover it. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/**
 * Strip CR and LF from a header value.
 *
 * This is the header-injection guard, and it is not theoretical here: every header value below
 * is model-supplied or derived from an email the model was told to read. A `\r\n` inside a
 * subject ends the Subject header and starts whatever the injected text says — `Bcc:` being the
 * interesting one, since the send would silently copy a third party.
 *
 * Stripping rather than rejecting is deliberate: a newline in a subject is a formatting mistake
 * far more often than an attack, and failing the send teaches the model to retry rather than to
 * fix it. The body is unaffected — it lives in the MIME part, where newlines are data.
 */
export function sanitizeHeaderValue(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

/** RFC 2047 encode a header value when it is not plain ASCII (subjects, display names).
 *  Raw UTF-8 in a header is not legal and renders as mojibake in most clients. */
export function encodeHeaderValue(value: string): string {
	const clean = sanitizeHeaderValue(value);
	if (!/[^\x20-\x7E]/.test(clean)) return clean;
	const utf8 = new TextEncoder().encode(clean);
	let binary = "";
	for (const byte of utf8) binary += String.fromCharCode(byte);
	return `=?UTF-8?B?${btoa(binary)}?=`;
}

/** Base64 with the 76-character line wrapping RFC 2045 requires of an attachment body. */
function wrapBase64(b64: string): string {
	return (b64.match(/.{1,76}/g) ?? []).join("\r\n");
}

export interface OutgoingAttachment {
	filename: string;
	mimeType: string;
	/** STANDARD base64 (not base64url) of the file's bytes. */
	base64: string;
}

export interface OutgoingMessage {
	to: string;
	cc?: string;
	subject: string;
	body: string;
	/** Set on a reply: the parent's Message-ID, quoted so clients thread it. */
	inReplyTo?: string;
	/** Set on a reply: the parent's References chain plus the parent's own Message-ID. */
	references?: string;
	attachments?: OutgoingAttachment[];
}

/**
 * Build an RFC 2822 message.
 *
 * The body is base64'd with an explicit UTF-8 charset rather than sent as 8-bit text. The
 * motivating case for this whole feature was a mail forwarded from a Chinese iPhone, so "the
 * body is ASCII" was never a safe assumption, and a quoted-printable encoder is a lot of code
 * to get subtly wrong for no gain.
 */
export function buildMimeMessage(msg: OutgoingMessage): string {
	// Kept short on purpose: a full UUID here pushed the Content-Type header past the 78-column
	// RFC 5322 recommends, and an over-long unfolded header is exactly what a strict MTA rewrites.
	const boundary = `----pags-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
	const headers: string[] = [
		`To: ${sanitizeHeaderValue(msg.to)}`,
		...(msg.cc ? [`Cc: ${sanitizeHeaderValue(msg.cc)}`] : []),
		`Subject: ${encodeHeaderValue(msg.subject)}`,
		...(msg.inReplyTo ? [`In-Reply-To: ${sanitizeHeaderValue(msg.inReplyTo)}`] : []),
		...(msg.references ? [`References: ${sanitizeHeaderValue(msg.references)}`] : []),
		"MIME-Version: 1.0",
	];

	const bodyB64 = (() => {
		const utf8 = new TextEncoder().encode(msg.body);
		let binary = "";
		for (const byte of utf8) binary += String.fromCharCode(byte);
		return wrapBase64(btoa(binary));
	})();

	const attachments = msg.attachments ?? [];
	if (attachments.length === 0) {
		return [
			...headers,
			'Content-Type: text/plain; charset="UTF-8"',
			"Content-Transfer-Encoding: base64",
			"",
			bodyB64,
		].join("\r\n");
	}

	const parts: string[] = [
		...headers,
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		'Content-Type: text/plain; charset="UTF-8"',
		"Content-Transfer-Encoding: base64",
		"",
		bodyB64,
	];
	for (const att of attachments) {
		const name = sanitizeHeaderValue(att.filename).replace(/"/g, "'");
		parts.push(
			`--${boundary}`,
			`Content-Type: ${sanitizeHeaderValue(att.mimeType)}; name="${name}"`,
			`Content-Disposition: attachment; filename="${name}"`,
			"Content-Transfer-Encoding: base64",
			"",
			wrapBase64(att.base64),
		);
	}
	parts.push(`--${boundary}--`, "");
	return parts.join("\r\n");
}

/** standard base64 → base64url, unpadded. What Gmail's `raw` field wants. */
export function base64ToBase64Url(input: string): string {
	return input.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build the reply headers for a parent message.
 *
 * `References` is the parent's own chain with the parent appended — that is what makes a client
 * nest the reply under the original rather than showing it as a new conversation. Passing
 * `threadId` to the API as well is necessary but NOT sufficient: it threads the copy in the
 * SENDER's Gmail, and does nothing for the recipient, whose client only sees the headers.
 */
export function replyHeaders(parent: Pick<GmailMessage, "messageId" | "references">): {
	inReplyTo?: string;
	references?: string;
} {
	if (!parent.messageId) return {};
	const chain = [parent.references, parent.messageId].filter(Boolean).join(" ").trim();
	return { inReplyTo: parent.messageId, references: chain };
}

/** Prefix a subject with "Re: " unless it already carries one (any case, any leading whitespace). */
export function replySubject(subject: string): string {
	const s = subject.trim();
	if (!s) return "Re:";
	return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** Send a built MIME message. `threadId` threads the sender's own copy. */
export async function sendMessage(
	accessToken: string,
	mime: string,
	threadId?: string,
): Promise<{ id: string; threadId: string }> {
	const utf8 = new TextEncoder().encode(mime);
	let binary = "";
	for (const byte of utf8) binary += String.fromCharCode(byte);
	const res = await fetch(`${GMAIL_API}/messages/send`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ raw: base64ToBase64Url(btoa(binary)), ...(threadId ? { threadId } : {}) }),
	});
	if (!res.ok) {
		throw new GmailError(`Gmail send failed (${res.status}): ${await gmailErrorReason(res)}`);
	}
	const sent = (await res.json()) as { id?: string; threadId?: string };
	return { id: sent.id ?? "", threadId: sent.threadId ?? threadId ?? "" };
}

/**
 * Does a recorded scope string cover sending?
 *
 * Answers the question BEFORE a send is attempted, from what was recorded at connect time
 * (`user_api_keys.granted_scopes`, migration 0133). `null`/empty means the connection predates
 * that column — which is precisely the population granted read-only, so it reads as "cannot
 * send" and the user is told to reconnect. Fail-closed: a wrong "yes" here costs a raw 403 the
 * user cannot act on, a wrong "no" costs one unnecessary reconnect.
 */
export function scopesAllowSend(grantedScopes: string | null | undefined): boolean {
	if (!grantedScopes) return false;
	return grantedScopes.split(/\s+/).some((s) => s === GMAIL_SEND_SCOPE || s === "https://mail.google.com/");
}
