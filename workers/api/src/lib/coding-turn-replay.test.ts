/**
 * The cloud half of per-turn replay (#693 slice 2) on the REAL migrated schema: which engines get the
 * platform's record with a turn, what is in it, and — the privacy half — what can never be.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SEED_PREAMBLE } from "./coding-seed-brief.js";
import { RESUME_WINDOW_MS } from "./coding-session-continuity.js";
import { wantsTurnReplay, withTurnReplay } from "./coding-turn-replay.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "./d1-sqlite.js";
import { stripCommentsAndLiterals } from "./source-guard.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
afterEach(() => {
	d1?.close();
	d1 = undefined as unknown as RealSchemaD1;
});

const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

function setup() {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i2"] });
	d1.exec(`
		INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'apps/chess'), ('r-other', 'i1', 'u1', 'apps/other'), ('r2', 'i2', 'u2', 'apps/chess');
		INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type) VALUES
			('s1', 'i1', 'r1', 'u1', 'grok'), ('s-other', 'i1', 'r-other', 'u1', 'grok'), ('s2', 'i2', 'r2', 'u2', 'grok');
	`);
	return { env: { DB: d1.DB } as unknown as Env };
}

function row(session: string, instance: string, user: string, type: string, content: string, at = Date.now() - 60_000) {
	d1.sqlite.prepare("INSERT INTO coding_timeline (session_id, instance_id, user_id, type, content, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(session, instance, user, type, content, sqlTime(at));
}

const TARGET = { instanceId: "i1", userId: "u1", repoId: "r1", repoName: "apps/chess" };
const msg = (text: string) => ({ kind: "message" as const, text });

describe("which engines are replayed to (#693 slice 2)", () => {
	it("Claude holds its own conversation — no replay is composed, and the database is not even read", async () => {
		const env = { DB: { prepare: () => { throw new Error("must not be read"); } } } as unknown as Env;
		expect(await withTurnReplay(env, { ...TARGET, clientType: "claude" }, msg("go"))).toEqual(msg("go"));
		expect(wantsTurnReplay("claude")).toBe(false);
		expect(wantsTurnReplay(null)).toBe(false); // an unrecorded engine is the default, Claude
	});

	it("every other engine gets the platform's record with the turn — the runner decides whether to spend it", async () => {
		const { env } = setup();
		row("s1", "i1", "u1", "command", "rename the config loader");
		row("s1", "i1", "u1", "terminal", "renamed loadConfig → readConfig in 4 files");
		for (const clientType of ["grok", "codex", "gemini", "ollama"]) {
			const sent = await withTurnReplay(env, { ...TARGET, clientType }, msg("now update the docs"));
			expect(sent.text).toBe("now update the docs");
			expect(sent.replay?.startsWith(SEED_PREAMBLE)).toBe(true);
			expect(sent.replay).toContain("rename the config loader");
			expect(sent.replay).toContain("renamed loadConfig → readConfig");
			expect(sent.replay).toContain("Repository: apps/chess");
		}
	});

	it("the turn being sent is not echoed back as the newest line of its own replay", async () => {
		const { env } = setup();
		row("s1", "i1", "u1", "command", "earlier instruction");
		row("s1", "i1", "u1", "command", "now update the docs"); // logged before it is sent
		const sent = await withTurnReplay(env, { ...TARGET, clientType: "grok" }, msg("[Project rules — x]\n\nnow update the docs"));
		expect(sent.replay).toContain("earlier instruction");
		expect(sent.replay).not.toContain("now update the docs");
	});

	it("an interrupt is not a turn, and a repo with no record sends the turn exactly as before", async () => {
		const { env } = setup();
		expect(await withTurnReplay(env, { ...TARGET, clientType: "grok" }, { kind: "interrupt" })).toEqual({ kind: "interrupt" });
		const sent = await withTurnReplay(env, { ...TARGET, clientType: "grok" }, msg("go"));
		expect(sent).toEqual(msg("go"));
		expect("replay" in sent).toBe(false);
	});

	it("a record that cannot be read is an absent replay, never a failed turn", async () => {
		const env = { DB: { prepare: () => { throw new Error("D1 down"); } } } as unknown as Env;
		expect(await withTurnReplay(env, { ...TARGET, clientType: "grok" }, msg("go"))).toEqual(msg("go"));
	});
});

describe("privacy — the replay is this owner's, this instance's, this repo's record, and only recent (#693 slice 2)", () => {
	it("another owner's rows, another repo's rows and another instance's same-named repo never reach the engine", async () => {
		const { env } = setup();
		row("s1", "i1", "u1", "command", "MINE");
		row("s-other", "i1", "u1", "command", "OTHER-REPO-SAME-OWNER");
		row("s2", "i2", "u2", "command", "ANOTHER-OWNERS-SECRET");
		const sent = await withTurnReplay(env, { ...TARGET, clientType: "grok" }, msg("go"));
		expect(sent.replay).toContain("MINE");
		expect(sent.replay).not.toContain("OTHER-REPO-SAME-OWNER");
		expect(sent.replay).not.toContain("ANOTHER-OWNERS-SECRET");
		// And the other owner's replay is theirs alone.
		const theirs = await withTurnReplay(env, { instanceId: "i2", userId: "u2", repoId: "r2", clientType: "grok" }, msg("go"));
		expect(theirs.replay).toContain("ANOTHER-OWNERS-SECRET");
		expect(theirs.replay).not.toContain("MINE");
	});

	it("naming another owner's instance with your own user id yields nothing", async () => {
		const { env } = setup();
		row("s2", "i2", "u2", "command", "ANOTHER-OWNERS-SECRET");
		expect(await withTurnReplay(env, { instanceId: "i2", userId: "u1", repoId: "r2", clientType: "grok" }, msg("go"))).toEqual(msg("go"));
	});

	it("nothing older than the resume window is replayed — one answer to 'too old' (#737)", async () => {
		const { env } = setup();
		row("s1", "i1", "u1", "command", "ANCIENT", Date.now() - RESUME_WINDOW_MS - 3_600_000);
		row("s1", "i1", "u1", "command", "RECENT");
		const sent = await withTurnReplay(env, { ...TARGET, clientType: "grok" }, msg("go"));
		expect(sent.replay).toContain("RECENT");
		expect(sent.replay).not.toContain("ANCIENT");
	});
});

describe("every door that sends a turn composes it through withTurnReplay (#693 slice 2)", () => {
	// Source-level for the same reason `turn-author-callsites.test.ts` is: three of the four senders are
	// only reachable with a live relay. A new `/coding/act` sender that forgets the replay leaves one
	// engine forgetting between turns on one path, which is exactly the qualifier this issue removes.
	const SRC = new URL("../", import.meta.url).pathname;
	for (const rel of ["routes/coding-drive.ts", "routes/coding-brains.ts", "lib/storage-tools.ts", "workflows/coding-session.ts"]) {
		it(rel, () => {
			const code = stripCommentsAndLiterals(readFileSync(join(SRC, rel), "utf-8"));
			expect(code).toMatch(/withTurnReplay\(/);
		});
	}
});
