/**
 * The hosted-read dispatcher (#221 phase 3).
 *
 * The deliverable here is the SEPARATION. `!repo.githubRepo?.includes("/")` was one expression
 * carrying three claims — hosted at all, coordinate known, host drivable — and fusing them is
 * why a correctly-added GitLab repo was told it "isn't connected to GitHub". Each test below
 * fixes one of those claims and varies only it.
 *
 * The second deliverable is negative and matters more: a GitLab slug must never reach the GitHub
 * client. `group/sub/project` is not an `owner/repo`, so a dispatch that leaked would build an
 * authenticated request against a namespace nobody asked about.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const gh = vi.hoisted(() => ({ listIssues: vi.fn(async () => [{ number: 1, title: "gh", state: "open", labels: [], comments: 0, updatedAt: "", url: "" }]), readIssue: vi.fn(async () => null) }));
const gl = vi.hoisted(() => ({
	listGitlabIssues: vi.fn(async () => [{ number: 3, title: "gl", state: "open", labels: [], comments: 0, updatedAt: "", url: "" }]),
	readGitlabIssue: vi.fn(async () => null),
	listGitlabPipelines: vi.fn(async () => [{ status: "completed", conclusion: "success" }]),
}));
const bb = vi.hoisted(() => ({
	listBitbucketIssues: vi.fn(async () => [{ number: 7, title: "bb", state: "open", labels: [], comments: 0, updatedAt: "", url: "" }]),
	readBitbucketIssue: vi.fn(async () => null),
	listBitbucketPipelines: vi.fn(async () => [{ status: "completed", conclusion: "failure" }]),
}));
/** The three pull-request clients, one per host — the seam this change adds. */
const ghp = vi.hoisted(() => ({ listPulls: vi.fn(async () => [{ number: 1, title: "gh-pr" }]), readPull: vi.fn(async () => ({ number: 1, title: "gh-pr" })) }));
const glp = vi.hoisted(() => ({ listGitlabPulls: vi.fn(async () => [{ number: 3, title: "gl-mr" }]), readGitlabPull: vi.fn(async () => ({ number: 3, title: "gl-mr" })) }));
const bbp = vi.hoisted(() => ({ listBitbucketPulls: vi.fn(async () => [{ number: 7, title: "bb-pr" }]), readBitbucketPull: vi.fn(async () => ({ number: 7, title: "bb-pr" })) }));
vi.mock("./github-issues.js", () => gh);
vi.mock("./gitlab-api.js", () => gl);
vi.mock("./bitbucket-api.js", () => bb);
vi.mock("./github-prs.js", () => ghp);
vi.mock("./gitlab-mrs.js", () => glp);
vi.mock("./bitbucket-prs.js", () => bbp);

import { canReadHosted, hostedCoordinate, hostedReadRefusal, latestHostedBuild, listHostedBuilds, listHostedIssues, listHostedPulls, readHostedPull } from "./hosted-repo.js";
import { readGithubCache } from "./github-cache.js";
import type { Env } from "../types.js";

const env = {} as Env;
afterEach(() => vi.clearAllMocks());

describe("hostedCoordinate", () => {
	it("prefers repoSlug but falls back to githubRepo", () => {
		expect(hostedCoordinate({ provider: "gitlab", repoSlug: "g/s/p" })).toBe("g/s/p");
		// A row written before migration 0097 backfilled the slug — or by an older code path —
		// still carries only the legacy column. A GitHub repo that silently stopped answering
		// because its slug was null is exactly the regression this change must not cause.
		expect(hostedCoordinate({ provider: "github", githubRepo: "acme/widget" })).toBe("acme/widget");
		expect(hostedCoordinate({})).toBe("");
	});
});

describe("hostedReadRefusal — three separate claims, not one", () => {
	it("a GitHub repo with a coordinate is allowed on all three surfaces", () => {
		const repo = { provider: "github", githubRepo: "acme/widget", repoSlug: "acme/widget" };
		for (const f of ["issues", "builds", "pulls"] as const) expect(hostedReadRefusal(repo, f), f).toBeNull();
	});

	it("a repo with NO stored provider still resolves from github_repo", () => {
		// Back-compat for every row written before 0097 — the same rule `git-credentials.ts`
		// applies. `github_repo` present means GitHub; it is the only thing it could have meant.
		expect(hostedReadRefusal({ githubRepo: "acme/widget" }, "issues")).toBeNull();
		expect(hostedReadRefusal({}, "issues")).not.toBeNull();
	});

	it("a GitLab repo with a project path is allowed all three surfaces", () => {
		// It was allowed issues and builds and refused `pulls` while there was no merge-request
		// client. There is one now (`gitlab-mrs.ts`), so the flag moved — independently, which is
		// the whole reason `supports` is three booleans and not one.
		const repo = { provider: "gitlab", repoSlug: "group/sub/project" };
		for (const f of ["issues", "builds", "pulls"] as const) expect(hostedReadRefusal(repo, f), f).toBeNull();
	});

	it("a Bitbucket repo with a workspace/repo slug is allowed all three surfaces", () => {
		const repo = { provider: "bitbucket", repoSlug: "team/widget" };
		for (const f of ["issues", "builds", "pulls"] as const) expect(hostedReadRefusal(repo, f), f).toBeNull();
	});

	it("distinguishes 'we don't know the coordinate' from 'we can't drive this host'", () => {
		// Same provider, same surface, only the slug varies — and the sentence changes.
		const known = hostedReadRefusal({ provider: "gitlab", repoSlug: "g/p" }, "issues");
		const unknown = hostedReadRefusal({ provider: "gitlab", repoSlug: null }, "issues");
		expect(known).toBeNull();
		expect(unknown).toMatch(/project path/);
		expect(unknown).not.toMatch(/yet/);
		// And the other direction: coordinate perfectly well known, surface we have no client for.
		// `other` is the only provider left in that position now that all three hosted rows read
		// pull requests — which is the point: the sentence is chosen by the true reason, not by a
		// provider name someone hardcoded.
		expect(hostedReadRefusal({ provider: "bitbucket", repoSlug: "team/thing" }, "pulls")).toBeNull();
		// …and a host we have no integration for at all, which is a third and different sentence.
		expect(hostedReadRefusal({ provider: "other", repoSlug: "team/thing" }, "issues")).toMatch(/no integration/);
	});

	it("refuses a bare name with no separator, the guard the old expression had", () => {
		expect(hostedReadRefusal({ provider: "github", githubRepo: "platform" }, "issues")).not.toBeNull();
	});

	it("never says 'isn't connected to GitHub' to a repo on another host", () => {
		// Driven with NO coordinate so every provider actually produces a sentence — otherwise
		// this passes vacuously on the two whose surfaces are now all readable.
		for (const provider of ["gitlab", "bitbucket", "other"]) {
			for (const f of ["issues", "builds", "pulls"] as const) {
				const msg = hostedReadRefusal({ provider, repoSlug: null }, f) ?? "";
				expect(msg, `${provider}/${f}`).not.toBe("");
				expect(msg, `${provider}/${f}`).not.toMatch(/connected to GitHub/i);
			}
		}
	});
});

describe("dispatch — the right client, and only the right client", () => {
	it("sends a GitHub repo to the GitHub client", async () => {
		const out = await listHostedIssues(env, "u1", { provider: "github", githubRepo: "acme/widget" });
		expect(gh.listIssues).toHaveBeenCalledTimes(1);
		expect(gl.listGitlabIssues).not.toHaveBeenCalled();
		expect(out[0].title).toBe("gh");
	});

	it("sends a GitLab repo to the GitLab client — the nested slug NEVER reaches GitHub", async () => {
		const out = await listHostedIssues(env, "u1", { provider: "gitlab", repoSlug: "group/sub/project" });
		expect(gl.listGitlabIssues).toHaveBeenCalledTimes(1);
		expect(gh.listIssues).not.toHaveBeenCalled();
		expect(out[0].title).toBe("gl");
	});

	it("sends a Bitbucket repo to the Bitbucket client, and to neither of the others", async () => {
		const out = await listHostedIssues(env, "u1", { provider: "bitbucket", repoSlug: "team/widget" });
		expect(bb.listBitbucketIssues).toHaveBeenCalledTimes(1);
		expect(gh.listIssues).not.toHaveBeenCalled();
		expect(gl.listGitlabIssues).not.toHaveBeenCalled();
		expect(out[0].title).toBe("bb");
	});

	it("calls NO client when the repo is refused", async () => {
		// The refusal is checked before dispatch, so an unsupported host cannot spend a request
		// to be told what the provider table already knows.
		expect(await listHostedIssues(env, "u1", { provider: "other", repoSlug: "team/thing" })).toEqual([]);
		expect(await listHostedIssues(env, "u1", { provider: "local", workdir: "~/x" } as never)).toEqual([]);
		expect(gh.listIssues).not.toHaveBeenCalled();
		expect(gl.listGitlabIssues).not.toHaveBeenCalled();
		expect(bb.listBitbucketIssues).not.toHaveBeenCalled();
	});

	it("turns a Bitbucket null into available:false, exactly as it does for GitLab", async () => {
		bb.listBitbucketPipelines.mockResolvedValueOnce(null as never);
		expect(await latestHostedBuild(env, "u1", { provider: "bitbucket", repoSlug: "t/w" })).toEqual({ available: false, run: null });
		bb.listBitbucketPipelines.mockResolvedValueOnce([] as never);
		expect(await latestHostedBuild(env, "u1", { provider: "bitbucket", repoSlug: "t/w" })).toEqual({ available: true, run: null });
	});

	it("turns a GitLab null (could not ask) into available:false, and [] into available:true", async () => {
		gl.listGitlabPipelines.mockResolvedValueOnce(null as never);
		expect(await latestHostedBuild(env, "u1", { provider: "gitlab", repoSlug: "g/p" })).toEqual({ available: false, run: null });
		gl.listGitlabPipelines.mockResolvedValueOnce([] as never);
		// "Asked, and there are no builds yet" is a different and useful answer from "could not
		// ask" — collapsing them shows a healthy project as permanently unavailable.
		expect(await latestHostedBuild(env, "u1", { provider: "gitlab", repoSlug: "g/p" })).toEqual({ available: true, run: null });
	});

	/**
	 * Pull requests, and the leak that has no shape check.
	 *
	 * A Bitbucket slug `team/widget` IS a well-formed `owner/repo`, so a dispatch mistake here
	 * would build an AUTHENTICATED GitHub request against a namespace nobody asked about — and
	 * nothing downstream would notice, because the request would be perfectly well-formed. Every
	 * assertion below is therefore negative as well as positive.
	 */
	it("sends each host's pull requests to its OWN client, and to no other", async () => {
		expect((await listHostedPulls(env, "u1", { provider: "github", githubRepo: "acme/widget" }))[0].title).toBe("gh-pr");
		expect(ghp.listPulls).toHaveBeenCalledTimes(1);
		expect(glp.listGitlabPulls).not.toHaveBeenCalled();
		expect(bbp.listBitbucketPulls).not.toHaveBeenCalled();
		vi.clearAllMocks();

		// `group/sub/project` is not an `owner/repo` at all — a leak would be caught by shape.
		expect((await listHostedPulls(env, "u1", { provider: "gitlab", repoSlug: "group/sub/project" }))[0].title).toBe("gl-mr");
		expect(glp.listGitlabPulls).toHaveBeenCalledTimes(1);
		expect(ghp.listPulls).not.toHaveBeenCalled();
		expect(bbp.listBitbucketPulls).not.toHaveBeenCalled();
		vi.clearAllMocks();

		// `team/widget` IS one, and this is the assertion that matters most on this seam.
		expect((await listHostedPulls(env, "u1", { provider: "bitbucket", repoSlug: "team/widget" }))[0].title).toBe("bb-pr");
		expect(bbp.listBitbucketPulls).toHaveBeenCalledTimes(1);
		expect(ghp.listPulls).not.toHaveBeenCalled();
		expect(glp.listGitlabPulls).not.toHaveBeenCalled();
	});

	it("reads ONE pull request through the same three-way dispatch", async () => {
		expect((await readHostedPull(env, "u1", { provider: "bitbucket", repoSlug: "team/widget" }, 7))?.title).toBe("bb-pr");
		expect(bbp.readBitbucketPull).toHaveBeenCalledWith(env, "u1", "team/widget", 7);
		expect(ghp.readPull).not.toHaveBeenCalled();
		expect(glp.readGitlabPull).not.toHaveBeenCalled();
		vi.clearAllMocks();
		expect((await readHostedPull(env, "u1", { provider: "gitlab", repoSlug: "group/sub/project" }, 3))?.title).toBe("gl-mr");
		expect(glp.readGitlabPull).toHaveBeenCalledWith(env, "u1", "group/sub/project", 3);
		expect(ghp.readPull).not.toHaveBeenCalled();
	});

	it("passes the caller's list options through UNCHANGED to whichever client answers", async () => {
		// `state`/`limit`/`enrich` are the panel's controls; a dispatcher that dropped them would
		// silently serve open PRs to someone who asked for closed ones.
		await listHostedPulls(env, "u1", { provider: "gitlab", repoSlug: "g/p" }, { state: "closed", enrich: false, limit: 5 });
		expect(glp.listGitlabPulls).toHaveBeenCalledWith(env, "u1", "g/p", { state: "closed", enrich: false, limit: 5 });
	});

	it("calls NO pull client for a local checkout or an unintegrated host", async () => {
		expect(await listHostedPulls(env, "u1", { provider: "local" })).toEqual([]);
		expect(await listHostedPulls(env, "u1", { provider: "other", repoSlug: "x/y" })).toEqual([]);
		// A hosted provider with no recorded coordinate must not be asked either — the bare-name
		// guard the five original call sites had.
		expect(await listHostedPulls(env, "u1", { provider: "gitlab", repoSlug: "project" })).toEqual([]);
		expect(await readHostedPull(env, "u1", { provider: "other", repoSlug: "x/y" }, 1)).toBeNull();
		expect(ghp.listPulls).not.toHaveBeenCalled();
		expect(glp.listGitlabPulls).not.toHaveBeenCalled();
		expect(bbp.listBitbucketPulls).not.toHaveBeenCalled();
	});

	it("canReadHosted agrees with hostedReadRefusal, so the panel and the routes cannot drift", () => {
		for (const repo of [{ provider: "github", githubRepo: "a/b" }, { provider: "gitlab", repoSlug: "g/s/p" }, { provider: "bitbucket", repoSlug: "t/w" }, { provider: "local" }, { provider: "other", repoSlug: "x/y" }]) {
			for (const f of ["issues", "builds", "pulls"] as const) {
				expect(canReadHosted(repo, f), `${repo.provider}/${f}`).toBe(hostedReadRefusal(repo, f) === null);
			}
		}
	});
});

/**
 * `/deployments` — the platform's ONLY unauthenticated GitHub read, made conditional (#439).
 *
 * The budget it spends is ~60 requests/hour PER IP, shared by every unauthenticated caller on the
 * same Cloudflare egress — not per user. It is the smallest budget the platform spends against
 * and the only one it does not spend on the caller's behalf, and the Builds panel POLLS it. So
 * the case that matters is the anonymous one, and that is the one these tests drive: with no
 * GitHub App configured `resolveGithubRead` yields `token:null` and `authContext:"anon"` — a
 * first-class cache identity, since only a `null` context means "do not cache".
 *
 * Everything runs through `listHostedBuilds` itself rather than through the cache module:
 * re-testing the cache would only re-prove the cache. What was missing here was the WIRING.
 */
describe("listHostedBuilds — the unauthenticated /deployments read is conditional (#439)", () => {
	/** An in-memory `OAUTH_KV`, and deliberately NO GitHub App — this is the anonymous path. */
	function kvEnv() {
		const store = new Map<string, string>();
		return {
			OAUTH_KV: {
				get: async (k: string) => store.get(k) ?? null,
				put: async (k: string, v: string) => {
					store.set(k, v);
				},
				delete: async (k: string) => {
					store.delete(k);
				},
			},
		} as unknown as Env;
	}

	/** A Response double with real headers, so the ETag round trip is actually exercised. */
	function ghResponse(status: number, body: unknown, etag?: string) {
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (h: string) => (h.toLowerCase() === "etag" && etag ? etag : null) },
			json: async () => body,
		} as unknown as Response;
	}

	const ANON = { userId: "u1", authContext: "anon" };
	const REPO = { provider: "github", githubRepo: "acme/public", repoSlug: "acme/public" };
	const runsBody = (n: number) => ({
		workflow_runs: [
			{ id: n, run_number: n, status: "completed", conclusion: "success", name: "deploy", html_url: "u", head_branch: "main", head_sha: "abcdef1234", updated_at: "t" },
		],
	});
	const realFetch = globalThis.fetch;

	/** Replace `fetch` with a double that records what was actually sent upstream. */
	function spy(...responses: Array<Response | Error>) {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		let i = 0;
		globalThis.fetch = vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
			calls.push({ url: String(url), headers: init?.headers ?? {} });
			const r = responses[Math.min(i++, responses.length - 1)];
			if (r instanceof Error) throw r;
			return r;
		}) as unknown as typeof fetch;
		return calls;
	}

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("asks GitHub with NO credential and stores the ETag — the fallback is unchanged, it is now cacheable", async () => {
		const env = kvEnv();
		const calls = spy(ghResponse(200, runsBody(7), 'W/"b1"'));
		const runs = await listHostedBuilds(env, "u1", REPO, { page: 1, perPage: 20 });
		expect(runs).toEqual([{ status: "completed", conclusion: "success", name: "deploy", runNumber: 7, url: "u", branch: "main", sha: "abcdef1", updatedAt: "t" }]);
		// The unauthenticated fallback IS this route (CODER-010, #121): no Authorization header,
		// and no `If-None-Match` on the first read because there is nothing stored yet.
		expect(calls[0].headers.Authorization).toBeUndefined();
		expect(calls[0].headers["If-None-Match"]).toBeUndefined();
		expect(await readGithubCache(env, ANON, "acme/public", "runs")).not.toBeNull();
	});

	it("a second poll of an unchanged repo costs a 304 and no rate-limit unit, and returns the SAME payload", async () => {
		const env = kvEnv();
		spy(ghResponse(200, runsBody(7), 'W/"b1"'));
		const first = await listHostedBuilds(env, "u1", REPO, { page: 1, perPage: 20 });
		const calls = spy(ghResponse(304, null));
		const second = await listHostedBuilds(env, "u1", REPO, { page: 1, perPage: 20 });
		expect(calls[0].headers["If-None-Match"]).toBe('W/"b1"');
		// Page 1 merges the live runs into the durable KV history and persists it
		// (`mergeRuns`/`persistBuildHistory`, in the route). So a cached hit must hand the route
		// exactly what the plain fetch handed it — asserted here rather than assumed, at this
		// boundary because the route itself is not this change's to touch.
		expect(second).toEqual(first);
	});

	it("keeps deeper pages apart from page 1 — the query string IS the cache variant", async () => {
		const env = kvEnv();
		spy(ghResponse(200, runsBody(7), 'W/"b1"'));
		await listHostedBuilds(env, "u1", REPO, { page: 1, perPage: 20 });
		// Page 2 is a different read of the same resource. Sending page 1's ETag would let GitHub
		// answer 304 and the cache serve page 1's runs as page 2's history.
		let calls = spy(ghResponse(200, runsBody(2), 'W/"b2"'));
		const page2 = await listHostedBuilds(env, "u1", REPO, { page: 2, perPage: 20 });
		expect(calls[0].url).toContain("page=2");
		expect(calls[0].headers["If-None-Match"]).toBeUndefined();
		expect(page2?.[0].runNumber).toBe(2);
		// Both variants live in the one entry, and each replays its own.
		calls = spy(ghResponse(304, null));
		expect(await listHostedBuilds(env, "u1", REPO, { page: 2, perPage: 20 })).toEqual(page2);
		expect(calls[0].headers["If-None-Match"]).toBe('W/"b2"');
		calls = spy(ghResponse(304, null));
		expect((await listHostedBuilds(env, "u1", REPO, { page: 1, perPage: 20 }))?.[0].runNumber).toBe(7);
		expect(calls[0].headers["If-None-Match"]).toBe('W/"b1"');
	});

	it("still answers `null` — 'could not ask' — on every GitHub failure, and never throws", async () => {
		// The route's `{available:false}` rests entirely on this, and a throw would reach it as a
		// 500 instead. A 304 with nothing stored is a failure too, not an invented empty history.
		for (const r of [ghResponse(404, null), ghResponse(500, null), new Error("network down"), ghResponse(304, null)]) {
			const env = kvEnv();
			spy(r);
			expect(await listHostedBuilds(env, "u1", REPO, { page: 1, perPage: 20 })).toBeNull();
		}
	});

	it("keeps the 403-invalidates / 5xx-serves-stale asymmetry — a tenancy control, not an optimisation", async () => {
		const env = kvEnv();
		spy(ghResponse(200, runsBody(7), 'W/"b1"'));
		const seeded = await listHostedBuilds(env, "u1", REPO, { page: 1, perPage: 20 });

		// Unreachable says nothing about permission, so the stored copy is served.
		spy(ghResponse(502, null));
		expect(await listHostedBuilds(env, "u1", REPO, { page: 1, perPage: 20 })).toEqual(seeded);
		spy(new Error("boom"));
		expect(await listHostedBuilds(env, "u1", REPO, { page: 1, perPage: 20 })).toEqual(seeded);
		expect(await readGithubCache(env, ANON, "acme/public", "runs")).not.toBeNull();

		// A 403 means access CHANGED — the stored copy was fetched under an authority the caller
		// may no longer have, so it is dropped rather than served.
		spy(ghResponse(403, null));
		expect(await listHostedBuilds(env, "u1", REPO, { page: 1, perPage: 20 })).toBeNull();
		expect(await readGithubCache(env, ANON, "acme/public", "runs")).toBeNull();
	});

	it("with no KV at all the cache is simply OFF — the caller behaves exactly as before it existed", async () => {
		const calls = spy(ghResponse(200, runsBody(7), 'W/"b1"'));
		const env = {} as Env;
		await listHostedBuilds(env, "u1", REPO, { page: 1, perPage: 20 });
		await listHostedBuilds(env, "u1", REPO, { page: 1, perPage: 20 });
		expect(calls).toHaveLength(2);
		expect(calls[1].headers["If-None-Match"]).toBeUndefined();
	});

	it("the aggregate /builds fan-out STILL refuses to spend the anonymous budget", async () => {
		// The asymmetry #121 established, which this change must not erase: `/deployments` falls
		// back to an unauthenticated read, `latestHostedBuild` does not — one repo's drill-down can
		// afford a shared ~60/hr budget; N repos per poll cannot.
		const calls = spy(ghResponse(200, runsBody(7), 'W/"b1"'));
		expect(await latestHostedBuild(kvEnv(), "u1", REPO)).toEqual({ available: false, run: null });
		expect(calls).toHaveLength(0);
	});
});
