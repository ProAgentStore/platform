/**
 * The Bitbucket read client (#221 phase 4).
 *
 * Four things here are decisions rather than transcription — each looks correct in review and is
 * wrong in production — so each has a test that fails on the obvious mistake. All four were
 * settled against the LIVE public API (`atlassian/fugue` for issues,
 * `bitbucketpipelines/example-aws-s3-deploy` for pipelines), because the condition #221's own
 * deferral comment named still holds: nobody here has a Bitbucket account, so the shapes had to
 * come from the wire rather than from documentation.
 *
 *   1. an issue's `id` IS its number here (unlike GitLab, where `id` is a global counter)
 *   2. there is no comment count in the payload at all
 *   3. there are no labels — `kind`/`priority` are what a human sees, and the filter must agree
 *   4. a pipeline has NO `links.html`, so its web URL is constructed
 *
 * (4) is the load-bearing one: transcribing `links.html.href` the way the other two clients do
 * would have put an empty string in every Builds row on this provider.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { bitbucketRepoPath, listBitbucketIssues, listBitbucketPipelines, mapPipelineState, readBitbucketIssue } from "./bitbucket-api.js";
import type { Env } from "../types.js";

// No KEY_ENCRYPTION_KEY and no DB: `readConnectorRefreshToken` throws, the client swallows it,
// and the read goes out UNAUTHENTICATED — which is the ordinary path for a public repo and the
// one that must not become an exception.
const env = {} as Env;

function stubFetch(body: unknown, status = 200) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
			return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
		}),
	);
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("bitbucketRepoPath", () => {
	it("takes exactly workspace/repo — Bitbucket namespaces do NOT nest", () => {
		expect(bitbucketRepoPath("team/widget")).toEqual({ workspace: "team", repo: "widget" });
		// A third segment on Bitbucket is a browser path that got kept, not a subgroup. Accepting
		// it — the way the GitLab client must — would build a request against a path that is not
		// a repository.
		expect(bitbucketRepoPath("team/widget/src/main")).toBeNull();
		expect(bitbucketRepoPath("widget")).toBeNull();
		expect(bitbucketRepoPath("")).toBeNull();
	});

	it("refuses a segment that could smuggle a query or path into the request", () => {
		// Defence in depth, matching `github-issues.ts` and `gitlab-api.ts`. The segments are
		// interpolated into an authenticated URL; a charset check means no upstream caller's
		// mistake becomes one here.
		expect(bitbucketRepoPath("team/widget?pagelen=100")).toBeNull();
		expect(bitbucketRepoPath("team/../admin")).toBeNull();
		expect(bitbucketRepoPath("team/wid get")).toBeNull();
		expect(bitbucketRepoPath("-team/widget")).toBeNull();
	});
});

describe("listBitbucketIssues", () => {
	// Trimmed from the live payload of atlassian/fugue.
	const raw = {
		values: [
			{
				id: 72,
				title: "5.0.0 of fugue-parent not in MVN central",
				state: "resolved",
				kind: "bug",
				priority: "blocker",
				updated_on: "2025-02-10T09:04:58.907022+00:00",
				links: { html: { href: "https://bitbucket.org/atlassian/fugue/issues/72/500-of-fugue-parent" } },
				content: { raw: "body text" },
			},
			{ id: 73, title: "Open one", state: "new", kind: "enhancement", priority: "minor", updated_on: "2025-01-01T00:00:00+00:00", links: { html: { href: "u73" } } },
		],
	};

	it("maps `id` to the issue number — the opposite of GitLab, where `id` is global", async () => {
		stubFetch(raw);
		const out = await listBitbucketIssues(env, "u1", "atlassian/fugue");
		expect(out[0].number).toBe(72);
		expect(out[0].url).toContain("/issues/72/");
	});

	it("reports NO comment count rather than inventing one", async () => {
		// The payload has `links.comments` (a URL) and no count anywhere. 0 means "unknown"; the
		// alternative is an N+1 fetch per issue against a rate-limited API for a grey number.
		stubFetch(raw);
		const out = await listBitbucketIssues(env, "u1", "atlassian/fugue");
		expect(out.every((i) => i.comments === 0)).toBe(true);
	});

	it("collapses eight Bitbucket states into the two words every caller filters on", async () => {
		stubFetch(raw);
		const out = await listBitbucketIssues(env, "u1", "atlassian/fugue");
		// `resolved` is done-with; `new` is still on the board. Neither word exists on GitHub, and
		// teaching the console a third vocabulary is what this normalisation avoids.
		expect(out.map((i) => i.state)).toEqual(["closed", "open"]);
	});

	it("surfaces kind + priority AS labels, because Bitbucket has none", async () => {
		stubFetch(raw);
		const out = await listBitbucketIssues(env, "u1", "atlassian/fugue");
		expect(out[0].labels).toEqual(["bug", "blocker"]);
	});

	it("filters on the SAME synthesized labels a reader sees — in process, not as a q clause", async () => {
		// The two must be one vocabulary: a filter matching something the panel never displays is
		// indistinguishable from a broken repo. Client-side also keeps the request URL built only
		// from the closed state enum, so no caller-supplied field can move where it is sent.
		const calls = stubFetch(raw);
		const out = await listBitbucketIssues(env, "u1", "atlassian/fugue", { state: "all", labels: "enhancement" });
		expect(out.map((i) => i.number)).toEqual([73]);
		expect(calls[0].url).not.toContain("enhancement");
	});

	it("builds the state filter from the enum, and OMITS it entirely for `all`", async () => {
		// Bitbucket answers a `q` it cannot satisfy with 200 and an EMPTY LIST, not a 400 — so a
		// query built wrong looks exactly like a repo with no issues. Deriving it from the enum is
		// what makes that unreachable.
		// `URLSearchParams` writes a space as `+`. That is form encoding, not percent encoding, and
		// whether an API's own query parser accepts it is a fact about that API — so it was checked
		// against the live one: the `+` form and the `%20` form return the identical 200 and the
		// identical rows. `readable` therefore undoes both, and asserts the clause that goes out.
		const readable = (url: string) => decodeURIComponent(url).replace(/\+/g, " ");
		const open = stubFetch(raw);
		await listBitbucketIssues(env, "u1", "atlassian/fugue", { state: "open" });
		expect(readable(open[0].url)).toContain('(state="new" OR state="open" OR state="on hold")');
		vi.unstubAllGlobals();
		const closed = stubFetch(raw);
		await listBitbucketIssues(env, "u1", "atlassian/fugue", { state: "closed" });
		expect(readable(closed[0].url)).toContain('state="wontfix"');
		vi.unstubAllGlobals();
		const all = stubFetch(raw);
		await listBitbucketIssues(env, "u1", "atlassian/fugue", { state: "all" });
		expect(all[0].url).not.toContain("q=");
	});

	it("asks unauthenticated when there is no stored token, rather than not asking", async () => {
		const calls = stubFetch(raw);
		await listBitbucketIssues(env, "u1", "atlassian/fugue");
		expect(calls[0].headers.Authorization).toBeUndefined();
		expect(calls[0].url).toContain("api.bitbucket.org/2.0/repositories/atlassian/fugue/issues");
	});

	it("degrades to [] when the ISSUE TRACKER IS OFF — Bitbucket answers 410, not 404", async () => {
		// Verified live: a repo with `has_issues:false` returns `410 {"error":{"message":"Gone"}}`.
		// It is the default for a new repo and not something re-authenticating fixes, so it has to
		// read as "no issues" rather than as a broken panel.
		stubFetch({ type: "error", error: { message: "Gone" } }, 410);
		expect(await listBitbucketIssues(env, "u1", "atlassian/fugue")).toEqual([]);
	});

	it("degrades to [] on a non-array body and a network error", async () => {
		stubFetch({ values: "nope" });
		expect(await listBitbucketIssues(env, "u1", "team/widget")).toEqual([]);
		vi.unstubAllGlobals();
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
		expect(await listBitbucketIssues(env, "u1", "team/widget")).toEqual([]);
	});

	it("makes no request at all for a malformed slug", async () => {
		const calls = stubFetch(raw);
		expect(await listBitbucketIssues(env, "u1", "team/widget/extra")).toEqual([]);
		expect(calls).toHaveLength(0);
	});
});

describe("a Bitbucket slug NEVER reaches another provider's API", () => {
	it("every request this client builds goes to api.bitbucket.org and nowhere else", async () => {
		// The mirror of the GitLab dispatch test, and the same reason: `team/widget` is a
		// perfectly well-formed `owner/repo`, so a leak here would not be caught by a shape check
		// — it would build an authenticated request against someone else's namespace of the same
		// name. The host is a module constant precisely so this can be asserted.
		const calls = stubFetch({ values: [] });
		await listBitbucketIssues(env, "u1", "team/widget");
		await readBitbucketIssue(env, "u1", "team/widget", 3);
		await listBitbucketPipelines(env, "u1", "team/widget");
		expect(calls).toHaveLength(3);
		for (const c of calls) {
			expect(new URL(c.url).host).toBe("api.bitbucket.org");
		}
	});
});

describe("readBitbucketIssue", () => {
	it("caps the body, which lives under content.raw and not `body`", async () => {
		stubFetch({ id: 72, title: "t", state: "new", kind: "bug", updated_on: "x", links: { html: { href: "u" } }, content: { raw: "z".repeat(9000) } });
		const issue = await readBitbucketIssue(env, "u1", "atlassian/fugue", 72);
		expect(issue?.number).toBe(72);
		expect(issue?.body.length).toBe(8 * 1024);
	});

	it("returns null for a body with no id, rather than an issue numbered 0", async () => {
		stubFetch({ title: "t" });
		expect(await readBitbucketIssue(env, "u1", "atlassian/fugue", 72)).toBeNull();
	});
});

describe("mapPipelineState", () => {
	it("carries a verdict only when the pipeline is COMPLETED — and reads it from result.name", () => {
		expect(mapPipelineState({ name: "COMPLETED", result: { name: "SUCCESSFUL" } })).toEqual({ status: "completed", conclusion: "success" });
		expect(mapPipelineState({ name: "COMPLETED", result: { name: "FAILED" } })).toEqual({ status: "completed", conclusion: "failure" });
		// ERROR is a Bitbucket-side fault rather than a failing build, but to every consumer of a
		// BuildRun it is the same thing: the run finished and it did not pass.
		expect(mapPipelineState({ name: "COMPLETED", result: { name: "ERROR" } })).toEqual({ status: "completed", conclusion: "failure" });
		expect(mapPipelineState({ name: "COMPLETED", result: { name: "STOPPED" } })).toEqual({ status: "completed", conclusion: "cancelled" });
	});

	it("gives unfinished work a NULL conclusion, so the panel can't paint it as failed", () => {
		expect(mapPipelineState({ name: "PENDING" })).toEqual({ status: "queued", conclusion: null });
		expect(mapPipelineState({ name: "IN_PROGRESS" })).toEqual({ status: "in_progress", conclusion: null });
	});

	it("describes a manual gate with the SAME words GitLab's `manual` gets", () => {
		// One state, one vocabulary. Two providers describing "waiting for a human" differently is
		// how a console ends up with a per-provider special case.
		expect(mapPipelineState({ name: "HALTED" })).toEqual({ status: "completed", conclusion: "action_required" });
	});

	it("degrades an unknown state to in-progress, and an unknown RESULT to finished-without-verdict", () => {
		expect(mapPipelineState({ name: "SOMETHING_NEW" })).toEqual({ status: "in_progress", conclusion: null });
		expect(mapPipelineState(undefined)).toEqual({ status: "in_progress", conclusion: null });
		// Completed with a result we don't recognise: the run IS over — leaving it spinning forever
		// would be the worse lie — but we will not name a verdict we cannot read.
		expect(mapPipelineState({ name: "COMPLETED", result: { name: "WHAT" } })).toEqual({ status: "completed", conclusion: null });
	});
});

describe("listBitbucketPipelines", () => {
	// Trimmed from the live payload of bitbucketpipelines/example-aws-s3-deploy.
	const raw = {
		values: [
			{
				state: { name: "COMPLETED", result: { name: "FAILED" } },
				build_number: 5,
				created_on: "2019-11-25T12:15:58.324Z",
				completed_on: "2019-11-25T12:16:42.052Z",
				target: { ref_name: "master", commit: { hash: "1e36e8b51dd786e7687bd9d41fff9455de095873" } },
				trigger: { name: "PUSH" },
				// The live payload's `links` really is only `self` and `steps`, both UUID-form API
				// URLs. There is no `html`, which is the whole point of the next test.
				links: { self: { href: "https://api.bitbucket.org/2.0/repositories/%7Bb29%7D/%7B161%7D/pipelines/%7B402%7D" } },
			},
		],
	};

	it("CONSTRUCTS the web URL — the payload has no links.html at all", async () => {
		// Verified live. Every other client on this seam transcribes the host's own browser URL;
		// doing that here yields "" and a dead link in every Builds row.
		stubFetch(raw);
		const runs = await listBitbucketPipelines(env, "u1", "bitbucketpipelines/example-aws-s3-deploy");
		expect(runs?.[0].url).toBe("https://bitbucket.org/bitbucketpipelines/example-aws-s3-deploy/pipelines/results/5");
	});

	it("maps a pipeline into the BuildRun the console already reads", async () => {
		stubFetch(raw);
		const runs = await listBitbucketPipelines(env, "u1", "bitbucketpipelines/example-aws-s3-deploy");
		expect(runs?.[0]).toEqual({
			status: "completed",
			conclusion: "failure",
			// Bitbucket pipelines are unnamed; `trigger.name` is the nearest true answer to "what
			// ran this" — the direct analogue of GitLab's `source` fallback.
			name: "PUSH",
			runNumber: 5,
			url: "https://bitbucket.org/bitbucketpipelines/example-aws-s3-deploy/pipelines/results/5",
			branch: "master",
			sha: "1e36e8b",
			updatedAt: "2019-11-25T12:16:42.052Z",
		});
	});

	it("falls back to created_on for a run that has not finished", async () => {
		stubFetch({ values: [{ state: { name: "IN_PROGRESS" }, build_number: 6, created_on: "2026-08-08T00:00:00Z", trigger: { name: "MANUAL" } }] });
		const runs = await listBitbucketPipelines(env, "u1", "team/widget");
		expect(runs?.[0].updatedAt).toBe("2026-08-08T00:00:00Z");
		expect(runs?.[0].conclusion).toBeNull();
	});

	it("distinguishes 'no pipelines yet' from 'could not ask'", async () => {
		// `[]` is a true and useful answer; `null` is what makes the route say available:false.
		stubFetch({ values: [] });
		expect(await listBitbucketPipelines(env, "u1", "team/widget")).toEqual([]);
		vi.unstubAllGlobals();
		stubFetch({ error: "nope" }, 403);
		expect(await listBitbucketPipelines(env, "u1", "team/widget")).toBeNull();
		vi.unstubAllGlobals();
		expect(await listBitbucketPipelines(env, "u1", "widget")).toBeNull();
	});
});
