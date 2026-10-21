// Strict validation of a worker-mail identity reply (#1280), and the credential-echo guard every adapter reply passes through.
//
// The identity call is the ONLY thing PAGS requires before storing a connection, so what it accepts is the whole gate. It used to take
// any HTTP 200 — `{}` became a "generic" identity with contract "unknown" — and returned whatever the bridge put in `account.address`
// and `contractVersion`, so a bridge that echoed its bearer there exposed a supplied secret over MCP. Now:
//
//   * `contractVersion` must be EXACTLY `email-worker/v1` (no fuzzy matching, no "unknown");
//   * `account`, when present, is an object whose `address` is null/absent or one plain mailbox address;
//   * `provider`, when present, is `cloudflare` or `generic` — an unknown provider is a protocol failure, never a generic fallback;
//   * a Cloudflare reply's `domains`, `senders`, `replyIdentities`, `mailboxes` and `routes` are well-typed when present — a wrong-typed
//     entry is a failure, not something silently dropped;
//   * the supplied secret appears NOWHERE in the reply, keys or values, at any depth. The reason returned for any failure is a fixed
//     sentence and never carries a fragment of the reply.
//
// A legitimate generic `email-worker/v1` provider (no `provider`, or `generic`, and no lists) still validates.
import { normalizeAddress } from "./email-worker-identities.js";

export const SUPPORTED_CONTRACT = "email-worker/v1";
export const ECHO_MESSAGE = "Bridge echoed credential in identity response";

export type ValidatedIdentityResponse = { ok: true; identity: Record<string, unknown> } | { ok: false; reason: string; echo: boolean };

/** Below this length a substring test would match ordinary words of any reply ("s" is in "address"), so only a whole key or value counts. */
const SUBSTRING_MIN = 8;

function exactAnywhere(value: unknown, s: string, depth = 0): boolean {
	if (depth > 20) return true; // too deep to show clean
	if (typeof value === "string") return value.trim() === s;
	if (Array.isArray(value)) return value.some((v) => exactAnywhere(v, s, depth + 1));
	if (value && typeof value === "object") return Object.entries(value).some(([k, v]) => k.trim() === s || exactAnywhere(v, s, depth + 1));
	return false;
}

/** Does this secret appear anywhere in `value`, in a key or a value, at any depth? Serialised once, so no shape hides it. */
export function containsSecret(value: unknown, secret: string): boolean {
	const s = secret.trim();
	if (!s) return false;
	if (s.length < SUBSTRING_MIN) return exactAnywhere(value, s);
	let text: string;
	try {
		text = JSON.stringify(value) ?? "";
	} catch {
		return true; // a reply that cannot be serialised cannot be shown to be clean
	}
	// JSON escapes (\", \\, \uXXXX) can split a secret that holds such characters, so the escaped form is checked as well.
	return text.includes(s) || text.includes(JSON.stringify(s).slice(1, -1));
}

/** `text` with every occurrence of the secret replaced. */
export function scrubSecret(text: string, secret: string): string {
	const s = secret.trim();
	// A very short secret is scrubbed only when the whole text is it: replacing "s" everywhere would shred every message.
	if (s.length < SUBSTRING_MIN) return s && text.trim() === s ? "[redacted]" : text;
	return text.split(s).join("[redacted]");
}

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function addressesOf(v: unknown, what: string): string | null {
	if (v === undefined) return null;
	if (!Array.isArray(v)) return `${what} must be a list`;
	for (const item of v) if (typeof item !== "string" || normalizeAddress(item) === null) return `${what} holds an entry that is not a plain email address`;
	return null;
}

export function validateIdentityResponse(raw: unknown, secret: string): ValidatedIdentityResponse {
	const fail = (reason: string, echo = false): ValidatedIdentityResponse => ({ ok: false, reason, echo });
	if (containsSecret(raw, secret)) return fail(ECHO_MESSAGE, true);
	if (!isObject(raw)) return fail("The bridge's identity reply is not an object");
	if (raw.contractVersion !== SUPPORTED_CONTRACT) return fail(`The bridge does not speak the supported contract (${SUPPORTED_CONTRACT})`);
	if (raw.account !== undefined && raw.account !== null) {
		if (!isObject(raw.account)) return fail("The bridge's account is not an object");
		const address = raw.account.address;
		if (address !== undefined && address !== null && (typeof address !== "string" || normalizeAddress(address) === null)) return fail("The bridge's account address is not a plain email address");
	}
	const provider = raw.provider;
	if (provider !== undefined && provider !== "cloudflare" && provider !== "generic") return fail("The bridge reports an unknown provider");
	if (provider === "cloudflare") {
		if (raw.domains !== undefined) {
			if (!Array.isArray(raw.domains)) return fail("domains must be a list");
			for (const d of raw.domains) if (typeof d !== "string" || !DOMAIN.test(d.trim().toLowerCase())) return fail("domains holds an entry that is not a domain name");
		}
		for (const key of ["senders", "replyIdentities", "mailboxes"] as const) {
			const problem = addressesOf(raw[key], key);
			if (problem) return fail(problem);
		}
		if (raw.routes !== undefined) {
			if (!Array.isArray(raw.routes)) return fail("routes must be a list");
			for (const r of raw.routes) {
				if (!isObject(r) || typeof r.address !== "string" || normalizeAddress(r.address) === null) return fail("routes holds an entry without a plain email address");
				if (r.destination !== undefined && r.destination !== null && typeof r.destination !== "string") return fail("a route's destination is not a string");
			}
		}
	}
	return { ok: true, identity: raw };
}
