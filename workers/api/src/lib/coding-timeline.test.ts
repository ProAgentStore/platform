import { describe, expect, it } from "vitest";
import { appendTimeline, loadTimeline, loadChat, lastTerminal, contextForCopilot, loadRepoTimeline } from "./coding-timeline.js";
import type { Env } from "../types.js";

interface Write { sql: string; args: unknown[] }

/** Mock D1: records writes; .all<Row>() returns `rows` (already DB-order = seq DESC),
 *  .first<T>() returns `first`. */
function mockEnv(opts: { rows?: unknown[]; first?: unknown } = {}): { env: Env; writes: Write[] } {
	const writes: Write[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
						async all() { return { results: opts.rows ?? [] }; },
						async first() { return opts.first ?? null; },
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Env, writes };
}

describe("appendTimeline", () => {
	it("inserts with all 6 bound columns and truncates content to 100k", async () => {
		const { env, writes } = mockEnv();
		await appendTimeline(env, { sessionId: "s1", instanceId: "i1", userId: "u1", type: "chat_user", content: "hello" });
		expect(writes).toHaveLength(1);
		expect(writes[0].sql).toContain("INSERT INTO coding_timeline");
		expect(writes[0].args).toEqual(["s1", "i1", "u1", "chat_user", "hello", null]);
	});

	it("caps overlong content at 100_000 chars", async () => {
		const { env, writes } = mockEnv();
		await appendTimeline(env, { sessionId: "s1", instanceId: "i1", userId: "u1", type: "terminal", content: "x".repeat(150_000) });
		expect((writes[0].args[4] as string).length).toBe(100_000);
	});

	it("no-ops on empty content (no write)", async () => {
		const { env, writes } = mockEnv();
		await appendTimeline(env, { sessionId: "s1", instanceId: "i1", userId: "u1", type: "system", content: "" });
		expect(writes).toHaveLength(0);
	});

	it("accepts a valid audioKey but rejects an invalid one (stored NULL)", async () => {
		const good = mockEnv();
		await appendTimeline(good.env, { sessionId: "s1", instanceId: "i1", userId: "u1", type: "chat_user", content: "hi", audioKey: "abc_123-XYZ" });
		expect(good.writes[0].args[5]).toBe("abc_123-XYZ");

		const bad = mockEnv();
		await appendTimeline(bad.env, { sessionId: "s1", instanceId: "i1", userId: "u1", type: "chat_user", content: "hi", audioKey: "bad key/with spaces!" });
		expect(bad.writes[0].args[5]).toBeNull(); // failed the [a-zA-Z0-9_-]{1,64} guard
	});
});

describe("loadTimeline", () => {
	it("maps DB rows to entries and REVERSES to oldest→newest", async () => {
		// DB returns seq DESC; loadTimeline reverses so caller gets ascending seq.
		const rows = [
			{ seq: 3, type: "chat_assistant", content: "third", created_at: "2026-08-01T00:00:03Z", audio_key: null },
			{ seq: 2, type: "chat_user", content: "second", created_at: "2026-08-01T00:00:02Z", audio_key: "k2" },
			{ seq: 1, type: "system", content: "first", created_at: "2026-08-01T00:00:01Z", audio_key: null },
		];
		const { env } = mockEnv({ rows });
		const out = await loadTimeline(env, "s1");
		expect(out.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(out[0].content).toBe("first");
		expect(out[1].audioKey).toBe("k2"); // audio_key → audioKey
		expect(out[2].audioKey).toBeUndefined(); // null → undefined
	});

	it("returns [] when there are no rows", async () => {
		const { env } = mockEnv({ rows: [] });
		expect(await loadTimeline(env, "s1")).toEqual([]);
	});
});

describe("loadChat", () => {
	it("filters to conversation turns via the SQL IN-list and reverses", async () => {
		const rows = [
			{ seq: 2, type: "command", content: "npm test", created_at: "t2", audio_key: null },
			{ seq: 1, type: "chat_user", content: "run tests", created_at: "t1", audio_key: null },
		];
		const { env } = mockEnv({ rows });
		const out = await loadChat(env, "s1");
		expect(out.map((e) => e.type)).toEqual(["chat_user", "command"]);
		expect(out.map((e) => e.seq)).toEqual([1, 2]);
	});
});

describe("lastTerminal", () => {
	it("returns the most recent terminal snapshot content", async () => {
		const { env } = mockEnv({ first: { content: "the terminal tail" } });
		expect(await lastTerminal(env, "s1")).toBe("the terminal tail");
	});

	it("returns null when there is no terminal snapshot", async () => {
		const { env } = mockEnv({ first: null });
		expect(await lastTerminal(env, "s1")).toBeNull();
	});
});

describe("contextForCopilot", () => {
	it("renders a labeled block with terminal tail truncation", async () => {
		const rows = [
			{ seq: 2, type: "terminal", content: "PREFIX" + "z".repeat(2000), created_at: "t2", audio_key: null },
			{ seq: 1, type: "chat_user", content: "what happened?", created_at: "t1", audio_key: null },
		];
		const { env } = mockEnv({ rows });
		const out = await contextForCopilot(env, "s1");
		expect(out).toContain("[You(user)] what happened?");
		expect(out).toContain("[Terminal]");
		// terminal keeps only the last 1200 chars — so the "PREFIX" at the head is dropped
		expect(out).not.toContain("PREFIX");
		// oldest-first ordering: the user turn (seq 1) precedes the terminal (seq 2)
		expect(out.indexOf("You(user)")).toBeLessThan(out.indexOf("Terminal"));
	});

	it("returns an empty string when the timeline is empty", async () => {
		const { env } = mockEnv({ rows: [] });
		expect(await contextForCopilot(env, "s1")).toBe("");
	});
});

describe("loadRepoTimeline — history belongs to the REPO, not to a session (#257)", () => {
	/** Mock D1 that records the READ, not just writes — the query IS the fix here. */
	function readEnv(rows: unknown[] = []) {
		const reads: { sql: string; args: unknown[] }[] = [];
		const DB = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						reads.push({ sql, args });
						return {
							async all() { return { results: rows }; },
							async first() { return null; },
							async run() { return { meta: { changes: 0 } }; },
						};
					},
				};
			},
		};
		return { env: { DB } as unknown as Env, reads };
	}

	it("joins coding_sessions to scope by repo, and scopes to the owner in the SQL itself", async () => {
		// Owner-scoping lives in the query rather than only at the route because this is reached
		// from a repo id: a repo that is not the caller's must return nothing even if a future
		// route forgets to check.
		const { env, reads } = readEnv();
		await loadRepoTimeline(env, { instanceId: "i1", userId: "u1", repoId: "r1" });
		expect(reads[0].sql).toContain("JOIN coding_sessions");
		expect(reads[0].sql).toContain("s.repo_id = ?3");
		expect(reads[0].sql).toContain("t.instance_id = ?1");
		expect(reads[0].sql).toContain("t.user_id = ?2");
		expect(reads[0].args.slice(0, 3)).toEqual(["i1", "u1", "r1"]);
	});

	it("takes the LATEST rows and returns them oldest-first", async () => {
		// ORDER BY seq DESC + reverse. Ascending with a LIMIT would keep the OLDEST rows, so a repo
		// with long history would show its first session forever and never the run that just ended.
		const { env, reads } = readEnv([
			{ seq: 9, type: "terminal", content: "newest", created_at: "t9", session_id: "s2" },
			{ seq: 8, type: "terminal", content: "older", created_at: "t8", session_id: "s1" },
		]);
		const out = await loadRepoTimeline(env, { instanceId: "i1", userId: "u1", repoId: "r1" });
		expect(reads[0].sql).toContain("ORDER BY t.seq DESC");
		expect(out.map((e) => e.content)).toEqual(["older", "newest"]);
	});

	it("carries sessionId so the UI can draw session boundaries", async () => {
		const { env } = readEnv([{ seq: 1, type: "terminal", content: "x", created_at: "t", session_id: "s1" }]);
		const out = await loadRepoTimeline(env, { instanceId: "i1", userId: "u1", repoId: "r1" });
		expect(out[0].sessionId).toBe("s1");
	});

	it("clamps the limit so a caller cannot ask for the whole table", async () => {
		const { env, reads } = readEnv();
		await loadRepoTimeline(env, { instanceId: "i1", userId: "u1", repoId: "r1", limit: 999_999 });
		expect(reads[0].args[3]).toBe(2000);
		await loadRepoTimeline(env, { instanceId: "i1", userId: "u1", repoId: "r1", limit: 0 });
		expect(reads[1].args[3]).toBe(1);
	});
});
