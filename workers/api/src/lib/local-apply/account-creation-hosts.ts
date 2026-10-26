/**
 * The hosts where the Runner may create an account (#1230): `account-creation-hosts.json`, validated.
 *
 * A host is matched by its site (`au.seek.com.au` → `seek.com.au`), the longest listed entry winning. Nothing is guessed: a host that is not
 * listed, or is listed with `enabled: false`, is never touched. `acceptTerms` is the owner's standing consent, per host, to the Runner ticking
 * that site's terms box on their behalf — default false, in which case a form that insists on the box ends in the owner's handoff.
 */
import hostsFile from "./account-creation-hosts.json" with { type: "json" };

export interface AccountCreationHost {
	host: string;
	enabled: boolean;
	acceptTerms: boolean;
	reason: string;
}

/** Validate a parsed config, dropping (never guessing at) an entry that is not well-formed. Pure, so the loader is tested as one. */
export function parseAccountCreationHosts(raw: unknown): AccountCreationHost[] {
	const hosts = (raw as { hosts?: unknown } | null)?.hosts;
	if (!Array.isArray(hosts)) return [];
	const out: AccountCreationHost[] = [];
	for (const h of hosts as Array<Record<string, unknown>>) {
		const host = typeof h?.host === "string" ? h.host.trim().toLowerCase() : "";
		if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || out.some((e) => e.host === host)) continue;
		out.push({ host, enabled: h.enabled === true, acceptTerms: h.acceptTerms === true, reason: typeof h.reason === "string" ? h.reason : "" });
	}
	return out;
}

export const ACCOUNT_CREATION_HOSTS: readonly AccountCreationHost[] = parseAccountCreationHosts(hostsFile);

/** The entry that covers this host (the longest listed site it is on), or null. Enabled or not — callers decide. */
export function accountCreationHostFor(host: string | undefined, hosts: readonly AccountCreationHost[] = ACCOUNT_CREATION_HOSTS): AccountCreationHost | null {
	const h = (host ?? "").trim().toLowerCase();
	if (!h) return null;
	return [...hosts].sort((a, b) => b.host.length - a.host.length).find((e) => h === e.host || h.endsWith(`.${e.host}`)) ?? null;
}
