/**
 * `actsInWindow` against the real schema: one run's acts are ITS SESSION's acts (#809).
 *
 * `instance-work.test.ts` pins the statement's shape with a stub, which answers whatever rows it is
 * handed — so it could never see that the window covered the whole INSTANCE. A Coder instance holds
 * several repos, each with its own session, and their runs overlap; a window over the instance handed
 * each run the other repo's pushes, on its card, its successor's resume note and `check_delegation`.
 *
 * Driven on an in-memory SQLite built from every migration, so `json_valid` / `json_extract` over
 * `agent_events.context` really execute. Mutation-checked: dropping the session predicate fails the
 * four overlap/window tests here (and the cross-repo case in `coding-resume-note-repo.test.ts`);
 * dropping `json_valid` fails the malformed-context test, because `json_extract` raises on bad JSON.
 * A null session falling through to the query is NOT visible here — `= NULL` matches no row, so the
 * answer is `[]` either way — and is caught by the no-query assertion in `instance-work.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { actsInWindow } from "./instance-work.js";
import type { Env } from "../types.js";

const MIN = 60_000;
const T0 = 1_800_000_000_000;

let d1: RealSchemaD1;
let env: Env;

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function repo(id: string) {
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES (${q(id)}, 'inst-1', 'u1', ${q(id)})`);
}

function session(id: string, repoId: string) {
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status) VALUES (${q(id)}, 'inst-1', ${q(repoId)}, 'u1', 'active')`);
}

/** An act as `recordEngineActs` writes it — `context.sessionId` included, as on every real row. */
function act(id: string, ts: number, sessionId: string, message: string, context?: string) {
	const ctx = context ?? JSON.stringify({ act: "push.trunk", ok: true, irreversible: true, command: "git push origin main", sessionId });
	d1.exec(
		`INSERT INTO agent_events (id, ts, user_id, instance_id, trace_id, source, event, message, context)
		  VALUES (${q(id)}, ${ts}, 'u1', 'inst-1', ${q(sessionId)}, 'coding', 'act.consequential', ${q(message)}, ${q(ctx)})`,
	);
}

const summaries = (acts: Awaited<ReturnType<typeof actsInWindow>>) => acts.map((a) => a.summary);

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	env = { DB: d1.DB } as unknown as Env;
	repo("repo-r");
	repo("repo-o");
	session("s-r", "repo-r");
	session("s-o", "repo-o");
	// Run R drives s-r over [T0, T0+60m]; run O drives s-o over [T0+20m, T0+80m]. They overlap for 40
	// minutes, and each pushes inside the other's window.
	act("r-1", T0 + 10 * MIN, "s-r", "pushed R #1");
	act("o-1", T0 + 30 * MIN, "s-o", "pushed O #1");
	act("r-2", T0 + 40 * MIN, "s-r", "pushed R #2");
	act("o-2", T0 + 50 * MIN, "s-o", "pushed O #2");
});

afterEach(() => d1.close());

describe("two overlapping runs on two repos of one instance (#809)", () => {
	it("run R reads only s-r's acts, though O pushed twice inside its window", async () => {
		const acts = await actsInWindow(env, "u1", "inst-1", "s-r", T0, T0 + 60 * MIN);
		expect(summaries(acts), "repo O's pushes reached run R — the window is not scoped to the session").toEqual(["pushed R #1", "pushed R #2"]);
	});

	it("run O reads only s-o's acts, though R pushed inside its window", async () => {
		const acts = await actsInWindow(env, "u1", "inst-1", "s-o", T0 + 20 * MIN, T0 + 80 * MIN);
		expect(summaries(acts)).toEqual(["pushed O #1", "pushed O #2"]);
	});

	it("still bounds by TIME within the session — the window is half the key, not replaced by it", async () => {
		act("r-late", T0 + 90 * MIN, "s-r", "pushed R after the run ended");
		const acts = await actsInWindow(env, "u1", "inst-1", "s-r", T0, T0 + 60 * MIN);
		expect(summaries(acts)).toEqual(["pushed R #1", "pushed R #2"]);
	});

	it("a run with no session — the chat driver's — reads none of the instance's acts", async () => {
		expect(await actsInWindow(env, "u1", "inst-1", null, T0, T0 + 80 * MIN)).toEqual([]);
	});

	it("a row whose context is not JSON is skipped, not a failed read", async () => {
		// `json_extract` over malformed JSON raises in SQLite; `json_valid` first keeps one bad row from
		// costing the whole card its act line (callers `.catch(() => [])`, which would hide every act).
		act("bad", T0 + 15 * MIN, "s-r", "unparseable", "{not json");
		const acts = await actsInWindow(env, "u1", "inst-1", "s-r", T0, T0 + 60 * MIN);
		expect(summaries(acts)).toEqual(["pushed R #1", "pushed R #2"]);
	});
});
