/**
 * `POST …/coding/repos/:repoId/retarget` and `GET …/retargets`, driven as the owner (#1012).
 *
 * The real route over the real migrated schema; only the two external seams are stubbed — GitHub
 * (the App token + the REST answer) and the runner transport. Invariants protected: identity comes
 * from GitHub's answer for a numeric id (never a reused name or redirect), the machine's origin must
 * already name the destination and is never changed, and nothing but metadata is written.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";

const { getBoundRunnerConn, callRunner, resolveGithubAccess } = vi.hoisted(() => ({
	getBoundRunnerConn: vi.fn(),
	callRunner: vi.fn(),
	resolveGithubAccess: vi.fn(),
}));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/runner-client.js")>()),
	getBoundRunnerConn,
	callRunner,
}));
vi.mock("../lib/github-app.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/github-app.js")>()),
	resolveGithubAccess,
}));

import { registerRepoRetargetRoutes } from "./coding-repo-retarget.js";
import type { Env } from "../types.js";

const SECRET = "retarget-route-secret";
let d1: RealSchemaD1;
let env: Env;
/** What GitHub answers, by request path. */
let github: Record<string, { id: number; full_name: string } | null>;
let origin: string | null;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB, SESSION_SIGNING_KEY: SECRET } as unknown as Env;
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, github_repository_id, provider, repo_slug, web_url, clone_url, branch, workdir, clone_status, default_client, instructions)
		VALUES ('repo-1', 'i1', 'u1', 'platform', 'acme/platform', 100, 'github', 'acme/platform', 'https://github.com/acme/platform', 'https://github.com/acme/platform.git', '', '/work/platform', 'ready', 'claude', 'keep me')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status, started_at) VALUES ('s1', 'i1', 'repo-1', 'u1', 'claude', 'ended', '2026-01-01 00:00:00')`);
	github = { "/repositories/100": { id: 100, full_name: "acme/platform-archive" } };
	origin = "git@github.com:acme/platform-archive.git";
	resolveGithubAccess.mockReset().mockResolvedValue({ ok: true, token: "ghs_test" });
	getBoundRunnerConn.mockReset().mockResolvedValue({ node: "mac" });
	callRunner.mockReset().mockImplementation(async (_conn: unknown, path: string) => {
		if (path === "/coding/git-remote") return { remote: origin };
		throw new Error(`unexpected runner call ${path}`);
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			const hit = github[new URL(url).pathname];
			return hit ? Response.json(hit) : new Response("Not Found", { status: 404 });
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

function app() {
	const a = new Hono<{ Bindings: Env }>();
	const routes = new Hono<{ Bindings: Env }>();
	registerRepoRetargetRoutes(routes);
	a.route("/v1/instances", routes);
	a.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
	return a;
}

const BODY = {
	expectedCurrent: { owner: "acme", name: "platform", githubId: 100, version: 1 },
	destination: { owner: "acme", name: "platform-archive", githubId: 100 },
};

async function retarget(body: unknown = BODY, uid = "u1") {
	const token = await signSession(uid, SECRET, { roles: [] });
	const res = await app().request(
		"/v1/instances/i1/coding/repos/repo-1/retarget",
		{ method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
		env,
	);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const row = () => d1.sqlite.prepare("SELECT github_repo, github_repository_id, binding_version, instructions FROM coding_repos WHERE id = 'repo-1'").get();
const unchanged = { github_repo: "acme/platform", github_repository_id: 100, binding_version: 1, instructions: "keep me" };

describe("POST /coding/repos/:repoId/retarget (#1012)", () => {
	it("previews without writing, then applies; GitHub is asked by numeric id and no work is started", async () => {
		const preview = await retarget({ ...BODY, dryRun: true });
		expect(preview).toMatchObject({ status: 200, body: { dryRun: true, ready: true, blockers: [], changes: { githubRepo: { from: "acme/platform", to: "acme/platform-archive" } } } });
		expect(row()).toEqual(unchanged);

		const applied = await retarget();
		expect(applied).toMatchObject({ status: 200, body: { ok: true, repo: { id: "repo-1", githubRepo: "acme/platform-archive", bindingVersion: 2 } } });
		expect(row()).toEqual({ ...unchanged, github_repo: "acme/platform-archive", binding_version: 2 });
		expect(vi.mocked(fetch).mock.calls.map(([u]) => new URL(u as string).pathname)).toEqual(["/repositories/100", "/repositories/100"]);
		// The only machine call is the read-only origin check.
		expect(callRunner.mock.calls.map((c) => c[1])).toEqual(["/coding/git-remote", "/coding/git-remote"]);

		const retry = await retarget();
		expect(retry).toMatchObject({ status: 200, body: { ok: true, idempotent: true } });
	});

	it("rejects a destination name GitHub assigns to a different id", async () => {
		const res = await retarget({ ...BODY, destination: { owner: "acme", name: "platform", githubId: 100 } });
		expect(res).toMatchObject({ status: 409, body: { canonical: "acme/platform-archive" } });
		expect(row()).toEqual(unchanged);
	});

	it("rejects a different repository that reused the name, even though GitHub confirms it", async () => {
		github["/repositories/200"] = { id: 200, full_name: "acme/platform" };
		const res = await retarget({ ...BODY, destination: { owner: "acme", name: "platform", githubId: 200 } });
		expect(res.status).toBe(409);
		expect(String(res.body.error)).toMatch(/different repository/);
		expect(row()).toEqual(unchanged);
	});

	it("refuses when the owner's GitHub App cannot reach the destination", async () => {
		resolveGithubAccess.mockResolvedValue({ ok: false, message: 'The ProAgentStore GitHub App is not installed on "acme".' });
		expect(await retarget()).toMatchObject({ status: 403, body: { error: expect.stringContaining("not installed") } });
		resolveGithubAccess.mockResolvedValue({ ok: true, token: "t" });
		github = {};
		expect((await retarget()).status).toBe(403);
		expect(row()).toEqual(unchanged);
	});

	it("does not serve another account's binding", async () => {
		d1.exec("INSERT INTO users (id, github_login) VALUES ('u2', 'u2')");
		expect([403, 404]).toContain((await retarget(BODY, "u2")).status);
		expect(row()).toEqual(unchanged);
	});

	describe("a binding recorded before the numeric id", () => {
		beforeEach(() => d1.exec("UPDATE coding_repos SET github_repository_id = NULL"));

		it("requires the caller to assert the id", async () => {
			const res = await retarget({ ...BODY, expectedCurrent: { owner: "acme", name: "platform", version: 1 } });
			expect(res.status).toBe(400);
		});

		it("refuses when the old name now resolves to a different repository", async () => {
			github["/repos/acme/platform"] = { id: 200, full_name: "acme/platform" };
			const res = await retarget();
			expect(res.status).toBe(409);
			expect(String(res.body.error)).toMatch(/cannot be established/);
		});

		it("stamps the id when the old name still resolves to it", async () => {
			github["/repos/acme/platform"] = { id: 100, full_name: "acme/platform-archive" };
			expect((await retarget()).status).toBe(200);
			expect(row()).toEqual({ ...unchanged, github_repo: "acme/platform-archive", binding_version: 2 });
		});
	});

	it("reports a local origin that does not name the destination, with the explicit command, and never changes it", async () => {
		origin = "https://github.com/acme/platform.git";
		const preview = await retarget({ ...BODY, dryRun: true });
		expect(preview).toMatchObject({
			status: 200,
			body: { ready: false, blockers: ["local_origin_mismatch"], originRemedy: 'git -C "/work/platform" remote set-url origin https://github.com/acme/platform-archive.git' },
		});
		expect(await retarget()).toMatchObject({ status: 409, body: { blockers: ["local_origin_mismatch"] } });
		expect(row()).toEqual(unchanged);
	});

	it.each([
		["runner offline", () => getBoundRunnerConn.mockResolvedValue(null), "runner_offline"],
		["origin unreadable", () => callRunner.mockRejectedValue(new Error("timeout")), "local_origin_unreadable"],
		["managed clone", () => d1.exec("UPDATE coding_repos SET workdir = NULL"), "managed_clone_origin_unverifiable"],
	])("blocks when the origin cannot be verified: %s", async (_label, arrange, blocker) => {
		arrange();
		expect(await retarget()).toMatchObject({ status: 409, body: { blockers: [blocker] } });
		expect(row()).toEqual(unchanged);
	});

	it("blocks queued work rather than redirecting it", async () => {
		d1.exec("INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, created_at) VALUES ('q1', 'i1', 'repo-1', 'u1', 'x', 'pending', 1)");
		expect(await retarget()).toMatchObject({ status: 409, body: { blockers: ["queued_work"] } });
		expect(d1.sqlite.prepare("SELECT status, run_id FROM instance_objective_queue").get()).toEqual({ status: "pending", run_id: null });
	});

	it("answers a stale expected version with 412 and the actual state", async () => {
		const res = await retarget({ ...BODY, expectedCurrent: { ...BODY.expectedCurrent, version: 7 } });
		expect(res).toMatchObject({ status: 412, body: { actual: { githubRepo: "acme/platform", githubRepositoryId: 100, version: 1 } } });
	});

	it.each([
		["no body", {}],
		["no destination id", { ...BODY, destination: { owner: "acme", name: "platform-archive" } }],
		["no version", { ...BODY, expectedCurrent: { owner: "acme", name: "platform", githubId: 100 } }],
		["a URL instead of a name", { ...BODY, destination: { owner: "acme", name: "platform/../x", githubId: 100 } }],
	])("validates input: %s", async (_label, body) => {
		expect((await retarget(body)).status).toBe(400);
	});
});

describe("GET /coding/repos/:repoId/retargets (#1012)", () => {
	it("returns the history and labels earlier sessions with the coordinate they worked on", async () => {
		await retarget();
		const token = await signSession("u1", SECRET, { roles: [] });
		const res = await app().request("/v1/instances/i1/coding/repos/repo-1/retargets", { headers: { Authorization: `Bearer ${token}` } }, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			githubRepo: "acme/platform-archive",
			githubRepositoryId: 100,
			bindingVersion: 2,
			audits: [{ from: "acme/platform", to: "acme/platform-archive", state: "applied" }],
			sessions: [{ sessionId: "s1", githubRepo: "acme/platform" }],
		});
	});
});
