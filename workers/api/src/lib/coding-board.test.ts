import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	closeCodingSessionCards,
	codingCardId,
	codingSessionTaskRecord,
	isCodingCardOpen,
	setCodingSessionCardStatus,
	upsertCodingSessionCard,
} from "./coding-board.js";
import { statusFor, type LoopStopReason } from "./agent-loop.js";
import { defaultBoardColumns, columnForStatus } from "./agent-capabilities.js";
import type { Env } from "../types.js";

function stubEnv(fail = false) {
	const sqls: string[] = [];
	const binds: unknown[][] = [];
	const env = {
		DB: {
			prepare(sql: string) {
				sqls.push(sql);
				return {
					bind(...args: unknown[]) {
						binds.push(args);
						return { async run() { if (fail) throw new Error("d1 down"); return { meta: { changes: 1 } }; } };
					},
				};
			},
		},
	} as unknown as Env;
	return { env, sqls, binds };
}

const NOW = "2026-08-05T12:00:00.000Z";

describe("codingSessionTaskRecord — the generic card a coding session becomes", () => {
	it("uses a STABLE per-session id, so every transition upserts one row", () => {
		// Without this a session would pile up a card per status change and the board would show
		// the same work three times.
		expect(codingCardId("csess_abc")).toBe("csess-csess_abc");
		expect(codingSessionTaskRecord({ sessionId: "s1", repoName: "platform", engine: "claude", status: "running", now: NOW }).id)
			.toBe(codingCardId("s1"));
	});

	it("lands in the RIGHT column of a Repo Coder's default board with no declaration at all", () => {
		// The whole point of writing a generic record: `coder-repo` declares no boardColumns, so a
		// supervisor buckets these through defaultBoardColumns(["coding"]). If the statuses this
		// emits weren't claimed there, every coding session would fall to the catchAll and read as
		// undifferentiated "Other" — visible but useless.
		const cols = defaultBoardColumns(["coding"]);
		expect(columnForStatus(cols, "running")?.title).toBe("Running");
		expect(columnForStatus(cols, "completed")?.title).toBe("Done");
		for (const s of ["running", "completed", "cancelled", "failed"] as const) {
			expect(columnForStatus(cols, s), s).not.toBeNull();
		}
	});

	it("stamps completedAt only on a terminal status", () => {
		expect(codingSessionTaskRecord({ sessionId: "s", repoName: "r", engine: "claude", status: "running", now: NOW }))
			.not.toHaveProperty("completedAt");
		expect(codingSessionTaskRecord({ sessionId: "s", repoName: "r", engine: "claude", status: "completed", now: NOW }))
			.toMatchObject({ completedAt: NOW, status: "completed" });
	});

	it("carries the repo in the title and the engine as the subtitle", () => {
		// This is the supervisor's answer to "who is working in which repo" — the repo name has to
		// be IN the card, because supervision will never read coding_repos to find it.
		const rec = codingSessionTaskRecord({ sessionId: "s", repoName: "fws/platform", engine: "codex", status: "running", now: NOW });
		expect(rec).toMatchObject({ type: "coding.session", title: "Coding: fws/platform", subtitle: "codex" });
	});

	it("bounds the free-text fields so one long repo name can't blow a supervisor's budget", () => {
		const rec = codingSessionTaskRecord({
			sessionId: "s", repoName: "r".repeat(500), engine: "claude", status: "running", now: NOW, note: "n".repeat(900),
		});
		expect((rec.title as string).length).toBeLessThanOrEqual(200);
		expect((rec.description as string).length).toBeLessThanOrEqual(300);
	});

	it("MARKS a cut description instead of ending mid-word (#568)", () => {
		// This card carried the identical blind `note.slice(0, 300)` the delegation card did, and
		// the reason both were fixed at once is that no reader can tell which writer produced the
		// card it is holding: a detail that just stops has to mean "there is more" everywhere, or
		// "it ends there" stays a plausible reading of a complete one.
		const cut = codingSessionTaskRecord({ sessionId: "s", repoName: "r", engine: "claude", status: "failed", now: NOW, note: "n".repeat(900) });
		expect(cut.description).not.toBe("n".repeat(300));
		expect((cut.description as string).endsWith("…")).toBe(true);
		expect((cut.description as string).length).toBe(300);
		// A note that fits is passed through untouched — the marker means something only because
		// it is absent when nothing was dropped.
		const whole = codingSessionTaskRecord({ sessionId: "s", repoName: "r", engine: "claude", status: "completed", now: NOW, note: "ended cleanly" });
		expect(whole.description).toBe("ended cleanly");
	});
});

describe("upsertCodingSessionCard / closeCodingSessionCards — writes", () => {
	it("upserts on conflict rather than inserting a duplicate", async () => {
		const { env, sqls } = stubEnv();
		await upsertCodingSessionCard(env, { instanceId: "i", userId: "u", sessionId: "s", repoName: "r", engine: "claude", status: "running" });
		expect(sqls[0]).toContain("ON CONFLICT(id) DO UPDATE");
	});

	it("scopes the close to the owner AND the instance", async () => {
		const { env, sqls, binds } = stubEnv();
		await closeCodingSessionCards(env, "i1", "u1", ["s1", "s2"], "cancelled");
		expect(sqls[0]).toContain("instance_id = ?2 AND user_id = ?3");
		expect(binds[0]).toEqual(["cancelled", "i1", "u1", codingCardId("s1"), codingCardId("s2")]);
	});

	it("patches the payload status instead of rebuilding the card", async () => {
		// The bulk paths (reaper, takeover) don't know the repo name. Rebuilding would either
		// invent one or wipe the title — patching keeps whatever the open path already wrote.
		const { env, sqls } = stubEnv();
		await closeCodingSessionCards(env, "i", "u", ["s"], "completed");
		expect(sqls[0]).toContain("json_set");
		expect(sqls[0]).not.toContain("INSERT");
	});

	it("issues NO query for an empty session list", async () => {
		const { env, sqls } = stubEnv();
		await closeCodingSessionCards(env, "i", "u", [], "completed");
		expect(sqls).toHaveLength(0);
	});

	it("never throws — a board write must not fail the session operation that triggered it", async () => {
		// Losing a card is a visibility bug; failing `createSession` because the board write failed
		// would be a work bug, and strictly worse.
		const a = stubEnv(true);
		await expect(upsertCodingSessionCard(a.env, { instanceId: "i", userId: "u", sessionId: "s", repoName: "r", engine: "c", status: "running" }))
			.resolves.toBeUndefined();
		const b = stubEnv(true);
		await expect(closeCodingSessionCards(b.env, "i", "u", ["s"], "failed")).resolves.toBeUndefined();
	});
});

describe("`needs_human` — the status the board had a column for and the card could not hold (#553)", () => {
	const COLUMNS = defaultBoardColumns(["coding"]);

	it("lands in the column named for it, not in an `other` bucket", () => {
		// The regression the issue names explicitly: `defaultBoardColumns(["coding"])` maps the
		// statuses with no declaration from the agent, so a status it does not claim goes nowhere.
		expect(columnForStatus(COLUMNS, "needs_human")?.title).toBe("Needs you");
		// …and the four that already worked still do, so the vocabulary was widened, not swapped.
		expect(columnForStatus(COLUMNS, "running")?.title).toBe("Running");
		expect(columnForStatus(COLUMNS, "completed")?.title).toBe("Done");
		expect(columnForStatus(COLUMNS, "failed")?.title).toBe("Failed");
		expect(columnForStatus(COLUMNS, "cancelled")?.title).toBe("Cancelled");
	});

	it("gives every stop reason a coding card status the board can render", () => {
		// G1: the reason list is read off the type's own declaration rather than retyped, and its
		// size asserted, so a reason added without a column fails HERE instead of rendering blank.
		const decl = /export type LoopStopReason =([\s\S]*?);\n/.exec(readFileSync(join(__dirname, "agent-loop.ts"), "utf8"));
		expect(decl, "LoopStopReason's declaration shape changed — re-read this guard").not.toBeNull();
		const reasons = [...decl![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) as LoopStopReason[];
		expect(reasons.length, "found no reasons — this guard has stopped measuring").toBeGreaterThanOrEqual(8);
		for (const r of reasons) {
			expect(columnForStatus(COLUMNS, statusFor(r)), `${r} → ${statusFor(r)}`).not.toBeNull();
		}
	});

	it("is a status the card is passing THROUGH, so it carries no completedAt", () => {
		// A run parked in a handoff has not finished, and `completedAt` is what every reader takes
		// "this finished at" from. It goes back to `running` when somebody answers.
		expect(isCodingCardOpen("needs_human")).toBe(true);
		expect(isCodingCardOpen("running")).toBe(true);
		for (const s of ["completed", "failed", "cancelled"] as const) expect(isCodingCardOpen(s)).toBe(false);
		const parked = codingSessionTaskRecord({ sessionId: "s", repoName: "r", engine: "claude", status: "needs_human", now: NOW });
		expect("completedAt" in parked).toBe(false);
		expect(parked.status).toBe("needs_human");
		expect(codingSessionTaskRecord({ sessionId: "s", repoName: "r", engine: "claude", status: "failed", now: NOW }).completedAt).toBe(NOW);
	});
});

describe("the RUN outranks the SESSION — which is how three dead runs read as `completed` (#553)", () => {
	it("lets the run write any status, unconditionally", async () => {
		// The run is the only thing that knows how the work went, so its write is not guarded: a
		// reaper that closed the card first must not be able to keep its answer.
		const { env, sqls, binds } = stubEnv();
		await setCodingSessionCardStatus(env, "i1", "u1", "s1", "needs_human");
		expect(sqls[0]).not.toContain("status IN ('running', 'needs_human')");
		expect(binds[0]).toEqual(["needs_human", "i1", "u1", codingCardId("s1")]);
		// A patch, not a rebuild — `$.description` is the live progress line (#207B).
		expect(sqls[0]).toContain("json_set");
		expect(sqls[0]).not.toContain("INSERT");
	});

	it("restricts every SESSION-side close to a card no run has already terminated", async () => {
		// `endSession` maps error → failed and EVERYTHING ELSE → completed, and four of its five
		// callers pass the default "ended" — two of them crons (the 6h idle reaper and the orphan
		// reconciler). Without this guard a sweep six hours after a run died overwrote its `failed`
		// with `completed`, which is exactly what the board showed for `csess_2dd3124c` and
		// `csess_302422b7`. Delete `{ openOnly: true }` and this goes red.
		const { env, sqls } = stubEnv();
		await closeCodingSessionCards(env, "i", "u", ["s"], "completed");
		expect(sqls[0]).toContain("status IN ('running', 'needs_human')");
	});

	it("never throws — the run's own card write must not fail the run", async () => {
		const { env } = stubEnv(true);
		await expect(setCodingSessionCardStatus(env, "i", "u", "s", "failed")).resolves.toBeUndefined();
	});
});

// That the Pilot moves this card at all three points of a run — start, handoff, terminal — is asserted by RUNNING the workflow in `workflows/coding-session/workflow-run.test.ts` (#915),
// not by reading its source.
