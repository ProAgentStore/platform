/**
 * The GitLab merge-request client (#221 — the half `supports.pulls:false` was holding back).
 *
 * Six things here are decisions rather than transcription. Each looks correct in review and is
 * wrong in production, so each has a test that fails on the obvious mistake. All six were
 * settled against the LIVE gitlab.com API (`gitlab-org/gitlab-runner`, unauthenticated), because
 * the condition #221's deferral comment named still holds: nobody here has a GitLab account, so
 * the shapes had to come off the wire rather than out of documentation.
 *
 *   1. the number is `iid`, never the instance-wide `id`
 *   2. checks come from `head_pipeline` — sha correlation FAILS on fork merge requests
 *   3. review state comes from `/reviewers`; the LIST's `reviewers[].state` is the user ACCOUNT's
 *   4. `merge_status` answers the git question, `detailed_merge_status` the policy one
 *   5. `state=closed` excludes merged MRs, and `not[state]` is silently ignored
 *   6. `changes_count` is a STRING, and GitLab caps it as `"1000+"`
 *
 * (2), (3) and (5) are the load-bearing ones: each would produce a 200, a plausible-looking
 * payload, and a wrong answer on every row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { listGitlabPulls, mergeability, parseChangesCount, readGitlabPull, resolveGitlabReviewState, toGitlabPullSummary, toPullChecks } from "./gitlab-mrs.js";
import type { Env } from "../types.js";

// No KEY_ENCRYPTION_KEY and no DB: `readConnectorRefreshToken` throws, the client swallows it,
// and the read goes out UNAUTHENTICATED — the ordinary path for a public project and the one
// every probe below was taken over.
const env = {} as Env;

/** A fetch double that records what went out and replays `bodies` in order. */
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

/** Trimmed from the live payload of `gitlab-org/gitlab-runner` MR !6886. */
const MR = {
	id: 500829467,
	iid: 6886,
	title: "fix(docker): clear entrypoint for build container with proxy_exec",
	state: "opened",
	draft: false,
	work_in_progress: false,
	sha: "40daaba2a468b5c18c91640b86bc7461f09a19a8",
	merge_status: "can_be_merged",
	detailed_merge_status: "requested_changes",
	has_conflicts: false,
	merged_at: null,
	labels: ["type::bug", "group::runner core"],
	user_notes_count: 22,
	source_branch: "fix/proxy-exec-entrypoint",
	target_branch: "main",
	web_url: "https://gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/6886",
	created_at: "2026-06-28T08:48:05.455Z",
	updated_at: "2026-08-23T00:18:00.144Z",
	author: { username: "gourabsingha1" },
	// The LIST's reviewers, whose `state` is the USER ACCOUNT's — this is the trap in (3).
	reviewers: [
		{ username: "takax", state: "active" },
		{ username: "lachie-gitlab", state: "active" },
	],
};

describe("toGitlabPullSummary — the mappings", () => {
	it("uses `iid` as the number, never the instance-wide `id`", () => {
		// Live: iid 6886 vs id 500829467. `id` appears nowhere a human looks, so a link built
		// from it points at a different project's merge request.
		expect(toGitlabPullSummary(MR).number).toBe(6886);
		expect(toGitlabPullSummary(MR).url).toContain("/merge_requests/6886");
	});

	it("keeps the FULL 40-character head sha", () => {
		expect(toGitlabPullSummary(MR).headSha).toHaveLength(40);
	});

	it("collapses four GitLab states into the two words every caller filters on", () => {
		expect(toGitlabPullSummary({ ...MR, state: "opened" }).state).toBe("open");
		// `locked` means a merge is in flight — still open to a reader.
		expect(toGitlabPullSummary({ ...MR, state: "locked" }).state).toBe("open");
		expect(toGitlabPullSummary({ ...MR, state: "closed" }).state).toBe("closed");
		const merged = toGitlabPullSummary({ ...MR, state: "merged", merged_at: "2026-08-01T00:00:00Z" });
		// GitHub reports a merged PR as CLOSED plus `merged:true`, so nothing is lost by the
		// collapse — the fact lives in its own field rather than in an overloaded state word.
		expect(merged.state).toBe("closed");
		expect(merged.merged).toBe(true);
		expect(toGitlabPullSummary(MR).merged).toBe(false);
	});

	it("treats the legacy `work_in_progress` flag as a draft too", () => {
		expect(toGitlabPullSummary({ ...MR, draft: false, work_in_progress: true }).draft).toBe(true);
		expect(toGitlabPullSummary(MR).draft).toBe(false);
	});

	it("carries a REAL comment count — unlike this platform's Bitbucket issue client", () => {
		// `user_notes_count` exists and is populated (live: 22). 0 here would mean zero, not
		// unknown, which is exactly why it is worth pinning that the field is read.
		expect(toGitlabPullSummary(MR).comments).toBe(22);
	});

	it("never reports a review state from the LIST — that `state` is the user's account state", () => {
		// The MR list carries `reviewers: [{username, state:"active"}]`. Reading it as a review
		// state would put a verdict on every row and be wrong on every row, with nothing in the
		// shape to give it away. An unenriched row says "unknown", which is the truth.
		expect(toGitlabPullSummary(MR).review).toBe("unknown");
		expect(toGitlabPullSummary(MR).reviewersRequested).toBe(2);
	});

	it("has no checks until something asks — the list carries no head_pipeline", () => {
		expect(toGitlabPullSummary(MR).checks).toBeNull();
	});
});

describe("mergeability — the git question and the policy question are different", () => {
	it("reads the live case: no conflicts AND cannot be merged", () => {
		// !6886 live: `merge_status:"can_be_merged"` with `detailed_merge_status:
		// "requested_changes"`. That is precisely GitHub's `mergeable:true` +
		// `mergeable_state:"blocked"`, and collapsing the two fields would have shown a blocked
		// merge request as ready to merge.
		expect(mergeability(MR)).toEqual({ mergeable: true, mergeableState: "blocked" });
	});

	it("maps GitLab's own words onto the two the console actually reads", () => {
		// `mergeTone` only changes what a reader sees for `blocked` and `behind`; transcribing
		// GitLab's vocabulary instead would render `not_approved` as a green "Mergeable".
		expect(mergeability({ merge_status: "can_be_merged", detailed_merge_status: "mergeable" })).toEqual({ mergeable: true, mergeableState: "clean" });
		expect(mergeability({ merge_status: "can_be_merged", detailed_merge_status: "not_approved" }).mergeableState).toBe("blocked");
		expect(mergeability({ merge_status: "can_be_merged", detailed_merge_status: "ci_still_running" }).mergeableState).toBe("blocked");
		expect(mergeability({ merge_status: "can_be_merged", detailed_merge_status: "discussions_not_resolved" }).mergeableState).toBe("blocked");
		expect(mergeability({ merge_status: "cannot_be_merged", detailed_merge_status: "need_rebase" }).mergeableState).toBe("behind");
	});

	it("says NULL for 'not computed yet', never false", () => {
		// Telling an owner their branch conflicts because nobody has checked is the false alarm
		// the console's own `mergeTone` comment names — they go and rebase a branch that is fine.
		for (const d of ["checking", "unchecked", "preparing"]) {
			expect(mergeability({ merge_status: "unchecked", detailed_merge_status: d }), d).toEqual({ mergeable: null, mergeableState: "unknown" });
		}
		expect(mergeability({}).mergeable).toBeNull();
	});

	it("lets an explicit conflict outrank a stale merge_status", () => {
		expect(mergeability({ merge_status: "can_be_merged", has_conflicts: true, detailed_merge_status: "conflict" })).toEqual({ mergeable: false, mergeableState: "dirty" });
	});

	it("degrades a status GitLab adds later without asserting a verdict", () => {
		expect(mergeability({ merge_status: "can_be_merged", detailed_merge_status: "something_new" })).toEqual({ mergeable: true, mergeableState: "clean" });
		expect(mergeability({ merge_status: "unchecked", detailed_merge_status: "something_new" })).toEqual({ mergeable: null, mergeableState: "unknown" });
	});
});

describe("resolveGitlabReviewState", () => {
	it("lets changes_requested outrank an approval — it is the BLOCKING state", () => {
		// Live on !6886: one reviewer `requested_changes`, another `approved`. A row reading
		// "approved" while somebody blocks would be read as ready to merge.
		expect(resolveGitlabReviewState([{ state: "requested_changes" }, { state: "approved" }])).toBe("changes_requested");
		expect(resolveGitlabReviewState([{ state: "approved" }])).toBe("approved");
	});

	it("calls engagement-without-a-decision 'commented', and no engagement 'none'", () => {
		expect(resolveGitlabReviewState([{ state: "reviewed" }])).toBe("commented");
		expect(resolveGitlabReviewState([{ state: "review_started" }])).toBe("commented");
		expect(resolveGitlabReviewState([{ state: "unreviewed" }, { state: "unapproved" }])).toBe("none");
		expect(resolveGitlabReviewState([])).toBe("none");
		expect(resolveGitlabReviewState(null)).toBe("none");
	});

	it("yields 'none' if it is ever fed the LIST's reviewers by mistake", () => {
		// Defence in depth for the trap in (3): the account state `"active"` is not a review
		// verdict, and an unrecognised state must contribute nothing rather than something wrong.
		expect(resolveGitlabReviewState([{ state: "active" }, { state: "active" }])).toBe("none");
	});
});

describe("toPullChecks — from head_pipeline, with the fallback phase 3 measured", () => {
	it("widens GitLab's single status into the (status, conclusion) pair the console reads", () => {
		expect(toPullChecks({ status: "success", source: "merge_request_event", web_url: "u" })).toEqual({ status: "completed", conclusion: "success", url: "u", name: "merge_request_event" });
		expect(toPullChecks({ status: "running", source: "push" })?.conclusion).toBeNull();
	});

	it("falls back to `source` — the live head_pipeline objects have NO name key at all", () => {
		// Phase 3's probe found `pipeline.name` null on every real pipeline, and the head-pipeline
		// objects probed here do not carry the key. An empty label in the row reads as a bug.
		expect(toPullChecks({ status: "success", source: "merge_request_event" })?.name).toBe("merge_request_event");
		expect(toPullChecks({ status: "success", name: "Nightly", source: "schedule" })?.name).toBe("Nightly");
		expect(toPullChecks({ status: "success" })?.name).toBe("Pipeline");
	});

	it("is null for an absent pipeline — 'not looked up', not 'no checks'", () => {
		expect(toPullChecks(null)).toBeNull();
		expect(toPullChecks(undefined)).toBeNull();
	});
});

describe("parseChangesCount — GitLab reports it as a STRING", () => {
	it('reads "2" as 2 and the capped "1000+" as its lower bound', () => {
		// Live value on !6886 is the string `"2"`. GitLab caps large diffs as `"1000+"`, which
		// `Number()` would turn into NaN and a naive parse into 0.
		expect(parseChangesCount("2")).toBe(2);
		expect(parseChangesCount("1000+")).toBe(1000);
		expect(parseChangesCount(7)).toBe(7);
		expect(parseChangesCount(null)).toBe(0);
		expect(parseChangesCount("lots")).toBe(0);
	});
});

describe("listGitlabPulls", () => {
	it("asks unauthenticated when there is no stored token, rather than not asking", async () => {
		const calls = stubFetch([MR], MR, []);
		const out = await listGitlabPulls(env, "u1", "gitlab-org/gitlab-runner");
		expect(out[0].number).toBe(6886);
		expect(calls[0].headers["PRIVATE-TOKEN"]).toBeUndefined();
		expect(calls[0].url).toContain("/api/v4/projects/gitlab-org%2Fgitlab-runner/merge_requests");
		expect(calls[0].url).toContain("state=opened");
	});

	it("makes `closed` TWO requests, because GitLab's `closed` excludes merged", async () => {
		// Verified live: `state=closed` returned only `closed` MRs and `state=merged` only merged
		// ones. One request would silently drop half the panel's rows.
		const calls = stubFetch([{ ...MR, state: "merged", merged_at: "2026-08-02T00:00:00Z", updated_at: "2026-08-02T00:00:00Z" }], [{ ...MR, iid: 10, state: "closed", updated_at: "2026-08-03T00:00:00Z" }]);
		const out = await listGitlabPulls(env, "u1", "g/p", { state: "closed", enrich: false });
		const states = calls.map((c) => new URL(c.url).searchParams.get("state"));
		expect(states).toEqual(["merged", "closed"]);
		// Two sorted pages concatenate into an unsorted list; the panel's contract is newest first.
		expect(out.map((p) => p.number)).toEqual([10, 6886]);
	});

	it("never uses `not[state]`, which GitLab SILENTLY IGNORES", async () => {
		// Probed live: `not[state]=opened` answered 200 with five `opened` merge requests. The
		// obvious workaround returns exactly the rows it was meant to exclude, with no error.
		const calls = stubFetch([MR], [MR]);
		await listGitlabPulls(env, "u1", "g/p", { state: "closed", enrich: false });
		for (const c of calls) expect(decodeURIComponent(c.url)).not.toContain("not[state]");
	});

	it("asks for `all` in ONE request — unlike the issues endpoint, this one accepts it", async () => {
		// `gitlab-api.ts` must OMIT the filter because the issues endpoint 400s on `state=all`.
		// The merge-requests endpoint accepts it (verified live, 200), and the two genuinely
		// differ — copying either rule to the other is the mistake.
		const calls = stubFetch([MR]);
		await listGitlabPulls(env, "u1", "g/p", { state: "all", enrich: false });
		expect(calls).toHaveLength(1);
		expect(new URL(calls[0].url).searchParams.get("state")).toBe("all");
	});

	it("enriches the first rows with head_pipeline and /reviewers, and stops at the cap", async () => {
		const list = Array.from({ length: 12 }, (_, i) => ({ ...MR, iid: 100 + i }));
		const detail = { ...MR, head_pipeline: { status: "success", source: "merge_request_event", web_url: "p" } };
		const calls = stubFetch(list, detail, [{ state: "approved" }]);
		const out = await listGitlabPulls(env, "u1", "g/p");
		// 1 list + 8 × (detail + reviewers) — the same cap and the same reason as `github-prs.ts`.
		expect(calls).toHaveLength(1 + 8 * 2);
		expect(out[0].checks).toMatchObject({ status: "completed", conclusion: "success" });
		expect(out[0].review).toBe("approved");
		// Past the cap the row keeps its honest "not looked up" values.
		expect(out[11].checks).toBeNull();
		expect(out[11].review).toBe("unknown");
	});

	it("skips enrichment entirely for enrich:false — one request, no lookups", async () => {
		const calls = stubFetch([MR]);
		const out = await listGitlabPulls(env, "u1", "g/p", { enrich: false });
		expect(calls).toHaveLength(1);
		expect(out[0].review).toBe("unknown");
	});

	it("keeps the row's own values when an enrichment call fails", async () => {
		// A failed lookup must not downgrade a merge request to "conflicted" or wipe its state.
		const calls = stubFetch([MR], { status: 500, body: null });
		const out = await listGitlabPulls(env, "u1", "g/p");
		expect(calls.length).toBeGreaterThan(1);
		expect(out[0].mergeable).toBe(true);
		expect(out[0].mergeableState).toBe("blocked");
		expect(out[0].review).toBe("unknown");
	});

	it("degrades to [] on a private project, a bad body and a network error", async () => {
		// GitLab hides existence rather than 403ing, so a private project is a 404.
		stubFetch({ status: 404, body: { message: "404 Project Not Found" } });
		expect(await listGitlabPulls(env, "u1", "g/p", { enrich: false })).toEqual([]);
		vi.unstubAllGlobals();
		stubFetch({ message: "nope" });
		expect(await listGitlabPulls(env, "u1", "g/p", { enrich: false })).toEqual([]);
		vi.unstubAllGlobals();
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
		expect(await listGitlabPulls(env, "u1", "g/p", { enrich: false })).toEqual([]);
	});

	it("makes no request at all for a slug that is not a project path", async () => {
		const calls = stubFetch([MR]);
		expect(await listGitlabPulls(env, "u1", "project")).toEqual([]);
		expect(await listGitlabPulls(env, "u1", "group/project?per_page=100")).toEqual([]);
		expect(calls).toHaveLength(0);
	});
});

describe("a GitLab slug NEVER reaches another provider's API", () => {
	it("every request this client builds goes to gitlab.com and nowhere else", async () => {
		// The mirror of the Bitbucket dispatch test. `gitlab.com` is a module constant precisely
		// so this can be asserted: no request field on this path can move where a read is sent,
		// which is also what keeps a self-managed host (provider `other`) out of this module.
		const calls = stubFetch([MR], MR, [{ state: "approved" }]);
		await listGitlabPulls(env, "u1", "group/sub/project");
		await readGitlabPull(env, "u1", "group/sub/project", 6886);
		expect(calls.length).toBeGreaterThan(3);
		for (const c of calls) {
			expect(new URL(c.url).host).toBe("gitlab.com");
		}
	});
});

describe("readGitlabPull", () => {
	it("returns the detail with its changed-file count, review state and pipeline", async () => {
		const detail = { ...MR, description: "why", changes_count: "2", head_pipeline: { status: "failed", source: "merge_request_event", web_url: "p" } };
		stubFetch(detail, [{ state: "requested_changes" }]);
		const pull = await readGitlabPull(env, "u1", "g/p", 6886);
		expect(pull).toMatchObject({ number: 6886, body: "why", changedFiles: 2, review: "changes_requested" });
		expect(pull?.checks).toMatchObject({ status: "completed", conclusion: "failure" });
	});

	it("leaves additions/deletions at 0 — GitLab carries no line counts on this payload", async () => {
		// 0 is "unknown" here, the same representation `bitbucket-api.ts` uses for its absent
		// comment count. Computing them would be a page-per-file diff walk for two grey numbers.
		stubFetch({ ...MR, description: "x", changes_count: "5" }, []);
		const pull = await readGitlabPull(env, "u1", "g/p", 6886);
		expect(pull).toMatchObject({ additions: 0, deletions: 0, changedFiles: 5 });
	});

	it("caps the body, which lives under `description` and not `body`", async () => {
		stubFetch({ ...MR, description: "z".repeat(9000) }, []);
		expect((await readGitlabPull(env, "u1", "g/p", 6886))?.body.length).toBe(8 * 1024);
	});

	it("returns null for a body with no iid, rather than a merge request numbered 0", async () => {
		stubFetch({ title: "t" });
		expect(await readGitlabPull(env, "u1", "g/p", 6886)).toBeNull();
	});

	it("makes no request for a malformed slug or a nonsense number", async () => {
		const calls = stubFetch(MR);
		expect(await readGitlabPull(env, "u1", "project", 1)).toBeNull();
		expect(await readGitlabPull(env, "u1", "g/p", Number.NaN)).toBeNull();
		expect(await readGitlabPull(env, "u1", "g/p", 0)).toBeNull();
		expect(calls).toHaveLength(0);
	});
});
