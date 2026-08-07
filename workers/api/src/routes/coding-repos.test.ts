/**
 * The repo surface, driven — what the owner's request actually STORES and is told (#221).
 *
 * `coding.contract.test.ts` drives every route as a stranger and pins the tenant gate. This one
 * drives two of them as the OWNER, because the bug being fixed is on the far side of that gate:
 * a GitLab clone URL used to be accepted, stored with an empty `github_repo`, rendered as a
 * local checkout, and — when its owner opened the Issues panel — told it "isn't connected to
 * GitHub", which is a sentence about a setup mistake they had not made.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { registerRepoRoutes } from "./coding-repos.js";
import type { Env } from "../types.js";

const SECRET = "coding-repos-test-secret";
const UID = "user-1";
const INSTANCE = "inst-1";

interface Statement {
	sql: string;
	binds: unknown[];
}

/**
 * A D1 that resolves ownership, echoes an inserted repo back as a row, and otherwise answers
 * with `repo`. Enough to drive add-repo and the read routes without a real database.
 */
function ownerEnv(repo?: Record<string, unknown>) {
	const issued: Statement[] = [];
	let inserted: Record<string, unknown> | null = null;
	const DB = {
		prepare(sql: string) {
			const flat = sql.replace(/\s+/g, " ").trim();
			const stmt = {
				bind: (...binds: unknown[]) => {
					issued.push({ sql: flat, binds });
					if (flat.startsWith("INSERT INTO coding_repos")) {
						// The column order of the INSERT, so the assertions below read as columns
						// rather than as positional indexes.
						const [id, instance_id, user_id, name, github_repo, provider, repo_slug, web_url, clone_url, branch, workdir, clone_status, default_client] = binds;
						inserted = {
							id, instance_id, user_id, name, github_repo, provider, repo_slug, web_url, clone_url, branch, workdir, clone_status, default_client,
							clone_error: null, urls: null, instructions: null, merge_policy: null,
							created_at: "2026-08-08 00:00:00", updated_at: "2026-08-08 00:00:00",
						};
					}
					return stmt;
				},
				first: async () => {
					if (/FROM agent_instances/.test(flat)) return { id: INSTANCE };
					if (/FROM coding_repos/.test(flat)) return inserted ?? repo ?? null;
					return null;
				},
				all: async () => ({ results: [] }),
				run: async () => ({ meta: { changes: 1 } }),
			};
			return stmt;
		},
	};
	const env = { SESSION_SIGNING_KEY: SECRET, DB } as unknown as Env;
	return { env, issued, insertedRepo: () => inserted };
}

function buildApp(repo?: Record<string, unknown>) {
	const ctx = ownerEnv(repo);
	const app = new Hono<{ Bindings: Env }>();
	const routes = new Hono<{ Bindings: Env }>();
	registerRepoRoutes(routes);
	app.route("/v1/instances", routes);
	app.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
	return { app, ...ctx };
}

async function addRepo(body: Record<string, unknown>) {
	const { app, env, insertedRepo } = buildApp();
	const token = await signSession({ uid: UID, email: "o@example.com", roles: [] }, SECRET);
	const res = await app.request(
		`/v1/instances/${INSTANCE}/coding/repos`,
		{ method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
		env,
	);
	return { status: res.status, body: (await res.json()) as { repo?: Record<string, unknown>; error?: string }, row: insertedRepo() };
}

describe("POST /coding/repos — a repo is stored as what it IS", () => {
	it("stores a GitLab URL as a GitLab repo, with its nested slug and NO github_repo", async () => {
		const { status, row } = await addRepo({ cloneUrl: "https://gitlab.com/group/subgroup/project.git" });
		expect(status).toBe(201);
		expect(row).toMatchObject({
			provider: "gitlab",
			repo_slug: "group/subgroup/project",
			web_url: "https://gitlab.com/group/subgroup/project",
			github_repo: null,
			name: "group/subgroup/project",
		});
	});

	it("stores a Bitbucket URL as Bitbucket", async () => {
		const { row } = await addRepo({ cloneUrl: "https://bitbucket.org/workspace/repo.git" });
		expect(row).toMatchObject({ provider: "bitbucket", repo_slug: "workspace/repo", github_repo: null });
	});

	it("keeps every existing GitHub path byte-for-byte", async () => {
		// What the console sends today for `owner/repo`.
		const both = await addRepo({ githubRepo: "ProAgentStore/platform", cloneUrl: "https://github.com/ProAgentStore/platform.git" });
		expect(both.row).toMatchObject({ provider: "github", github_repo: "ProAgentStore/platform", repo_slug: "ProAgentStore/platform" });
		// A bare clone URL still derives the coordinate.
		const urlOnly = await addRepo({ cloneUrl: "https://github.com/o/r.git" });
		expect(urlOnly.row).toMatchObject({ provider: "github", github_repo: "o/r" });
		// A bare coordinate with no URL still means GitHub.
		const slugOnly = await addRepo({ githubRepo: "o/r" });
		expect(slugOnly.row).toMatchObject({ provider: "github", github_repo: "o/r" });
	});

	it("lets the URL's host WIN over a conflicting githubRepo", async () => {
		// The two are independent body fields. Trusting the coordinate here would store a GitLab
		// repo as a GitHub one and then ask GitHub about a project that does not exist there.
		const { row } = await addRepo({ githubRepo: "me/private", cloneUrl: "https://gitlab.com/group/project.git" });
		expect(row).toMatchObject({ provider: "gitlab", repo_slug: "group/project", github_repo: null });
	});

	it("canonicalises a pasted BROWSER url into something git can clone", async () => {
		const { row } = await addRepo({ cloneUrl: "https://gitlab.com/group/project/-/tree/main" });
		expect(row?.clone_url).toBe("https://gitlab.com/group/project.git");
	});

	it("keeps an ssh clone URL verbatim — the machine's own keys do that clone", async () => {
		const { row } = await addRepo({ cloneUrl: "git@gitlab.com:group/project.git" });
		expect(row).toMatchObject({ provider: "gitlab", clone_url: "git@gitlab.com:group/project.git" });
	});

	it("calls a local path local, and a nameless placeholder local too", async () => {
		expect((await addRepo({ localPath: "~/dev/stores/pags/platform" })).row).toMatchObject({ provider: "local", workdir: "~/dev/stores/pags/platform" });
		expect((await addRepo({ name: "scratch" })).row).toMatchObject({ provider: "local", name: "scratch" });
	});

	it("calls an unrecognised host `other` — a real remote, not a local checkout", async () => {
		const { row } = await addRepo({ cloneUrl: "https://git.internal.example/team/service.git" });
		expect(row).toMatchObject({ provider: "other", clone_url: "https://git.internal.example/team/service.git" });
	});
});

describe("GET /coding/repos/:id/issues — a deferred surface fails CLEANLY", () => {
	const gitlabRepo = {
		id: "repo-1", instance_id: INSTANCE, user_id: UID, name: "group/project",
		github_repo: null, provider: "gitlab", repo_slug: "group/project", web_url: null,
		clone_url: "https://gitlab.com/group/project.git", branch: "", workdir: null,
		clone_status: "ready", clone_error: null, default_client: "claude",
		urls: null, instructions: null, merge_policy: null,
		created_at: "2026-08-08 00:00:00", updated_at: "2026-08-08 00:00:00",
	};

	const get = async (path: string, repo: Record<string, unknown>) => {
		const { app, env } = buildApp(repo);
		const token = await signSession({ uid: UID, email: "o@example.com", roles: [] }, SECRET);
		const res = await app.request(`/v1/instances/${INSTANCE}/coding/repos/repo-1${path}`, { headers: { Authorization: `Bearer ${token}` } }, env);
		return { status: res.status, body: (await res.json()) as { error?: string } };
	};

	it("says GitLab issues are not supported YET, not that the repo is unconnected", async () => {
		for (const path of ["/issues", "/issues/7", "/next-issue"]) {
			const { status, body } = await get(path, gitlabRepo);
			expect(status, path).toBe(400);
			expect(body.error, path).toContain("GitLab");
			expect(body.error, path).not.toContain("isn't connected to GitHub");
		}
	});

	it("still gives a LOCAL repo the actionable message it always got", async () => {
		const { status, body } = await get("/issues", { ...gitlabRepo, provider: "local", repo_slug: null, clone_url: null, workdir: "~/notes" });
		expect(status).toBe(400);
		expect(body.error).toMatch(/local checkout/);
	});

	it("reports GitLab builds as unavailable rather than asking GitHub about them", async () => {
		// The build routes key off `github_repo`, which a GitLab repo does not have — so they
		// already degrade correctly. Pinned because the temptation when wiring a provider is to
		// let the slug flow through, which would send `group/subgroup/project` to api.github.com.
		// `env` here has no GitHub App and no fetch stub: reaching GitHub at all would be visible.
		const { status, body } = await get("/deployment", gitlabRepo);
		expect(status).toBe(200);
		expect(body).toEqual({ available: false });
	});
});
