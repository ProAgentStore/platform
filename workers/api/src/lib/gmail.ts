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
	body?: { data?: string };
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
