/**
 * #987 — an application card's executions are the RUNS behind it, not the card rows.
 *
 * The live card for `435d31c8…` reported `attempts: 1` while its trace listed four correlated fill
 * runs. One card per application is the product model (#978) and is correct; the execution history
 * is a different question, and the generic counter could never answer it.
 */
import { describe, expect, it } from "vitest";
import { APPLICATION_EXECUTION_LIMIT, type ApplicationRunFact, reconcileApplicationCard } from "./application-runs.js";
import { applicationCardId } from "./application-board.js";

const run = (runId: string, over: Partial<ApplicationRunFact> = {}): ApplicationRunFact => ({ runId, kind: "fill", status: "blocked", at: Date.parse("2026-10-08T01:00:00Z"), instanceId: "ap", ...over });

/** The live shape: four fill runs on one application, the newest ending at review. */
const LIVE: ApplicationRunFact[] = [
	run("207849f1", { at: Date.parse("2026-10-08T02:10:00Z") }),
	run("da669896", { at: Date.parse("2026-10-08T05:45:00Z") }),
	run("1b4963e7", { at: Date.parse("2026-10-08T09:16:00Z"), status: "awaiting_review" }),
	run("286bbb8a", { at: Date.parse("2026-10-08T11:22:00Z"), status: "awaiting_review" }),
];
const CARD = { applicationId: "435d31c8", applicationStatus: "awaiting_review", stateVersion: 20, actions: [], kind: "fill" as const, runId: "286bbb8a", stage: "…", traceUrl: "/t" };

describe("an application card's execution history (#987)", () => {
	it("counts the correlated RUNS, not the one card row", () => {
		const { attempts, executions } = reconcileApplicationCard({ attempts: [{ id: "app-435d31c8", status: "needs_human", updatedAt: "2026-10-08T11:22:00Z" }], runs: LIVE, application: CARD });
		expect(executions.total).toBe(4);
		expect(executions.fills).toBe(4);
		expect(executions.tailorings).toBe(0);
		// The generic counter said 1 for this application. The attempts a reader sees are the runs.
		expect(attempts).toHaveLength(4);
		expect(attempts.map((a) => a.id)).toEqual(["286bbb8a", "1b4963e7", "da669896", "207849f1"]);
	});

	it("names the latest execution and its state, newest first whatever order they arrive in", () => {
		const { executions } = reconcileApplicationCard({ attempts: [], runs: [...LIVE].reverse(), application: CARD });
		expect(executions.latest).toMatchObject({ runId: "286bbb8a", kind: "fill", status: "awaiting_review", instanceId: "ap" });
		expect(executions.runs[0]?.runId).toBe("286bbb8a");
	});

	it("keeps the run the CARD speaks for, so its trace link points at the right execution", () => {
		const { executions } = reconcileApplicationCard({ attempts: [], runs: LIVE, application: { ...CARD, runId: "1b4963e7" } });
		expect(executions.card).toMatchObject({ runId: "1b4963e7", status: "awaiting_review" });
		// …and the latest is still the latest: the two are different questions.
		expect(executions.latest?.runId).toBe("286bbb8a");
	});

	it("separates the Tailor's runs from the Runner's — both are executions of one application", () => {
		const { executions } = reconcileApplicationCard({
			attempts: [],
			runs: [run("t-1", { kind: "tailor", status: "completed", instanceId: "t1", at: 1 }), run("t-2", { kind: "tailor", status: "failed", instanceId: "t1", at: 2 }), run("f-1", { at: 3 })],
			application: CARD,
		});
		expect(executions).toMatchObject({ total: 3, fills: 1, tailorings: 2 });
		expect(executions.runs.find((r) => r.runId === "t-2")).toMatchObject({ kind: "tailor", status: "failed", instanceId: "t1" });
	});

	it("bounds what it lists without understating what happened", () => {
		const many = Array.from({ length: APPLICATION_EXECUTION_LIMIT + 7 }, (_, i) => run(`r${i}`, { at: i }));
		const { attempts, executions } = reconcileApplicationCard({ attempts: [], runs: many, application: CARD });
		expect(executions.runs).toHaveLength(APPLICATION_EXECUTION_LIMIT);
		expect(attempts).toHaveLength(APPLICATION_EXECUTION_LIMIT);
		// The COUNT is the truth, and it is not truncated.
		expect(executions.total).toBe(APPLICATION_EXECUTION_LIMIT + 7);
	});

	it("falls back to the card's own attempts when there is no run behind it yet", () => {
		const generic = [{ id: "app-x", status: "running", updatedAt: "2026-10-08T00:00:00Z" }];
		const { attempts, executions } = reconcileApplicationCard({ attempts: generic, runs: [], application: CARD });
		expect(attempts).toEqual(generic);
		expect(executions).toMatchObject({ total: 0, fills: 0, tailorings: 0 });
		expect(executions.latest).toBeUndefined();
	});

	it("is a projection, not a mutation: the same facts give the same answer", () => {
		const a = reconcileApplicationCard({ attempts: [], runs: LIVE, application: CARD });
		const b = reconcileApplicationCard({ attempts: [], runs: LIVE, application: CARD });
		expect(b).toEqual(a);
	});

	it("the card id the executions are keyed by is the application's, so a retry cannot fork it", () => {
		expect(applicationCardId("435d31c8")).toBe("app-435d31c8");
		expect(applicationCardId("435d31c8")).not.toContain("286bbb8a");
	});
});
