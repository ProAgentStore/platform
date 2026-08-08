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

/**
 * A repo can be MOVED. Its identity cannot (#410/#411).
 *
 * `workdir` was the one thing about a repo that could not be corrected: the settings sheet showed
 * it as read-only text styled exactly like the inputs around it, and this route's payload type did
 * not name it — so the console was not failing to send a change, there was nothing to send. The
 * owner's only remedy was DELETE, which takes the name, the URLs, the merge policy (#314), the
 * instructions and the issue mode with it, and is the foreign key for `coding_sessions` and
 * `coding_timeline`. Fixing a typo meant destroying the history.
 *
 * The rule these tests pin is neither "editable" nor "immutable": WHICH repository this is stays
 * fixed, WHERE its working copy lives does not.
 */
describe("PUT /coding/repos/:id — the folder is editable, and checked when it changes", () => {
	const FAKE_CONN = { instanceId: INSTANCE } as never;
	const HEALTHY = { checked: true, path: "~/dev/stores/pas/apps/chess-academy", exists: true, isDirectory: true, entryCount: 21039, insideWorkTree: true, gitChecked: true };

	const repoRow = (over: Record<string, unknown> = {}) => ({
		id: "repo-1", instance_id: INSTANCE, user_id: UID, name: "apps/chess-academy",
		github_repo: null, provider: "local", repo_slug: null, web_url: null, clone_url: null,
		branch: "", workdir: "~/dev/pas/platform/apps/chess-academy", clone_status: "ready",
		clone_error: null, default_client: "claude", urls: null, instructions: null, merge_policy: null,
		created_at: "2026-08-07 08:29:04", updated_at: "2026-08-07 08:29:04", ...over,
	});

	/**
	 * A D1 whose repo row actually CHANGES when the route updates it — the route re-reads the row
	 * before verifying, so a harness echoing the pre-update row would have it checking the OLD path
	 * and every assertion below would pass for the wrong reason.
	 *
	 * `session` is the active-session lookup's answer; `null` is a quiet repo.
	 */
	function movableEnv(row: Record<string, unknown> | null, session: Record<string, unknown> | null = null) {
		const issued: Statement[] = [];
		let current = row;
		const DB = {
			prepare(sql: string) {
				const flat = sql.replace(/\s+/g, " ").trim();
				const stmt = {
					bind: (...binds: unknown[]) => {
						issued.push({ sql: flat, binds });
						// updateRepo binds: repoId, instanceId, userId, name, urlsJson, hasUrls, mergePolicy, workdir
						if (flat.startsWith("UPDATE coding_repos SET name") && current) {
							if (binds[7] != null) current = { ...current, workdir: binds[7] };
							if (binds[3] != null) current = { ...current, name: binds[3] };
						}
						if (flat.startsWith("UPDATE coding_repos SET clone_status") && current) {
							current = { ...current, clone_status: binds[1], clone_error: binds[2] };
						}
						return stmt;
					},
					first: async () => {
						if (/FROM agent_instances/.test(flat)) return { id: INSTANCE };
						if (/FROM coding_sessions/.test(flat)) return session;
						if (/FROM coding_repos/.test(flat)) return current;
						return null;
					},
					all: async () => ({ results: [] }),
					run: async () => ({ meta: { changes: current ? 1 : 0 } }),
				};
				return stmt;
			},
		};
		return { env: { SESSION_SIGNING_KEY: SECRET, DB } as unknown as Env, issued, row: () => current };
	}

	async function put(body: Record<string, unknown>, ctx: ReturnType<typeof movableEnv>) {
		const app = new Hono<{ Bindings: Env }>();
		const routes = new Hono<{ Bindings: Env }>();
		registerRepoRoutes(routes);
		app.route("/v1/instances", routes);
		app.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
		const token = await signSession({ uid: UID, email: "o@example.com", roles: [] }, SECRET);
		const res = await app.request(
			`/v1/instances/${INSTANCE}/coding/repos/repo-1`,
			{ method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
			ctx.env,
		);
		return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; sessionId?: string; warning?: string; repo?: Record<string, unknown> } };
	}

	it("writes the new folder, keeping the row — and therefore its sessions and its history", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue(HEALTHY);
		const ctx = movableEnv(repoRow());
		const { status } = await put({ workdir: "~/dev/stores/pas/apps/chess-academy" }, ctx);
		expect(status).toBe(200);
		expect(ctx.row()).toMatchObject({ id: "repo-1", workdir: "~/dev/stores/pas/apps/chess-academy" });
		// The handle everything else hangs off is untouched — this is the whole reason
		// delete-and-re-add was not an acceptable answer.
		expect(ctx.issued.some((s) => s.sql.startsWith("DELETE FROM coding_repos"))).toBe(false);
	});

	it("checks the NEW path on the machine, and clears needs_attention when it is good", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue(HEALTHY);
		const ctx = movableEnv(repoRow({ clone_status: "needs_attention", clone_error: "…is EMPTY" }));
		const { body } = await put({ workdir: "~/dev/stores/pas/apps/chess-academy" }, ctx);
		// It asked about the new path, not the one the row held when the request arrived.
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/coding/repo-check", { workDir: "~/dev/stores/pas/apps/chess-academy" }, expect.anything());
		expect(body.repo?.cloneStatus).toBe("ready");
		expect(body.warning).toBeUndefined();
	});

	it("stores a broken path and MARKS it — the same sentence the add path gives", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ checked: true, path: "~/typo", exists: false });
		const ctx = movableEnv(repoRow());
		const { status, body } = await put({ workdir: "~/typo" }, ctx);
		// Not a 400. The owner may be fixing this from a phone with the machine shut, and refusing
		// the save would make the product unusable for the case it exists to serve. What must not
		// happen is the row going on claiming `ready` about a directory that is not there.
		expect(status).toBe(200);
		expect(body.repo?.cloneStatus).toBe("needs_attention");
		expect(body.warning).toMatch(/does not exist/);
		expect(body.warning).toContain("~/typo");
	});

	// `unknown`, NOT the `ready` the OLD directory earned. `clone_status` is a claim about the path
	// the row holds NOW, so it must move with it — #405's point, applied to an edit instead of an add.
	it("does not let a moved repo keep the previous path's `ready`", async () => {
		const ctx = movableEnv(repoRow({ clone_status: "ready" })); // no machine connected
		const { body } = await put({ workdir: "~/dev/somewhere/else" }, ctx);
		expect(body.repo?.cloneStatus).toBe("unknown");
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("refuses the move while a session is live, and names the session", async () => {
		const ctx = movableEnv(repoRow(), { id: "sess-9", instance_id: INSTANCE, user_id: UID, repo_id: "repo-1", status: "active" });
		const { status, body } = await put({ workdir: "~/dev/elsewhere" }, ctx);
		// The engine's cwd is the old path and moving the row does not move the process: the
		// platform would believe path B while the CLI works in path A, and Claude Code would
		// `--resume` a conversation about different code.
		expect(status).toBe(409);
		expect(body.sessionId).toBe("sess-9");
		expect(ctx.row()).toMatchObject({ workdir: "~/dev/pas/platform/apps/chess-academy" });
	});

	it("does NOT refuse a save that resends the SAME folder while a session is live", async () => {
		// The settings sheet posts the folder on every Save, because the field is always populated.
		// A no-op must stay a no-op, or renaming a repo becomes impossible while it is being worked.
		const ctx = movableEnv(repoRow(), { id: "sess-9", instance_id: INSTANCE, user_id: UID, repo_id: "repo-1", status: "active" });
		const { status } = await put({ name: "chess", workdir: "~/dev/pas/platform/apps/chess-academy" }, ctx);
		expect(status).toBe(200);
		expect(ctx.row()).toMatchObject({ name: "chess" });
		expect(callRunner).not.toHaveBeenCalled(); // nothing moved, nothing to re-check
	});

	it("refuses a BLANK folder — that is a delete, and delete has its own route", async () => {
		const ctx = movableEnv(repoRow());
		const { status, body } = await put({ workdir: "   " }, ctx);
		expect(status).toBe(400);
		expect(body.error).toMatch(/folder is required/i);
		expect(ctx.issued.some((s) => s.sql.startsWith("UPDATE coding_repos"))).toBe(false);
	});

	it("is still owner-scoped — another user's repo is a 404, and is not written", async () => {
		const ctx = movableEnv(null); // getRepo finds nothing for this (user, instance, repo)
		const { status } = await put({ workdir: "~/dev/theirs" }, ctx);
		expect(status).toBe(404);
		expect(ctx.issued.some((s) => s.sql.startsWith("UPDATE coding_repos"))).toBe(false);
	});

	it("leaves the name/urls-only path exactly as it was — no read, no session check, no probe", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		const ctx = movableEnv(repoRow());
		const { status, body } = await put({ name: "renamed" }, ctx);
		expect(status).toBe(200);
		expect(body).toEqual({ ok: true });
		expect(ctx.issued.some((s) => /FROM coding_sessions/.test(s.sql))).toBe(false);
		expect(callRunner).not.toHaveBeenCalled();
	});

	// #322 — the repo DECLARES which standing invariants it claims. The declaration is the whole
	// safety property of the feature, so it is validated at the boundary rather than at the reader.
	describe("standing policies", () => {
		/** The bind index of the policies JSON, and of the flag that says it was supplied at all. */
		const POLICIES = 8;
		const HAS_POLICIES = 9;
		const updateBinds = (ctx: ReturnType<typeof movableEnv>) =>
			ctx.issued.find((s) => s.sql.startsWith("UPDATE coding_repos SET name"))?.binds;

		it("stores a declaration", async () => {
			const ctx = movableEnv(repoRow());
			const { status } = await put({ policies: { "repo.on_default_branch": "observe" } }, ctx);
			expect(status).toBe(200);
			const binds = updateBinds(ctx);
			expect(binds?.[POLICIES]).toBe('{"repo.on_default_branch":"observe"}');
			expect(binds?.[HAS_POLICIES]).toBe(1);
		});

		it("refuses an unknown policy, and writes nothing", async () => {
			const ctx = movableEnv(repoRow());
			const { status, body } = await put({ policies: { "repo.fix_everything": "observe" } }, ctx);
			expect(status).toBe(400);
			expect(body.error).toContain("unknown policy");
			expect(ctx.issued.some((s) => s.sql.startsWith("UPDATE coding_repos"))).toBe(false);
		});

		it("refuses `act` — there is no actuator, so accepting the word would be a promise", async () => {
			const ctx = movableEnv(repoRow());
			const { status, body } = await put({ policies: { "repo.tree_clean": "act" } }, ctx);
			expect(status).toBe(400);
			expect(body.error).toContain("off, observe");
		});

		it("clearing every claim stores NULL, not `{}` — one spelling of declared-nothing", async () => {
			const ctx = movableEnv(repoRow());
			const { status } = await put({ policies: {} }, ctx);
			expect(status).toBe(200);
			const binds = updateBinds(ctx);
			expect(binds?.[POLICIES]).toBeNull();
			expect(binds?.[HAS_POLICIES]).toBe(1);
		});

		it("a request that does not mention policies leaves the column alone", async () => {
			const ctx = movableEnv(repoRow());
			await put({ name: "renamed" }, ctx);
			expect(updateBinds(ctx)?.[HAS_POLICIES]).toBe(0);
		});
	});
});
