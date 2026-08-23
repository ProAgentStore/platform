/**
 * The Pulls routes, driven as the OWNER (#401).
 *
 * `coding.contract.test.ts` already drives every coding route as a stranger and pins the tenant
 * gate. This one is about what the owner is told on the far side of it: the panel's payload, the
 * agent-attribution badge, the Layer-1 ETag/304, and the honest per-provider refusal for a repo
 * that has no GitHub coordinate to ask about.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { pullsETag, registerPullRoutes, withAttribution } from "./coding-pulls.js";
import type { PullSummary } from "../lib/github-prs.js";
import type { Env } from "../types.js";

// The route goes through `hosted-repo.ts`'s dispatcher, so the REAL dispatch runs here and only
// the three per-host clients are doubled. That is deliberate: mocking the dispatcher would leave
// the one decision this route makes — which host to ask — untested at the route level.
const { listPulls, readPull } = vi.hoisted(() => ({ listPulls: vi.fn(), readPull: vi.fn() }));
const { listGitlabPulls, readGitlabPull } = vi.hoisted(() => ({ listGitlabPulls: vi.fn(), readGitlabPull: vi.fn() }));
const { listBitbucketPulls, readBitbucketPull } = vi.hoisted(() => ({ listBitbucketPulls: vi.fn(), readBitbucketPull: vi.fn() }));
vi.mock("../lib/github-prs.js", () => ({ listPulls, readPull }));
vi.mock("../lib/gitlab-mrs.js", () => ({ listGitlabPulls, readGitlabPull }));
vi.mock("../lib/bitbucket-prs.js", () => ({ listBitbucketPulls, readBitbucketPull }));

const SECRET = "coding-pulls-test-secret";
const UID = "user-1";
const INSTANCE = "inst-1";

const PULL: PullSummary = {
	number: 42,
	title: "Fix the flake",
	state: "open",
	draft: false,
	merged: false,
	author: "coder-bot",
	branch: "fix/flake",
	baseBranch: "main",
	headSha: "abc123",
	labels: ["bug"],
	comments: 1,
	createdAt: "2026-08-01T00:00:00Z",
	updatedAt: "2026-08-02T00:00:00Z",
	url: "https://github.com/acme/widget/pull/42",
	reviewersRequested: 0,
	mergeable: true,
	mergeableState: "clean",
	review: "approved",
	checks: { status: "completed", conclusion: "success" },
};

/** A D1 that resolves ownership, hands back one repo, and answers the act scan with `acts`. */
function ownerEnv(repo: Record<string, unknown> | null, acts: Array<Record<string, unknown>> = []) {
	const DB = {
		prepare(sql: string) {
			const flat = sql.replace(/\s+/g, " ").trim();
			const stmt = {
				bind: () => stmt,
				first: async () => (/FROM agent_instances/.test(flat) ? { id: INSTANCE } : /FROM coding_repos/.test(flat) ? repo : null),
				all: async () => ({ results: /FROM agent_events/.test(flat) ? acts : [] }),
				run: async () => ({ meta: { changes: 0 } }),
			};
			return stmt;
		},
	};
	return { SESSION_SIGNING_KEY: SECRET, DB } as unknown as Env;
}

function buildApp(repo: Record<string, unknown> | null, acts: Array<Record<string, unknown>> = []) {
	const env = ownerEnv(repo, acts);
	const app = new Hono<{ Bindings: Env }>();
	const routes = new Hono<{ Bindings: Env }>();
	registerPullRoutes(routes);
	app.route("/v1/instances", routes);
	app.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
	return { app, env };
}

const GH_REPO = { id: "repo-1", instance_id: INSTANCE, user_id: UID, name: "widget", github_repo: "acme/widget", provider: "github" };
const LOCAL_REPO = { id: "repo-1", instance_id: INSTANCE, user_id: UID, name: "widget", github_repo: null, provider: "local" };
const GL_REPO = { id: "repo-1", instance_id: INSTANCE, user_id: UID, name: "project", github_repo: null, provider: "gitlab", repo_slug: "group/sub/project" };
const BB_REPO = { id: "repo-1", instance_id: INSTANCE, user_id: UID, name: "widget", github_repo: null, provider: "bitbucket", repo_slug: "team/widget" };

async function get(app: Hono<{ Bindings: Env }>, env: Env, path: string, headers: Record<string, string> = {}) {
	const token = await signSession(UID, SECRET, { roles: ["user"] });
	return app.request(`/v1/instances/${INSTANCE}/coding/repos/repo-1${path}`, { headers: { Authorization: `Bearer ${token}`, ...headers } }, env);
}

beforeEach(() => {
	listPulls.mockReset();
	readPull.mockReset();
	listGitlabPulls.mockReset();
	readGitlabPull.mockReset();
	listBitbucketPulls.mockReset();
	readBitbucketPull.mockReset();
});

describe("GET …/pulls", () => {
	it("returns the repo's pull requests for its owner", async () => {
		listPulls.mockResolvedValue([PULL]);
		const { app, env } = buildApp(GH_REPO);
		const res = await get(app, env, "/pulls");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { repo: string; pulls: Array<Record<string, unknown>> };
		expect(body.repo).toBe("acme/widget");
		expect(body.pulls[0]).toMatchObject({ number: 42, review: "approved", mergeable: true });
	});

	it("shows ALL pull requests, not only the agent's — the panel is a view of the repo", async () => {
		listPulls.mockResolvedValue([PULL, { ...PULL, number: 43, author: "a-human" }]);
		const { app, env } = buildApp(GH_REPO, [
			{ trace_id: "run-9", ts: 1, context: JSON.stringify({ act: "pr.open", target: "#42", sessionId: "s1" }) },
		]);
		const body = (await (await get(app, env, "/pulls")).json()) as { pulls: Array<Record<string, unknown>> };
		expect(body.pulls).toHaveLength(2);
		// The agent's is BADGED rather than the human's being hidden.
		expect(body.pulls[0].agentAct).toMatchObject({ traceId: "run-9", act: "pr.open" });
		expect(body.pulls[1].agentAct).toBeNull();
	});

	it("passes ?state through and honours ?enrich=0", async () => {
		listPulls.mockResolvedValue([]);
		const { app, env } = buildApp(GH_REPO);
		await get(app, env, "/pulls?state=all&enrich=0");
		expect(listPulls).toHaveBeenCalledWith(expect.anything(), UID, "acme/widget", { state: "all", enrich: false });
	});

	it("falls back to open for a state it does not know", async () => {
		listPulls.mockResolvedValue([]);
		const { app, env } = buildApp(GH_REPO);
		await get(app, env, "/pulls?state=nonsense");
		expect(listPulls).toHaveBeenCalledWith(expect.anything(), UID, "acme/widget", { state: "open", enrich: true });
	});

	it("answers If-None-Match with a 304 when nothing changed (Layer 1)", async () => {
		listPulls.mockResolvedValue([PULL]);
		const { app, env } = buildApp(GH_REPO);
		const first = await get(app, env, "/pulls");
		const etag = first.headers.get("ETag");
		expect(etag).toBeTruthy();
		const second = await get(app, env, "/pulls", { "If-None-Match": etag as string });
		expect(second.status).toBe(304);
		expect(await second.text()).toBe("");
	});

	it("does NOT 304 once a review lands — the ETag covers the whole body, not just the newest row", async () => {
		listPulls.mockResolvedValue([PULL]);
		const { app, env } = buildApp(GH_REPO);
		const etag = (await get(app, env, "/pulls")).headers.get("ETag") as string;
		listPulls.mockResolvedValue([{ ...PULL, review: "changes_requested" }]);
		const again = await get(app, env, "/pulls", { "If-None-Match": etag });
		expect(again.status).toBe(200);
	});

	it("asks the repo's OWN host — a Bitbucket slug never reaches api.github.com", async () => {
		// The leak this route is the last line of defence against: `team/widget` is a perfectly
		// well-formed `owner/repo`, so calling the GitHub client would build an AUTHENTICATED
		// request against a GitHub namespace nobody asked about, and every shape check downstream
		// would pass. Asserting the negative is the only thing that catches it.
		listBitbucketPulls.mockResolvedValue([{ ...PULL, url: "https://bitbucket.org/team/widget/pull-requests/42" }]);
		const bb = buildApp(BB_REPO);
		const res = await get(bb.app, bb.env, "/pulls");
		expect(res.status).toBe(200);
		expect(((await res.json()) as { repo: string }).repo).toBe("team/widget");
		expect(listBitbucketPulls).toHaveBeenCalledWith(expect.anything(), UID, "team/widget", { state: "open", enrich: true });
		expect(listPulls).not.toHaveBeenCalled();
		expect(listGitlabPulls).not.toHaveBeenCalled();

		// And the nested GitLab path, which cannot be an `owner/repo` at all.
		listGitlabPulls.mockResolvedValue([PULL]);
		const gl = buildApp(GL_REPO);
		expect((await get(gl.app, gl.env, "/pulls")).status).toBe(200);
		expect(listGitlabPulls).toHaveBeenCalledWith(expect.anything(), UID, "group/sub/project", { state: "open", enrich: true });
		expect(listPulls).not.toHaveBeenCalled();
	});

	it("refuses a repo with no GitHub coordinate by naming its provider, not a setup mistake", async () => {
		const { app, env } = buildApp(LOCAL_REPO);
		const res = await get(app, env, "/pulls");
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(/local checkout/);
		expect(listPulls).not.toHaveBeenCalled();
	});

	it("404s for a repo the caller does not have", async () => {
		const { app, env } = buildApp(null);
		expect((await get(app, env, "/pulls")).status).toBe(404);
	});
});

describe("GET …/pulls/:number", () => {
	it("returns one pull request with its attribution", async () => {
		readPull.mockResolvedValue({ ...PULL, body: "why", additions: 1, deletions: 0, changedFiles: 1 });
		const { app, env } = buildApp(GH_REPO, [
			{ trace_id: "run-9", ts: 1, context: JSON.stringify({ act: "pr.open", target: "#42" }) },
		]);
		const body = (await (await get(app, env, "/pulls/42")).json()) as { pull: Record<string, unknown> };
		expect(body.pull).toMatchObject({ number: 42, body: "why" });
		expect(body.pull.agentAct).toMatchObject({ traceId: "run-9" });
	});

	it("rejects a non-numeric number before asking GitHub", async () => {
		const { app, env } = buildApp(GH_REPO);
		const res = await get(app, env, "/pulls/abc");
		expect(res.status).toBe(400);
		expect(readPull).not.toHaveBeenCalled();
	});

	it("404s a pull request that is not there", async () => {
		readPull.mockResolvedValue(null);
		const { app, env } = buildApp(GH_REPO);
		expect((await get(app, env, "/pulls/999")).status).toBe(404);
	});
});

describe("pullsETag / withAttribution", () => {
	it("is stable for identical bodies and different for any change", () => {
		expect(pullsETag("a")).toBe(pullsETag("a"));
		expect(pullsETag("a")).not.toBe(pullsETag("b"));
		expect(pullsETag("")).toMatch(/^W\/"pulls-/);
	});

	it("attributes exactly the numbers it has an act for", () => {
		const acts = new Map([[42, { traceId: "r", act: "pr.open", at: "2026-08-01T00:00:00Z", sessionId: null }]]);
		const rows = withAttribution([PULL, { ...PULL, number: 7 }], acts);
		expect(rows[0].agentAct?.traceId).toBe("r");
		expect(rows[1].agentAct).toBeNull();
	});
});
