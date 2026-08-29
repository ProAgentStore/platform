import { describe, expect, it, beforeEach } from "vitest";
import { appendTimeline, appendEngineUsageTimeline, loadTimeline, loadChat, lastTerminal, contextForCopilot, loadRepoTimeline, loadTerminalSnapshots, pruneTerminalSnapshots, sweepTerminalSnapshots, TERMINAL_KEEP_PER_SESSION, loadTimelineFeed } from "./coding-timeline.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
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

	it("stays COMPLETE by default — the route that renders human history must not be cut (#737)", async () => {
		// The acceptance criterion the date bound must not break. `GET …/coding/repos/:id/timeline`
		// is a person scrolling back through their own work, which is a different question from an
		// engine being told what is still true. A caller that names no window gets a NULL bound, and
		// `(?5 IS NULL OR …)` is what makes that one query rather than two that can drift apart.
		const { env, reads } = readEnv([{ seq: 1, type: "terminal", content: "from June", created_at: "2026-06-26 09:00:00", session_id: "s1" }]);
		const out = await loadRepoTimeline(env, { instanceId: "i1", userId: "u1", repoId: "r1" });
		expect(reads[0].args[4], "the default read must carry no date bound").toBeNull();
		expect(out.map((e) => e.content)).toEqual(["from June"]);
	});

	it("formats an explicit window in the COLUMN's own format, not ISO", async () => {
		// `created_at` is `datetime('now')` — `YYYY-MM-DD HH:MM:SS`, compared as text. A raw
		// `toISOString()` puts a `T` where the column has a space, and `T` (0x54) sorts above every
		// digit, so `t.created_at >= '2026-08-20T…'` would match nothing that looks older and the
		// bound would silently do the opposite of its job.
		const { env, reads } = readEnv();
		await loadRepoTimeline(env, { instanceId: "i1", userId: "u1", repoId: "r1", since: Date.parse("2026-08-20T10:00:00Z") });
		expect(reads[0].sql).toContain("t.created_at >= ?5");
		expect(reads[0].args[4]).toBe("2026-08-20 10:00:00");
	});

	it("ignores a window that is not a number, rather than binding NaN", async () => {
		const { env, reads } = readEnv();
		await loadRepoTimeline(env, { instanceId: "i1", userId: "u1", repoId: "r1", since: Number.NaN });
		expect(reads[0].args[4]).toBeNull();
	});
});

describe("pruneTerminalSnapshots — keep newest N terminal rows, delete older ones (#466)", () => {
	/** Mock D1 that records run() calls and returns `changes` for each. */
	function pruneEnv(changes = 5): { env: Env; deletes: { sql: string; args: unknown[] }[] } {
		const deletes: { sql: string; args: unknown[] }[] = [];
		const DB = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async run() {
								deletes.push({ sql, args });
								return { meta: { changes } };
							},
							async all() { return { results: [] }; },
							async first() { return null; },
						};
					},
				};
			},
		};
		return { env: { DB } as unknown as Env, deletes };
	}

	it("issues a DELETE scoped to the given session_id and type = 'terminal' only", async () => {
		const { env, deletes } = pruneEnv();
		await pruneTerminalSnapshots(env, "sess-1");
		expect(deletes).toHaveLength(1);
		const { sql, args } = deletes[0];
		// Must be a DELETE — never touches non-terminal types
		expect(sql.trim()).toContain("DELETE FROM coding_timeline");
		expect(sql).toContain("type = 'terminal'");
		// session_id bound as ?1
		expect(args[0]).toBe("sess-1");
		// keep-1 offset as ?2 — this is the index into ORDER BY seq DESC to find the cutoff
		expect(args[1]).toBe(TERMINAL_KEEP_PER_SESSION - 1);
	});

	it("never mentions non-terminal types in the DELETE", async () => {
		const { env, deletes } = pruneEnv();
		await pruneTerminalSnapshots(env, "sess-1");
		const { sql } = deletes[0];
		// The retention sweep MUST be terminal-only.
		// This is the acceptance criterion from #466: "never deletes chat_user/chat_assistant/…"
		for (const forbidden of ["chat_user", "chat_assistant", "command", "brain", "outcome", "system"]) {
			expect(sql).not.toContain(forbidden);
		}
	});

	it("applies the caller-supplied keep and limit as bound parameters", async () => {
		const { env, deletes } = pruneEnv();
		await pruneTerminalSnapshots(env, "sess-2", 50, 10);
		const { args } = deletes[0];
		// ?2 = keep - 1 = 49 (the OFFSET into the newest-first list that marks the cutoff)
		expect(args[1]).toBe(49);
		// ?3 = limit = 10
		expect(args[2]).toBe(10);
	});

	it("returns the number of rows deleted from meta.changes", async () => {
		const { env } = pruneEnv(7);
		expect(await pruneTerminalSnapshots(env, "sess-3")).toBe(7);
	});

	it("returns 0 when meta.changes is absent", async () => {
		const DB = {
			prepare(_sql: string) {
				return {
					bind() {
						return {
							async run() { return {}; }, // no meta
							async all() { return { results: [] }; },
							async first() { return null; },
						};
					},
				};
			},
		};
		expect(await pruneTerminalSnapshots({ DB } as unknown as Env, "s")).toBe(0);
	});
});

describe("sweepTerminalSnapshots — finds over-cap sessions and prunes each (#466)", () => {
	/** Mock: .all() returns sessions, .run() records deletes. */
	function sweepEnv(sessionRows: { session_id: string }[]): { env: Env; dels: string[] } {
		const dels: string[] = [];
		const DB = {
			prepare(sql: string) {
				return {
					bind() {
						return {
							async all() {
								// The GROUP BY / HAVING query — return the mocked session list
								if (sql.includes("GROUP BY")) return { results: sessionRows };
								return { results: [] };
							},
							async run() {
								// Capture which session_id was passed to each DELETE
								dels.push(sql);
								return { meta: { changes: 1 } };
							},
							async first() { return null; },
						};
					},
				};
			},
		};
		return { env: { DB } as unknown as Env, dels };
	}

	it("issues a DELETE for each session returned by the GROUP BY query", async () => {
		const sessions = [{ session_id: "s1" }, { session_id: "s2" }];
		const { env, dels } = sweepEnv(sessions);
		const deleted = await sweepTerminalSnapshots(env);
		// One DELETE per session
		expect(dels).toHaveLength(2);
		// Returns total changes (1 per session from the mock)
		expect(deleted).toBe(2);
	});

	it("returns 0 and does not throw when no sessions exceed the cap", async () => {
		const { env } = sweepEnv([]);
		expect(await sweepTerminalSnapshots(env)).toBe(0);
	});

	it("GROUP BY query filters by type = 'terminal' and uses HAVING COUNT(*) > cap", async () => {
		const reads: string[] = [];
		const DB = {
			prepare(sql: string) {
				return {
					bind() {
						return {
							async all() {
								reads.push(sql);
								return { results: [] };
							},
							async run() { return { meta: { changes: 0 } }; },
							async first() { return null; },
						};
					},
				};
			},
		};
		await sweepTerminalSnapshots({ DB } as unknown as Env);
		expect(reads).toHaveLength(1);
		expect(reads[0]).toContain("type = 'terminal'");
		expect(reads[0]).toContain("GROUP BY session_id");
		expect(reads[0]).toContain("HAVING COUNT(*)");
	});

	it("returns 0 and swallows errors without throwing", async () => {
		const DB = {
			prepare() {
				return {
					bind() {
						return {
							async all() { throw new Error("D1 exploded"); },
							async run() { throw new Error("D1 exploded"); },
							async first() { throw new Error("D1 exploded"); },
						};
					},
				};
			},
		};
		expect(await sweepTerminalSnapshots({ DB } as unknown as Env)).toBe(0);
	});
});

describe("loadTerminalSnapshots — `after` is the cursor that makes a reload a delta (#550)", () => {
	/** A D1 that answers each terminal query from `rows`, applying the cursor itself, and records the SQL. */
	function pagedEnv(rows: Array<{ seq: number; content: string }>) {
		const issued: Array<{ sql: string; args: unknown[] }> = [];
		const DB = {
			prepare(sql: string) {
				const flat = sql.replace(/\s+/g, " ").trim();
				return {
					bind(...args: unknown[]) {
						issued.push({ sql: flat, args });
						return {
							async all() {
								const [, cursor, limit] = args as [string, number, number];
								const asc = flat.includes("seq > ?2");
								const hit = rows.filter((r) => (asc ? r.seq > cursor : r.seq < cursor));
								hit.sort((a, b) => (asc ? a.seq - b.seq : b.seq - a.seq));
								const page = hit.slice(0, limit);
								return { results: page.map((r) => ({ seq: r.seq, type: "terminal", content: r.content, created_at: "2026-08-12 12:00:00", audio_key: null })) };
							},
							async run() { return { meta: { changes: 0 } }; },
							async first() { return null; },
						};
					},
				};
			},
		};
		return { env: { DB } as unknown as Env, issued };
	}

	const three = [
		{ seq: 10, content: "a" },
		{ seq: 20, content: "b" },
		{ seq: 30, content: "c" },
	];

	it("asks only for rows NEWER than the cursor — the whole point of the ticket", async () => {
		// The measured cost this replaces: 41,767 bytes and 0.156 s, paid on every page load, for
		// append-only rows the client was already holding.
		const { env, issued } = pagedEnv(three);
		const page = await loadTerminalSnapshots(env, { sessionId: "s1", after: 20 });
		expect(issued[0].sql).toContain("seq > ?2");
		expect(issued[0].args[1]).toBe(20);
		expect(page.tail).toBe(true);
		expect(page.entries.map((e) => e.seq)).toEqual([30]);
		expect(page.newestSeq).toBe(30);
	});

	it("answers an untouched session with an empty delta, and hands the cursor straight back", async () => {
		// Nothing appended. `newestSeq: null` here would make the client re-ask from the beginning
		// on the load after this one — the cache would then work exactly once.
		const { env } = pagedEnv(three);
		const page = await loadTerminalSnapshots(env, { sessionId: "s1", after: 30 });
		expect(page.entries).toEqual([]);
		expect(page.tail).toBe(true);
		expect(page.newestSeq).toBe(30);
	});

	it("leaves `hasMore`/`oldestSeq` undefined on a delta, so a client cannot lose its scrollback cursor", async () => {
		const { env } = pagedEnv(three);
		const page = await loadTerminalSnapshots(env, { sessionId: "s1", after: 20 });
		expect(page.hasMore).toBeUndefined();
		expect(page.oldestSeq).toBeUndefined();
	});

	it("returns the whole newest PAGE when more was appended than one page holds", async () => {
		// The gap. Stitching a delta that does not join the cached text would weld two moments
		// together with the middle missing — so the reply becomes a replacement, in the same trip.
		const many = Array.from({ length: 9 }, (_, i) => ({ seq: 100 + i * 10, content: `s${i}` }));
		const { env, issued } = pagedEnv([...three, ...many]);
		const page = await loadTerminalSnapshots(env, { sessionId: "s1", after: 30, limit: 5 });
		expect(page.tail).toBe(false);
		expect(issued).toHaveLength(2); // the tail probe, then the newest page
		expect(issued[1].sql).toContain("seq < ?2");
		expect(page.entries.map((e) => e.seq)).toEqual([140, 150, 160, 170, 180]);
		expect(page.hasMore).toBe(true);
		expect(page.oldestSeq).toBe(140);
	});

	it("reports `newestSeq` on the ordinary page too — a first load has to seed the cursor", async () => {
		const { env } = pagedEnv(three);
		const page = await loadTerminalSnapshots(env, { sessionId: "s1" });
		expect(page.tail).toBe(false);
		expect(page.entries.map((e) => e.seq)).toEqual([10, 20, 30]);
		expect(page.newestSeq).toBe(30);
		expect(page.oldestSeq).toBe(10);
	});

	it("ignores a junk or zero cursor rather than answering a delta nobody asked for", async () => {
		const { env } = pagedEnv(three);
		for (const after of [0, -5, Number.NaN]) {
			const page = await loadTerminalSnapshots(env, { sessionId: "s1", after });
			expect(page.tail).toBe(false);
			expect(page.entries).toHaveLength(3);
		}
	});
});

// ── appendEngineUsageTimeline + loadTimelineFeed usage parsing (#674) ─────────────

const SESSION_U = "csess_usage";

describe("appendEngineUsageTimeline", () => {
	it("writes a `usage` type row with compact JSON turns", async () => {
		const db = realSchemaD1();
		seedTenant(db, { userId: "u1", instanceIds: ["i1"] });
		db.exec("INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'demo')");
		db.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, tmux_session) VALUES ('${SESSION_U}', 'i1', 'r1', 'u1', 'active', 'claude:${SESSION_U}')`);
		const env = { DB: db.DB } as unknown as Env;

		await appendEngineUsageTimeline(env, { sessionId: SESSION_U, instanceId: "i1", userId: "u1" }, [
			{ id: "turn-1", model: "claude-sonnet-4-6", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 50, costUsd: 0.015 },
		]);

		// Use the underlying sqlite connection for direct row reads (db.DB is the FakeD1 async shim).
		const rows = db.sqlite.prepare("SELECT type, content FROM coding_timeline WHERE session_id = ?").all(SESSION_U) as Array<{ type: string; content: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].type).toBe("usage");
		const parsed = JSON.parse(rows[0].content) as { turns: unknown[] };
		expect(parsed.turns).toHaveLength(1);
		expect((parsed.turns[0] as Record<string, unknown>).model).toBe("claude-sonnet-4-6");
		expect((parsed.turns[0] as Record<string, unknown>).in).toBe(1000);
		expect((parsed.turns[0] as Record<string, unknown>).out).toBe(500);
		expect((parsed.turns[0] as Record<string, unknown>).cacheRead).toBe(200);
		expect((parsed.turns[0] as Record<string, unknown>).cacheWrite).toBe(50);
		expect((parsed.turns[0] as Record<string, unknown>).costUsd).toBeCloseTo(0.015);
	});

	it("no-ops when records is empty — no row written", async () => {
		const db = realSchemaD1();
		seedTenant(db, { userId: "u1", instanceIds: ["i1"] });
		db.exec("INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'demo')");
		db.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, tmux_session) VALUES ('${SESSION_U}2', 'i1', 'r1', 'u1', 'active', 'claude:${SESSION_U}2')`);
		const env = { DB: db.DB } as unknown as Env;

		await appendEngineUsageTimeline(env, { sessionId: `${SESSION_U}2`, instanceId: "i1", userId: "u1" }, []);
		const rows = db.sqlite.prepare("SELECT seq FROM coding_timeline WHERE session_id = ?").all(`${SESSION_U}2`) as unknown[];
		expect(rows).toHaveLength(0);
	});
});

describe("loadTimelineFeed — usage rows carry structured EngineUsageTurn[] (#674)", () => {
	let db: RealSchemaD1;
	let env: Env;
	const SID = "csess_usage_feed";

	beforeEach(() => {
		db = realSchemaD1();
		seedTenant(db, { userId: "u1", instanceIds: ["i1"] });
		db.exec("INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'demo')");
		db.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, tmux_session) VALUES ('${SID}', 'i1', 'r1', 'u1', 'active', 'claude:${SID}')`);
		env = { DB: db.DB } as unknown as Env;
	});

	const add = (type: "brain" | "command" | "outcome" | "usage", content: string) =>
		appendTimeline(env, { sessionId: SID, instanceId: "i1", userId: "u1", type, content });

	it("a `usage` event in the feed carries `usage` array with the turns", async () => {
		await add("brain", "objective");
		await add("command", "implement it");
		await appendEngineUsageTimeline(env, { sessionId: SID, instanceId: "i1", userId: "u1" }, [
			{ id: "t1", model: "claude-sonnet-4-6", inputTokens: 800, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
		]);
		await add("outcome", "done");

		const feed = await loadTimelineFeed(env, { sessionId: SID });
		const usageEvents = feed.events.filter((e) => e.type === "usage");
		expect(usageEvents).toHaveLength(1);
		expect(usageEvents[0].usage).toBeDefined();
		expect(usageEvents[0].usage).toHaveLength(1);
		const turn = usageEvents[0].usage![0];
		expect(turn.model).toBe("claude-sonnet-4-6");
		expect(turn.in).toBe(800);
		expect(turn.out).toBe(300);
		expect(turn.cacheRead).toBe(0);
		expect(turn.cacheWrite).toBe(0);
		expect(turn.costUsd).toBeCloseTo(0.01);
	});

	it("a `usage` event with multiple turns carries all of them", async () => {
		await appendEngineUsageTimeline(env, { sessionId: SID, instanceId: "i1", userId: "u1" }, [
			{ id: "t1", model: "claude-sonnet-4-6", inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.005 },
			{ id: "t2", model: "claude-sonnet-4-6", inputTokens: 600, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 0, costUsd: 0.008 },
		]);

		const feed = await loadTimelineFeed(env, { sessionId: SID });
		const usageEvents = feed.events.filter((e) => e.type === "usage");
		expect(usageEvents[0].usage).toHaveLength(2);
		expect(usageEvents[0].usage![1].cacheRead).toBe(50);
	});

	it("non-usage events do not carry a `usage` field", async () => {
		await add("brain", "objective");
		await add("command", "implement it");
		await add("outcome", "done");
		await appendEngineUsageTimeline(env, { sessionId: SID, instanceId: "i1", userId: "u1" }, [
			{ id: "t1", model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 },
		]);

		const feed = await loadTimelineFeed(env, { sessionId: SID });
		for (const ev of feed.events.filter((e) => e.type !== "usage")) {
			expect(ev.usage).toBeUndefined();
		}
	});

	it("a `usage` row with malformed JSON silently omits the `usage` field rather than throwing", async () => {
		// Manually insert a broken usage row
		db.exec(`INSERT INTO coding_timeline (session_id, instance_id, user_id, type, content) VALUES ('${SID}', 'i1', 'u1', 'usage', 'NOT JSON AT ALL')`);

		const feed = await loadTimelineFeed(env, { sessionId: SID });
		const usageEvents = feed.events.filter((e) => e.type === "usage");
		expect(usageEvents).toHaveLength(1);
		// Malformed JSON → `usage` field is absent, not an error
		expect(usageEvents[0].usage).toBeUndefined();
	});

	it("the `content` field of a `usage` event is the raw JSON string (accessible if needed)", async () => {
		await appendEngineUsageTimeline(env, { sessionId: SID, instanceId: "i1", userId: "u1" }, [
			{ id: "t1", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
		]);
		const feed = await loadTimelineFeed(env, { sessionId: SID });
		const usageEvent = feed.events.find((e) => e.type === "usage");
		expect(usageEvent?.content).toBeTruthy();
		expect(() => JSON.parse(usageEvent!.content)).not.toThrow();
	});
});
