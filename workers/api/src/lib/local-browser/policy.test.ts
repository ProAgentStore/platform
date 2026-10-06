/**
 * Local CLI browser research policy (#945): what a creator may declare, what a subscriber may
 * choose within it, the policy a run starts with, and the run lifecycle.
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_LIMITS,
	type LocalBrowserCapability,
	canTransition,
	domainWithin,
	effectiveLocalBrowserPolicy,
	isTerminal,
	mergeLocalBrowserSettings,
	normalizeDomain,
	parseLocalBrowserCapability,
	validateLocalBrowserSettings,
} from "./policy";

const cap = (raw: unknown = {}): LocalBrowserCapability => {
	const c = parseLocalBrowserCapability(raw);
	if ("error" in c) throw new Error(c.error);
	return c;
};
const err = (r: unknown) => (r && typeof r === "object" && "error" in r ? (r as { error: string }).error : "");

describe("the creator's capability block", () => {
	it("resolves an empty declaration to research-only, both engines, subscription-only and the default limits", () => {
		expect(cap()).toEqual({ engines: ["claude", "codex"], mode: "research_only", subscriptionOnly: true, resultSchema: { id: "findings", version: 1 }, limits: DEFAULT_LIMITS, allowDomains: [], denyDomains: [] });
	});

	it("keeps what is declared, normalized", () => {
		const c = cap({ engines: ["codex"], subscriptionOnly: false, resultSchema: { id: "job_leads", version: 2 }, limits: { maxMinutes: 30 }, allowDomains: ["Seek.com.au", "seek.com.au"], collection: { name: "job_leads", keyField: "url" } });
		expect(c).toMatchObject({ engines: ["codex"], subscriptionOnly: false, resultSchema: { id: "job_leads", version: 2 }, limits: { ...DEFAULT_LIMITS, maxMinutes: 30 }, allowDomains: ["seek.com.au"], collection: { name: "job_leads", keyField: "url" } });
	});

	it.each([
		[{ engines: [] }, /engines must list/],
		[{ engines: ["gemini"] }, /engines must list/],
		[{ mode: "full_access" }, /only research ships/],
		[{ limits: { maxMinutes: 600 } }, /maxMinutes must be a whole number from 1 to 60/],
		[{ limits: { maxConcurrent: 0 } }, /maxConcurrent/],
		[{ allowDomains: ["https://seek.com.au/jobs"] }, /not a hostname/],
		[{ allowDomains: ["*.seek.com.au"] }, /not a hostname/],
		[{ denyDomains: ["10.0.0.1"] }, /not a hostname/],
		[{ resultSchema: { id: "bad id" } }, /resultSchema/],
		[{ collection: { name: "" } }, /collection.name/],
	])("refuses %j", (raw, why) => {
		expect(err(parseLocalBrowserCapability(raw))).toMatch(why);
	});
});

describe("an instance's settings, within the capability", () => {
	it("accepts a full, valid set", () => {
		const r = validateLocalBrowserSettings({ engine: "codex", authMode: "machine", workspace: { kind: "path", path: "~/jobs" }, browserProfile: "default", access: { mode: "research_only", allowDomains: ["seek.com.au"], denyDomains: ["linkedin.com"] }, limits: { maxPages: 10 }, traceRetentionDays: 7, collection: { name: "leads" } }, cap());
		expect(r).toEqual({ settings: { engine: "codex", authMode: "machine", workspace: { kind: "path", path: "~/jobs" }, browserProfile: "default", access: { mode: "research_only", allowDomains: ["seek.com.au"], denyDomains: ["linkedin.com"] }, limits: { maxPages: 10 }, traceRetentionDays: 7, collection: { name: "leads" } } });
	});

	it("refuses api-key sign-in when the agent is subscription-only, and allows it when the agent says so", () => {
		expect(err(validateLocalBrowserSettings({ authMode: "api-key" }, cap()))).toMatch(/subscription only.*api-key.*refused/);
		expect(validateLocalBrowserSettings({ authMode: "api-key" }, cap({ subscriptionOnly: false }))).toEqual({ settings: { authMode: "api-key" } });
	});

	it("refuses an engine the agent does not offer", () => {
		expect(err(validateLocalBrowserSettings({ engine: "claude" }, cap({ engines: ["codex"] })))).toMatch(/engine must be one this agent offers: codex/);
	});

	it.each([["/Users/me/jobs"], ["~/../etc"], ["~/jobs/../../x"], ["~/./x"], ["jobs"], ["~"], ["C:\\jobs"]])("refuses the workspace path %s as outside the runner's allowed scope", (path) => {
		expect(err(validateLocalBrowserSettings({ workspace: { kind: "path", path } }, cap()))).toMatch(/outside the runner's allowed scope/);
	});

	it("refuses a git-ish or unknown workspace kind", () => {
		expect(err(validateLocalBrowserSettings({ workspace: { kind: "repo", repo: "a/b" } }, cap()))).toMatch(/workspace.kind/);
	});

	it("lets an instance narrow the agent's sites, never widen them", () => {
		const c = cap({ allowDomains: ["seek.com.au"] });
		expect(validateLocalBrowserSettings({ access: { allowDomains: ["jobs.seek.com.au"] } }, c)).toEqual({ settings: { access: { allowDomains: ["jobs.seek.com.au"] } } });
		expect(err(validateLocalBrowserSettings({ access: { allowDomains: ["indeed.com"] } }, c))).toMatch(/indeed.com is outside the sites this agent may visit/);
	});

	it("refuses a limit above the agent's ceiling instead of clamping it", () => {
		expect(err(validateLocalBrowserSettings({ limits: { maxPages: 31 } }, cap()))).toMatch(/limits.maxPages must be a whole number from 1 to 30/);
	});

	it("refuses an access mode that does not ship yet", () => {
		expect(err(validateLocalBrowserSettings({ access: { mode: "ask_before_action" } }, cap()))).toMatch(/not available yet/);
	});

	it("patches access and limits per key, so one list or one limit leaves the others alone", () => {
		const stored = { access: { allowDomains: ["seek.com.au"], denyDomains: ["ads.com"] }, limits: { maxPages: 10, maxMinutes: 5 } };
		expect(mergeLocalBrowserSettings(stored, { access: { denyDomains: null }, limits: { maxPages: 20 } }, cap())).toEqual({ settings: { access: { allowDomains: ["seek.com.au"] }, limits: { maxPages: 20, maxMinutes: 5 } } });
	});

	it("clears one limit with a null inside limits, even when none was stored", () => {
		expect(mergeLocalBrowserSettings({}, { limits: { maxPages: null, maxMinutes: 5 } }, cap())).toEqual({ settings: { limits: { maxMinutes: 5 } } });
		expect(mergeLocalBrowserSettings({ limits: { maxPages: 9 } }, { limits: { maxPages: null } }, cap())).toEqual({ settings: { limits: {} } });
	});

	it("merges a patch: present replaces, null clears to the default, absent keeps", () => {
		const stored = { engine: "codex", traceRetentionDays: 7 };
		expect(mergeLocalBrowserSettings(stored, { traceRetentionDays: null, browserProfile: "default" }, cap())).toEqual({ settings: { engine: "codex", browserProfile: "default" } });
	});
});

describe("the policy a run starts with", () => {
	it("fills every field from the agent where the instance chose nothing", () => {
		expect(effectiveLocalBrowserPolicy(cap(), {})).toEqual({
			engine: "claude",
			authMode: "subscription",
			workspace: { kind: "scratch" },
			browserProfile: "isolated",
			mode: "research_only",
			allowDomains: [],
			denyDomains: [],
			limits: DEFAULT_LIMITS,
			traceRetentionDays: 30,
			resultSchema: { id: "findings", version: 1 },
			collection: null,
		});
	});

	it("unions deny lists, lets deny win over allow, and narrows limits", () => {
		const p = effectiveLocalBrowserPolicy(cap({ allowDomains: ["seek.com.au", "indeed.com"], denyDomains: ["ads.example.com"] }), { access: { denyDomains: ["indeed.com"] }, limits: { maxMinutes: 5 } });
		expect(p).toMatchObject({ allowDomains: ["seek.com.au"], denyDomains: ["ads.example.com", "indeed.com"], limits: { ...DEFAULT_LIMITS, maxMinutes: 5 } });
	});

	it("refuses stored settings the creator has since narrowed below", () => {
		expect(err(effectiveLocalBrowserPolicy(cap({ engines: ["codex"] }), { engine: "claude" }))).toMatch(/no longer fit this agent/);
	});
});

describe("domains", () => {
	it("normalizes hostnames and matches subdomains only", () => {
		expect(normalizeDomain(" Seek.COM.au. ")).toBe("seek.com.au");
		expect(normalizeDomain("seek.com.au:443")).toBeNull();
		expect(domainWithin("jobs.seek.com.au", "seek.com.au")).toBe(true);
		expect(domainWithin("notseek.com.au", "seek.com.au")).toBe(false);
	});
});

describe("the run lifecycle", () => {
	it("allows exactly these moves", () => {
		expect(canTransition("queued", "running")).toBe(true);
		expect(canTransition("running", "paused")).toBe(true);
		expect(canTransition("paused", "running")).toBe(true);
		expect(canTransition("running", "completed")).toBe(true);
		expect(canTransition("queued", "paused")).toBe(false);
		expect(canTransition("queued", "completed")).toBe(false);
		expect(canTransition("paused", "completed")).toBe(false);
	});

	it("never moves a terminal run", () => {
		for (const t of ["completed", "failed", "cancelled"] as const) {
			expect(isTerminal(t)).toBe(true);
			for (const to of ["queued", "running", "paused", "completed", "failed", "cancelled"] as const) expect(canTransition(t, to)).toBe(false);
		}
	});
});
