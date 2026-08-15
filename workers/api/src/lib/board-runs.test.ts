import { describe, expect, it } from "vitest";
import { buildInstanceBoard, type BoardItemView } from "./board.js";
import { codingCardId } from "./coding-board.js";
import {
	CODING_SESSION_TASK_TYPE,
	codingSessionIdFromCardId,
	reconcileCodingCard,
	type CodingRunFact,
} from "./board-runs.js";
import type { Env } from "../types.js";

/**
 * The board card, the loop run and the coding session are three records describing ONE piece of
 * work, and #592 measured all three ways they can disagree over 83 live cards. These hold the
 * agreement.
 */

describe("codingSessionIdFromCardId", () => {
	it("is the exact inverse of codingCardId — the two must not drift", () => {
		// board-runs.ts carries its own copy of the `csess-` prefix rather than importing the writer,
		// so this is the thing that keeps the copy honest.
		expect(codingSessionIdFromCardId(codingCardId("csess_c960d431"))).toBe("csess_c960d431");
		expect(codingSessionIdFromCardId(codingCardId("s1"))).toBe("s1");
	});

	it("returns nothing for a card that is not a coding session", () => {
		expect(codingSessionIdFromCardId("task_fbf2744e")).toBe("");
		expect(codingSessionIdFromCardId("jobs.example.com/role/1")).toBe("");
	});
});

/**
 * `waitingReason`/`waitingUntil` carry the production DEFAULTS, not nothing. `runFactsFor`
 * (board-runs.ts:203) normalises the two columns with `?? ""` and `?? null`, so a fact that reaches
 * the reconciler in production is never missing them — but this factory omitted both, and until #599
 * put this file in front of tsc nothing said so. Every test here was therefore driving the reconciler
 * with `waitingReason: undefined`, a value the real mapper cannot emit. Overridable, so a test about
 * a parked run (#580) can state the park instead of building a second factory.
 */
const run = (runId: string, status: string, at: number, detail = "", waitingReason = "", waitingUntil: number | null = null): CodingRunFact => ({ runId, status, detail, at, waitingReason, waitingUntil });

describe("reconcileCodingCard — attempts is the RUNS behind the session", () => {
	it("reports nine runs for the nine-run session, with the failure among them (#592 case 1)", () => {
		// `csess_c960d431` — the live case. The card said `attempts:1, completed`; nine runs drove it
		// and `9f3cf5ab` failed. Before the join this number was pinned at 1 by construction: one
		// session is one `instance_runtime_tasks` row, and `attempts` counted rows.
		const runs = [
			run("9f3cf5ab", "failed", 1_000),
			run("026d4255", "completed", 2_000),
			run("f19d0654", "completed", 3_000),
			run("0dce25fb", "completed", 4_000),
			run("2ab928b6", "completed", 5_000),
			run("86a7ad7f", "completed", 6_000),
			run("ea27fbfb", "completed", 7_000),
			run("0cba259e", "completed", 8_000),
			run("c7a03659", "completed", 9_000),
		];
		const patch = reconcileCodingCard({
			runStatus: "completed",
			description: "",
			attempts: [{ id: codingCardId("csess_c960d431"), status: "completed", updatedAt: "2026-08-15T09:00:00.000Z" }],
			runs,
			session: { status: "ended" },
		});
		expect(patch.attempts).toHaveLength(9);
		expect(patch.attempts.map((a) => a.id)).toEqual(expect.arrayContaining(["9f3cf5ab", "c7a03659"]));
		expect(patch.attempts.filter((a) => a.status === "failed")).toHaveLength(1);
	});

	it("orders attempts newest-first, so the representative attempt is the latest run", () => {
		const patch = reconcileCodingCard({
			runStatus: "completed", description: "", attempts: [],
			runs: [run("old", "failed", 1_000), run("new", "completed", 9_000)],
		});
		expect(patch.attempts.map((a) => a.id)).toEqual(["new", "old"]);
	});

	it("keeps the card's own single attempt when a human drove the session with no loop run", () => {
		// "One session, no automated runs" is the truth for a hand-driven engine — not zero attempts.
		const own = [{ id: codingCardId("s1"), status: "running", updatedAt: "2026-08-15T09:00:00.000Z" }];
		const patch = reconcileCodingCard({ runStatus: "running", description: "", attempts: own, runs: [] });
		expect(patch.attempts).toEqual(own);
	});
});

describe("reconcileCodingCard — a needs_human card stops asking once nothing can answer", () => {
	const parked = { runStatus: "needs_human", description: "", attempts: [] };

	it("adopts the run's verdict when the run has moved on and the session is over (#592 case 2)", () => {
		const patch = reconcileCodingCard({
			...parked,
			runs: [run("r1", "completed", 5_000, "objective met")],
			session: { status: "ended" },
		});
		expect(patch.runStatus).toBe("completed");
		expect(patch.sessionEnded).toBe(true);
	});

	it("is failed — never completed — when nobody ever answered and the session died under it", () => {
		// `completed` here is the exact overwrite `closeCodingSessionCards`' `openOnly` guard exists
		// to prevent: a reaper's "ended" is a fact about the session being untouched, not about the
		// work. A run parked for a human that never came did not succeed.
		const patch = reconcileCodingCard({
			...parked,
			runs: [run("r1", "needs_human", 5_000, "the limit does not reset until 2026-08-17 16:00 +10:00")],
			session: { status: "ended" },
		});
		expect(patch.runStatus).toBe("failed");
		expect(patch.runStatus).not.toBe("completed");
		expect(patch.sessionEnded).toBe(true);
	});

	it("states that the session is over AND carries the run's reason", () => {
		const patch = reconcileCodingCard({
			...parked,
			runs: [run("r1", "needs_human", 5_000, "the limit does not reset until 2026-08-17 16:00 +10:00")],
			session: { status: "ended" },
		});
		expect(patch.description).toContain("session ended while this was waiting for you");
		expect(patch.description).toContain("2026-08-17");
	});

	it("leaves a card asking while its session is still active — that one really does want you", () => {
		// `bd43f4de`'s card, the fifth of the five: capture-verified active. It must survive untouched.
		const patch = reconcileCodingCard({
			...parked,
			runs: [run("r1", "needs_human", 5_000, "waiting on a takeover")],
			session: { status: "active" },
		});
		expect(patch.runStatus).toBe("needs_human");
		expect(patch.sessionEnded).toBe(false);
		expect(patch.description).toContain("waiting on a takeover");
	});

	it("does not reconcile a card whose session it cannot find — absence is not death", () => {
		const patch = reconcileCodingCard({ ...parked, runs: [run("r1", "needs_human", 1)], session: undefined });
		expect(patch.runStatus).toBe("needs_human");
		expect(patch.sessionEnded).toBe(false);
	});
});

describe("reconcileCodingCard — the reason reaches the card", () => {
	it("fills an empty detail from the latest run (#592 case 3)", () => {
		// All five measured `needs_human` cards had `detail: ""` while the run carried the whole
		// explanation: `setCodingSessionCardStatus` patches only `$.status`.
		const patch = reconcileCodingCard({
			runStatus: "failed", description: "", attempts: [],
			runs: [run("r1", "failed", 5_000, "engine refused: weekly limit")],
		});
		expect(patch.description).toBe("engine refused: weekly limit");
	});

	it("never overwrites a live progress line the card already carries (#207B)", () => {
		const patch = reconcileCodingCard({
			runStatus: "running", description: "editing src/index.ts", attempts: [],
			runs: [run("r1", "running", 5_000, "iteration 4")],
		});
		expect(patch.description).toBe("editing src/index.ts");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The invariant, over a whole fixture board.
// ─────────────────────────────────────────────────────────────────────────────

interface FixtureSession {
	sessionId: string;
	/** What the card row stores — what the writers last wrote. */
	cardStatus: string;
	/** `active` | `ended` | `error`, or absent when the session row is gone. */
	sessionStatus?: string;
	runs: Array<{ runId: string; status: string; at: number; detail?: string }>;
}

/**
 * Every combination that produced a wrong card live, plus the ones that must NOT move.
 *
 * The denominator this guard states (G2) is this table's length: a card-by-card assertion that
 * walked a one-card board is exactly the subset measurement ADR 0002 forbids, and #592's own
 * evidence was 83 cards on 5 boards.
 */
const FIXTURE: FixtureSession[] = [
	// The nine-run case — under-reported 9× as one clean success.
	{
		sessionId: "csess_c960d431", cardStatus: "completed", sessionStatus: "ended",
		runs: [
			{ runId: "9f3cf5ab", status: "failed", at: 1_000 },
			{ runId: "026d4255", status: "completed", at: 2_000 },
			{ runId: "f19d0654", status: "completed", at: 3_000 },
			{ runId: "0dce25fb", status: "completed", at: 4_000 },
			{ runId: "2ab928b6", status: "completed", at: 5_000 },
			{ runId: "86a7ad7f", status: "completed", at: 6_000 },
			{ runId: "ea27fbfb", status: "completed", at: 7_000 },
			{ runId: "0cba259e", status: "completed", at: 8_000 },
			{ runId: "c7a03659", status: "completed", at: 9_000 },
		],
	},
	// The four "Needs you" cards on sessions that had ended.
	{
		sessionId: "csess_88a4de4b", cardStatus: "needs_human", sessionStatus: "ended",
		runs: [{ runId: "r-88a", status: "needs_human", at: 5_000, detail: "waiting on a takeover" }],
	},
	{
		sessionId: "csess_f7a6fcec", cardStatus: "needs_human", sessionStatus: "ended",
		runs: [{ runId: "r-f7a", status: "failed", at: 5_000, detail: "engine_limit" }],
	},
	{
		sessionId: "csess_f6266368", cardStatus: "needs_human", sessionStatus: "error",
		runs: [{ runId: "r-f62", status: "needs_human", at: 5_000, detail: "resets Aug 17 at 4pm" }],
	},
	{
		sessionId: "csess_e94eb26a", cardStatus: "needs_human", sessionStatus: "ended",
		runs: [{ runId: "r-e94", status: "cancelled", at: 5_000, detail: "cancelled by owner" }],
	},
	// The fifth: genuinely active, genuinely wants a human. Must survive.
	{
		sessionId: "csess_c306e923", cardStatus: "needs_human", sessionStatus: "active",
		runs: [
			{ runId: "r-c30-a", status: "needs_human", at: 5_000, detail: "takeover requested" },
			{ runId: "r-c30-b", status: "completed", at: 3_000 },
			{ runId: "r-c30-c", status: "failed", at: 1_000 },
		],
	},
	// A live session mid-run.
	{
		sessionId: "csess_9228b52f", cardStatus: "running", sessionStatus: "active",
		runs: [{ runId: "r-922-a", status: "running", at: 5_000 }, { runId: "r-922-b", status: "completed", at: 1_000 }],
	},
	// Hand-driven: a session with no loop run at all.
	{ sessionId: "csess_manual", cardStatus: "running", sessionStatus: "active", runs: [] },
	// The session row is gone entirely — the card may not be reconciled on an absence.
	{
		sessionId: "csess_orphan", cardStatus: "needs_human",
		runs: [{ runId: "r-orph", status: "needs_human", at: 5_000, detail: "still parked" }],
	},
];

/** A D1 stub that answers each of `buildInstanceBoard`'s five reads from the fixture. */
function fixtureEnv(fixture: FixtureSession[]): Env {
	const tasks = fixture.map((f) => ({
		payload: JSON.stringify({
			id: codingCardId(f.sessionId),
			type: CODING_SESSION_TASK_TYPE,
			status: f.cardStatus,
			title: `Coding: repo-${f.sessionId}`,
			subtitle: "claude",
			createdAt: "2026-08-15T09:00:00.000Z",
			updatedAt: "2026-08-15T09:20:00.000Z",
		}),
	}));
	const loopRows = fixture.flatMap((f) =>
		f.runs.map((r) => ({
			run_id: r.runId, session_id: f.sessionId, status: r.status,
			detail: r.detail ?? null, started_at: r.at, finished_at: r.at,
		})),
	);
	const sessionRows = fixture
		.filter((f) => f.sessionStatus)
		.map((f) => ({ id: f.sessionId, status: f.sessionStatus as string }));

	const DB = {
		prepare(sql: string) {
			return {
				bind(..._args: unknown[]) {
					return {
						async first() {
							// boardConfigForInstance's agent/instance row.
							return { slug: "coder", category: "coding", agent_config: "{}", instance_config: "{}" };
						},
						async all() {
							if (sql.includes("FROM instance_runtime_tasks")) return { results: tasks };
							if (sql.includes("FROM agent_loop_runs")) return { results: loopRows };
							if (sql.includes("FROM coding_sessions")) return { results: sessionRows };
							if (sql.includes("FROM board_items")) return { results: [] };
							if (sql.includes("instance_runtime_task_events")) return { results: [] };
							throw new Error(`unstubbed query: ${sql}`);
						},
						async run() { return { meta: { changes: 0 } }; },
					};
				},
			};
		},
	};
	return { DB } as unknown as Env;
}

describe("board invariant — every coding card agrees with the run and session it is keyed on", () => {
	it("holds over the whole fixture board, and says how many cards it measured", async () => {
		const board = await buildInstanceBoard(fixtureEnv(FIXTURE), "inst-1", "u1");
		const byKey = new Map<string, BoardItemView>(board.items.map((i) => [i.jobKey, i]));

		// G1 — the input set is asserted, not assumed. A stub that stopped returning tasks, or a
		// grouping that stopped producing coding cards, must fail HERE rather than pass vacuously
		// with an empty offender list.
		expect(board.items, "board built no cards — the guard is measuring nothing").toHaveLength(FIXTURE.length);
		expect(FIXTURE.length, "fixture must cover every observed combination").toBeGreaterThanOrEqual(9);

		let checked = 0;
		const violations: string[] = [];
		for (const f of FIXTURE) {
			const card = byKey.get(codingCardId(f.sessionId));
			// G3 — a card the lookup cannot resolve is reported, never skipped.
			if (!card) { violations.push(`${f.sessionId}: no card built`); continue; }
			checked++;

			const runs = [...f.runs].sort((a, b) => b.at - a.at);
			const latest = runs[0];
			const sessionOver = !!f.sessionStatus && f.sessionStatus !== "active";

			// 1. attempts equals the run count whenever there are runs.
			const expectedAttempts = runs.length || 1;
			if (card.attempts.length !== expectedAttempts) {
				violations.push(`${f.sessionId}: attempts ${card.attempts.length} ≠ ${expectedAttempts} runs`);
			}

			// 2. no card asks for a human on a session that is over.
			if (card.status === "needs_human" && sessionOver) {
				violations.push(`${f.sessionId}: needs_human on a ${f.sessionStatus} session`);
			}
			// ...and the card says the session is over when it is.
			if (sessionOver && card.sessionEnded !== true) {
				violations.push(`${f.sessionId}: sessionEnded not reported for a ${f.sessionStatus} session`);
			}
			// A card whose session is still active must NOT have been moved.
			if (!sessionOver && card.runStatus !== f.cardStatus) {
				violations.push(`${f.sessionId}: live session's card moved ${f.cardStatus} → ${card.runStatus}`);
			}

			// 3. a card that reached a terminal state carries a reason, when the run gave one.
			if (latest?.detail && !card.description) {
				violations.push(`${f.sessionId}: run carried a reason, card detail is empty`);
			}
			// 3b. every card carries a timestamp.
			if (!card.updatedAt) violations.push(`${f.sessionId}: card carries no timestamp`);
		}

		expect(violations, violations.join("\n")).toEqual([]);
		// G2 — the denominator is in the passing output.
		expect(checked, `cards reconciled against their run + session`).toBe(FIXTURE.length);
	});

	it("the nine-run card reports nine attempts and its failure, end to end", async () => {
		const board = await buildInstanceBoard(fixtureEnv(FIXTURE), "inst-1", "u1");
		const card = board.items.find((i) => i.jobKey === codingCardId("csess_c960d431"));
		expect(card).toBeDefined();
		expect(card?.attempts).toHaveLength(9);
		expect(card?.attempts.filter((a) => a.status === "failed")).toHaveLength(1);
	});

	it("the four ended 'Needs you' cards leave the column; the active one stays", async () => {
		const board = await buildInstanceBoard(fixtureEnv(FIXTURE), "inst-1", "u1");
		const asking = board.items.filter((i) => i.status === "needs_human").map((i) => i.jobKey);
		// `csess_c306e923` is capture-verified active; `csess_orphan` has no session row, and an
		// absence must not be read as death.
		expect(asking.sort()).toEqual([codingCardId("csess_c306e923"), codingCardId("csess_orphan")].sort());
	});
});
