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
 */
export function isAllowedBundleUrl(bundleUrl: string): boolean {
	try {
		const u = new URL(bundleUrl);
		// No localhost exception here, unlike return_to: a dev-only bundle host would be a
		// production-reachable code-execution path if the env were ever misread.
		if (u.protocol !== "https:") return false;
		const host = u.hostname.toLowerCase();
		return host === "proagentstore.online" || host.endsWith(".proagentstore.online");
	} catch {
		return false;
	}
}
