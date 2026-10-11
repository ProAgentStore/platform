/**
 * The retarget primitive (#1012), driven against the real migrated schema.
 *
 * Invariants protected: a retarget updates ONE row in place (children keep their repo_id, history
 * is kept and labelled), refuses any work that could be redirected, never moves a binding onto a
 * different repository, is idempotent for a retry whose response was lost, fails closed on a stale
 * or concurrent change, and leaves an unambiguous audit when it is interrupted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepo } from "./coding-store.js";
import { labelSessions, listRetargetAudits, retargetCloneUrl, retargetRepositoryBinding, type RetargetRequest } from "./coding-repo-retarget.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";

const NOW = 1_800_000_000_000;
let d1: RealSchemaD1;
let env: Env;

function seedRepo(opts: { githubId?: number | null; cloneUrl?: string } = {}) {
	const id = opts.githubId === undefined ? 100 : opts.githubId;
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, github_repository_id, provider, repo_slug, web_url, clone_url, branch, workdir, clone_status, default_client, instructions, policies)
		VALUES ('repo-1', 'i1', 'u1', 'platform', 'acme/platform', ${id ?? "NULL"}, 'github', 'acme/platform', 'https://github.com/acme/platform', '${opts.cloneUrl ?? "git@github.com:acme/platform.git"}', '', '/work/platform', 'ready', 'claude', 'keep me', '{"merge":"pr"}')`);
}

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB } as unknown as Env;
	seedRepo();
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status, tmux_session, started_at) VALUES ('s1', 'i1', 'repo-1', 'u1', 'codex', 'ended', 'pane', '2026-01-01 00:00:00')`);
	d1.exec(`INSERT INTO coding_timeline (session_id, instance_id, user_id, type, content, created_at) VALUES ('s1', 'i1', 'u1', 'outcome', 'historic receipt', '2026-01-01 00:00:00')`);
});

afterEach(() => d1.close());

const request = (overrides: Partial<RetargetRequest> = {}): RetargetRequest => ({
	instanceId: "i1",
	userId: "u1",
	repoId: "repo-1",
	expectedCurrent: { owner: "acme", name: "platform", githubId: 100, version: 1 },
	destination: { owner: "acme", name: "platform-archive", githubId: 100 },
	now: NOW,
	...overrides,
});

const one = <T>(sql: string) => d1.sqlite.prepare(sql).get() as T;
const binding = () => one<{ id: string; github_repo: string; github_repository_id: number | null; binding_version: number; instructions: string; policies: string; clone_url: string | null; web_url: string; repo_slug: string; workdir: string; clone_status: string }>("SELECT * FROM coding_repos WHERE id = 'repo-1'");
const audits = () => d1.sqlite.prepare("SELECT state FROM coding_repo_retarget_audits ORDER BY created_at, rowid").all() as Array<{ state: string }>;

describe("retargetRepositoryBinding (#1012)", () => {
	it("renames the same numeric repository in place and preserves metadata, sessions and timeline", async () => {
		const result = await retargetRepositoryBinding(env, request());
		expect(result.kind).toBe("applied");
		expect(binding()).toMatchObject({
			id: "repo-1",
			github_repo: "acme/platform-archive",
			github_repository_id: 100,
			binding_version: 2,
			repo_slug: "acme/platform-archive",
			web_url: "https://github.com/acme/platform-archive",
			// The clone URL keeps its protocol; only the path moves.
			clone_url: "git@github.com:acme/platform-archive.git",
			instructions: "keep me",
			policies: '{"merge":"pr"}',
			workdir: "/work/platform",
			clone_status: "ready",
		});
		expect(one<{ repo_id: string }>("SELECT repo_id FROM coding_sessions WHERE id = 's1'").repo_id).toBe("repo-1");
		expect(one<{ content: string }>("SELECT content FROM coding_timeline WHERE session_id = 's1'").content).toBe("historic receipt");
		expect(one("SELECT previous_owner, previous_name, previous_clone_url, destination_name, github_repository_id, expected_binding_version, resulting_binding_version, state FROM coding_repo_retarget_audits")).toEqual({
			previous_owner: "acme",
			previous_name: "platform",
			previous_clone_url: "git@github.com:acme/platform.git",
			destination_name: "platform-archive",
			github_repository_id: 100,
			expected_binding_version: 1,
			resulting_binding_version: 2,
			state: "applied",
		});
		if (result.kind === "applied") {
			expect(result.repo).toMatchObject({ githubRepo: "acme/platform-archive", githubRepositoryId: 100, bindingVersion: 2 });
			expect(result.rollback).toEqual({
				expectedCurrent: { owner: "acme", name: "platform-archive", githubId: 100, version: 2 },
				destination: { owner: "acme", name: "platform", githubId: 100 },
			});
		}
	});

	it("stamps the numeric id on a binding recorded before migration 0209", async () => {
		d1.exec("DELETE FROM coding_timeline; DELETE FROM coding_sessions; DELETE FROM coding_repos");
		seedRepo({ githubId: null });
		expect((await retargetRepositoryBinding(env, request())).kind).toBe("applied");
		expect(binding().github_repository_id).toBe(100);
		// …and with no id anywhere there is no identity to preserve.
		d1.exec("DELETE FROM coding_repo_retarget_audits; DELETE FROM coding_repos");
		seedRepo({ githubId: null });
		const noId = await retargetRepositoryBinding(env, request({ expectedCurrent: { owner: "acme", name: "platform", version: 1 } }));
		expect(noId.kind).toBe("stale");
	});

	it("previews the exact changes and blockers without writing anything", async () => {
		const preview = await retargetRepositoryBinding(env, request({ dryRun: true, routeBlockers: ["local_origin_mismatch"] }));
		expect(preview).toMatchObject({
			kind: "preview",
			blockers: ["local_origin_mismatch"],
			changes: {
				githubRepo: { from: "acme/platform", to: "acme/platform-archive" },
				githubRepositoryId: { from: 100, to: 100 },
				bindingVersion: { from: 1, to: 2 },
				cloneUrl: { from: "git@github.com:acme/platform.git", to: "git@github.com:acme/platform-archive.git" },
			},
		});
		expect(binding()).toMatchObject({ github_repo: "acme/platform", binding_version: 1 });
		expect(audits()).toEqual([]);
	});

	describe("a dry run is read-only on every branch (#1012 review)", () => {
		const PREPARED = `INSERT INTO coding_repo_retarget_audits (id, repo_id, instance_id, user_id, expected_binding_version, previous_owner, previous_name, destination_owner, destination_name, github_repository_id, resulting_binding_version, state, created_at)
			VALUES ('dangling', 'repo-1', 'i1', 'u1', 1, 'acme', 'platform', 'acme', 'platform-archive', 100, 2, 'prepared', 1)`;
		const writes = () => d1.issued.filter((st) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(st.sql));
		const snapshot = () => JSON.stringify([binding(), d1.sqlite.prepare("SELECT * FROM coding_repo_retarget_audits ORDER BY id").all()]);

		it.each<[string, Partial<RetargetRequest>]>([
			["ready preview", {}],
			["blocked preview", { routeBlockers: ["local_origin_mismatch"] }],
			["stale", { expectedCurrent: { owner: "acme", name: "platform", githubId: 100, version: 9 } }],
			["different repository", { destination: { owner: "acme", name: "platform", githubId: 200 } }],
		])("%s: zero database writes, a dangling prepared audit left as it is", async (_label, overrides) => {
			d1.exec(PREPARED);
			const before = snapshot();
			d1.issued.length = 0;
			await retargetRepositoryBinding(env, request({ ...overrides, dryRun: true }));
			expect(writes()).toEqual([]);
			expect(snapshot()).toBe(before);
		});

		it("idempotent (already applied): zero database writes", async () => {
			expect((await retargetRepositoryBinding(env, request())).kind).toBe("applied");
			d1.exec(PREPARED.replace("'dangling'", "'dangling-2'"));
			const before = snapshot();
			d1.issued.length = 0;
			expect((await retargetRepositoryBinding(env, request({ dryRun: true }))).kind).toBe("idempotent");
			expect(writes()).toEqual([]);
			expect(snapshot()).toBe(before);
		});

		it("the real apply settles the dangling audit, then applies", async () => {
			d1.exec(PREPARED);
			expect((await retargetRepositoryBinding(env, request())).kind).toBe("applied");
			expect(one<{ state: string }>("SELECT state FROM coding_repo_retarget_audits WHERE id = 'dangling'").state).toBe("conflicted");
			expect(audits().map((a) => a.state).sort()).toEqual(["applied", "conflicted"]);
		});
	});

	it("refuses a route blocker on apply and writes nothing", async () => {
		expect(await retargetRepositoryBinding(env, request({ routeBlockers: ["local_origin_mismatch"] }))).toEqual({ kind: "busy", blockers: ["local_origin_mismatch"] });
		expect(binding().github_repo).toBe("acme/platform");
		expect(audits()).toEqual([]);
	});

	it("answers a retry after a lost response idempotently, without a second write", async () => {
		const first = await retargetRepositoryBinding(env, request());
		const retry = await retargetRepositoryBinding(env, request());
		expect(retry.kind).toBe("idempotent");
		if (first.kind === "applied" && retry.kind === "idempotent") expect(retry.audit?.id).toBe(first.audit.id);
		expect(binding().binding_version).toBe(2);
		expect(audits()).toEqual([{ state: "applied" }]);
	});

	it("rejects a different repository that reused the name", async () => {
		const result = await retargetRepositoryBinding(env, request({ destination: { owner: "acme", name: "platform", githubId: 200 } }));
		expect(result).toEqual({ kind: "different-repository", bindingGithubId: 100 });
		expect(binding()).toMatchObject({ github_repo: "acme/platform", github_repository_id: 100, binding_version: 1 });
		expect(audits()).toEqual([]);
	});

	it.each([
		["a stale version", { owner: "acme", name: "platform", githubId: 100, version: 9 }],
		["a different expected id", { owner: "acme", name: "platform", githubId: 101, version: 1 }],
		["a missing expected id once one is recorded", { owner: "acme", name: "platform", version: 1 }],
		["a different expected coordinate", { owner: "acme", name: "other", githubId: 100, version: 1 }],
	])("fails closed on %s", async (_label, expectedCurrent) => {
		const result = await retargetRepositoryBinding(env, request({ expectedCurrent }));
		expect(result).toMatchObject({ kind: "stale", actual: { githubRepo: "acme/platform", githubRepositoryId: 100, version: 1 } });
		expect(binding().github_repo).toBe("acme/platform");
	});

	it("refuses when another binding already holds the destination", async () => {
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, provider, branch, clone_status, default_client) VALUES ('repo-2', 'i1', 'u1', 'other', 'acme/platform-archive', 'github', '', 'ready', 'claude')`);
		expect(await retargetRepositoryBinding(env, request())).toEqual({ kind: "conflict", conflictingRepoId: "repo-2" });
	});

	describe("work that could be redirected is a blocker, never moved", () => {
		const cases: Array<[string, string, string]> = [
			["active session", "UPDATE coding_sessions SET status = 'active'", "active_session"],
			["suspended session", "UPDATE coding_sessions SET status = 'suspended'", "active_session"],
			["driver lock", "UPDATE coding_sessions SET driver_id = 'pilot-1'", "session_lock"],
			["running run on this repo", "INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-1', 'u1', 'i1', 'x', 'running', 5, 1, 's1')", "active_run"],
			["run parked on a person", "INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-1', 'u1', 'i1', 'x', 'needs_human', 5, 1, 's1')", "active_run"],
			["pending queue entry for this repo", "INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, created_at) VALUES ('q1', 'i1', 'repo-1', 'u1', 'x', 'pending', 1)", "queued_work"],
			["pending repo-less queue entry", "INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, created_at) VALUES ('q1', 'i1', NULL, 'u1', 'x', 'pending', 1)", "queued_work"],
			["draining queue entry", "INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, created_at) VALUES ('q1', 'i1', 'repo-1', 'u1', 'x', 'running', 1)", "queued_work"],
			["in-flight start", `INSERT INTO loop_start_receipts (user_id, instance_id, request_id, input_json, state, created_at, updated_at) VALUES ('u1', 'i1', 'req-1', '{"repoId":"repo-1"}', 'provisioning', ${NOW - 1000}, ${NOW})`, "pending_start"],
		];
		it.each(cases)("%s", async (_label, sql, blocker) => {
			d1.exec(sql);
			const preview = await retargetRepositoryBinding(env, request({ dryRun: true }));
			expect(preview).toMatchObject({ kind: "preview", blockers: [blocker] });
			expect(await retargetRepositoryBinding(env, request())).toEqual({ kind: "busy", blockers: [blocker] });
			expect(binding()).toMatchObject({ github_repo: "acme/platform", binding_version: 1 });
		});

		it("ignores work on another repo and an abandoned start receipt", async () => {
			d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, provider, branch, clone_status, default_client) VALUES ('repo-2', 'i1', 'u1', 'other', 'acme/other', 'github', '', 'ready', 'claude')`);
			d1.exec("INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, created_at) VALUES ('q2', 'i1', 'repo-2', 'u1', 'other repo work', 'pending', 1)");
			d1.exec(`INSERT INTO loop_start_receipts (user_id, instance_id, request_id, input_json, state, created_at, updated_at) VALUES ('u1', 'i1', 'old', '{"repoId":"repo-1"}', 'provisioning', ${NOW - 60 * 60_000}, ${NOW})`);
			expect((await retargetRepositoryBinding(env, request())).kind).toBe("applied");
			// No automatic queue execution: the other repo's entry is untouched and no run was started.
			expect(one("SELECT repo_id, status, run_id FROM instance_objective_queue WHERE id = 'q2'")).toEqual({ repo_id: "repo-2", status: "pending", run_id: null });
			expect(one<{ n: number }>("SELECT count(*) AS n FROM agent_loop_runs").n).toBe(0);
		});
	});

	it("lets exactly one of two concurrent identical requests write; the other is idempotent", async () => {
		const [a, b] = await Promise.all([retargetRepositoryBinding(env, request()), retargetRepositoryBinding(env, request())]);
		expect([a.kind, b.kind].sort()).toEqual(["applied", "idempotent"]);
		expect(binding().binding_version).toBe(2);
		expect(audits().map((r) => r.state).sort()).toEqual(["applied", "conflicted"]);
	});

	it("fails the loser of two concurrent different destinations closed", async () => {
		const [a, b] = await Promise.all([
			retargetRepositoryBinding(env, request()),
			retargetRepositoryBinding(env, request({ destination: { owner: "acme-archive", name: "platform", githubId: 100 } })),
		]);
		expect([a.kind, b.kind].sort()).toEqual(["applied", "stale"]);
		expect(binding().binding_version).toBe(2);
	});

	it("leaves an interrupted attempt recoverable: binding unchanged, audit prepared, settled by the next attempt", async () => {
		const failing = { DB: Object.assign(Object.create(d1.DB), { batch: async () => { throw new Error("D1 unavailable"); }, prepare: d1.DB.prepare.bind(d1.DB) }) } as unknown as Env;
		await expect(retargetRepositoryBinding(failing, request())).rejects.toThrow("D1 unavailable");
		expect(binding()).toMatchObject({ github_repo: "acme/platform", binding_version: 1 });
		expect(audits()).toEqual([{ state: "prepared" }]);

		expect((await retargetRepositoryBinding(env, request())).kind).toBe("applied");
		expect(audits()).toEqual([{ state: "conflicted" }, { state: "applied" }]);
	});

	it("supports the rename-and-replace case: archive the old binding, then bind the replacement separately", async () => {
		expect((await retargetRepositoryBinding(env, request())).kind).toBe("applied");
		const replacement = await createRepo(env, "i1", "u1", { name: "platform (new)", githubRepo: "acme/platform", workdir: "/work/platform-new" });
		expect(replacement.id).not.toBe("repo-1");
		expect(one<{ n: number }>("SELECT count(*) AS n FROM coding_sessions WHERE repo_id = 'repo-1'").n).toBe(1);
		expect(binding().github_repo).toBe("acme/platform-archive");
	});

	it("rolls back with the recorded reverse input as another guarded retarget", async () => {
		const applied = await retargetRepositoryBinding(env, request());
		if (applied.kind !== "applied") throw new Error(applied.kind);
		const back = await retargetRepositoryBinding(env, request({ ...applied.rollback }));
		expect(back.kind).toBe("applied");
		expect(binding()).toMatchObject({ github_repo: "acme/platform", binding_version: 3, clone_url: "git@github.com:acme/platform.git" });
		const history = await listRetargetAudits(env, "i1", "u1", "repo-1");
		expect(history.map((h) => [h.from, h.to, h.state])).toEqual([
			["acme/platform-archive", "acme/platform", "applied"],
			["acme/platform", "acme/platform-archive", "applied"],
		]);
	});
});

describe("labelSessions (#1012)", () => {
	it("labels a session with the coordinate the binding had when it started", () => {
		const audit = { id: "a", state: "applied" as const, from: "acme/platform", to: "acme/platform-archive", githubRepositoryId: 100, expectedBindingVersion: 1, resultingBindingVersion: 2, createdAt: 0, appliedAt: Date.parse("2026-06-01T00:00:00Z") };
		expect(labelSessions("acme/platform-archive", [audit], [
			{ id: "before", startedAt: "2026-01-01 00:00:00" },
			{ id: "after", startedAt: "2026-07-01 00:00:00" },
		])).toEqual([
			{ sessionId: "before", startedAt: "2026-01-01 00:00:00", githubRepo: "acme/platform" },
			{ sessionId: "after", startedAt: "2026-07-01 00:00:00", githubRepo: "acme/platform-archive" },
		]);
	});
});

describe("retargetCloneUrl (#1012)", () => {
	it.each([
		["https://github.com/acme/platform.git", "https://github.com/acme/platform-archive.git"],
		["https://github.com/acme/platform", "https://github.com/acme/platform-archive"],
		["git@github.com:acme/platform.git", "git@github.com:acme/platform-archive.git"],
		["ssh://git@github.com/ACME/Platform.git", "ssh://git@github.com/acme/platform-archive.git"],
		["https://github.com/someone/else.git", null],
		[null, null],
	])("%s → %s", (from, to) => {
		expect(retargetCloneUrl(from, "acme/platform", "acme/platform-archive")).toBe(to);
	});
});
