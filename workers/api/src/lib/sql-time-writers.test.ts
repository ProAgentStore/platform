/**
 * The executable half of the `sql-time.ts` invariant: every write to a TEXT timestamp column that
 * is COMPARED against `datetime('now')` stores it in that format (#634, #657).
 *
 * A helper that exists is not the guard. `waiting_until` had one writer and three call sites, none
 * of which passed the value (#591), and four private copies of this very conversion had been
 * sitting in the tree while the columns that needed it had none. So this file asserts two things
 * the branded type cannot: that the rows really come out in one format when the production writers
 * run, and that the CENSUS of writers is what it was when the fix landed — a new one has to be
 * driven through here rather than discovered by a supervisor reading the wrong eight cards.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { INPUT_TTL_MS } from "./mcp-elicitation.js";
import { openMcpInputRequest, listMcpInputRequests, purgeExpiredMcpInputRequests } from "./mcp-input-requests.js";
import { purgeExpiredFlows, saveFlow } from "./mcp-oauth-store.js";
import { sqlTime } from "./sql-time.js";
import { closeWorkCards, setWorkCardProgress, upsertWorkCard } from "./work-card.js";
import { mirrorRuntimeTask, mirroredRuntimeTasks, mirrorRuntimeEvent } from "../routes/instances-runtime.js";
import type { Env } from "../types.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEK = "1".repeat(64);

/** Exactly `datetime('now')`'s shape, asserted in SQL so the engine decides, not a JS regex. */
const COLUMN_GLOB = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]";

function fixture(): { d1: RealSchemaD1; env: Env } {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	return { d1, env: { DB: d1.DB, KEY_ENCRYPTION_KEY: KEK } as unknown as Env };
}

/** The date SQLite itself thinks it is — the ISO stamps below are built on it so the comparison
 *  under test is same-date, which is the only case where the two formats are confusable. */
function sqliteToday(d1: RealSchemaD1): string {
	return (d1.sqlite.prepare("SELECT datetime('now') AS t").get() as { t: string }).t.slice(0, 10);
}

function offenders(d1: RealSchemaD1, table: string, column: string): unknown[] {
	return d1.sqlite.prepare(`SELECT id, ${column} AS v FROM ${table} WHERE ${column} NOT GLOB ?1`).all(COLUMN_GLOB);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("#634 — instance_runtime_tasks.updated_at is one ordering, not two", () => {
	it("ranks the escalation raised now above a runner task stamped at 00:00:01 today", async () => {
		// The reported defect, executed. A supervisor reads `recentWorkForInstances`, which returns
		// EIGHT cards per subordinate; before the fix every runner-mirrored task outranked every
		// `datetime('now')` card on the same date, so the card saying "a supervised agent needs a
		// decision" was the one that fell off the end.
		const { d1, env } = fixture();
		const today = sqliteToday(d1);
		await mirrorRuntimeTask(env, "i1", "u1", {
			id: "runner-task",
			type: "browser.task",
			status: "completed",
			updatedAt: `${today}T00:00:01.000Z`,
		});
		await upsertWorkCard(env, {
			instanceId: "i1",
			userId: "u1",
			id: "escalation",
			task: { id: "escalation", type: "escalation", status: "needs_human" },
		});
		// Pin the escalation's updated_at to noon on SQLite's own date rather than leaving it at the
		// datetime('now') the INSERT used. A clock rollover between the sqliteToday() call above and
		// the INSERT would put the two rows on different dates, making the byte comparison below
		// measure the date prefix instead of the time-of-day. Pinning makes both dates identical by
		// construction — the precondition below is now redundant rather than a loud-fail guard.
		// This mirrors 8eeaf631 (line 155), which applied the same pin to the single-flight cutoff arm.
		d1.sqlite
			.prepare("UPDATE instance_runtime_tasks SET updated_at = ?1 WHERE id = 'escalation'")
			.run(sqlTime(Date.parse(`${today}T12:00:00.000Z`)));

		const stored = d1.sqlite.prepare("SELECT id, updated_at FROM instance_runtime_tasks ORDER BY id").all() as {
			id: string;
			updated_at: string;
		}[];
		// Both rows now carry today's date by construction: the runner task from the ISO input above,
		// the escalation from the pin just applied. The assertion documents the invariant the test
		// depends on and is guaranteed to hold regardless of when the test runs.
		expect(stored.map((r) => r.updated_at.slice(0, 10))).toEqual([today, today]);

		const newest = await mirroredRuntimeTasks(env, "i1", "u1", 1);
		expect((newest[0] as { id: string }).id).toBe("escalation");
		d1.close();
	});

	it("stores every mirrored task in the column's format, whatever the runner sent", async () => {
		// `packages/browser-runner` assigns `task.updatedAt = new Date().toISOString()` in eleven
		// places, and that value arrives here verbatim. The conversion belongs at this boundary:
		// the runner is a separately published npm package, so a fix that needed it to ship first
		// would leave every already-installed CLI writing the broken format.
		const { d1, env } = fixture();
		const today = sqliteToday(d1);
		await mirrorRuntimeTask(env, "i1", "u1", { id: "t1", type: "browser.task", status: "queued", createdAt: `${today}T01:02:03.456Z` });
		await mirrorRuntimeTask(env, "i1", "u1", { id: "t2", type: "browser.task", status: "queued", updatedAt: "not a timestamp" });
		await mirrorRuntimeTask(env, "i1", "u1", { id: "t3", type: "browser.task", status: "queued" });
		await mirrorRuntimeEvent(env, "i1", "u1", { id: "e1", taskId: "t1", type: "task.started", createdAt: `${today}T01:02:03.456Z` });

		expect(offenders(d1, "instance_runtime_tasks", "updated_at")).toEqual([]);
		expect(offenders(d1, "instance_runtime_tasks", "created_at")).toEqual([]);
		expect(offenders(d1, "instance_runtime_task_events", "created_at")).toEqual([]);

		// The PAYLOAD keeps the runner's ISO: it is what the console renders, and a browser reads
		// `new Date("2026-08-15 01:02:03")` as local time. Column format and payload format are
		// different decisions and this pins both.
		const payload = JSON.parse((d1.sqlite.prepare("SELECT payload FROM instance_runtime_tasks WHERE id = 't1'").get() as { payload: string }).payload);
		expect(payload.createdAt).toBe(`${today}T01:02:03.456Z`);
		d1.close();
	});

	it("keeps the format across the update writers too", async () => {
		const { d1, env } = fixture();
		await upsertWorkCard(env, { instanceId: "i1", userId: "u1", id: "c1", task: { id: "c1", type: "coding", status: "running" } });
		await setWorkCardProgress(env, "i1", "u1", "c1", "still going");
		await closeWorkCards(env, "i1", "u1", ["c1"], "completed");
		expect(offenders(d1, "instance_runtime_tasks", "updated_at")).toEqual([]);
		d1.close();
	});

	it("the single-flight claim's cutoff moved with the column, so a live card still blocks", async () => {
		// The coupling that would have been missed. `startJobApply` compares `updated_at > ?5`
		// against a bound cutoff; converting the mirror writer WITHOUT converting the cutoff would
		// have made every live `datetime('now')` card read as stale, and two concurrent
		// applications is the failure single-flight exists to prevent.
		const { d1, env } = fixture();
		const claimSql = applyClaimSql();
		await upsertWorkCard(env, {
			instanceId: "i1",
			userId: "u1",
			id: "live-apply",
			task: { id: "live-apply", type: "job.apply_agent", status: "running" },
		});
		// `upsertWorkCard` swallows its own errors, so the row it was asked to write is asserted
		// rather than assumed — without it the claims below would both "succeed" against an empty
		// table and prove nothing. Its FORMAT is asserted here as well, because the production
		// writer's output is what the two cutoffs below are compared against.
		const live = d1.sqlite.prepare("SELECT updated_at AS v FROM instance_runtime_tasks WHERE id = 'live-apply'").get() as
			| { v: string }
			| undefined;
		expect(live?.v, "the live card `upsertWorkCard` wrote is what the cutoffs are compared against").toMatch(
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
		);

		// The card is then pinned to a chosen instant, and both cutoffs are derived from it.
		// `sql-time.ts` states the invariant as holding "for two stamps on the same date": `' '`
		// (0x20) sorts below `'T'` (0x54) at index 10, so an ISO cutoff loses the comparison — but
		// only while the DATES are equal. Read against a `datetime('now')` card, a cutoff built
		// from `Date.now() - 4h` is on the previous date for the four hours after midnight UTC, and
		// there the ISO cutoff correctly WINS and the claim is refused: a true statement about byte
		// ordering, and a false one about the bug. That is not a property of the code under test,
		// it is the time of day — and it red-lined `main` and blocked the API deploy nightly
		// between 00:00 and 04:00 UTC (#677). Deriving both stamps from one pinned instant makes
		// the arm measure the CUTOFF's format, which is what it owns; the writer's own format is
		// pinned by the arms above and by the assertion just made.
		const cardAt = Date.parse(`${sqliteToday(d1)}T12:00:00.000Z`);
		d1.sqlite.prepare("UPDATE instance_runtime_tasks SET updated_at = ?1 WHERE id = 'live-apply'").run(sqlTime(cardAt));
		const staleAt = cardAt - 4 * 60 * 60 * 1000; // same UTC date as the card, by construction
		const run = (cutoff: string) =>
			d1.sqlite.prepare(claimSql.replace(/\?(\d)/g, "?$1")).run("claim-1", "i1", "u1", sqlTime(), cutoff);

		// An ISO cutoff loses the byte comparison against the live card and grants the claim.
		expect(run(new Date(staleAt).toISOString()).changes).toBe(1);
		d1.sqlite.exec("DELETE FROM instance_runtime_tasks WHERE id = 'claim-1'");
		// The cutoff the code now binds sees it and refuses.
		expect(run(sqlTime(staleAt)).changes).toBe(0);
		d1.close();
	});
});

describe("#657 — an expiring secret's TTL fires on the clock, not on the date", () => {
	it("purges an input request 30 minutes after it was opened", async () => {
		// Before the fix `expires_at <= datetime('now')` was false for the whole UTC day the row
		// expired on, so the encrypted copy of somebody's tool arguments sat in D1 for up to ~24 h
		// past the retention the module states in its own docstring.
		const { d1, env } = fixture();
		vi.useFakeTimers();
		vi.setSystemTime(new Date(Date.now() - INPUT_TTL_MS - 60_000));
		const id = await openMcpInputRequest(env, {
			instanceId: "i1",
			userId: "u1",
			endpoint: "https://mcp.example/mcp",
			tool: "create_thing",
			round: 1,
			ask: { message: "which account?", fields: [{ name: "account", type: "string", required: true, sensitive: false }] },
			call: { args: { a: 1 }, useAuth: true },
		});
		vi.useRealTimers();

		const before = d1.sqlite.prepare("SELECT status, call_ciphertext IS NOT NULL AS held FROM mcp_input_requests WHERE id = ?1").get(id);
		expect(before).toMatchObject({ status: "pending", held: 1 });

		await purgeExpiredMcpInputRequests(env);
		const after = d1.sqlite.prepare("SELECT status, call_ciphertext IS NOT NULL AS held FROM mcp_input_requests WHERE id = ?1").get(id);
		expect(after).toMatchObject({ status: "expired", held: 0 });
		d1.close();
	});

	it("still publishes expires_at as the ISO-8601 the field has always carried", async () => {
		// The column's format is an internal decision about how SQLite sorts it. The response body
		// is a contract, and a console parsing `2026-08-15 22:38:19` in a browser would read it as
		// local time.
		const { d1, env } = fixture();
		const id = await openMcpInputRequest(env, {
			instanceId: "i1",
			userId: "u1",
			endpoint: "https://mcp.example/mcp",
			tool: "create_thing",
			round: 1,
			ask: { message: "which account?", fields: [{ name: "account", type: "string", required: true, sensitive: false }] },
			call: { args: {}, useAuth: false },
		});
		const [view] = await listMcpInputRequests(env, "i1", "u1");
		expect(view.id).toBe(id);
		expect(view.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(view.status).toBe("pending");
		expect(offenders(d1, "mcp_input_requests", "expires_at")).toEqual([]);
		d1.close();
	});

	it("purges an abandoned OAuth flow once its ten minutes are up", async () => {
		const { d1, env } = fixture();
		const flow = {
			id: "flow-1",
			userId: "u1",
			endpoint: "https://mcp.example/mcp",
			issuer: "https://as.example",
			tokenEndpoint: "https://as.example/token",
			clientId: "client-1",
			redirectUri: "https://api.example/callback",
			scope: null,
			verifier: "a-pkce-verifier",
		};
		await saveFlow(env, flow, -60);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM mcp_oauth_flows").get()).toMatchObject({ n: 1 });
		expect(offenders(d1, "mcp_oauth_flows", "expires_at")).toEqual([]);

		await purgeExpiredFlows(env);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM mcp_oauth_flows").get()).toMatchObject({ n: 0 });
		d1.close();
	});
});

describe("migration 0128 converts the rows already in the table", () => {
	it("leaves nothing in the old format, and does not touch rows already converted", () => {
		// The code fix alone converges within a day as the ISO rows age out. That day is exactly
		// the window in which the mis-ordering is user-visible, which is why the backfill exists.
		const d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
		d1.sqlite.exec(
			`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
			 VALUES ('legacy', 'i1', 'u1', 'browser.task', 'completed', '{}', '2026-08-15T00:00:01.000Z', '2026-08-15T00:00:01.000Z'),
			        ('modern', 'i1', 'u1', 'escalation', 'needs_human', '{}', '2026-08-15 22:38:19', '2026-08-15 22:38:19')`,
		);
		d1.sqlite.exec(readFileSync(join(SRC, "..", "migrations", "0128_normalize_timestamp_text.sql"), "utf8"));

		expect(offenders(d1, "instance_runtime_tasks", "updated_at")).toEqual([]);
		const rows = d1.sqlite.prepare("SELECT id FROM instance_runtime_tasks ORDER BY updated_at DESC").all();
		expect(rows).toEqual([{ id: "modern" }, { id: "legacy" }]);
		d1.close();
	});
});

describe("the writer census", () => {
	// A source scan, in the shape `runtime-response.test.ts` already uses for `last_seen_at`. The
	// point is the DENOMINATOR: not "the helper exists" but "every write site goes through it".
	// A thirteenth statement fails this test and has to be driven through the cases above.
	const STATEMENT_RE = /(?:INSERT INTO|UPDATE)\s+instance_runtime_tasks[\s\S]*?`/g;

	function writerFiles(): { file: string; statement: string }[] {
		const out: { file: string; statement: string }[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				const p = join(dir, entry);
				if (statSync(p).isDirectory()) {
					walk(p);
					continue;
				}
				if (!p.endsWith(".ts") || p.endsWith(".test.ts") || p.endsWith("d1-sqlite.ts")) continue;
				const src = readFileSync(p, "utf8");
				for (const m of src.match(STATEMENT_RE) ?? []) {
					if (/updated_at|created_at/.test(m)) out.push({ file: p.slice(SRC.length + 1), statement: m });
				}
			}
		};
		walk(SRC);
		return out;
	}

	it("is twelve statements across eight files, and every one of them is accounted for", () => {
		const found = writerFiles();
		expect(
			[...new Set(found.map((f) => f.file))].sort(),
			"a new writer of instance_runtime_tasks.updated_at — add it to the executable cases above, then update this list",
		).toEqual([
			"lib/loop-drivers.ts",
			"lib/work-card.ts",
			"routes/instances-apply.ts",
			"routes/instances-browse.ts",
			"routes/instances-runtime.ts",
			"routes/instances-tasks.ts",
			"workflows/agent-loop.ts",
			"workflows/job-apply.ts",
		]);
		expect(found).toHaveLength(12);
	});

	it("every writer that BINDS a timestamp names a producer from sql-time.ts", () => {
		// The two legitimate ways to produce the format: the SQL literal `datetime('now')`, or a
		// bound value from one of these three functions. A fourth — a literal `toISOString()`
		// reaching one of these columns — is the bug, and it is what this refuses.
		//
		// Named producers, NOT "the file imports sql-time.js somewhere": nearly every module in
		// this Worker reaches `sql-time.ts` transitively through `error-log.ts`, so a reachability
		// rule passes everything and guards nothing. It was written that way first and caught a
		// deliberately broken tree exactly zero times.
		//
		// `taskColumnTimestamp` is on the list because the mirror writer's conversion was extracted
		// to `lib/runtime-task-time.ts` — an extraction a guard should reward, not punish. Its own
		// provenance is asserted below, so it cannot become a hole.
		const PRODUCERS = /\b(?:sqlTime|toSqlTime|taskColumnTimestamp)\s*\(/;
		const bad = writerFiles()
			.filter(({ statement }) => /(?:created_at|updated_at)\s*=\s*\?/.test(statement) || /\?\d+,\s*\?\d+\s*\)?\s*$/m.test(statement.split("VALUES").pop() ?? "") || /SELECT[\s\S]*\?\d+,\s*\?\d+/.test(statement))
			.map(({ file }) => file)
			.filter((file) => !PRODUCERS.test(readFileSync(join(SRC, file), "utf8")));
		expect([...new Set(bad)], "these bind a timestamp into instance_runtime_tasks without a sql-time.ts producer").toEqual([]);
	});

	it("taskColumnTimestamp really is sql-time.ts, so the indirection is not a hole", () => {
		const src = readFileSync(join(SRC, "lib", "runtime-task-time.ts"), "utf8");
		expect(src).toMatch(/from "\.\/sql-time\.js"/);
		expect(src).toMatch(/export function taskColumnTimestamp[\s\S]*?return toSqlTime\(/);
	});
});

/** The apply single-flight claim, read out of the module that issues it. */
function applyClaimSql(): string {
	const src = readFileSync(join(SRC, "routes", "instances-apply.ts"), "utf8");
	const m = src.match(/`(INSERT INTO instance_runtime_tasks[\s\S]*?)`/);
	if (!m) throw new Error("the apply single-flight claim moved — this test has to move with it");
	return m[1];
}
