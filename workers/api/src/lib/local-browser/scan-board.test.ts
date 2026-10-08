/**
 * One scan as a card on the normal board (#980).
 *
 * The live state: a Scout mid-scan had an EMPTY board and an `Idle` instance card, so "is it doing
 * anything" was answerable only from the Research tab — and a supervisor, which reads exactly these
 * rows, could not see a scan at all.
 *
 * The card is pure (`scanTaskRecord`), so what the board will show is assertable without a
 * database, and it round-trips through the leaf parser the GENERIC board reads it back with.
 */
import { describe, expect, it } from "vitest";
import { SCAN_TASK_TYPE, scanCardId, scanCardStatus, scanCardTitle, scanTaskRecord } from "./scan-board.js";
import { parseScanCard } from "./scan-card-payload.js";
import { scanTelemetry } from "./telemetry.js";
import { defaultBoardColumns } from "../agent-capabilities.js";
import type { EffectiveLocalBrowserPolicy } from "./policy.js";
import type { FindingReview, LocalBrowserRun } from "./store.js";

const POLICY = {
	engine: "claude",
	authMode: "subscription",
	workspace: { kind: "scratch" },
	browserProfile: "isolated",
	mode: "research_only",
	allowDomains: ["jobs.example.com"],
	denyDomains: [],
	limits: { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 },
	traceRetentionDays: 30,
	resultSchema: { fields: [] },
	collection: { name: "job_leads", keyField: "url" },
} as unknown as EffectiveLocalBrowserPolicy;

const run = (over: Partial<LocalBrowserRun> = {}): LocalBrowserRun =>
	({
		id: "run-1",
		instanceId: "scout",
		requestId: "req-1",
		objective: "Senior TypeScript roles in Sydney posted this week",
		status: "running",
		pauseReason: null,
		errorCode: null,
		error: null,
		policy: POLICY,
		result: null,
		engineAuth: "subscription",
		runnerNode: "mac",
		runnerTaskId: "t1",
		runnerSeq: 1,
		lastSyncedAt: null,
		findingReviews: {},
		createdAt: 1_000,
		startedAt: 2_000,
		endedAt: null,
		updatedAt: 2_000,
		...over,
	}) as LocalBrowserRun;

const card = (r: LocalBrowserRun, source: "owner" | "trigger" = "owner") =>
	scanTaskRecord({ run: r, telemetry: scanTelemetry({ run: r, events: [{ type: "run.requested", at: "2026-10-08T10:00:00.000Z", detail: { source } }] }), now: "2026-10-08T10:05:00.000Z" });

describe("the scan card", () => {
	it("is one card per RUN, keyed on it, so every transition upserts the same row", () => {
		expect(scanCardId("run-1")).toBe("scan-run-1");
		expect(card(run()).id).toBe("scan-run-1");
		expect(card(run()).type).toBe(SCAN_TASK_TYPE);
	});

	it("maps onto the DEFAULT board columns — a scan needs no column set of its own", () => {
		const columns = defaultBoardColumns([]);
		const statuses = new Set(columns.flatMap((c) => c.statuses));
		for (const runStatus of ["queued", "running", "paused", "completed", "failed", "cancelled"]) {
			expect(statuses.has(scanCardStatus(runStatus)), `${runStatus} → ${scanCardStatus(runStatus)}`).toBe(true);
		}
	});

	it("a PAUSED scan is `needs_human`: it is waiting for the owner, not broken", () => {
		expect(scanCardStatus("paused")).toBe("needs_human");
		const c = card(run({ status: "paused", pauseReason: "login_required" }));
		expect(c.status).toBe("needs_human");
		// Not terminal: an open card must not carry a completion time.
		expect(c.completedAt).toBeUndefined();
		expect((c.scan as { pauseReason?: string }).pauseReason).toBe("login_required");
	});

	it("a finished scan is terminal and stamped", () => {
		expect(card(run({ status: "completed", endedAt: 8_000 })).completedAt).toBe("2026-10-08T10:05:00.000Z");
		expect(card(run({ status: "failed", errorCode: "runner_offline", endedAt: 8_000 })).status).toBe("failed");
	});

	it("says whether the SCHEDULE or the owner started it — the Board is where that is noticed", () => {
		expect(card(run(), "trigger").subtitle).toBe("Scheduled scan");
		expect(card(run(), "owner").subtitle).toBe("Started by you");
	});

	it("is titled with the owner's own objective, marked when it is cut", () => {
		expect(scanCardTitle("Senior TypeScript roles")).toBe("Scan: Senior TypeScript roles");
		const long = scanCardTitle("x".repeat(300));
		expect(long.length).toBeLessThan(200);
		expect(long).toMatch(/\[cut:/);
	});

	it("links the RUN page, which is where the structured activity and the findings are", () => {
		expect((card(run()).input as { url: string }).url).toBe("/instances/scout/research/run-1");
	});

	it("carries the counts and the Data record ids — Board → Data (#980)", () => {
		const reviewed = run({
			status: "completed",
			endedAt: 8_000,
			result: { runId: "run-1", outcome: "completed", findings: [{ title: "a", url: "https://jobs.example.com/1", evidence: "e", fields: {} }, { title: "b", url: "https://jobs.example.com/2", evidence: "e", fields: {} }], sourceFailures: [], summary: "s", traceId: "run-1", engineAuth: "subscription" },
			findingReviews: { "0": { decision: "saved", collection: "job_leads", recordId: "lead-9", at: 5_000 } as FindingReview, "1": { decision: "duplicate", collection: "job_leads", duplicateOf: "lead-3", at: 5_000 } as FindingReview },
		});
		const scan = card(reviewed).scan as Record<string, unknown>;
		expect(scan).toMatchObject({ runId: "run-1", results: 2, leadsAdded: 1, duplicates: 1, pendingReview: 0, leadRecordIds: ["lead-9"] });
		expect(String(scan.reason)).toMatch(/1 lead\(s\) added from 2 result\(s\)/);
	});

	it("round-trips through the leaf parser the generic board reads it with", () => {
		const parsed = parseScanCard(card(run(), "trigger").scan);
		expect(parsed).toMatchObject({ runId: "run-1", startedBy: "trigger", outcome: "running" });
		// …and anything that is not a scan block reads as absent rather than half-built.
		expect(parseScanCard(undefined)).toBeUndefined();
		expect(parseScanCard({})).toBeUndefined();
		expect(parseScanCard({ pages: 3 })).toBeUndefined();
		expect(parseScanCard({ runId: "r", startedBy: "someone-else", pages: -2 })).toMatchObject({ startedBy: "unknown", pages: 0 });
	});

	it("carries no finding text — a board card is the widest surface this data reaches", () => {
		const withText = run({
			result: { runId: "run-1", outcome: "completed", findings: [{ title: "Staff Engineer at Globex", url: "https://jobs.example.com/x?q=secret", evidence: "Salary 190k, apply by Friday", fields: {} }], sourceFailures: [], summary: "Found a great role", traceId: "run-1", engineAuth: "subscription" },
		});
		const json = JSON.stringify(card(withText));
		expect(json).not.toContain("Staff Engineer at Globex");
		expect(json).not.toContain("Salary 190k");
		expect(json).not.toContain("q=secret");
		expect(json).not.toContain("Found a great role");
	});
});
