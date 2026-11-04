import { RunnerInputError } from "../errors.js";
import type { LocalApplyPause } from "./contract.js";

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const normalized = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase().replace(/\.$/, "") : "";

/** Revalidate the live runner pause, since cloud status can change before resume reaches it. */
export function resumeDomainGrants(raw: unknown, state: string, pause: LocalApplyPause | undefined): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.length > 10) throw new RunnerInputError("allowDomains must be up to 10 bare hostnames");
	const domains = [...new Set(raw.map(normalized))];
	if (domains.some((domain) => !DOMAIN_RE.test(domain))) throw new RunnerInputError("allowDomains must contain bare hostnames, without a URL, path, port or wildcard");
	if (domains.length && (state !== "paused" || pause?.reason !== "external_redirect" || domains.some((domain) => domain !== normalized(pause.domain)))) throw new RunnerInputError("allowDomains must name only the exact hostname of the current external_redirect pause", 409);
	return domains;
}
