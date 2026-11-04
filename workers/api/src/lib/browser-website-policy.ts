import { compareVersions } from "./machine-capability-compat.js";
/** Owner-configured website access, independent of submission and credential permission. */
import { normalizeDomain } from "./browser-hostname.js";

export const BROWSER_WEBSITE_ACCESS_MIN_CLI = "0.4.209";
export const WEBSITE_ACCESS_MODES = ["allow_all", "allowlist", "ask_once"] as const;
export interface BrowserWebsiteAccess { mode: (typeof WEBSITE_ACCESS_MODES)[number]; domains: string[] }
export interface BrowserWebsiteAccessWire extends BrowserWebsiteAccess { rememberedDomains?: string[]; deniedDomains?: string[] }

/** Exact hostnames only. Null means inherit; malformed explicit objects never become allow_all. */
export function browserWebsiteAccessValue(value: unknown): BrowserWebsiteAccess | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (Object.keys(raw).some((key) => !["mode", "domains"].includes(key)) || !WEBSITE_ACCESS_MODES.includes(raw.mode as BrowserWebsiteAccess["mode"]) || !Array.isArray(raw.domains) || raw.domains.length > 100) return null;
	const domains = raw.domains.map(normalizeDomain);
	if (domains.some((domain) => !domain)) return null;
	return { mode: raw.mode as BrowserWebsiteAccess["mode"], domains: [...new Set(domains as string[])] };
}

export function websiteAccessRunnerProblem(access: BrowserWebsiteAccess | null | undefined, version: string | null | undefined, node?: string | null): string | null {
	if (!access) return null;
	if (version && /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(version.trim()) && compareVersions(version.trim(), BROWSER_WEBSITE_ACCESS_MIN_CLI) >= 0) return null;
	return `Website access requires CLI ${BROWSER_WEBSITE_ACCESS_MIN_CLI} or newer on ${node || "this instance's runner"}; registered version is ${version || "unknown"}. Update and restart the runner before continuing this browser task.`;
}

/** Relay metadata includes server-owned decisions; it is never accepted by the settings writer. */
export function browserWebsiteAccessWireValue(value: unknown): BrowserWebsiteAccessWire | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (Object.keys(raw).some((key) => !["mode", "domains", "rememberedDomains", "deniedDomains"].includes(key))) return null;
	const access = browserWebsiteAccessValue({ mode: raw.mode, domains: raw.domains });
	if (!access) return null;
	const out: BrowserWebsiteAccessWire = { ...access };
	for (const key of ["rememberedDomains", "deniedDomains"] as const) {
		if (raw[key] === undefined) continue;
		if (!Array.isArray(raw[key]) || raw[key].length > 1000) return null;
		const domains = raw[key].map(normalizeDomain);
		if (domains.some((domain) => !domain)) return null;
		out[key] = [...new Set(domains as string[])];
	}
	return out;
}
