const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A bare hostname, lowercased — or null. No scheme, port, path, wildcard or IP literal. */
export function normalizeDomain(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const d = raw.trim().toLowerCase().replace(/\.$/, "");
	return DOMAIN_RE.test(d) ? d : null;
}
