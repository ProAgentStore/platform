import { describe, expect, it, vi } from "vitest";
import type { ApplyRun } from "./store.js";
import type { SupervisorCheckpoint } from "./supervision.js";

const { runUserWorkersAi } = vi.hoisted(() => ({ runUserWorkersAi: vi.fn() }));
vi.mock("../user-ai.js", () => ({ runUserWorkersAi }));

const { checkpointDecisionEvent, constrainBrainDirective, decideApplicationCheckpoint, decideCheckpoint } = await import("./brain.js");

const run = (mode: "fill_and_review" | "auto_submit" = "auto_submit") => ({
	id: "run-1",
	instanceId: "runner-1",
	applicationId: "app-1",
	requestId: "event-1",
	status: "paused",
	policy: {
		engine: "claude",
		authMode: "machine",
		browserProfile: "isolated",
		mode,
		allowDomains: ["jobs.example.com"],
		limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 },
		gate: { allowed: mode === "auto_submit", gateId: mode === "auto_submit" ? "gate-1" : null, checks: [] },
	},
	pause: null,
	result: null,
	engineAuth: null,
	errorCode: null,
	error: null,
	runnerNode: "mac",
	// #977: the CLI that executed the run is part of its record now.
	runnerVersion: null,
	trace: [],
	runnerSeq: 4,
	lastSyncedAt: null,
	createdAt: 1,
	startedAt: 1,
	endedAt: null,
}) as ApplyRun;

const checkpoint = (phase: SupervisorCheckpoint["facts"]["phase"] = "initial", blockers: string[] = []): SupervisorCheckpoint => ({
	runId: "run-1",
	instanceId: "runner-1",
	checkpointId: "checkpoint-1",
	schemaVersion: 1,
	runnerSeq: 4,
	receivedAt: 1,
	facts: { phase, actions: 2, filled: 1, uploaded: 0, blockers: blockers as SupervisorCheckpoint["facts"]["blockers"], url: "https://jobs.example.com/apply", domain: "jobs.example.com", title: "Staff engineer application" },
	directive: null,
});

const env = () => ({
	AGENT: {
		idFromName: (name: string) => name,
		get: () => ({ fetch: async () => Response.json({ model: "claude-sonnet-4-6", modelChosen: true }) }),
	},
}) as never;

describe("Application Runner cloud brain", () => {
	it("explains full native evidence limits without claiming routine tools cannot submit", async () => {
		runUserWorkersAi.mockClear();
		runUserWorkersAi.mockResolvedValueOnce({ tool_calls: [{ name: "decide_application_checkpoint", arguments: { directive: "continue" } }] });
		const full = run(); full.policy.toolAccess = "full";
		await decideApplicationCheckpoint(env(), "u1", full, checkpoint("before_submit"));
		const body = runUserWorkersAi.mock.calls[0][3] as { messages: Array<{ content: string }> };
		const supplied = JSON.parse(body.messages[1].content);
		expect(supplied.policy.toolAccess).toBe("full");
		expect(supplied.evidenceLimits).toContain("Zero tracked fills is not proof of an empty form");
		expect(decideCheckpoint(full, checkpoint("initial"), null).reason).toBe("routine_checkpoint_full_access");
		full.policy.mode = "fill_and_review";
		expect(decideCheckpoint(full, checkpoint("before_submit"), "continue")).toMatchObject({ directive: "request_review", reason: "submission_authorization_required" });
		runUserWorkersAi.mockClear();
	});
	it("uses the Runner instance's selected brain and exposes only bounded checkpoint facts", async () => {
		runUserWorkersAi.mockResolvedValueOnce({ tool_calls: [{ name: "decide_application_checkpoint", arguments: { directive: "continue" } }] });
		await expect(decideApplicationCheckpoint(env(), "u1", run(), checkpoint())).resolves.toMatchObject({ directive: "continue" });
		expect(runUserWorkersAi).toHaveBeenCalledWith(
			expect.anything(),
			"u1",
			"claude-sonnet-4-6",
			expect.objectContaining({ tools: expect.any(Array), toolChoice: "required", maxTokens: 256, timeoutMs: 20_000 }),
			expect.objectContaining({ kind: "run", instanceId: "runner-1" }),
			{ honorModel: true },
		);
		const body = runUserWorkersAi.mock.calls[0][3] as { messages: Array<{ content: string }> };
		expect(body.messages[1].content).toContain('"checkpointId":"checkpoint-1"');
		expect(body.messages[1].content).not.toMatch(/resume|cover|answer|snapshot|cookie/i);
	});

	it("uses the acting model assessment and frozen threshold without consulting a second model", async () => {
		runUserWorkersAi.mockClear();
		const r = run("fill_and_review"); r.policy.escalationLevel = "balanced";
		const c = checkpoint("uncertain"); c.facts.decision = { risk: "minor", reason: "The source supports the visible option." };
		await expect(decideApplicationCheckpoint(env(), "u1", r, c)).resolves.toMatchObject({ directive: "continue", source: "policy", reason: "escalation_allows_decision" });
		expect(runUserWorkersAi).not.toHaveBeenCalled();
	});

	it("keeps policy as the final authority over a model's continue", () => {
		expect(constrainBrainDirective(run("fill_and_review"), checkpoint("before_submit"), "continue")).toBe("request_review");
		expect(constrainBrainDirective(run(), checkpoint("initial", ["captcha"]), "continue")).toBe("stop");
	});

	// #982 — a brain that cannot answer no longer stops safe work. Where it still fails closed is
	// the checkpoint that can actually release something: before_submit.
	it("a brain that cannot answer still CONTINUES a routine checkpoint — the platform decides it", async () => {
		runUserWorkersAi.mockRejectedValueOnce(new Error("no BYOK key"));
		await expect(decideApplicationCheckpoint(env(), "u1", run(), checkpoint())).resolves.toMatchObject({
			directive: "continue",
			source: "policy",
			reason: "routine_checkpoint_cannot_submit",
		});
	});

	it("…and still fails closed at the final submit checkpoint, where the only actions reach the employer", async () => {
		runUserWorkersAi.mockRejectedValueOnce(new Error("no BYOK key"));
		const base = run("auto_submit");
		const gated = { ...base, policy: { ...base.policy, gate: { allowed: true, gateId: "gate-1", checks: [] } } };
		await expect(decideApplicationCheckpoint(env(), "u1", gated, checkpoint("before_submit"))).resolves.toMatchObject({
			directive: "request_review",
			source: "policy",
			reason: "brain_unavailable",
		});
	});

	describe("a second before_submit checkpoint on an unchanged page (#1620)", () => {
		const continued = (actions = 2, url = "https://jobs.example.com/apply") => {
			const r = run("auto_submit");
			r.trace = [
				{ type: "supervisor.checkpoint", at: "t1", url, detail: { checkpointId: "first", phase: "before_submit", actions, filled: 1, uploaded: 0 } },
				{ type: "policy.decision", at: "t2", detail: { class: "checkpoint", checkpointId: "first", phase: "before_submit", decision: "continue", source: "brain", reason: "brain_decision", actions, filled: 1, uploaded: 0 } },
			];
			return r;
		};

		it("keeps the model's continue without asking again", async () => {
			runUserWorkersAi.mockClear();
			await expect(decideApplicationCheckpoint(env(), "u1", continued(1), checkpoint("before_submit"))).resolves.toMatchObject({ directive: "continue", source: "brain", reason: "same_page_already_continued" });
			expect(runUserWorkersAi).not.toHaveBeenCalled();
		});

		it("asks again when the page, its uploads or the work done since have changed", async () => {
			for (const r of [continued(2, "https://jobs.example.com/other"), continued(-1)]) {
				runUserWorkersAi.mockClear();
				runUserWorkersAi.mockResolvedValueOnce({ tool_calls: [{ name: "decide_application_checkpoint", arguments: { directive: "request_review" } }] });
				await expect(decideApplicationCheckpoint(env(), "u1", r, checkpoint("before_submit"))).resolves.toMatchObject({ directive: "request_review", source: "brain" });
				expect(runUserWorkersAi).toHaveBeenCalledTimes(1);
			}
		});

		it("never reuses a continue over a blocker or a run without a submit gate", async () => {
			await expect(decideApplicationCheckpoint(env(), "u1", continued(1), checkpoint("before_submit", ["captcha"]))).resolves.toMatchObject({ directive: "stop", reason: "blocker" });
			const review = continued(1); review.policy = { ...review.policy, mode: "fill_and_review" };
			await expect(decideApplicationCheckpoint(env(), "u1", review, checkpoint("before_submit"))).resolves.toMatchObject({ directive: "request_review", source: "policy" });
		});
	});

	it("records a model reply that holds no directive, then fails closed at the final checkpoint (#1620)", async () => {
		runUserWorkersAi.mockResolvedValueOnce({ response: "The facts show", stopReason: "max_tokens" });
		const db = { DB: { prepare: vi.fn(() => { throw new Error("unavailable"); }) } };
		const logged = { ...(env() as object), ...db } as never;
		await expect(decideApplicationCheckpoint(logged, "u1", run("auto_submit"), checkpoint("before_submit"))).resolves.toMatchObject({ directive: "request_review", reason: "brain_unavailable" });
		expect(db.DB.prepare).toHaveBeenCalled();
	});

	it("…but a brain that cannot answer does not cancel the owner's approval of THIS application (#1575)", async () => {
		runUserWorkersAi.mockRejectedValueOnce(new Error("timeout"));
		const base = run("auto_submit");
		const approved = { ...base, policy: { ...base.policy, gate: { allowed: true, gateId: "auth-1", checks: [{ check: "submission_approved", ok: true, why: "authorization auth-1" }] } } } as ApplyRun;
		await expect(decideApplicationCheckpoint(env(), "u1", approved, checkpoint("before_submit"))).resolves.toMatchObject({ directive: "continue", source: "policy", reason: "owner_approved_submission" });
		// A brain that DOES answer is still honoured, and a blocker still stops.
		runUserWorkersAi.mockResolvedValueOnce({ tool_calls: [{ name: "decide_application_checkpoint", arguments: { directive: "request_review" } }] });
		await expect(decideApplicationCheckpoint(env(), "u1", approved, checkpoint("before_submit"))).resolves.toMatchObject({ directive: "request_review", source: "brain" });
		expect(decideCheckpoint(approved, checkpoint("before_submit", ["captcha"]), null)).toMatchObject({ directive: "stop", reason: "blocker" });
	});
});

// ── #982: a routine checkpoint is not a review point ──────────────────────────────────────────
//
// The live failure: two runs reached `awaiting_review` at the runner's INITIAL checkpoint with
// `filled: 0, uploaded: 0` and no blocker. Nothing was wrong with the page — the brain simply
// proposed `request_review`, and a proposal used to pass straight through. So a `fill_and_review`
// workflow stopped before filling anything, and the owner was shown a review state with nothing in
// it to review.
describe("safe routine checkpoints continue deterministically (#982)", () => {
	const initial = (over: Partial<SupervisorCheckpoint["facts"]> = {}) => {
		const c = checkpoint("initial");
		return { ...c, facts: { ...c.facts, actions: 1, filled: 0, uploaded: 0, ...over } };
	};

	it("THE regression: initial, filled:0, no blocker, brain says review → continues anyway", () => {
		const d = decideCheckpoint(run("fill_and_review"), initial(), "request_review");
		expect(d).toMatchObject({ directive: "continue", source: "policy", reason: "routine_checkpoint_cannot_submit", overrodeBrain: true });
	});

	it("the same with NO proposal at all — an absent model is not a reason to stop safe work", () => {
		expect(decideCheckpoint(run("fill_and_review"), initial(), null)).toMatchObject({ directive: "continue", source: "policy", overrodeBrain: false });
	});

	it.each([["initial"], ["post_navigation"]] as const)("%s is routine: the next local action cannot submit", (phase) => {
		const c = checkpoint(phase);
		expect(decideCheckpoint(run(), c, "request_review").directive).toBe("continue");
		expect(decideCheckpoint(run(), c, "stop").directive).toBe("continue");
	});

	it("a real blocker still stops, whatever anyone proposed — precedence is unchanged", () => {
		for (const proposed of ["continue", "request_review", null] as const) {
			expect(decideCheckpoint(run(), checkpoint("initial", ["captcha"]), proposed)).toMatchObject({ directive: "stop", source: "policy", reason: "blocker" });
		}
	});

	it("an `uncertain` phase is an unknown condition, so it still asks a person", () => {
		expect(decideCheckpoint(run(), checkpoint("uncertain"), null)).toMatchObject({ directive: "request_review", reason: "unknown_phase_needs_review" });
		// A cloud continue is not a substitute for the acting model assessing the decision.
		expect(decideCheckpoint(run(), checkpoint("uncertain"), "continue")).toMatchObject({ directive: "request_review", source: "policy" });
	});

	describe("the one-job gate is untouched", () => {
		const gated = (over: { allowed?: boolean; gateId?: string | null } = {}) => {
			const r = run("auto_submit");
			return { ...r, policy: { ...r.policy, gate: { allowed: over.allowed ?? true, gateId: over.gateId === undefined ? "gate-1" : over.gateId, checks: [] } } };
		};

		it("fill_and_review NEVER submits, however the model argues", () => {
			expect(decideCheckpoint(run("fill_and_review"), checkpoint("before_submit"), "continue")).toMatchObject({
				directive: "request_review",
				reason: "fill_and_review_never_submits",
				overrodeBrain: true,
			});
		});

		it("an ungated auto_submit run cannot be talked into submitting", () => {
			expect(decideCheckpoint(gated({ allowed: false }), checkpoint("before_submit"), "continue")).toMatchObject({ directive: "request_review", reason: "no_submit_authorization" });
			expect(decideCheckpoint(gated({ gateId: null }), checkpoint("before_submit"), "continue")).toMatchObject({ directive: "request_review", reason: "no_submit_authorization" });
		});

		it("a valid one-shot authorization lets the brain release the submit", () => {
			expect(decideCheckpoint(gated(), checkpoint("before_submit"), "continue")).toMatchObject({ directive: "continue", source: "brain" });
		});

		it("and the routine auto-continue never reaches before_submit — it is not a routine phase", () => {
			expect(decideCheckpoint(gated(), checkpoint("before_submit"), null).directive).toBe("request_review");
		});
	});
});

describe("the decision leaves an auditable, redacted line (#982)", () => {
	it("records the phase, the progress, who decided and why", () => {
		const c = checkpoint("initial");
		const ev = checkpointDecisionEvent(c, decideCheckpoint(run(), c, "request_review"), "2026-10-08T06:00:00.000Z");
		expect(ev).toMatchObject({ type: "policy.decision", at: "2026-10-08T06:00:00.000Z" });
		expect(ev.detail).toMatchObject({
			class: "checkpoint",
			checkpointId: "checkpoint-1",
			phase: "initial",
			decision: "continue",
			source: "policy",
			reason: "routine_checkpoint_cannot_submit",
			filled: 1,
			uploaded: 0,
			overrodeBrain: true,
		});
	});

	it("names the blockers when there are any, and omits the flag when nothing was overridden", () => {
		const c = checkpoint("initial", ["captcha", "login_required"]);
		const ev = checkpointDecisionEvent(c, decideCheckpoint(run(), c, "stop"), "t");
		expect(ev.detail).toMatchObject({ decision: "stop", reason: "blocker", blockers: "captcha,login_required" });
		expect(ev.detail).not.toHaveProperty("overrodeBrain");
	});

	it("carries no page value, answer or snapshot — only ids, counts and a phase", () => {
		const c = checkpoint("post_navigation");
		const ev = checkpointDecisionEvent(c, decideCheckpoint(run(), c, null), "t");
		const text = JSON.stringify(ev);
		// The checkpoint itself holds a url, a domain and a page title; none of them belong here.
		for (const leak of ["jobs.example.com", "Staff engineer application", "https://"]) expect(text, leak).not.toContain(leak);
	});
});
