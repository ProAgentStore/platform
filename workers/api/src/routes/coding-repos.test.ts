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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
// The runner transport, stubbed at the seam every repo route reaches the machine through. Only
// the two entry points are replaced; the rest of the module (typed errors, timeouts) is real, so
// a caller that starts depending on one of them is not silently handed `undefined`.
const { getBoundRunnerConn, callRunner } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn(), callRunner: vi.fn() }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/runner-client.js")>()),
	getBoundRunnerConn,
	callRunner,
}));

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
	const { app, env, insertedRepo, issued } = buildApp();
	const token = await signSession({ uid: UID, email: "o@example.com", roles: [] }, SECRET);
	const res = await app.request(
		`/v1/instances/${INSTANCE}/coding/repos`,
		{ method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
		env,
	);
	return {
		status: res.status,
		body: (await res.json()) as { repo?: Record<string, unknown>; warning?: string; error?: string },
		row: insertedRepo(),
		issued,
	};
}

/** No machine is connected — the default for every test that predates #405. */
beforeEach(() => {
	getBoundRunnerConn.mockReset();
	callRunner.mockReset();
	getBoundRunnerConn.mockResolvedValue(null);
});

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

/**
 * `ready` is a CLAIM, and the platform may only make it about a path it has looked at (#405).
 *
 * A local repo used to become `ready` — the same word a successful clone gets — the instant
 * someone typed a path. The runner was connected at that moment and could have answered all
 * three questions; it was never asked. Two days later the agent was still being asked about code
 * in an empty directory the console called ready, and it invented the code (#395).
 */
describe("POST /coding/repos — a local path is CHECKED before it is called ready", () => {
	const FAKE_CONN = { instanceId: INSTANCE } as never;
	const HEALTHY = { checked: true, path: "/home/u/dev/thing", exists: true, isDirectory: true, entryCount: 91, insideWorkTree: true, gitChecked: true };

	/** The last `clone_status`/`clone_error` written for a repo, or null if nothing was written. */
	const statusWritten = (issued: Statement[]) => {
		const update = issued.filter((s) => s.sql.startsWith("UPDATE coding_repos SET clone_status")).pop();
		return update ? { status: update.binds[1], error: update.binds[2] } : null;
	};

	it("asks the machine that will use the path, passing the path the owner typed", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue(HEALTHY);
		await addRepo({ localPath: "~/dev/thing" });
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/coding/repo-check", { workDir: "~/dev/thing" }, expect.anything());
	});

	it("marks an EMPTY directory needs_attention, with a message naming it", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ ...HEALTHY, entryCount: 0, insideWorkTree: false });
		const { status, body, issued } = await addRepo({ localPath: "~/dev/pas/platform/apps/chess-academy" });
		// Still created: the row is the handle the owner needs to fix or delete it. What changed
		// is that it no longer says `ready`.
		expect(status).toBe(201);
		expect(statusWritten(issued)).toMatchObject({ status: "needs_attention" });
		expect(body.repo?.cloneStatus).toBe("needs_attention");
		expect(body.warning).toContain("/home/u/dev/thing");
		expect(body.warning).toMatch(/EMPTY/);
	});

	it("marks a path that does not exist needs_attention too", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ checked: true, path: "/home/u/typo", exists: false });
		const { body } = await addRepo({ localPath: "~/typo" });
		expect(body.repo?.cloneStatus).toBe("needs_attention");
		expect(body.warning).toMatch(/does not exist/);
	});

	it("leaves a real checkout `ready`, and writes nothing it did not have to", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue(HEALTHY);
		const { body, issued } = await addRepo({ localPath: "~/dev/thing" });
		expect(body.repo?.cloneStatus).toBe("ready");
		expect(body.warning).toBeUndefined();
		expect(statusWritten(issued)).toBeNull();
	});

	// "Only when the runner is live" — with no machine connected there is nobody to ask, and the
	// honest outcome is not a silent `ready`. `unknown` is a path nobody has looked at yet; the
	// repos list upgrades it the moment one is.
	it("does NOT say ready when no machine is connected to check", async () => {
		const { status, body, issued } = await addRepo({ localPath: "~/dev/thing" });
		expect(status).toBe(201);
		expect(statusWritten(issued)).toMatchObject({ status: "unknown" });
		expect(body.repo?.cloneStatus).toBe("unknown");
		// Not a defect, so not a warning — the console's offline banner is the true sentence here.
		expect(body.warning).toBeUndefined();
	});

	// An older CLI 404s /coding/repo-check; the relay hands the cloud `{error:"Not found"}`. A
	// version skew must not condemn a repo — but it must not mint `ready` either.
	it("treats an older runner as unchecked, not as broken", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ error: "Not found" });
		const { body, issued } = await addRepo({ localPath: "~/dev/thing" });
		expect(statusWritten(issued)).toMatchObject({ status: "unknown" });
		expect(body.warning).toBeUndefined();
	});

	it("never asks the machine about a CLONE — there is no local path to look at yet", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		await addRepo({ cloneUrl: "https://github.com/o/r.git" });
		expect(callRunner).not.toHaveBeenCalled();
	});
});

/**
 * A checkout can be moved or deleted long after it was added — the same state arriving later.
 * The list is the only place that state can be caught, because it is what the console reads.
 */
describe("GET /coding/repos — the path is re-checked on every list", () => {
	const FAKE_CONN = { instanceId: INSTANCE } as never;
	const row = (over: Record<string, unknown> = {}) => ({
		id: "repo-1", instance_id: INSTANCE, user_id: UID, name: "apps/chess-academy",
		github_repo: null, provider: "local", repo_slug: null, web_url: null, clone_url: null,
		branch: "", workdir: "~/dev/pas/platform/apps/chess-academy", clone_status: "ready",
		clone_error: null, default_client: "claude", urls: null, instructions: null, merge_policy: null,
		created_at: "2026-08-07 08:29:04", updated_at: "2026-08-07 08:29:04", ...over,
	});

	async function listRepos(rows: Array<Record<string, unknown>>) {
		const issued: Statement[] = [];
		const DB = {
			prepare(sql: string) {
				const flat = sql.replace(/\s+/g, " ").trim();
				const stmt = {
					bind: (...binds: unknown[]) => {
						issued.push({ sql: flat, binds });
						return stmt;
					},
					first: async () => (/FROM agent_instances/.test(flat) ? { id: INSTANCE } : null),
					all: async () => ({ results: /FROM coding_repos/.test(flat) ? rows : [] }),
					run: async () => ({ meta: { changes: 1 } }),
				};
				return stmt;
			},
		};
		const env = { SESSION_SIGNING_KEY: SECRET, DB } as unknown as Env;
		const app = new Hono<{ Bindings: Env }>();
		const routes = new Hono<{ Bindings: Env }>();
		registerRepoRoutes(routes);
		app.route("/v1/instances", routes);
		const token = await signSession({ uid: UID, email: "o@example.com", roles: [] }, SECRET);
		const res = await app.request(`/v1/instances/${INSTANCE}/coding/repos`, { headers: { Authorization: `Bearer ${token}` } }, env);
		return { body: (await res.json()) as { repos: Array<Record<string, unknown>> }, issued };
	}

	it("downgrades a repo whose checkout has gone since it was added", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ checked: true, path: "/home/u/dev/chess-academy", exists: false });
		const { body, issued } = await listRepos([row()]);
		expect(body.repos[0].cloneStatus).toBe("needs_attention");
		expect(String(body.repos[0].cloneError)).toContain("/home/u/dev/chess-academy");
		expect(issued.some((s) => s.sql.startsWith("UPDATE coding_repos SET clone_status"))).toBe(true);
	});

	it("upgrades one back to ready when the checkout is there again", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ checked: true, path: "/home/u/dev/x", exists: true, isDirectory: true, entryCount: 12, insideWorkTree: true, gitChecked: true });
		const { body } = await listRepos([row({ clone_status: "needs_attention", clone_error: "…was empty" })]);
		expect(body.repos[0].cloneStatus).toBe("ready");
		expect(body.repos[0].cloneError).toBeUndefined();
	});

	// A laptop that closed says nothing new about the path on it. Downgrading on its absence
	// would flip every repo in the list every time someone shut a lid, while the console's
	// offline banner already says the true thing.
	it("leaves every stored verdict alone when no machine is connected", async () => {
		const { body, issued } = await listRepos([row(), row({ id: "repo-2", clone_status: "needs_attention", clone_error: "gone" })]);
		expect(body.repos.map((r) => r.cloneStatus)).toEqual(["ready", "needs_attention"]);
		expect(issued.some((s) => s.sql.startsWith("UPDATE coding_repos SET clone_status"))).toBe(false);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("does not ask the machine about repos that have no local path", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		await listRepos([row({ provider: "github", workdir: null, github_repo: "o/r", clone_url: "https://github.com/o/r.git" })]);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("writes nothing when the verdict has not changed", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ checked: true, path: "~/dev/x", exists: true, isDirectory: true, entryCount: 3, insideWorkTree: true, gitChecked: true });
		const { issued } = await listRepos([row()]);
		expect(issued.some((s) => s.sql.startsWith("UPDATE coding_repos SET clone_status"))).toBe(false);
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
