/**
 * What one scan DID, and the question it exists to answer (#980): why did this scan not produce
 * the lead I expected?
 *
 * The live state: a connected Scout with leads in Data, and no way to tell whether it checked four
 * sources or one, whether a board rejected it, how many postings it read, or why a scan that ran to
 * completion found nothing. All of that was in the trace and the result — as a transcript, which is
 * what an owner tuning a search should not have to read.
 */
import { describe, expect, it } from "vitest";
import { scanHeadline, scanTelemetry } from "./telemetry.js";
import type { EffectiveLocalBrowserPolicy } from "./policy.js";
import type { FindingReview, LocalBrowserRun, TraceEvent } from "./store.js";
import type { LocalBrowserFinding, LocalBrowserResultEnvelope } from "./contract.js";

const POLICY: EffectiveLocalBrowserPolicy = {
	engine: "claude",
	authMode: "subscription",
	workspace: { kind: "scratch" },
	browserProfile: "isolated",
	mode: "research_only",
	allowDomains: ["jobs.example.com", "boards.example.org"],
	denyDomains: ["ads.example.net"],
	limits: { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 },
	traceRetentionDays: 30,
	resultSchema: { fields: [] } as unknown as EffectiveLocalBrowserPolicy["resultSchema"],
	collection: { name: "job_leads", keyField: "url" },
};

const finding = (n: number): LocalBrowserFinding => ({
	title: `Senior TypeScript Engineer ${n}`,
	url: `https://jobs.example.com/role-${n}`,
	evidence: "Senior TypeScript Engineer — Globex, Sydney. Salary 190k. Apply by Friday.",
	fields: { company: "Globex", location: "Sydney" },
});

const run = (over: Partial<LocalBrowserRun> = {}): LocalBrowserRun =>
	({
		id: "run-1",
		instanceId: "scout",
		requestId: "req-1",
		objective: "Senior TypeScript roles in Sydney posted this week",
		status: "completed",
		pauseReason: null,
		errorCode: null,
		error: null,
		policy: POLICY,
		result: null,
		engineAuth: "subscription",
		runnerNode: "mac",
		runnerTaskId: "t1",
		runnerSeq: 9,
		lastSyncedAt: 1_000,
		findingReviews: {},
		createdAt: 1_000,
		startedAt: 2_000,
		endedAt: 8_000,
		updatedAt: 8_000,
		...over,
	}) as LocalBrowserRun;

const result = (over: Partial<LocalBrowserResultEnvelope> = {}): LocalBrowserResultEnvelope => ({
	runId: "run-1",
	outcome: "completed",
	findings: [],
	sourceFailures: [],
	summary: "done",
	traceId: "run-1",
	engineAuth: "subscription",
	...over,
});

const ev = (type: TraceEvent["type"], over: Partial<TraceEvent> = {}): TraceEvent => ({ type, at: "2026-10-08T10:00:00.000Z", ...over });
const reviews = (...decisions: Array<FindingReview["decision"]>): Record<string, FindingReview> =>
	Object.fromEntries(decisions.map((decision, i) => [String(i), { decision, at: 5_000, ...(decision === "saved" ? { collection: "job_leads", recordId: `lead-${i}` } : {}) } as FindingReview]));

describe("who asked for the scan", () => {
	it("reads it off the run's own request event — a scheduled scan says so", () => {
		expect(scanTelemetry({ run: run(), events: [ev("run.requested", { detail: { source: "trigger" } })] }).startedBy).toBe("trigger");
		expect(scanTelemetry({ run: run(), events: [ev("run.requested", { detail: { source: "owner" } })] }).startedBy).toBe("owner");
	});

	it("is `unknown` rather than a guess when the event is older than the field or absent", () => {
		expect(scanTelemetry({ run: run(), events: [] }).startedBy).toBe("unknown");
		expect(scanTelemetry({ run: run(), events: [ev("run.requested", { detail: {} })] }).startedBy).toBe("unknown");
	});
});

describe("what it was configured with — half of 'why did it find nothing'", () => {
	it("reports the sources, the denied sites, the collection and the limits", () => {
		const t = scanTelemetry({ run: run(), events: [] });
		expect(t.configured).toMatchObject({ engine: "claude", sources: ["jobs.example.com", "boards.example.org"], denied: ["ads.example.net"], collection: "job_leads", keyField: "url", maxPages: 30 });
		// Every configured source is listed even if nothing was read from it — a source with zero
		// pages IS the finding when a scan comes back empty.
		expect(t.sources).toMatchObject({ configured: 2, reached: 0, unreachable: 0 });
		expect(t.sources.reach.map((r) => r.domain)).toEqual(["boards.example.org", "jobs.example.com"]);
	});
});

describe("source reachability (#980)", () => {
	it("counts pages per source, and names the one that failed with the contract's reason", () => {
		const t = scanTelemetry({
			run: run({ result: result({ sourceFailures: [{ url: "https://boards.example.org/search", reason: "login_required" }] }) }),
			events: [
				ev("browser.navigated", { url: "https://jobs.example.com/search", domain: "jobs.example.com" }),
				ev("browser.navigated", { url: "https://jobs.example.com/role-1", domain: "jobs.example.com" }),
				ev("browser.blocked", { domain: "jobs.example.com" }),
			],
		});
		expect(t.sources).toMatchObject({ configured: 2, reached: 1, unreachable: 1 });
		expect(t.sources.reach).toEqual([
			{ domain: "boards.example.org", pages: 0, blocked: 0, failed: "login_required" },
			{ domain: "jobs.example.com", pages: 2, blocked: 1, failed: null },
		]);
		expect(t.seen).toMatchObject({ pages: 2 });
		// The failure is an ERROR code, by its closed vocabulary — never the runner's prose.
		expect(t.errors).toEqual([{ code: "source:login_required", count: 1 }]);
	});

	it("a source nobody configured is still counted when the scan visited it", () => {
		const t = scanTelemetry({ run: run(), events: [ev("browser.navigated", { url: "https://elsewhere.example/jobs" })] });
		expect(t.sources.reach.find((r) => r.domain === "elsewhere.example")).toMatchObject({ pages: 1 });
	});
});

describe("what became of each result", () => {
	it("splits added, duplicate, skipped and still-pending, and names the Data records", () => {
		const t = scanTelemetry({
			run: run({ result: result({ findings: [finding(1), finding(2), finding(3), finding(4)] }), findingReviews: reviews("saved", "duplicate", "skipped") }),
			events: [],
		});
		expect(t.leads).toMatchObject({ added: 1, duplicates: 1, skipped: 1, pending: 1, recordIds: ["lead-0"] });
		// Rejections carry the REASON, which is what tuning needs: a duplicate is the collection's
		// key already holding that posting, a skip is the owner's own decision.
		expect(t.rejections).toEqual([{ reason: "duplicate", count: 1 }, { reason: "skipped", count: 1 }, { reason: "pending", count: 1 }]);
	});

	it("reports no rejections at all when every result became a lead", () => {
		const t = scanTelemetry({ run: run({ result: result({ findings: [finding(1)] }), findingReviews: reviews("saved") }), events: [] });
		expect(t.rejections).toEqual([]);
		expect(t.leads.pending).toBe(0);
	});

	it("says a Scout emits no handoff by itself — the next step is the owner's Apply", () => {
		const t = scanTelemetry({ run: run({ result: result({ findings: [finding(1)] }), findingReviews: reviews("saved") }), events: [] });
		expect(t.handoffs.emitted).toBe(0);
		expect(t.handoffs.note).toMatch(/when you Apply/);
		// …and a handoff that IS correlated to the scan is reported as one.
		expect(scanTelemetry({ run: run(), events: [], handoffs: 2 }).handoffs.emitted).toBe(2);
	});
});

describe("the terminal reason — the sentence an empty scan needs", () => {
	it("no results because every source was unreachable", () => {
		const t = scanTelemetry({
			run: run({ result: result({ sourceFailures: [{ url: "https://jobs.example.com/x", reason: "captcha" }, { url: "https://boards.example.org/y", reason: "paywall" }] }) }),
			events: [],
		});
		expect(t.terminal.reason).toMatch(/^No results: 2 of 2 source\(s\) could not be read/);
		expect(t.terminal.reason).toContain("jobs.example.com: captcha");
		expect(t.terminal.reason).toContain("boards.example.org: paywall");
	});

	it("no results and no page opened — a different problem with a different fix", () => {
		const t = scanTelemetry({ run: run({ result: result() }), events: [] });
		expect(t.terminal.reason).toMatch(/no page was opened/);
		expect(t.terminal.reason).toMatch(/allowed sources and the engine's sign-in/);
	});

	it("no results from pages that WERE read — the objective is the thing to change", () => {
		const t = scanTelemetry({ run: run({ result: result() }), events: [ev("browser.navigated", { domain: "jobs.example.com" }), ev("browser.navigated", { domain: "jobs.example.com" })] });
		expect(t.terminal.reason).toMatch(/No results from 2 page\(s\) read/);
		expect(t.terminal.reason).toMatch(/narrow or widen it/);
	});

	it("results found, all of them already in Data", () => {
		const t = scanTelemetry({ run: run({ result: result({ findings: [finding(1), finding(2)] }), findingReviews: reviews("duplicate", "duplicate") }), events: [] });
		expect(t.terminal.reason).toMatch(/all of them already in your Data \(2 duplicate/);
	});

	it("results found and waiting for the owner — nothing has entered the pipeline yet", () => {
		const t = scanTelemetry({ run: run({ result: result({ findings: [finding(1), finding(2)] }) }), events: [] });
		expect(t.terminal.reason).toMatch(/2 still waiting for your review/);
	});

	it("a FAILED scan says what failed, not that it found nothing", () => {
		const t = scanTelemetry({ run: run({ status: "failed", errorCode: "runner_offline", error: "No runner is connected." }), events: [] });
		expect(t.terminal.reason).toMatch(/The scan failed \(runner_offline\)/);
		expect(t.errors).toEqual([{ code: "runner_offline", count: 1 }]);
	});

	it("a PAUSED scan says it is waiting for the owner, with the reason", () => {
		const t = scanTelemetry({ run: run({ status: "paused", pauseReason: "login_required" }), events: [ev("run.paused", { pauseReason: "login_required" })] });
		expect(t.terminal.reason).toMatch(/waiting for you \(login_required\)/);
		// A pause is a WARNING, by its own code — the scan is not broken, it needs a person.
		expect(t.warnings).toEqual([{ code: "paused:login_required", count: 1 }]);
	});

	it("a cancelled and a still-running scan each say so rather than reporting an outcome", () => {
		expect(scanTelemetry({ run: run({ status: "cancelled" }), events: [] }).terminal.reason).toMatch(/You cancelled/);
		expect(scanTelemetry({ run: run({ status: "running" }), events: [] }).terminal.reason).toMatch(/still going/);
	});

	it("an engine that was never signed in is an error code, not a silent empty scan", () => {
		const t = scanTelemetry({ run: run({ engineAuth: "missing_login", result: result() }), events: [] });
		expect(t.errors.map((e) => e.code)).toContain("engine_not_signed_in");
	});
});

describe("the privacy boundary (#980)", () => {
	it("carries counts, hostnames and codes — never a finding's text, a URL path or page content", () => {
		const t = scanTelemetry({
			run: run({ result: result({ findings: [finding(1)], summary: "Found one great role at Globex" }), findingReviews: reviews("saved") }),
			events: [
				ev("browser.navigated", { url: "https://jobs.example.com/search?q=typescript+sydney&salary=190000", domain: "jobs.example.com" }),
				ev("browser.snapshot", { detail: { text: "the whole page, which must never reach a board card" } }),
				ev("note", { detail: { note: "engine said something" } }),
			],
		});
		const json = JSON.stringify(t);
		expect(json).not.toContain("Senior TypeScript Engineer");
		expect(json).not.toContain("Apply by Friday");
		expect(json).not.toContain("Found one great role");
		// The query the owner typed is in the URL; only the hostname survives.
		expect(json).not.toContain("q=typescript");
		expect(json).not.toContain("salary=190000");
		expect(json).not.toContain("the whole page");
		expect(json).toContain("jobs.example.com");
		// What it DOES carry: the owner's own record ids, which is the join to their Data.
		expect(t.leads.recordIds).toEqual(["lead-0"]);
	});

	it("survives a trace page that holds none of the events it counts", () => {
		// The board card computes from a bounded page of the trace; a missing event is a zero.
		const t = scanTelemetry({ run: run({ result: result({ findings: [finding(1)] }) }), events: [] });
		expect(t.seen).toEqual({ pages: 0, snapshots: 0, findings: 1 });
	});
});

describe("the one line a board card carries", () => {
	it("leads with the shape of the scan and ends with the reason", () => {
		const line = scanHeadline(
			scanTelemetry({
				run: run({ result: result({ findings: [finding(1), finding(2)], sourceFailures: [{ url: "https://boards.example.org/x", reason: "timeout" }] }), findingReviews: reviews("saved", "duplicate") }),
				events: [ev("browser.navigated", { domain: "jobs.example.com" })],
			}),
		);
		expect(line).toMatch(/^1 page · 2 results · 1 lead added · 1 duplicate · 1 source unreachable/);
		expect(line).toContain("errors: source:timeout");
	});

	it("singularises, because a card is read at a glance", () => {
		expect(scanHeadline(scanTelemetry({ run: run({ result: result({ findings: [finding(1)] }), findingReviews: reviews("saved") }), events: [ev("browser.navigated")] }))).toMatch(/^1 page · 1 result · 1 lead added/);
	});
});
