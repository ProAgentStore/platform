/**
 * An application execution as a board card (#978) — the shape, pure.
 *
 * What this protects is the product model: one card per APPLICATION, many runs as its attempts,
 * with the stage, the checkpoint and the permitted controls on it. The projection itself is driven
 * end to end in `application-runner-routes.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { APPLICATION_RUN_TASK_TYPE, applicationCardId, applicationCardLabel, applicationCardStatus, applicationRunTaskRecord, applicationStageLabel, type ApplicationCardFacts } from "./application-board.js";
import { fillProgressOf } from "./fill-progress.js";

const APP = {
	id: "app-1",
	lead: {
		leadUrl: "https://au.seek.com/job/94991284",
		lead: { title: "Head of Engineering", company: "Business AI Group Pty Ltd", location: "Port Melbourne, Melbourne VIC" },
	},
} as never;

const execution = {
	schemaVersion: 1,
	lifecycle: { status: "filling", stateVersion: 4, blockReason: null, submitAttempted: false },
	currentRun: { id: "run-1", kind: "fill", status: "running", instanceId: "ap", mode: null },
	checkpoint: null,
	progress: null,
	permittedActions: ["cancel"],
	directiveReconciliation: "not_applicable",
} satisfies ApplicationCardFacts["execution"];

const facts = (over: Record<string, unknown> = {}) => ({
	applicationId: "app-1",
	applicationStatus: "filling",
	stateVersion: 4,
	actions: ["cancel"],
	kind: "fill" as const,
	runId: "run-1",
	stage: "Filling the application in the browser",
	traceUrl: "/instances/ap/applications/app-1/trace",
	execution,
	...over,
} as ApplicationCardFacts);

describe("one card per application, many runs (#978)", () => {
	it("is keyed on the APPLICATION, so a retry lands on the same card", () => {
		expect(applicationCardId("app-1")).toBe("app-1".replace("app-1", "app-app-1"));
		// The id does not mention the run, which is what makes tailoring, a fill and a retry one card.
		expect(applicationCardId("app-1")).not.toContain("run-");
	});

	it("carries the job the owner recognises, and the url the board groups by", () => {
		const record = applicationRunTaskRecord({ app: APP, facts: facts(), runStatus: "running", now: "2026-10-08T05:00:00.000Z" });
		expect(record.title).toBe("Head of Engineering — Business AI Group Pty Ltd");
		expect(record.subtitle).toBe("Port Melbourne, Melbourne VIC");
		expect(record.type).toBe(APPLICATION_RUN_TASK_TYPE);
		// `input.url` is what the generic board reads for the card's url AND its per-job key.
		expect(record.input).toEqual({ url: "https://au.seek.com/job/94991284" });
	});

	it("a lead with no company or location still reads sensibly", () => {
		expect(applicationCardLabel({ lead: { lead: { title: "Staff Engineer" } } } as never)).toMatchObject({ title: "Staff Engineer", subtitle: "" });
		expect(applicationCardLabel({ lead: {} } as never).title).toBe("(untitled job)");
	});

	it("puts the application's own state and permitted actions on the card", () => {
		const record = applicationRunTaskRecord({ app: APP, facts: facts({ actions: ["resume", "cancel"] }), runStatus: "paused", now: "n" });
		expect(record.application).toMatchObject({ applicationId: "app-1", applicationStatus: "filling", stateVersion: 4, actions: ["resume", "cancel"], kind: "fill", runId: "run-1" });
		// The compare-and-set token is on the card, so a control taken from a stale card is refused.
		expect((record.application as { stateVersion: number }).stateVersion).toBe(4);
	});
});

describe("the stage a reader sees", () => {
	it.each([
		["tailor", "running", null, /Tailoring the résumé/],
		["tailor", "queued", null, /Waiting for the machine to tailor/],
	] as const)("%s %s → %s", (kind, status, pause, expected) => {
		expect(applicationStageLabel(kind, status, pause)).toMatch(expected);
	});

	it("a tailoring pause says what it is waiting for, in words", () => {
		expect(applicationStageLabel("tailor", "paused", "missing_answer")).toBe("Paused — missing answer");
	});

	/**
	 * A FILL's stage is the runner's facts, not its status word (#986).
	 *
	 * This block used to assert `fill awaiting_review → "Filled — waiting for your review before
	 * anything is sent"`, which is the sentence the issue was filed about: the runner reports that
	 * outcome for a complete form AND for a run that stopped before touching one, and the card said
	 * "Filled" for both. The label now comes from `fillProgressOf`, so the test that pinned the
	 * inference is replaced by tests of the facts.
	 */
	it("takes the progress's own sentence when the facts are in hand", () => {
		const progress = fillProgressOf({ applicationStatus: "awaiting_review", runStatus: "awaiting_review", result: { outcome: "awaiting_review", filled: 7, uploaded: ["resume"] } });
		expect(applicationStageLabel("fill", "awaiting_review", null, progress)).toMatch(/Filled 7 fields and 1 attachment — waiting for your review/);
	});

	it("never claims a filled form from the status word alone", () => {
		// No facts: the honest answer is the status, and `Filled` is not in it.
		for (const status of ["awaiting_review", "running", "queued", "blocked"]) {
			expect(applicationStageLabel("fill", status, null), status).not.toMatch(/Filled|filled/);
		}
		expect(applicationStageLabel("fill", "awaiting_review", null)).toBe("Fill awaiting_review");
		expect(applicationStageLabel("fill", "submitted", null)).toMatch(/Submitted to the employer/);
	});

	it("a pause with no facts still says what it is waiting for", () => {
		expect(applicationStageLabel("fill", "paused", "missing_answer")).toBe("Paused — missing answer");
	});
});

describe("the board column a run lands in", () => {
	it.each([
		["paused", "needs_human"],
		["awaiting_review", "needs_human"],
	])("%s is work waiting on a person → %s", (runStatus, expected) => {
		expect(applicationCardStatus(runStatus)).toBe(expected);
	});

	it("a submitted application is completed work, in the column that word belongs to", () => {
		expect(applicationCardStatus("submitted")).toBe("completed");
	});

	it.each([["running"], ["queued"], ["failed"], ["blocked"], ["cancelled"]])("%s passes through — the board has a column for it", (runStatus) => {
		expect(applicationCardStatus(runStatus)).toBe(runStatus);
	});

	it("an open run carries no completedAt, and a closed one does", () => {
		const open = applicationRunTaskRecord({ app: APP, facts: facts(), runStatus: "running", now: "n" });
		const paused = applicationRunTaskRecord({ app: APP, facts: facts(), runStatus: "paused", now: "n" });
		const done = applicationRunTaskRecord({ app: APP, facts: facts(), runStatus: "submitted", now: "n" });
		expect(open.completedAt).toBeUndefined();
		// A checkpoint pause is NOT finished work: it is waiting for the owner.
		expect(paused.completedAt).toBeUndefined();
		expect(done.completedAt).toBe("n");
	});
});

describe("what the card says about a checkpoint and a terminal reason", () => {
	it("shows the checkpoint and that it is awaiting a directive — #978's acceptance line", () => {
		const record = applicationRunTaskRecord({
			app: APP,
			facts: facts({ checkpoint: { checkpointId: "before-submit-1", phase: "before_submit", directive: null } }),
			runStatus: "paused",
			now: "n",
		});
		expect(record.status).toBe("needs_human");
		expect(String(record.description)).toContain("before-submit-1");
		expect(String(record.description)).toContain("before_submit");
		expect(String(record.description)).toMatch(/awaiting a directive/);
	});

	it("shows the directive once the supervisor has decided", () => {
		const record = applicationRunTaskRecord({ app: APP, facts: facts({ checkpoint: { checkpointId: "c1", phase: "uncertain", directive: "request_review" } }), runStatus: "paused", now: "n" });
		expect(String(record.description)).toContain("→ request_review");
	});

	it("shows the terminal reason, so a blocked card explains itself", () => {
		const record = applicationRunTaskRecord({ app: APP, facts: facts({ blockReason: "bridge_unused" }), runStatus: "blocked", now: "n" });
		expect(String(record.description)).toContain("reason: bridge_unused");
	});

	it("links the correlated trace, and carries the runner that executed it (#977)", () => {
		const record = applicationRunTaskRecord({ app: APP, facts: facts({ runnerVersion: "0.4.84" }), runStatus: "running", now: "n" });
		expect(record.application).toMatchObject({ traceUrl: "/instances/ap/applications/app-1/trace", runnerVersion: "0.4.84" });
	});

	it("bounds the detail it writes, so one long reason cannot crowd the card", () => {
		const record = applicationRunTaskRecord({ app: APP, facts: facts({ stage: "x".repeat(500) }), runStatus: "running", now: "n" });
		expect(String(record.description).length).toBeLessThanOrEqual(300);
	});
});
