import { describe, expect, it } from "vitest";
import { closeCodingSessionCards, codingCardId, codingSessionTaskRecord, upsertCodingSessionCard } from "./coding-board.js";
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
