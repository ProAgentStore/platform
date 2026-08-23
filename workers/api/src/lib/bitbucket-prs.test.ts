/**
 * The Bitbucket pull-request client (#221 — the half `supports.pulls:false` was holding back).
 *
 * Five things here are decisions rather than transcription, each with a test that fails on the
 * obvious mistake. All five were settled against the LIVE public API (`atlassian/fugue`),
 * because the condition #221's deferral comment named still holds: nobody here has a Bitbucket
 * account, so the shapes had to come off the wire rather than out of documentation.
 *
 *   1. omitting `state` returns OPEN ONLY — the exact inverse of the issues endpoint
 *   2. there is no mergeability anywhere in the payload
 *   3. checks come from `/statuses`, one call per pull request
 *   4. review state and reviewer count come from the DETAIL endpoint's `participants`
 *   5. `source.commit.hash` is truncated to 12 characters
 *
 * (1) is the load-bearing one: it produces a 200 and an empty list, which is indistinguishable
 * from a repository that has no closed pull requests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregateStatuses, listBitbucketPulls, mapCommitStatus, readBitbucketPull, resolveBitbucketReviewState, statesFor, toBitbucketPullSummary } from "./bitbucket-prs.js";
import type { Env } from "../types.js";

// No KEY_ENCRYPTION_KEY and no DB: `readConnectorRefreshToken` throws, the client swallows it,
// and the read goes out UNAUTHENTICATED — the ordinary path for a public repo.
const env = {} as Env;

function stubFetch(...bodies: Array<unknown | { status: number; body: unknown }>) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	let i = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
			const b = bodies[Math.min(i++, bodies.length - 1)];
			const framed = b && typeof b === "object" && "status" in (b as Record<string, unknown>) ? (b as { status: number; body: unknown }) : { status: 200, body: b };
			return new Response(JSON.stringify(framed.body), { status: framed.status, headers: { "Content-Type": "application/json" } });
		}),
	);
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

/** Trimmed from the live payload of `atlassian/fugue` pull request #139. */
const PR = {
	id: 139,
	title: "DCPL-3998: Remove all files and add readme",
	state: "MERGED",
	draft: false,
	comment_count: 9,
	created_on: "2026-04-09T13:05:11.531550+00:00",
	updated_on: "2026-04-09T14:12:38.408199+00:00",
	description: "the body",
	author: { display_name: "Tom Rijnbeek", nickname: "trijnbeek" },
	// TWELVE characters — this is what the API actually returns (5).
	source: { branch: { name: "issue/master/DCPL-3998-remove-files-add-readme" }, commit: { hash: "e45f5964a8c2" } },
	destination: { branch: { name: "master" } },
	links: { html: { href: "https://bitbucket.org/atlassian/fugue/pull-requests/139" } },
	summary: { raw: "the body" },
};

describe("toBitbucketPullSummary — the mappings", () => {
	it("uses `id` as the number — the opposite of GitLab, where `id` is a global counter", () => {
		expect(toBitbucketPullSummary(PR).number).toBe(139);
		expect(toBitbucketPullSummary(PR).url).toContain("/pull-requests/139");
	});

	it("collapses four Bitbucket states into the two words every caller filters on", () => {
		expect(toBitbucketPullSummary({ ...PR, state: "OPEN" }).state).toBe("open");
		for (const s of ["MERGED", "DECLINED", "SUPERSEDED"]) {
			expect(toBitbucketPullSummary({ ...PR, state: s }).state, s).toBe("closed");
		}
		expect(toBitbucketPullSummary({ ...PR, state: "MERGED" }).merged).toBe(true);
		expect(toBitbucketPullSummary({ ...PR, state: "DECLINED" }).merged).toBe(false);
	});

	it("reports NO mergeability rather than borrowing GitHub's word for it", () => {
		// Nothing in the payload answers "does this merge" — Bitbucket computes it only when you
		// POST a merge attempt. `false` means "the host says this conflicts", and a provider that
		// was never asked must not claim it. `mergeTone` renders null as no badge.
		expect(toBitbucketPullSummary(PR).mergeable).toBeNull();
		expect(toBitbucketPullSummary(PR).mergeableState).toBe("unknown");
	});

	it("carries a REAL comment count — unlike this provider's ISSUE client", () => {
		// `bitbucket-api.ts` records `comments: 0 = unknown` because an issue payload has no
		// count at all. A pull request DOES (live values 9 and 3), so 0 here would mean zero.
		expect(toBitbucketPullSummary(PR).comments).toBe(9);
	});

	it("has NO labels at all — not even the kind/priority pair an issue gets", () => {
		// The issue client synthesizes labels from `kind`+`priority`. A pull request carries
		// neither, so an empty list is the true answer rather than a placeholder.
		expect(toBitbucketPullSummary(PR).labels).toEqual([]);
	});

	it("records the 12-character head sha as given, without padding or dropping it", () => {
		// GitHub's `head.sha` is the full 40. Nothing on this provider correlates a run by sha —
		// checks come from a per-PR endpoint — so the short form costs nothing, and the missing
		// 28 characters are not available to invent.
		expect(toBitbucketPullSummary(PR).headSha).toBe("e45f5964a8c2");
	});

	it("prefers the stable nickname over the display name for the author", () => {
		expect(toBitbucketPullSummary(PR).author).toBe("trijnbeek");
		expect(toBitbucketPullSummary({ ...PR, author: { display_name: "Tom Rijnbeek" } }).author).toBe("Tom Rijnbeek");
		expect(toBitbucketPullSummary({ ...PR, author: null }).author).toBe("");
	});

	it("starts with review 'unknown', 0 reviewers and no checks — all three are lookups", () => {
		// The LIST payload carries neither `participants` nor `reviewers`, and statuses live on
		// their own endpoint. 0 and "unknown" here mean "not looked up".
		const row = toBitbucketPullSummary(PR);
		expect(row.review).toBe("unknown");
		expect(row.reviewersRequested).toBe(0);
		expect(row.checks).toBeNull();
	});
});

describe("statesFor — omitting `state` would return OPEN ONLY", () => {
	it("names every state for `all` and `closed`, which the ISSUE client must not do", () => {
		// Verified live: no `state` answered `size: 0` on a repo holding 139 pull requests, while
		// naming all four answered 139. `bitbucket-api.ts` omits the filter for `all` because the
		// ISSUES endpoint answers a `q` it cannot satisfy with a 200 and an empty list — the same
		// symptom, the opposite fix. Copying either rule to the other endpoint is the mistake.
		expect(statesFor("all")).toEqual(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]);
		expect(statesFor("closed")).toEqual(["MERGED", "DECLINED", "SUPERSEDED"]);
		expect(statesFor("open")).toEqual(["OPEN"]);
	});
});

describe("mapCommitStatus / aggregateStatuses", () => {
	it("carries a verdict only for a terminal status", () => {
		expect(mapCommitStatus("SUCCESSFUL")).toEqual({ status: "completed", conclusion: "success" });
		expect(mapCommitStatus("FAILED")).toEqual({ status: "completed", conclusion: "failure" });
		// ERROR is a Bitbucket-side fault rather than a failing build, but to every consumer it is
		// the same thing: the check finished and it did not pass.
		expect(mapCommitStatus("ERROR")).toEqual({ status: "completed", conclusion: "failure" });
		expect(mapCommitStatus("STOPPED")).toEqual({ status: "completed", conclusion: "cancelled" });
		expect(mapCommitStatus("INPROGRESS")).toEqual({ status: "in_progress", conclusion: null });
		// A status Bitbucket adds later degrades to unfinished rather than being asserted.
		expect(mapCommitStatus("SOMETHING_NEW")).toEqual({ status: "in_progress", conclusion: null });
	});

	it("reports the status that DECIDED the verdict, so a red check cannot hide behind a green one", () => {
		// A PR can carry a green Pipelines build beside a red external check. `PullChecks` holds
		// one answer, so taking the first would show that row as passing.
		const many = [
			{ state: "SUCCESSFUL", name: "pipeline", url: "ok" },
			{ state: "FAILED", name: "bamboo", url: "bad" },
		];
		expect(aggregateStatuses(many)).toMatchObject({ conclusion: "failure", name: "bamboo", url: "bad" });
		expect(aggregateStatuses([{ state: "SUCCESSFUL", name: "a" }, { state: "INPROGRESS", name: "b" }])).toMatchObject({ status: "in_progress", name: "b" });
		expect(aggregateStatuses([{ state: "SUCCESSFUL", name: "a" }, { state: "SUCCESSFUL", name: "b" }])).toMatchObject({ conclusion: "success", name: "a" });
	});

	it("is null for no statuses — 'not looked up', never 'no checks'", () => {
		expect(aggregateStatuses([])).toBeNull();
		expect(aggregateStatuses(undefined)).toBeNull();
	});
});

describe("resolveBitbucketReviewState", () => {
	it("lets changes_requested outrank an approval — it is the BLOCKING state", () => {
		expect(resolveBitbucketReviewState([{ state: "changes_requested" }, { state: "approved", approved: true }])).toBe("changes_requested");
		expect(resolveBitbucketReviewState([{ state: "approved", approved: true }])).toBe("approved");
		// Bitbucket sets `approved` and `state` together; either alone is the same claim.
		expect(resolveBitbucketReviewState([{ approved: true, state: null }])).toBe("approved");
	});

	it("calls an unapproved participant who engaged 'commented', and one who never did 'none'", () => {
		// Live shape: `{role:"REVIEWER", approved:false, state:null, participated_on:null}`.
		expect(resolveBitbucketReviewState([{ role: "REVIEWER", approved: false, state: null, participated_on: "2026-04-09T00:00:00Z" }])).toBe("commented");
		expect(resolveBitbucketReviewState([{ role: "REVIEWER", approved: false, state: null, participated_on: null }])).toBe("none");
		expect(resolveBitbucketReviewState([])).toBe("none");
		expect(resolveBitbucketReviewState(null)).toBe("none");
	});
});

describe("listBitbucketPulls", () => {
	it("asks unauthenticated when there is no stored token, rather than not asking", async () => {
		const calls = stubFetch({ values: [PR] }, PR, { values: [] });
		const out = await listBitbucketPulls(env, "u1", "atlassian/fugue", { enrich: false });
		expect(out[0].number).toBe(139);
		expect(calls[0].headers.Authorization).toBeUndefined();
		expect(calls[0].url).toContain("api.bitbucket.org/2.0/repositories/atlassian/fugue/pullrequests");
	});

	it("REPEATS the state parameter rather than omitting it or comma-joining it", async () => {
		// The union is expressed by repetition on this endpoint. Omitting it narrows silently to
		// OPEN; a comma-joined value is not accepted.
		const calls = stubFetch({ values: [] });
		await listBitbucketPulls(env, "u1", "team/widget", { state: "all", enrich: false });
		const states = new URL(calls[0].url).searchParams.getAll("state");
		expect(states).toEqual(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]);
		vi.unstubAllGlobals();
		const closed = stubFetch({ values: [] });
		await listBitbucketPulls(env, "u1", "team/widget", { state: "closed", enrich: false });
		expect(new URL(closed[0].url).searchParams.getAll("state")).toEqual(["MERGED", "DECLINED", "SUPERSEDED"]);
		// One request whatever the filter — unlike GitLab, where `closed` needs two.
		expect(closed).toHaveLength(1);
	});

	it("enriches the first rows with participants and statuses, and stops at the cap", async () => {
		const list = { values: Array.from({ length: 12 }, (_, i) => ({ ...PR, id: 100 + i })) };
		const detail = { ...PR, participants: [{ state: "approved", approved: true }], reviewers: [{}, {}] };
		const calls = stubFetch(list, detail, { values: [{ state: "FAILED", name: "bamboo", url: "u" }] });
		const out = await listBitbucketPulls(env, "u1", "team/widget");
		// 1 list + 8 × (detail + statuses) — the same cap and reason as `github-prs.ts`.
		expect(calls).toHaveLength(1 + 8 * 2);
		expect(out[0].review).toBe("approved");
		expect(out[0].reviewersRequested).toBe(2);
		expect(out[0].checks).toMatchObject({ conclusion: "failure", name: "bamboo" });
		// Past the cap the row keeps its honest "not looked up" values.
		expect(out[11].review).toBe("unknown");
		expect(out[11].checks).toBeNull();
	});

	it("keeps the row's own values when an enrichment call fails", async () => {
		const calls = stubFetch({ values: [PR] }, { status: 500, body: null });
		const out = await listBitbucketPulls(env, "u1", "team/widget");
		expect(calls.length).toBeGreaterThan(1);
		expect(out[0].review).toBe("unknown");
		expect(out[0].checks).toBeNull();
		expect(out[0].mergeable).toBeNull();
	});

	it("degrades to [] on a private repo, a bad body and a network error", async () => {
		stubFetch({ status: 403, body: { error: { message: "nope" } } });
		expect(await listBitbucketPulls(env, "u1", "team/widget", { enrich: false })).toEqual([]);
		vi.unstubAllGlobals();
		stubFetch({ values: "nope" });
		expect(await listBitbucketPulls(env, "u1", "team/widget", { enrich: false })).toEqual([]);
		vi.unstubAllGlobals();
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
		expect(await listBitbucketPulls(env, "u1", "team/widget", { enrich: false })).toEqual([]);
	});

	it("makes no request at all for a slug that is not workspace/repo", async () => {
		const calls = stubFetch({ values: [PR] });
		expect(await listBitbucketPulls(env, "u1", "widget")).toEqual([]);
		expect(await listBitbucketPulls(env, "u1", "team/widget/src/main")).toEqual([]);
		expect(await listBitbucketPulls(env, "u1", "team/widget?pagelen=100")).toEqual([]);
		expect(calls).toHaveLength(0);
	});
});

describe("a Bitbucket slug NEVER reaches another provider's API", () => {
	it("every request this client builds goes to api.bitbucket.org and nowhere else", async () => {
		// The sharpest negative on this seam: `team/widget` IS a well-formed `owner/repo`, so a
		// leak would build an AUTHENTICATED request against a GitHub namespace of the same name
		// and no shape check anywhere would catch it. The host is a module constant so this can
		// be asserted directly.
		const calls = stubFetch({ values: [PR] }, PR, { values: [] });
		await listBitbucketPulls(env, "u1", "team/widget");
		await readBitbucketPull(env, "u1", "team/widget", 139);
		expect(calls.length).toBeGreaterThan(3);
		for (const c of calls) {
			expect(new URL(c.url).host).toBe("api.bitbucket.org");
		}
	});
});

describe("readBitbucketPull", () => {
	it("returns the detail with its review state and checks", async () => {
		stubFetch({ ...PR, participants: [{ state: "changes_requested" }] }, { values: [{ state: "SUCCESSFUL", name: "pipeline", url: "u" }] });
		const pull = await readBitbucketPull(env, "u1", "atlassian/fugue", 139);
		expect(pull).toMatchObject({ number: 139, body: "the body", review: "changes_requested" });
		expect(pull?.checks).toMatchObject({ status: "completed", conclusion: "success", name: "pipeline" });
	});

	it("leaves the diff size at 0 — the payload has none and /diffstat paginates per FILE", async () => {
		// 0 is "unknown", the representation this provider's issue client already uses for its
		// absent comment count. Totalling `/diffstat` would be a page-walk for three grey numbers.
		stubFetch(PR, { values: [] });
		expect(await readBitbucketPull(env, "u1", "atlassian/fugue", 139)).toMatchObject({ additions: 0, deletions: 0, changedFiles: 0 });
	});

	it("reads the body from `description`, falling back to summary.raw", async () => {
		// Both held the IDENTICAL text on every probed pull request; `description` is the
		// documented field and the other is a fallback, not a second source of truth.
		stubFetch({ ...PR, description: null, summary: { raw: "from summary" } }, { values: [] });
		expect((await readBitbucketPull(env, "u1", "atlassian/fugue", 139))?.body).toBe("from summary");
		vi.unstubAllGlobals();
		stubFetch({ ...PR, description: "z".repeat(9000) }, { values: [] });
		expect((await readBitbucketPull(env, "u1", "atlassian/fugue", 139))?.body.length).toBe(8 * 1024);
	});

	it("returns null for a body with no id, rather than a pull request numbered 0", async () => {
		stubFetch({ title: "t" });
		expect(await readBitbucketPull(env, "u1", "atlassian/fugue", 139)).toBeNull();
	});

	it("makes no request for a malformed slug or a nonsense number", async () => {
		const calls = stubFetch(PR);
		expect(await readBitbucketPull(env, "u1", "widget", 1)).toBeNull();
		expect(await readBitbucketPull(env, "u1", "team/widget", Number.NaN)).toBeNull();
		expect(await readBitbucketPull(env, "u1", "team/widget", 0)).toBeNull();
		expect(calls).toHaveLength(0);
	});
});
