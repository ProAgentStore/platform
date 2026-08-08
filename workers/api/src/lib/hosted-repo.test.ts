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
vi.mock("./github-issues.js", () => gh);
vi.mock("./gitlab-api.js", () => gl);

import { canReadHosted, hostedCoordinate, hostedReadRefusal, latestHostedBuild, listHostedIssues } from "./hosted-repo.js";
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

	it("a GitLab repo is allowed issues and builds, and refused pull requests", () => {
		const repo = { provider: "gitlab", repoSlug: "group/sub/project" };
		expect(hostedReadRefusal(repo, "issues")).toBeNull();
		expect(hostedReadRefusal(repo, "builds")).toBeNull();
		expect(hostedReadRefusal(repo, "pulls")).toContain("GitLab");
	});

	it("distinguishes 'we don't know the coordinate' from 'we can't drive this host'", () => {
		// Same provider, same surface, only the slug varies — and the sentence changes.
		const known = hostedReadRefusal({ provider: "gitlab", repoSlug: "g/p" }, "issues");
		const unknown = hostedReadRefusal({ provider: "gitlab", repoSlug: null }, "issues");
		expect(known).toBeNull();
		expect(unknown).toMatch(/project path/);
		expect(unknown).not.toMatch(/yet/);
		// And the other direction: coordinate perfectly well known, host we have no client for.
		expect(hostedReadRefusal({ provider: "bitbucket", repoSlug: "team/thing" }, "issues")).toMatch(/yet/);
	});

	it("refuses a bare name with no separator, the guard the old expression had", () => {
		expect(hostedReadRefusal({ provider: "github", githubRepo: "platform" }, "issues")).not.toBeNull();
	});

	it("never says 'isn't connected to GitHub' to a repo on another host", () => {
		for (const provider of ["gitlab", "bitbucket", "other"]) {
			const msg = hostedReadRefusal({ provider, repoSlug: "a/b" }, "pulls") ?? "";
			expect(msg, provider).not.toMatch(/connected to GitHub/i);
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

	it("calls NO client when the repo is refused", async () => {
		// The refusal is checked before dispatch, so an unsupported host cannot spend a request
		// to be told what the provider table already knows.
		expect(await listHostedIssues(env, "u1", { provider: "bitbucket", repoSlug: "team/thing" })).toEqual([]);
		expect(await listHostedIssues(env, "u1", { provider: "local", workdir: "~/x" } as never)).toEqual([]);
		expect(gh.listIssues).not.toHaveBeenCalled();
		expect(gl.listGitlabIssues).not.toHaveBeenCalled();
	});

	it("turns a GitLab null (could not ask) into available:false, and [] into available:true", async () => {
		gl.listGitlabPipelines.mockResolvedValueOnce(null as never);
		expect(await latestHostedBuild(env, "u1", { provider: "gitlab", repoSlug: "g/p" })).toEqual({ available: false, run: null });
		gl.listGitlabPipelines.mockResolvedValueOnce([] as never);
		// "Asked, and there are no builds yet" is a different and useful answer from "could not
		// ask" — collapsing them shows a healthy project as permanently unavailable.
		expect(await latestHostedBuild(env, "u1", { provider: "gitlab", repoSlug: "g/p" })).toEqual({ available: true, run: null });
	});

	it("canReadHosted agrees with hostedReadRefusal, so the panel and the routes cannot drift", () => {
		for (const repo of [{ provider: "github", githubRepo: "a/b" }, { provider: "gitlab", repoSlug: "g/s/p" }, { provider: "local" }, { provider: "other", repoSlug: "x/y" }]) {
			for (const f of ["issues", "builds", "pulls"] as const) {
				expect(canReadHosted(repo, f), `${repo.provider}/${f}`).toBe(hostedReadRefusal(repo, f) === null);
			}
		}
	});
});
