/**
 * The Research tab's and the research settings' decisions (#946), held without rendering.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authModeChoices, engineAuthLabel, formFromSettings, pageSteps, parseDomains, patchFromForm, pauseBanner, reviewLabel, runPhases, runProblem, setupChecklist } from "./localBrowser";
import { visibleSurfaces } from "./surfaces";
import type { LocalBrowserRunView, LocalBrowserTraceEvent } from "./types";

const ev = (seq: number, type: string, extra: Partial<LocalBrowserTraceEvent> = {}): LocalBrowserTraceEvent => ({ seq, type, at: "2026-10-07T01:00:00Z", recordedAt: 0, ...extra });
const run = (over: Partial<LocalBrowserRunView> = {}): LocalBrowserRunView => ({
	id: "r1",
	instanceId: "i1",
	requestId: "q",
	objective: "Find roles",
	status: "running",
	pauseReason: null,
	errorCode: null,
	error: null,
	policy: { engine: "codex", authMode: "subscription", workspace: { kind: "scratch" }, browserProfile: "isolated", mode: "research_only", allowDomains: [], denyDomains: [], limits: { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 }, traceRetentionDays: 30, resultSchema: { id: "findings", version: 1 }, collection: { name: "job_leads" } },
	result: null,
	engineAuth: null,
	runnerNode: "Macmini",
	findingReviews: {},
	createdAt: 0,
	startedAt: null,
	endedAt: null,
	updatedAt: 0,
	...over,
});

describe("the Research tab is a runtime's tab, never the Coding tab", () => {
	it("shows for a local_browser agent, and not for a coding or chat one", () => {
		const ids = (caps: Parameters<typeof visibleSurfaces>[0]) => visibleSurfaces(caps).map((s) => s.id);
		expect(ids({ surfaces: [], runtime: "local_browser" })).toContain("research");
		expect(ids({ surfaces: [], runtime: "local_browser" })).not.toContain("coding");
		expect(ids({ surfaces: ["coding"], runtime: "coding" })).not.toContain("research");
		expect(ids({ surfaces: [] })).not.toContain("research");
	});

	it("never asks for a repository or GitHub anywhere in its UI", () => {
		for (const f of ["../tabs/ResearchTab.tsx", "../tabs/research/ResearchRunView.tsx", "../tabs/settings/LocalBrowserSection.tsx", "../components/LocalBrowserCapabilityCard.tsx"]) {
			// The UI, not its comments: a comment saying "never a repository" is the point, not a leak.
			const src = readFileSync(join(__dirname, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
			expect(src, f).not.toMatch(/github|repositor|coding\/repos|add a repo/i);
		}
	});
});

describe("setup checklist", () => {
	it("names each check, and marks unknown as unknown rather than failing", () => {
		expect(setupChecklist({ ready: false, checks: [{ id: "runner", ok: false, detail: "Run pags up" }, { id: "engine_login", ok: null, detail: "per run" }, { id: "settings", ok: true, detail: "" }] })).toEqual([
			{ id: "runner", label: "Runner connected", state: "todo", detail: "Run pags up" },
			{ id: "engine_login", label: "Task engine signed in", state: "unknown", detail: "per run" },
			{ id: "settings", label: "Settings fit this agent", state: "ok", detail: "" },
		]);
		expect(setupChecklist(null)).toEqual([]);
	});
});

describe("why a run is blocked, and the one step that unblocks it", () => {
	it("asks to allow the exact site a consent pause is about", () => {
		const b = pauseBanner(run({ status: "paused", pauseReason: "consent_required" }), [ev(1, "consent.requested", { domain: "indeed.com", detail: { scope: "navigate" } }), ev(2, "run.paused", { pauseReason: "consent_required" })]);
		expect(b).toMatchObject({ title: "Open indeed.com?", actions: [{ kind: "allow_site", domain: "indeed.com" }] });
	});

	it("asks about the signed-in profile when that is what it waits on", () => {
		expect(pauseBanner(run({ status: "paused", pauseReason: "consent_required" }), [ev(1, "consent.requested", { detail: { scope: "signed_in_profile" } })])?.actions).toEqual([{ kind: "allow_profile" }]);
	});

	it("sends a captcha or sign-in to the browser on the machine — PAGS cannot do it", () => {
		const c = pauseBanner(run({ status: "paused", pauseReason: "captcha" }), [ev(1, "browser.blocked", { domain: "seek.com.au", detail: { reason: "captcha" } })]);
		expect(c).toMatchObject({ title: "Captcha on seek.com.au", actions: [{ kind: "done_in_browser" }] });
		expect(c?.body).toMatch(/on Macmini.*never tries to get past it/);
		expect(pauseBanner(run({ status: "paused", pauseReason: "login_required" }), [])?.title).toBe("Sign-in");
	});

	it("a bot check is the owner's to pass in that browser — or to leave; the run never gets past it (#947)", () => {
		const b = pauseBanner(run({ status: "paused", pauseReason: "access_blocked" }), [ev(1, "browser.blocked", { domain: "indeed.com", detail: { reason: "access_blocked" } })]);
		expect(b).toMatchObject({ title: "indeed.com is blocking automated browsing", actions: [{ kind: "done_in_browser" }] });
		expect(b?.body).toMatch(/on Macmini.*does not work around it/);
	});

	it("a submit/pay/upload page asks only whether to READ it — nothing on it can be filled (#947)", () => {
		const b = pauseBanner(run({ status: "paused", pauseReason: "write_affordance" }), [ev(1, "browser.blocked", { domain: "seek.com.au", detail: { reason: "write_affordance" } })]);
		expect(b).toMatchObject({ title: "A page on seek.com.au asks for something to be submitted", actions: [{ kind: "keep_reading" }] });
		expect(b?.body).toMatch(/cannot fill or submit anything/);
	});

	it("a paywall is the owner's to open in that browser, or to leave (#947)", () => {
		const b = pauseBanner(run({ status: "paused", pauseReason: "paywall" }), [ev(1, "browser.blocked", { domain: "news.com", detail: { reason: "paywall" } })]);
		expect(b).toMatchObject({ title: "Paywall on news.com", actions: [{ kind: "done_in_browser" }] });
		expect(b?.body).toMatch(/on Macmini.*never gets around a paywall/);
	});

	it("shows nothing for a run that is not paused", () => {
		expect(pauseBanner(run(), [])).toBeNull();
	});

	it("explains a failed run with its fix first", () => {
		expect(runProblem(run({ status: "failed", errorCode: "runner_unsupported", error: "x" }))).toMatch(/^The runner on that machine is too old.*npm i -g @proagentstore\/cli.* x$/);
		expect(runProblem(run({ status: "failed", errorCode: "engine_not_signed_in", error: "Run `codex login` on that machine" }))).toMatch(/not signed in\. Run `codex login`/);
		expect(runProblem(run({ status: "cancelled", errorCode: "cancelled", error: "Cancelled by the owner" }))).toBe("You cancelled this run.");
		expect(runProblem(run())).toBeNull();
	});
});

describe("the run as steps, each owned by PAGS, the local CLI, or you", () => {
	it("walks brief → CLI → pages → findings → review", () => {
		const events = [ev(1, "run.requested"), ev(2, "engine.auth_checked", { detail: { engineAuth: "subscription" } }), ev(3, "engine.started"), ev(4, "browser.navigated", { domain: "seek.com.au", url: "https://seek.com.au/", detail: { title: "Jobs" } }), ev(5, "finding.parsed")];
		const phases = runPhases(run(), events);
		expect(phases.map((p) => [p.id, p.actor, p.state])).toEqual([
			["brief", "PAGS", "done"],
			["cli", "Local CLI", "done"],
			["pages", "Local CLI", "current"],
			["findings", "Local CLI", "current"],
			["review", "You", "waiting"],
		]);
		expect(phases[1].detail).toBe("Codex on Macmini · Subscription");
	});

	it("marks review done once every finding is saved or skipped", () => {
		const result = { runId: "r1", outcome: "completed" as const, findings: [{ title: "a", url: "https://a.com", evidence: "e", fields: {} }], sourceFailures: [], summary: "", traceId: "r1", engineAuth: "subscription" };
		expect(runPhases(run({ status: "completed", result }), []).at(-1)?.state).toBe("current");
		expect(runPhases(run({ status: "completed", result, findingReviews: { "0": { decision: "skipped", at: 1 } } }), []).at(-1)).toMatchObject({ state: "done", detail: "1 of 1 reviewed" });
	});

	it("lists pages newest first, with blocks and refusals called out", () => {
		const steps = pageSteps([ev(1, "browser.navigated", { domain: "a.com", detail: { title: "A" } }), ev(2, "browser.blocked", { domain: "b.com", detail: { reason: "captcha" } }), ev(3, "policy.decision", { detail: { decision: "refused", reason: "deny list" } })]);
		expect(steps.map((s) => s.note ?? s.title)).toEqual(["Refused: deny list", "Blocked: captcha", "A"]);
	});

	it("labels the engine's sign-in, warning on per-token billing", () => {
		expect(engineAuthLabel("api-key")).toEqual({ label: "API key — billed per token", tone: "warning" });
		expect(engineAuthLabel("missing_login").tone).toBe("danger");
		expect(engineAuthLabel(null).label).toBe("Not checked yet");
	});

	it("labels a finding's review", () => {
		expect(reviewLabel({ decision: "duplicate", collection: "job_leads", at: 1 })).toEqual({ label: "Already in job_leads", tone: "warning" });
		expect(reviewLabel(undefined)).toBeNull();
	});
});

describe("settings form", () => {
	it("offers subscription first, and api-key only when the agent allows per-token billing", () => {
		expect(authModeChoices({ subscriptionOnly: true }).map((c) => c.value)).toEqual(["subscription", "machine"]);
		expect(authModeChoices({ subscriptionOnly: false }).map((c) => c.value)).toEqual(["subscription", "machine", "api-key"]);
	});

	it("round-trips stored settings, and sends a cleared field as null — back to the agent default", () => {
		const stored = { engine: "codex" as const, workspace: { kind: "path" as const, path: "~/jobs" }, access: { allowDomains: ["seek.com.au"] }, limits: { maxPages: 10 }, collection: { name: "leads", keyField: "url" } };
		const form = formFromSettings(stored);
		expect(patchFromForm(form)).toEqual({
			engine: "codex",
			authMode: null,
			workspace: { kind: "path", path: "~/jobs" },
			browserProfile: null,
			access: { allowDomains: ["seek.com.au"], denyDomains: [] },
			limits: { maxMinutes: null, maxPages: 10, maxActions: null, maxConcurrent: null },
			collection: { name: "leads", keyField: "url" },
		});
		expect(patchFromForm({ ...form, workspace: "scratch", collection: "" })).toMatchObject({ workspace: null, collection: null });
	});

	it("reads a site list typed one per line or comma-separated", () => {
		expect(parseDomains("Seek.com.au\nindeed.com, seek.com.au ")).toEqual(["seek.com.au", "indeed.com"]);
	});
});
