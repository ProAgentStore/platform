import { RunnerInputError } from "./errors.js";

/** Owner-resolved website access, independent of browser engine, credentials and submit policy. */
export interface BrowserWebsiteAccess {
	mode: "allow_all" | "allowlist" | "ask_once";
	domains: string[];
	rememberedDomains?: string[];
	deniedDomains?: string[];
}

export interface WebsiteAccessBlock {
	decision: "ask" | "deny";
	hostname: string;
	url: string;
	mode: "allowlist" | "ask_once";
	/** The browser action was sent, not proof of its effect. Never automatically replay it. */
	actionDispatched: boolean;
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export function normalizeWebsiteHostname(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const host = value.trim().toLowerCase().replace(/\.$/, "");
	return DOMAIN.test(host) ? host : null;
}

function domains(value: unknown, key: string, max: number): string[] {
	if (!Array.isArray(value) || value.length > max) throw new RunnerInputError(`browserWebsiteAccess.${key} must be up to ${max} exact hostnames`);
	const normalized = value.map(normalizeWebsiteHostname);
	if (normalized.some((host) => !host)) throw new RunnerInputError(`browserWebsiteAccess.${key} requires bare DNS hostnames, without a URL, wildcard, port or IP address`);
	return [...new Set(normalized as string[])];
}

/** Absence retains legacy behavior. Malformed explicit policy must never silently become allow_all. */
export function parseBrowserWebsiteAccess(raw: unknown): BrowserWebsiteAccess | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RunnerInputError("browserWebsiteAccess must be a policy object");
	const value = raw as Record<string, unknown>;
	if (value.mode !== "allow_all" && value.mode !== "allowlist" && value.mode !== "ask_once") throw new RunnerInputError("browserWebsiteAccess.mode must be allow_all, allowlist or ask_once");
	return {
		mode: value.mode,
		domains: domains(value.domains, "domains", 100),
		...(value.rememberedDomains === undefined ? {} : { rememberedDomains: domains(value.rememberedDomains, "rememberedDomains", 1000) }),
		...(value.deniedDomains === undefined ? {} : { deniedDomains: domains(value.deniedDomains, "deniedDomains", 1000) }),
	};
}

/** Exact hosts only. A remembered denial cannot override an explicitly configured allow entry. */
export function websiteDecision(policy: BrowserWebsiteAccess, hostname: string): "allow" | "ask" | "deny" {
	if (policy.mode === "allow_all") return "allow";
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (policy.domains.includes(host)) return "allow";
	if (policy.mode === "allowlist") return "deny";
	if (policy.deniedDomains?.includes(host)) return "deny";
	return policy.rememberedDomains?.includes(host) ? "allow" : "ask";
}

/** The scheme guard stays independent: allow_all grants websites, never local files or page code. */
export function websiteAccessBlock(policy: BrowserWebsiteAccess, rawUrl: string, actionDispatched = false): WebsiteAccessBlock | null {
	let url: URL;
	try { url = new URL(rawUrl); } catch { return null; }
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	const decision = websiteDecision(policy, url.hostname);
	if (decision === "allow") return null;
	return { decision, hostname: url.hostname.toLowerCase().replace(/\.$/, ""), url: `${url.origin}${url.pathname}`, mode: policy.mode as "allowlist" | "ask_once", actionDispatched };
}

/** Frozen task settings may refresh durable decisions, but an action cannot replace its access mode. */
export function refreshWebsiteAccess(bound: BrowserWebsiteAccess | undefined, incoming: BrowserWebsiteAccess | undefined): BrowserWebsiteAccess | undefined {
	if (!incoming) return bound;
	if (!bound) return incoming;
	if (bound.mode !== incoming.mode || JSON.stringify([...bound.domains].sort()) !== JSON.stringify([...incoming.domains].sort())) throw new RunnerInputError("This task's website access policy is fixed. Start a new task to use changed website settings.", 409);
	return incoming;
}

/** Bind a durable owner answer to the exact paused request before any state is released. */
export function websiteResumePolicy(bound: BrowserWebsiteAccess | undefined, incoming: unknown, pause: { hostname: string; pauseKey: string } | undefined, expectedKey: unknown, decision: unknown): BrowserWebsiteAccess | undefined {
	const next = refreshWebsiteAccess(bound, parseBrowserWebsiteAccess(incoming));
	if (pause || expectedKey !== undefined || decision !== undefined) {
		if (!pause || expectedKey !== pause.pauseKey) throw new RunnerInputError("Website approval does not match the current pause", 409);
		if (next?.mode !== "ask_once" || (decision !== "allow" && decision !== "deny") || websiteDecision(next, pause.hostname) !== decision) throw new RunnerInputError("The saved owner website decision does not authorize this pause response", 409);
	}
	return next;
}
