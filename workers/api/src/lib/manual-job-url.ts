/**
 * Is an owner-pasted job URL one the pipeline may take in (#1056)? Pure — no request is made.
 *
 * Only a public https URL of an allowlisted job provider (the providers `provider-redirect.ts` knows: Indeed,
 * SEEK, LinkedIn) naming exactly one posting. It is reduced to that provider's canonical posting URL — the id
 * and nothing else — so a tracking id, a referral code or a signed-in user's token in the pasted query never
 * reaches a lead, a receipt or a log. A rejection is a category; it never echoes the URL.
 */
import { jobProviderOf, providerPostingUrl } from "./gmail-scout/provider-redirect.js";
import { checkPublicHttpsUrl } from "./ssrf.js";

export type ManualUrlRejectionReason = "not_https" | "private_target" | "provider_not_allowed" | "no_posting_id";

export type ManualUrlCheck = { ok: true; canonicalUrl: string; provider: string } | { ok: false; reason: ManualUrlRejectionReason; host: string | null };

/** Longer than any posting URL a provider prints; anything bigger is not a pasted link. */
const MAX_URL_CHARS = 2048;

export function validateManualJobUrl(raw: string): ManualUrlCheck {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return { ok: false, reason: "not_https", host: null };
	}
	const host = url.hostname.toLowerCase() || null;
	if (raw.length > MAX_URL_CHARS || url.protocol !== "https:" || url.username || url.password) return { ok: false, reason: "not_https", host };
	if (!checkPublicHttpsUrl(url.toString()).ok) return { ok: false, reason: "private_target", host };
	const provider = jobProviderOf(url.hostname);
	if (!provider) return { ok: false, reason: "provider_not_allowed", host };
	const canonicalUrl = providerPostingUrl(url.toString());
	// A search, a saved-search, a company page or a tracking wrapper with no visible id: not ONE posting.
	if (!canonicalUrl) return { ok: false, reason: "no_posting_id", host };
	return { ok: true, canonicalUrl, provider };
}
