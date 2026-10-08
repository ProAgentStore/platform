/**
 * "Approve & continue" on an application the owner has LOOKED at (#981), over the real schema.
 *
 * The live state this is about: a fill reached a SEEK supervisor checkpoint, #982's deterministic
 * decision asked for a review, the run ended `awaiting_review` — and the queue then offered the
 * owner `defer`, `archive` and `mark_not_interested`. There was no way to say "that one, send it".
 *
 * What is real here: the migrated tables, the authorization store, the supervisor checkpoint and
 * directive store with its immutability, the run store and its trace. Faked: the machine at the end
 * of the relay, so what was asked of it is assertable — and so is the fact that nothing was.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../d1-sqlite.js";
import { CONTINUE_RECOVERY, approveAndContinue, continueCorrelatedRun, isPostFillApproval, refusalDetail, CONTINUE_REFUSALS } from "./approve-continue.js";
import { getSubmitAuthorization, consumeSubmitAuthorization } from "./approval-store.js";
import { getApplyRun, insertApplyRun, updateApplyRun, type ApplyRun, type ApplyRunPolicy } from "./store.js";
import { issueSupervisorDirective, listSupervisorCheckpoints, receiveSupervisorCheckpoint } from "./supervision.js";
import type { JobApplication } from "../local-artifact/store.js";
import type { Env } from "../../types.js";

let d1: RealSchemaD1;
let env: Env;
/** Every command the cloud sent the machine. */
let sent: Array<{ path: string; body: Record<string, unknown> }>;
let relayOk: boolean;

const NOW = 1_760_000_000_000;

const POLICY: ApplyRunPolicy = {
	engine: "claude",
	authMode: "auto",
	browserProfile: "default",
	mode: "fill_and_review",
	allowDomains: ["jobs.example.com"],
	limits: { maxMinutes: 20, maxPages: 30, maxActions: 200 },
	gate: { allowed: false, gateId: null, checks: [{ check: "auto_submit_enabled", ok: false, why: "off" }] },
};

/** The application as the owner sees it on the board: filled, nothing sent. */
const appFixture = (over: Partial<JobApplication> = {}): JobApplication =>
	({
		id: "app-1",
		instanceId: "t1",
		sourceInstanceId: "scout",
		leadId: "lead-1",
		status: "awaiting_review",
		stateVersion: 4,
		lifecycleVersion: 1,
		profileVersion: "0123456789abcdef",
		resumeArtifact: { kind: "resume", path: "~/jobs/a/resume.md", sha256: "a".repeat(64) },
		coverLetterArtifact: { kind: "cover_letter", path: "~/jobs/a/cover.md", sha256: "b".repeat(64) },
		submitAttemptedAt: null,
		fillRunId: "run-1",
		readyEvent: { eventId: "ev-1", applicationId: "app-1", tailorInstanceId: "t1" },
		updatedAt: NOW,
		...over,
	}) as unknown as JobApplication;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["t1", "ap"] });
	sent = [];
	relayOk = true;
	d1.exec(
		`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, status, last_seen_at)
		 VALUES ('ap', 'u1', 'mac', 'relay://', '0.6.0', 'online', datetime('now'))`,
	);
	env = {
		DB: d1.DB,
		RELAY: {
			idFromName: (n: string) => n,
			get: () => ({
				async fetch(req: Request) {
					if (new URL(req.url).pathname === "/status") return new Response(JSON.stringify({ connected: true }));
					const cmd = (await req.json().catch(() => ({}))) as { path?: string; body?: string | Record<string, unknown> };
					sent.push({ path: cmd.path ?? "", body: (typeof cmd.body === "string" ? JSON.parse(cmd.body) : cmd.body) ?? {} });
					return new Response(JSON.stringify(relayOk ? { ok: true } : { error: "no" }), { status: relayOk ? 200 : 500 });
				},
			}),
		},
	} as unknown as Env;
});
afterEach(() => d1.close());

/** A fill run in the given state. `paused` also receives a checkpoint, as a real pause does. */
async function seedRun(opts: { status: "paused" | "awaiting_review" | "running"; checkpointId?: string } = { status: "paused" }): Promise<ApplyRun> {
	await insertApplyRun(env, { id: "run-1", instanceId: "ap", userId: "u1", applicationId: "app-1", requestId: "ev-1", policy: POLICY, trace: [], now: NOW, runnerVersion: "0.6.0" });
	let run = (await getApplyRun(env, "ap", "u1", "run-1")) as ApplyRun;
	run = (await updateApplyRun(env, run, { to: "running" }, NOW)) as ApplyRun;
	if (opts.status === "running") return run;
	if (opts.status === "awaiting_review") return (await updateApplyRun(env, run, { to: "awaiting_review" }, NOW)) as ApplyRun;
	const checkpointId = opts.checkpointId ?? "cp-1";
	run = (await updateApplyRun(env, run, { to: "paused", pause: { reason: "supervisor_checkpoint", checkpoint: { schemaVersion: 1, checkpointId, facts: { phase: "before_submit", actions: 7, filled: 6, uploaded: 1, blockers: [] } } } }, NOW)) as ApplyRun;
	await receiveSupervisorCheckpoint(env, run, "u1", { schemaVersion: 1, checkpointId, facts: { phase: "before_submit", actions: 7, filled: 6, uploaded: 1, blockers: [] }, runnerSeq: 7 }, NOW);
	return run;
}

const auth = () => getSubmitAuthorization(env, "app-1", "u1");
const directives = async () => (await d1.DB.prepare("SELECT checkpoint_id, directive, idempotency_key, delivered_at FROM local_apply_supervisor_directives").all<Record<string, unknown>>()).results ?? [];
const traceOf = async (id = "run-1") => ((await getApplyRun(env, "ap", "u1", id)) as ApplyRun).trace;
const instanceConfig = async () => (await d1.DB.prepare("SELECT config FROM agent_instances WHERE id = 'ap'").first<{ config: string | null }>())?.config ?? null;

describe("which applications are at the post-fill decision (#981)", () => {
	it("awaiting_review is, whatever the run says — the form is filled and nothing was sent", () => {
		expect(isPostFillApproval(appFixture(), null)).toBe(true);
	});

	it("a run parked at a SUPERVISOR CHECKPOINT is, because that is the same situation one step earlier", () => {
		expect(isPostFillApproval(appFixture({ status: "blocked" }), { status: "paused", pause: { reason: "supervisor_checkpoint" } })).toBe(true);
	});

	it("a run parked on a QUESTION is not — approving a submission answers none of it", () => {
		expect(isPostFillApproval(appFixture({ status: "blocked" }), { status: "paused", pause: { reason: "missing_answer" } })).toBe(false);
		expect(isPostFillApproval(appFixture({ status: "blocked" }), null)).toBe(false);
	});

	it("materials_ready is NOT: that is #973's pre-fill stage, which dispatches the fill instead", () => {
		expect(isPostFillApproval(appFixture({ status: "materials_ready" }), null)).toBe(false);
	});

	it("neither is a live fill, a submitted application or a failed one", () => {
		for (const status of ["filling", "submitted", "failed", "archived", "tailoring"]) {
			expect(isPostFillApproval(appFixture({ status: status as JobApplication["status"] }), null)).toBe(false);
		}
	});
});

describe("the exact correlated run is continued where it still can be (#981)", () => {
	it("releases the checkpoint it is parked at, by id, in the session already open", async () => {
		const run = await seedRun();
		const out = await approveAndContinue(env, "u1", appFixture({ status: "blocked" }), run, { idempotencyKey: "k-1" }, NOW);

		expect(out).toMatchObject({ stage: "post_fill", approval: "granted" });
		expect(out.continuation).toMatchObject({ kind: "continued", runId: "run-1", checkpointId: "cp-1", directive: "continue", delivered: true });
		// The decision is durable, immutable per checkpoint, and it is what the machine was sent.
		expect(await directives()).toMatchObject([{ checkpoint_id: "cp-1", directive: "continue" }]);
		expect(sent).toMatchObject([{ path: "/local-apply/directive", body: { runId: "run-1", checkpointId: "cp-1", directive: "continue" } }]);
		// The authorization exists and is NOT spent: the run that submits is the one that consumes it.
		expect(await auth()).toMatchObject({ applicationId: "app-1", consumedAt: null, revokedAt: null, approvedBy: "owner" });
	});

	it("records the approval on the run's own trace — the timeline the application trace reads", async () => {
		const run = await seedRun();
		await approveAndContinue(env, "u1", appFixture({ status: "blocked" }), run, { idempotencyKey: "k-1" }, NOW);
		const approved = (await traceOf()).find((e) => e.type === "policy.decision" && e.detail?.basis === "owner_application_approval");
		expect(approved?.detail).toMatchObject({ class: "submit", decision: "approved", stage: "post_fill", continued: true, checkpointId: "cp-1", directive: "continue" });
		expect(String(approved?.detail?.authorizationId)).toBe((await auth())?.id);
	});

	it("a double-click is one authorization, one directive and one delivery", async () => {
		const run = await seedRun();
		const first = await approveAndContinue(env, "u1", appFixture({ status: "blocked" }), run, { idempotencyKey: "k-1" }, NOW);
		const fresh = (await getApplyRun(env, "ap", "u1", "run-1")) as ApplyRun;
		const second = await approveAndContinue(env, "u1", appFixture({ status: "blocked" }), fresh, { idempotencyKey: "k-1" }, NOW + 1_000);

		expect(second.authorizationId).toBe(first.authorizationId);
		expect(second.approval).toBe("existing");
		// Still continued — a repeat of the SAME decision is not "already answered" (that would read
		// as a refusal to the owner who merely clicked twice).
		expect(second.continuation).toMatchObject({ kind: "continued", checkpointId: "cp-1", delivered: true });
		expect(await directives()).toHaveLength(1);
		expect(sent.filter((s) => s.path === "/local-apply/directive")).toHaveLength(1);
	});

	it("never revises a checkpoint somebody else already answered — #982's review decision stands", async () => {
		const run = await seedRun();
		await issueSupervisorDirective(env, run, "u1", { checkpointId: "cp-1", schemaVersion: 1, idempotencyKey: "brain:cp-1", directive: "request_review" }, NOW);
		const out = await approveAndContinue(env, "u1", appFixture({ status: "blocked" }), run, { idempotencyKey: "k-1" }, NOW);

		expect(out.continuation).toMatchObject({ kind: "not_resumable", reason: "checkpoint_already_directed", recovery: CONTINUE_RECOVERY });
		expect((await listSupervisorCheckpoints(env, run))[0].directive).toMatchObject({ directive: "request_review" });
		expect(sent.filter((s) => s.path === "/local-apply/directive")).toHaveLength(0);
		// …and the owner's decision is still recorded, so the recovery run can spend it.
		expect(await auth()).toMatchObject({ consumedAt: null });
	});

	it("an undelivered directive is reported as such, not as a release that happened", async () => {
		relayOk = false;
		const run = await seedRun();
		const out = await approveAndContinue(env, "u1", appFixture({ status: "blocked" }), run, { idempotencyKey: "k-1" }, NOW);
		expect(out.continuation).toMatchObject({ kind: "continued", delivered: false });
		expect(String((out.continuation as { detail: string }).detail)).toMatch(/has not acknowledged it yet/);
		// Durable anyway: the next status pull delivers the same decision for the same checkpoint.
		expect(await directives()).toMatchObject([{ checkpoint_id: "cp-1", directive: "continue", delivered_at: null }]);
	});
});

describe("when the session is gone, it says so and creates nothing (#981)", () => {
	it("an ENDED run cannot be resumed: the approval is held and retry_fill is named", async () => {
		const run = await seedRun({ status: "awaiting_review" });
		const out = await approveAndContinue(env, "u1", appFixture(), run, { idempotencyKey: "k-1" }, NOW);

		expect(out.continuation).toMatchObject({ kind: "not_resumable", runId: "run-1", reason: "run_ended", recovery: "retry_fill" });
		const detail = (out.continuation as { detail: string }).detail;
		expect(detail).toMatch(/browser session for run run-1 has ended/);
		expect(detail).toMatch(/retry_fill/);
		expect(detail).toMatch(/Nothing has been sent, and nothing was started automatically/);
		// NOTHING was created or sent: no directive, no second run, no relay traffic.
		expect(await directives()).toEqual([]);
		expect(sent.filter((s) => s.path === "/local-apply/run")).toHaveLength(0);
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_apply_runs").first<{ n: number }>())?.n).toBe(1);
		// The decision survives, which is the half that has to.
		expect(await auth()).toMatchObject({ applicationId: "app-1", consumedAt: null });
		// The refusal is on the run's trace too, with the recovery, so the trace explains the gap.
		expect((await traceOf()).at(-1)?.detail).toMatchObject({ decision: "approved", continued: false, reason: "run_ended", recovery: "retry_fill" });
	});

	it("an application with no fill run at all is refused the same way", async () => {
		const out = await approveAndContinue(env, "u1", appFixture({ fillRunId: null }), null, { idempotencyKey: "k-1" }, NOW);
		expect(out.continuation).toMatchObject({ kind: "not_resumable", runId: null, reason: "no_run", recovery: "retry_fill" });
		expect(await auth()).toMatchObject({ consumedAt: null });
	});

	it("a run paused on something that is not a checkpoint is refused, and nothing is released", async () => {
		const run = await seedRun({ status: "running" });
		const paused = (await updateApplyRun(env, run, { to: "paused", pause: { reason: "missing_answer", question: "Notice period?" } }, NOW)) as ApplyRun;
		const out = await continueCorrelatedRun(env, "u1", paused, "k-1", NOW);
		expect(out).toMatchObject({ kind: "not_resumable", reason: "not_paused_at_checkpoint" });
		expect(sent).toEqual([]);
	});

	it("every refusal names the recovery and promises nothing was sent", () => {
		for (const reason of CONTINUE_REFUSALS) {
			const detail = refusalDetail(reason, "run-9");
			expect(detail, reason).toMatch(/retry_fill/);
			expect(detail, reason).toMatch(/Nothing has been sent/);
			expect(detail, reason).toMatch(/held for this application/);
		}
	});
});

describe("what approving can NEVER do (#981)", () => {
	it("refuses an application that already attempted a submit — nothing re-authorizes that", async () => {
		const run = await seedRun({ status: "awaiting_review" });
		await expect(approveAndContinue(env, "u1", appFixture({ submitAttemptedAt: NOW - 1 }), run, { idempotencyKey: "k-1" }, NOW)).rejects.toThrow(/already attempted/);
		expect(await auth()).toBeNull();
	});

	it("refuses a second approval once a run has spent the first — a second send must not be hidden", async () => {
		const run = await seedRun({ status: "awaiting_review" });
		const first = await approveAndContinue(env, "u1", appFixture(), run, { idempotencyKey: "k-1" }, NOW);
		expect(await consumeSubmitAuthorization(env, first.authorizationId, "u1", "run-2", NOW)).toMatchObject({ consumedRunId: "run-2" });
		await expect(approveAndContinue(env, "u1", appFixture({ stateVersion: 5 }), run, { idempotencyKey: "k-2" }, NOW + 1)).rejects.toThrow(/already used by a run/);
	});

	it("refuses the wrong stage, rather than approving something nobody has looked at", async () => {
		await expect(approveAndContinue(env, "u1", appFixture({ status: "materials_ready" }), null, { idempotencyKey: "k-1" }, NOW)).rejects.toThrow(/no filled form waiting/);
		await expect(approveAndContinue(env, "u1", appFixture({ status: "filling" }), null, { idempotencyKey: "k-1" }, NOW)).rejects.toThrow(/no filled form waiting/);
		expect(await auth()).toBeNull();
	});

	it("does not touch the Runner's standing auto-submit policy — this is one application, not a setting", async () => {
		const before = await instanceConfig();
		const run = await seedRun();
		await approveAndContinue(env, "u1", appFixture({ status: "blocked" }), run, { idempotencyKey: "k-1" }, NOW);
		expect(await instanceConfig()).toBe(before);
		// The one row it wrote is scoped to this application, by construction.
		const rows = (await d1.DB.prepare("SELECT application_id FROM job_application_submit_authorizations").all<{ application_id: string }>()).results ?? [];
		expect(rows).toEqual([{ application_id: "app-1" }]);
	});
});
