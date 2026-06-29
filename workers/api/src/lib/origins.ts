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
