/**
 * #1107 — what the owner hears while an application is tailored and filled. Fixtures over the real
 * schema; the delivery stack is the injected `AttentionDeps` (so every raised event is observed) and,
 * in the integration case, the REAL `notifyUser` writing the owner's notification row. No runner, no
 * employer site, no real application.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "../d1-sqlite.js";
import type { AttentionDeps } from "../owner-attention.js";
import { resolveNotificationDelivery } from "../notification-policy.js";
import type { ApplyRun, ApplyTraceEvent } from "../local-apply/store.js";
import { getApplyRun } from "../local-apply/store.js";
import type { TailorRun } from "../local-artifact/store.js";
import { mergeTailorSettings, TAILOR_DEFAULTS } from "../local-artifact/store.js";
import { mergeRunnerSettings, RUNNER_DEFAULTS } from "../local-apply/policy.js";
import { syncApplyRun } from "../local-apply/apply.js";
import { applyRunSignals, runnerStage, stallMinutesFor, tailorRunSignals } from "./run-signals.js";
import { normaliseTraceEntries, pageTraceEntries } from "./trace-page.js";
import type { Env } from "../../types.js";

const NOW = Date.parse("2026-10-16T10:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const SECRET = "SYNTH-SESSION-55aa";
let d1: RealSchemaD1;
let env: Env;
let raised: Array<{ event?: string; kind: string; title: string; body: string; key: string }>;
const deps: AttentionDeps<Env> = {
	notify: async (_env, _uid, _type, title, body, _url, opts) => {
		raised.push({ event: opts.event, kind: opts.kind, title, body, key: opts.key });
	},
};

beforeEach(() => {
	raised = [];
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["runner-1", "tailor-1", "scout-1"] });
	d1.exec(`INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, created_at, updated_at)
	         VALUES ('a1', 'tailor-1', 'u1', 'scout-1', 'lead-1', 1, 'k1', 'filling', '${JSON.stringify({ lead: { title: "Engineering Manager", company: "Tennis Australia" } })}', 1, 1)`);
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

const POLICY = { mode: "fill_and_review", engine: "claude", authMode: "machine", browserProfile: "isolated", limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 } };
function applyRun(id: string, over: Partial<ApplyRun> & { trace?: ApplyTraceEvent[] } = {}): ApplyRun {
	const run = { id, instanceId: "runner-1", applicationId: "a1", requestId: `req-${id}`, status: "running", policy: POLICY, pause: null, result: null, engineAuth: null, errorCode: null, error: null, runnerNode: null, runnerVersion: null, trace: [], runnerSeq: 0, lastSyncedAt: null, createdAt: NOW - 30 * 60_000, startedAt: NOW - 3 * 60_000, endedAt: null, ...over } as ApplyRun;
	d1.DB.prepare(`INSERT OR IGNORE INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, trace, created_at, updated_at) VALUES (?1, 'runner-1', 'u1', 'a1', ?2, 'running', ?3, '[]', 1, 1)`)
		.bind(id, run.requestId, JSON.stringify(run.policy))
		.run();
	return run;
}
function tailorRun(id: string, over: Partial<TailorRun> = {}): TailorRun {
	d1.exec(`INSERT OR IGNORE INTO local_artifact_runs (id, instance_id, user_id, application_id, request_id, status, policy, trace, created_at, updated_at) VALUES ('${id}', 'tailor-1', 'u1', 'a1', 'req-${id}', 'running', '{}', '[]', 1, 1)`);
	return { id, instanceId: "tailor-1", applicationId: "a1", requestId: `req-${id}`, status: "running", policy: { maxMinutes: 10 }, result: null, engineAuth: null, errorCode: null, error: null, runnerNode: null, trace: [], runnerSeq: 0, lastSyncedAt: null, createdAt: NOW - 60_000, startedAt: NOW - 60_000, endedAt: null, ...over } as unknown as TailorRun;
}
const ev = (type: string, minutesAgo: number, extra: Partial<ApplyTraceEvent> = {}) => ({ type, at: ago(minutesAgo), ...extra }) as ApplyTraceEvent;

describe("progress: one update per stage reached, never per field (#1107)", () => {
	it("announces the furthest stage once, the next stage once, and never a step backwards", async () => {
		let run = applyRun("r1", { trace: [ev("engine.started", 3), ev("browser.navigated", 2.5, { url: `https://au.seek.com/job/95035981` })] });
		await applyRunSignals(env, "u1", run, NOW, deps);
		await applyRunSignals(env, "u1", run, NOW, deps); // the sweep again, nothing new
		expect(raised.map((r) => [r.event, r.kind])).toEqual([["run_progress", "update"]]);
		expect(raised[0].title).toBe("Runner on the job listing: Engineering Manager at Tennis Australia");
		expect(raised[0].body).toBe("Stage: on the job listing. Last action: opened a page. Elapsed: 3m 0s.");

		run = { ...run, trace: [...run.trace, ev("field.filled", 2, { detail: { role: "email" } }), ev("field.filled", 1.5, { detail: { role: "phone" } })] };
		await applyRunSignals(env, "u1", run, NOW, deps);
		expect(raised[1].body).toBe("Stage: filling the form. Last action: filled a field (2 fields filled). Elapsed: 3m 0s.");

		// Back to the listing page: an earlier stage — no ping-pong.
		run = { ...run, trace: [...run.trace, ev("browser.navigated", 1)] };
		await applyRunSignals(env, "u1", run, NOW, deps);
		expect(raised).toHaveLength(2);
	});

	it("reads sign-in as its own stages: waiting at a sign-in, then signed in once it resumes", () => {
		expect(runnerStage([ev("browser.navigated", 3), ev("run.paused", 2, { pauseReason: "login_required" })])?.stage).toBe("signing_in");
		expect(runnerStage([ev("browser.navigated", 3), ev("run.paused", 2, { pauseReason: "login_required" }), ev("run.resumed", 1)])?.stage).toBe("signed_in");
		expect(runnerStage([ev("submit.attempted", 1)])?.stage).toBe("submitting");
	});

	it("push text carries stage names and counts only — no URL, no field value, no query string", async () => {
		const run = applyRun("r-red", { trace: [ev("browser.navigated", 2, { url: `https://login.seek.com/login?JobseekerSessionId=${SECRET}` }), ev("field.filled", 1, { detail: { role: "email" } })] });
		await applyRunSignals(env, "u1", run, NOW, deps);
		const text = raised.map((r) => `${r.title} ${r.body}`).join(" ");
		expect(text).not.toMatch(/https?:|seek\.com|@|email/i);
		expect(text).not.toContain(SECRET);
	});
});

describe("blockers nothing announced before, pushed at once (#1107)", () => {
	it("listing expired (the runner saw it) → blocker_required, once", async () => {
		const run = applyRun("r-exp", { trace: [ev("browser.navigated", 2), ev("job.unavailable", 1)] });
		await applyRunSignals(env, "u1", run, NOW, deps);
		await applyRunSignals(env, "u1", run, NOW, deps);
		const blockers = raised.filter((r) => r.event === "blocker_required");
		expect(blockers).toHaveLength(1);
		expect(blockers[0]).toMatchObject({ kind: "alert", title: "Listing no longer available: Engineering Manager at Tennis Australia" });
	});

	it("a consent wall pause → blocker_required; a second consent wall later in the run is announced again", async () => {
		let run = applyRun("r-con", { status: "paused", pause: { reason: "consent_required" }, trace: [ev("browser.navigated", 3), ev("run.paused", 2, { pauseReason: "consent_required" })] });
		await applyRunSignals(env, "u1", run, NOW, deps);
		await applyRunSignals(env, "u1", run, NOW, deps);
		expect(raised.filter((r) => r.event === "blocker_required").map((r) => r.title)).toEqual(["A consent step needs you: Engineering Manager at Tennis Australia"]);
		run = { ...run, trace: [...run.trace, ev("run.resumed", 1.5), ev("run.paused", 1, { pauseReason: "consent_required" })] };
		await applyRunSignals(env, "u1", run, NOW, deps);
		expect(raised.filter((r) => r.event === "blocker_required")).toHaveLength(2);
	});

	it("a sign-in pause is NOT re-announced here — #1013's live handoff already does", async () => {
		const run = applyRun("r-login", { status: "paused", pause: { reason: "login_required" }, trace: [ev("run.paused", 1, { pauseReason: "login_required" })] });
		await applyRunSignals(env, "u1", run, NOW, deps);
		expect(raised.filter((r) => r.event !== "run_progress")).toEqual([]);
	});

	it("an auto_submit run lost before it reported → decision_required (submit state unknown); a long-ended one never re-announces", async () => {
		const fresh = applyRun("r-lost", { status: "failed", errorCode: "runner_lost", policy: { ...POLICY, mode: "auto_submit" } as ApplyRun["policy"], endedAt: NOW - 60_000 });
		await applyRunSignals(env, "u1", fresh, NOW, deps);
		expect(raised).toEqual([expect.objectContaining({ event: "decision_required", kind: "alert", title: "Check whether it was sent: Engineering Manager at Tennis Australia" })]);
		const old = applyRun("r-old", { status: "failed", errorCode: "run_timed_out", policy: { ...POLICY, mode: "auto_submit" } as ApplyRun["policy"], endedAt: NOW - 2 * 3600_000 });
		await applyRunSignals(env, "u1", old, NOW, deps);
		expect(raised).toHaveLength(1);
	});

	it("submit_unconfirmed (#1068) and a confirmed submit keep their own notifications — nothing extra here", async () => {
		await applyRunSignals(env, "u1", applyRun("r-unc", { status: "blocked", result: { blockReason: "submit_unconfirmed" }, endedAt: NOW - 60_000, trace: [ev("submit.unconfirmed", 1)] }), NOW, deps);
		await applyRunSignals(env, "u1", applyRun("r-sub", { status: "submitted", endedAt: NOW - 60_000, trace: [ev("submit.confirmed", 1)] }), NOW, deps);
		expect(raised).toEqual([]);
	});

	it("the Tailor needing the owner's answers → input_required, once", async () => {
		const run = tailorRun("t-nh", { status: "needs_human", endedAt: NOW - 60_000 });
		await tailorRunSignals(env, "u1", run, NOW, deps);
		await tailorRunSignals(env, "u1", run, NOW, deps);
		expect(raised).toEqual([expect.objectContaining({ event: "input_required", kind: "alert", title: "The Tailor needs your answers: Engineering Manager at Tennis Australia" })]);
	});

	it("the Tailor's own progress: reading sources, then writing — once each", async () => {
		let run = tailorRun("t-p", { trace: [{ type: "engine.started", at: ago(1) }, { type: "source.read", at: ago(0.8) }] as TailorRun["trace"] });
		await tailorRunSignals(env, "u1", run, NOW, deps);
		run = { ...run, trace: [...run.trace, { type: "artifact.written", at: ago(0.5) }] as TailorRun["trace"] };
		await tailorRunSignals(env, "u1", run, NOW, deps);
		await tailorRunSignals(env, "u1", run, NOW, deps);
		expect(raised.map((r) => r.title)).toEqual(["Tailor reading your sources: Engineering Manager at Tennis Australia", "Tailor writing the materials: Engineering Manager at Tennis Australia"]);
	});
});

describe("stall: once, at the threshold, not before (#1107)", () => {
	it("automatic threshold is half the time limit, capped at 10, never under 5", () => {
		expect(stallMinutesFor(20, null)).toBe(10);
		expect(stallMinutesFor(60, null)).toBe(10);
		expect(stallMinutesFor(8, null)).toBe(5);
		expect(stallMinutesFor(20, 3)).toBe(3);
	});

	it("9 minutes silent: nothing; 11 minutes: run_stalled; again: nothing", async () => {
		const run = applyRun("r-st", { startedAt: NOW - 15 * 60_000, trace: [ev("browser.navigated", 14)] });
		await applyRunSignals(env, "u1", { ...run, trace: [ev("browser.navigated", 9)] }, NOW, deps);
		expect(raised.filter((r) => r.event === "run_stalled")).toEqual([]);
		await applyRunSignals(env, "u1", { ...run, trace: [ev("browser.navigated", 11)] }, NOW, deps);
		await applyRunSignals(env, "u1", { ...run, trace: [ev("browser.navigated", 11)] }, NOW + 60_000, deps);
		const stalls = raised.filter((r) => r.event === "run_stalled");
		expect(stalls).toHaveLength(1);
		expect(stalls[0]).toMatchObject({ kind: "alert", title: "Runner stalled: Engineering Manager at Tennis Australia" });
		expect(stalls[0].body).toMatch(/^No progress for 11m 0s \(threshold 10 min\)\. Stage: on the job listing\./);
	});

	it("the owner's own threshold, recorded on the run's policy, is the one used; a paused run (waiting on a person) is not a stall", async () => {
		const run = applyRun("r-own", { policy: { ...POLICY, limits: { ...POLICY.limits, stallMinutes: 3 } } as ApplyRun["policy"], trace: [ev("browser.navigated", 4)] });
		await applyRunSignals(env, "u1", run, NOW, deps);
		expect(raised.some((r) => r.event === "run_stalled")).toBe(true);
		raised = [];
		await applyRunSignals(env, "u1", applyRun("r-wait", { status: "paused", pause: { reason: "missing_answer" }, trace: [ev("run.paused", 30, { pauseReason: "missing_answer" })] }), NOW, deps);
		expect(raised.some((r) => r.event === "run_stalled")).toBe(false);
	});
});

describe("the hook: a real sync raises through the real notification stack (#1107)", () => {
	it("syncApplyRun on an auto_submit run that was lost writes the owner's decision_required notification", async () => {
		d1.DB.prepare(
			`INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, trace, error_code, created_at, started_at, ended_at, updated_at) VALUES ('r-int', 'runner-1', 'u1', 'a1', 'req-int', 'failed', ?1, '[]', 'runner_lost', 1, 1, ?2, 1)`,
		)
			.bind(JSON.stringify({ ...POLICY, mode: "auto_submit" }), Date.now() - 60_000)
			.run();
		const run = await getApplyRun(env, "runner-1", "u1", "r-int");
		await syncApplyRun(env, "u1", run as ApplyRun);
		const rows = d1.sqlite.prepare("SELECT type, title, kind FROM notifications WHERE user_id = 'u1'").all() as Array<{ type: string; title: string; kind: string }>;
		expect(rows).toEqual([{ type: "apply", title: "Check whether it was sent: Engineering Manager at Tennis Australia", kind: "alert" }]);
	});
});

describe("policy: progress is in-app by default, a stall alert pushes (#992, #1107)", () => {
	it("run_progress: the row is written, the push is off — until the owner turns it on", () => {
		const off = resolveNotificationDelivery({ type: "apply", severity: "update", event: "run_progress", instanceId: "runner-1" }, { account: undefined, instance: undefined });
		expect(off.inapp.allowed).toBe(true);
		expect(off.push).toMatchObject({ allowed: false, source: "default" });
		const on = resolveNotificationDelivery({ type: "apply", severity: "update", event: "run_progress", instanceId: "runner-1" }, { account: undefined, instance: { rules: [{ event: "run_progress", push: true }] } } as never);
		expect(on.push.allowed).toBe(true);
	});

	it("run_stalled is an alert and pushes by default", () => {
		expect(resolveNotificationDelivery({ type: "apply", severity: "alert", event: "run_stalled", instanceId: "runner-1" }, { account: undefined, instance: undefined }).push.allowed).toBe(true);
	});
});

describe("stallMinutes is a setting, refused out of bounds (#1107)", () => {
	it("Runner and Tailor accept 1–60 or null, and refuse anything else", () => {
		expect(mergeRunnerSettings(RUNNER_DEFAULTS, { stallMinutes: 7 })).toMatchObject({ settings: { stallMinutes: 7 } });
		expect(mergeRunnerSettings(RUNNER_DEFAULTS, { stallMinutes: null })).toMatchObject({ settings: { stallMinutes: null } });
		expect(mergeRunnerSettings(RUNNER_DEFAULTS, { stallMinutes: 0 })).toHaveProperty("error");
		expect(mergeTailorSettings(TAILOR_DEFAULTS, { stallMinutes: 5 })).toMatchObject({ settings: { stallMinutes: 5 } });
		expect(mergeTailorSettings(TAILOR_DEFAULTS, { stallMinutes: 61 })).toHaveProperty("error");
	});
});

describe("application_trace: real time order across sources, and paging (#1107)", () => {
	const entry = (source: "lead" | "delivery" | "tailor" | "runner" | "lifecycle", at: string, type: string, runId: string | null = null) => ({ source, at, type, instanceId: null, runId, detail: {} });

	it("a SQLite-text time and an ISO time are ordered by instant, not as strings, and come back ISO", () => {
		const out = normaliseTraceEntries([
			entry("runner", "2026-10-16T01:00:05.000Z", "browser.navigated", "r1"),
			entry("delivery", "2026-10-16 01:00:09", "materials.ready"), // later — but sorts FIRST as a string (" " < "T")
			entry("tailor", "2026-10-16T00:59:00.000Z", "engine.started", "t1"),
		]);
		expect(out.map((e) => [e.type, e.at])).toEqual([
			["engine.started", "2026-10-16T00:59:00.000Z"],
			["browser.navigated", "2026-10-16T01:00:05.000Z"],
			["materials.ready", "2026-10-16T01:00:09.000Z"],
		]);
	});

	it("pages oldest first by cursor without gaps or repeats, even across identical events, and refuses a forged cursor", () => {
		const all = normaliseTraceEntries(Array.from({ length: 7 }, (_, i) => entry("runner", `2026-10-16T01:00:0${i < 4 ? 0 : i}.000Z`, "field.filled", "r1")));
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 10; guard++) {
			const page = pageTraceEntries(all, cursor, 3);
			if ("error" in page) throw new Error(page.error);
			seen.push(...page.entries.map((e) => e.id));
			expect(page.total).toBe(7);
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		expect(seen).toEqual(all.map((e) => e.id));
		expect(new Set(seen).size).toBe(7);
		expect(pageTraceEntries(all, "forged", 3)).toHaveProperty("error");
	});
});
