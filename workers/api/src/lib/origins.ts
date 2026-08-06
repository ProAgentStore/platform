/**
 * return_to allowlist for the OAuth flow. Self-contained — trusts ONLY
 * ProAgentStore's own hosts (plus localhost for dev). No other store's domains
 * are allowed, so PAGS auth has no dependency on FAS or any sibling store.
 */
function isAllowedHost(url: URL): boolean {
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host === "127.0.0.1") {
		return url.protocol === "http:" || url.protocol === "https:";
	}
	if (url.protocol !== "https:") return false;
	return host === "proagentstore.online" || host.endsWith(".proagentstore.online");
}

export function isAllowedReturnTo(returnTo: string): boolean {
	try {
		return isAllowedHost(new URL(returnTo));
	} catch {
		return false;
	}
}

/** The origin a ROOT-relative bundle path is judged against — the platform's own. */
const PLATFORM_BUNDLE_BASE = "https://proagentstore.online/";

/**
 * May this URL be loaded as a custom-surface CODE bundle?
 *
 * A surface bundle executes in the console origin with the viewer's session, so this is an
 * account-takeover-grade decision. The console already refuses a cross-origin bundle — but that
 * was the ONLY check: the server happily persisted and served `https://evil.example/x.js`, so
 * any second consumer (a mobile shell, an SSR/preview renderer, an admin preview) that mounted a
 * bundle without re-implementing the same test would inherit the hole. Enforcing it here makes
 * the client check defence-in-depth instead of the whole defence.
 *
 * Deliberately reuses the OAuth return_to allowlist: "our own hosts" is the same question, and
 * two lists would drift.
 *
 * Two forms are accepted, and nothing else:
 *  - a ROOT-relative path (`/console/surfaces/notes.js`) — the form `docs/custom-surfaces.md`
 *    and the shipped example both use, and the only form a creator can write without naming a
 *    host. The absolute-only version of this check silently rejected every documented example.
 *  - an absolute `https://` URL on a platform host.
 *
 * The relative form is RESOLVED rather than string-matched, which is what closes the classic
 * looks-relative-but-isn't bypasses: `//evil.example/x.js` and `/\evil.example/x.js` both parse
 * to a foreign origin (WHATWG treats `\` as `/` for special schemes) and are refused here, the
 * same way `new URL(u, location.href).origin` refuses them in the console.
 */
export function isAllowedBundleUrl(bundleUrl: string): boolean {
	const raw = typeof bundleUrl === "string" ? bundleUrl.trim() : "";
	if (!raw) return false;
	let u: URL | null = null;
	try { u = new URL(raw); } catch { /* not absolute — may still be a root-relative path */ }
	if (!u) {
		// A bare `notes.js` would resolve against whatever page happened to load it, so it is not
		// a contract the server can honour; only a root-anchored path is.
		if (!raw.startsWith("/")) return false;
		try { u = new URL(raw, PLATFORM_BUNDLE_BASE); } catch { return false; }
	}
	// No localhost exception here, unlike return_to: a dev-only bundle host would be a
	// production-reachable code-execution path if the env were ever misread.
	if (u.protocol !== "https:") return false;
	const host = u.hostname.toLowerCase();
	return host === "proagentstore.online" || host.endsWith(".proagentstore.online");
}
