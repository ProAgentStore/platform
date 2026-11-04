/** Per-run permission for the exact external site at which the owner saw a pause. */
import { HttpError } from "../auth.js";
import { normalizeDomain } from "../local-browser/policy.js";
import type { ApplyRun } from "./store.js";

export function parseResumeDomains(raw: unknown): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.length > 10) throw new HttpError(400, "allow_domains must be up to 10 bare hostnames");
	const domains = raw.map(normalizeDomain);
	if (domains.some((domain) => !domain)) throw new HttpError(400, "allow_domains must be up to 10 bare hostnames (no URL, path, port or wildcard)");
	return [...new Set(domains as string[])];
}

export function resumeDomainsFor(raw: unknown, run: Pick<ApplyRun, "status" | "pause">): string[] {
	const domains = parseResumeDomains(raw);
	if (!domains.length) return domains;
	if (run.status !== "paused" || run.pause?.reason !== "external_redirect") throw new HttpError(409, "allow_domains is only valid for a paused external_redirect run");
	const pausedDomain = normalizeDomain(run.pause.domain);
	if (!pausedDomain || domains.some((domain) => domain !== pausedDomain)) throw new HttpError(409, "allow_domains must name only the exact hostname in this run's external_redirect pause");
	return domains;
}
