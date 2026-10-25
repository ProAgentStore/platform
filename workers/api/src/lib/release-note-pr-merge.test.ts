/**
 * #1350 — a gated release note for a run that delivered through PULL REQUEST MERGES.
 *
 * Over the real schema, driven through `recordEngineActs` (the path the workflow drains runner acts through) and
 * `postReleaseNotes`. What is asserted is what happens: a note is QUEUED for the exact range, or a typed HELD row
 * appears (visible through the #1348 delivery list) and nothing posts. GitHub is never read at run end (the queue tick
 * does that, tested in release-note-queue.test.ts), so any read here is a failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { notifyUser } = vi.hoisted(() => ({ notifyUser: vi.fn() }));
vi.mock("../routes/push.js", async (orig) => ({ ...(await orig<typeof import("../routes/push.js")>()), notifyUser }));

import { upsertConnectorGrant } from "./connector-grants.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { type EngineActReport, recordEngineActs, sanitizeEngineActs } from "./engine-acts.js";
import type { MergeEvidence } from "./merge-evidence.js";
import { postReleaseNotes, type ReleaseNoteDeps, type ReleaseNoteInput } from "./release-notes.js";
import type { Env } from "../types.js";

const RUN = "run-1";
const GATE = [{ path: ".github/workflows/ci.yml", role: "check" }, { path: ".github/workflows/deploy.yml", role: "production_deploy", jobName: "deploy", stepName: "Upload to R2" }];
const sha = (c: string) => c.repeat(40);

let d1: RealSchemaD1;
let env: Env;

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, branch) VALUES ('repo-1', 'inst-1', 'u1', 'platform', 'acme/platform', 'main')");
	env = { DB: d1.DB } as unknown as Env;
	notifyUser.mockReset().mockResolvedValue(undefined);
	await upsertConnectorGrant(env, "inst-1", "u1", { provider: "discord", resourceId: "111111111111111111", resourceName: "#releases", resourceType: "discord_channel" });
	d1.exec(`UPDATE agent_instances SET config = '${JSON.stringify({ releaseNotes: { requiredWorkflows: GATE } })}' WHERE id = 'inst-1'`);
});
afterEach(() => d1.close());

/** A runner-reported act. `extra` may carry anything a runner could send, including malformed evidence, so it is not typed. */
const act = (id: string, kind: string, command: string, extra: Record<string, unknown> = {}): EngineActReport => ({ id, kind, command, target: null, irreversible: true, ok: true, at: "2026-10-19T10:05:00Z", atReliable: true, ...extra }) as EngineActReport;
const record = (...acts: EngineActReport[]) => recordEngineActs(env, { userId: "u1", instanceId: "inst-1", sessionId: "sess-1", traceId: RUN }, acts);
const push = (id: string, from: string, to: string) => act(id, "push.trunk", "git push origin main", { target: "origin main", pushedFromSha: from, pushedSha: to });
const evidence = (over: Partial<MergeEvidence> = {}): MergeEvidence => ({ v: 1, repo: "acme/platform", pr: 42, baseRef: "main", method: "squash", beforeSha: sha("a"), afterSha: sha("b"), mergedAt: "2026-10-19T10:05:05Z", mergedBy: "serge", actor: "serge", ...over });
const merge = (id: string, over: Partial<MergeEvidence> = {}, extra: Record<string, unknown> = {}) => act(id, "pr.merge", "gh pr merge 42 --squash", { target: "#42", merge: evidence(over), ...extra });
const input = (): ReleaseNoteInput => ({ env, userId: "u1", instanceId: "inst-1", runId: RUN, sessionId: "sess-1", repoId: "repo-1", repoLabel: "platform", runStartedAt: Date.parse("2026-10-19T10:00:00Z") });
function deps() {
	const posts: string[] = [];
	const githubCalls: string[] = [];
	const d: ReleaseNoteDeps = { now: () => Date.parse("2026-10-19T11:00:00Z"), githubGet: async (path) => { githubCalls.push(path); return null; }, deliver: async (_c, text) => { posts.push(text); return { ok: true }; } };
	return { d, posts, githubCalls };
}
const rows = () => d1.DB.prepare("SELECT sha, status, hold_code, reason, context_json FROM release_note_queue").all<{ sha: string; status: string; hold_code: string | null; reason: string | null; context_json: string }>().then((r) => r.results ?? []);

/** Record the acts through the sanitizer, as the relay does, so the runner's payload is validated on the way in. */
const relay = (...acts: EngineActReport[]) => record(...sanitizeEngineActs(acts));

describe("a synchronous PR merge to the default branch is queued for its exact range", () => {
	it.each(["merge", "squash", "rebase"] as const)("a %s merge queues one note, for the merge's own before/after, reading nothing from GitHub", async (method) => {
		await relay(merge("m1", { method }));
		const { d, posts, githubCalls } = deps();
		expect((await postReleaseNotes(input(), d)).status).toBe("queued");
		expect(posts).toHaveLength(0);
		expect(githubCalls).toEqual([]);
		const [row] = await rows();
		expect(row).toMatchObject({ status: "pending", hold_code: null, sha: sha("b") });
		const ctx = JSON.parse(row.context_json);
		expect(ctx.pendingRange).toMatchObject({ base: sha("a"), head: sha("b"), branch: "main" });
		expect(ctx.pendingRange.merges).toEqual([evidence({ method })]);
	});

	it("a direct push followed by a merge that starts where the push ended is ONE release over the combined range", async () => {
		await relay(push("p1", "1".repeat(7), "2".repeat(7)), merge("m1", { beforeSha: sha("2"), afterSha: sha("3") }));
		expect((await postReleaseNotes(input(), deps().d)).status).toBe("queued");
		const [row] = await rows();
		expect(JSON.parse(row.context_json).pendingRange).toMatchObject({ base: "1".repeat(7), head: sha("3"), branch: "main" });
		expect(row.sha).toBe(sha("3"));
	});

	it("a merge followed by a push, and two merges, chain the same way", async () => {
		await relay(merge("m1", { beforeSha: sha("1"), afterSha: sha("2") }), push("p1", "2".repeat(7), "3".repeat(7)));
		expect((await postReleaseNotes(input(), deps().d)).status).toBe("queued");
		expect(JSON.parse((await rows())[0].context_json).pendingRange).toMatchObject({ base: sha("1"), head: "3".repeat(7) });
		d1.exec("DELETE FROM release_note_queue; DELETE FROM agent_events WHERE event = 'act.consequential'");
		await relay(merge("m1", { pr: 7, beforeSha: sha("1"), afterSha: sha("2") }), merge("m2", { pr: 8, beforeSha: sha("2"), afterSha: sha("3") }));
		expect((await postReleaseNotes(input(), deps().d)).status).toBe("queued");
		const pending = JSON.parse((await rows())[0].context_json).pendingRange;
		expect(pending).toMatchObject({ base: sha("1"), head: sha("3") });
		expect(pending.merges.map((m: MergeEvidence) => m.pr)).toEqual([7, 8]);
	});

	it("a direct push alone is unchanged", async () => {
		await relay(push("p1", "1".repeat(7), "2".repeat(7)));
		expect((await postReleaseNotes(input(), deps().d)).status).toBe("queued");
		expect(JSON.parse((await rows())[0].context_json).pendingRange).toMatchObject({ base: "1".repeat(7), head: "2".repeat(7) });
	});
});

describe("anything short of a proved, contiguous delivery is HELD as a visible row, and nothing posts", () => {
	const held = async (code: string, reason: RegExp) => {
		const { d, posts, githubCalls } = deps();
		expect((await postReleaseNotes(input(), d)).status).toBe("unverified");
		expect(posts).toEqual([]);
		expect(githubCalls).toEqual([]);
		const all = await rows();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ status: "held", hold_code: code, sha: `unverified:${RUN}` });
		expect(all[0].reason).toMatch(reason);
		expect(notifyUser).toHaveBeenCalled();
	};

	it("an old runner's merge (no evidence at all) names the CLI to update to", async () => {
		await relay(act("m1", "pr.merge", "gh pr merge 42 --squash", { target: "#42" }));
		await held("pr_merge_old_runner", /older than CLI 0\.4\.180/);
	});
	it("--auto is a request, not a merge, whatever else the payload says", async () => {
		await relay(act("m1", "pr.merge", "gh pr merge 42 --squash --auto", { target: "#42" }));
		await held("pr_merge_auto", /only requested|--auto/);
	});
	it("--auto is held even when a (wrong) runner attached evidence to it", async () => {
		await relay(merge("m1", {}, { command: "gh pr merge 42 --squash --auto" }));
		// The command line says it only asked for a merge later: no attached evidence turns that into a delivered range.
		await held("pr_merge_auto", /only requested/);
	});
	it.each([
		["auto", "pr_merge_auto", /only requested|scheduled/],
		["scheduled", "pr_merge_auto", /scheduled/],
		["not_merged", "pr_merge_unverified", /not merged/],
		["wrong_branch", "pr_merge_unverified", /default branch/],
		["unrecognized_output", "pr_merge_unverified", /does not say/],
		["method_unknown", "pr_merge_unverified", /method/],
		["actor_mismatch", "pr_merge_unverified", /not merged by this run's account/],
		["unreadable", "pr_merge_unverified", /could not be read/],
	])("a runner that could not prove the merge (%s) holds with %s", async (unverified, code, reason) => {
		await relay(act("m1", "pr.merge", "gh pr merge 42 --squash", { target: "#42", mergeUnverified: unverified, mergeDetail: "GitHub said so" }));
		await held(code, reason);
	});
	it("malformed evidence (a wrong version, a missing field) is held, not repaired", async () => {
		await relay(act("m1", "pr.merge", "gh pr merge 42 --squash", { target: "#42", merge: { ...evidence(), v: 2 } }));
		await held("pr_merge_unverified", /not valid for this contract version/);
		d1.exec("DELETE FROM release_note_queue; DELETE FROM agent_events WHERE event = 'act.consequential'");
		const { beforeSha: _drop, ...partial } = evidence();
		await relay(act("m2", "pr.merge", "gh pr merge 42 --squash", { target: "#42", merge: partial }));
		await held("pr_merge_unverified", /not valid for this contract version/);
	});
	it("a merge that was started but never observed to finish", async () => {
		await relay(act("m1", "pr.merge", "gh pr merge 42 --squash", { target: "#42", ok: null }));
		await held("pr_merge_unverified", /never observed to finish/);
	});
	it("a push and a merge with another update between them are not one release", async () => {
		await relay(push("p1", "1".repeat(7), "2".repeat(7)), merge("m1", { beforeSha: sha("9"), afterSha: sha("3") }));
		await held("pr_range_not_contiguous", /not contiguous/);
	});
	it("overlapping ranges are not summarized as one", async () => {
		await relay(merge("m1", { beforeSha: sha("1"), afterSha: sha("3") }), merge("m2", { pr: 8, beforeSha: sha("2"), afterSha: sha("4") }));
		await held("pr_range_not_contiguous", /not contiguous/);
	});
	it("a merge into a different branch than the push is not one release", async () => {
		await relay(push("p1", "1".repeat(7), "2".repeat(7)), merge("m1", { baseRef: "release", beforeSha: sha("2"), afterSha: sha("3") }));
		await held("pr_range_not_contiguous", /main and release|release and main/);
	});
	it("one good merge does not rescue another that is unverified", async () => {
		await relay(merge("m1", { beforeSha: sha("1"), afterSha: sha("2") }), act("m2", "pr.merge", "gh pr merge 9 --squash", { target: "#9" }));
		await held("pr_merge_old_runner", /older than CLI/);
	});
});

describe("a merge that did not happen creates no note", () => {
	it("a failed merge command alone ships nothing: no row, no post, nothing read", async () => {
		await relay(act("m1", "pr.merge", "gh pr merge 42 --squash", { target: "#42", ok: false }));
		const { d, posts, githubCalls } = deps();
		expect((await postReleaseNotes(input(), d)).status).toBe("not_shipped");
		expect(posts).toEqual([]);
		expect(githubCalls).toEqual([]);
		expect(await rows()).toEqual([]);
	});
	it("a failed merge beside a good direct push does not hold the push", async () => {
		await relay(push("p1", "1".repeat(7), "2".repeat(7)), act("m1", "pr.merge", "gh pr merge 42 --squash", { target: "#42", ok: false }));
		expect((await postReleaseNotes(input(), deps().d)).status).toBe("queued");
	});
	it("without a gate, a merge that is only scheduled (--auto) or unobserved is not a trunk change; a completed one still is", async () => {
		d1.exec(`UPDATE agent_instances SET config = '${JSON.stringify({ releaseNotes: {} })}' WHERE id = 'inst-1'`);
		await relay(act("m1", "pr.merge", "gh pr merge 42 --squash --auto", { target: "#42" }));
		expect((await postReleaseNotes(input(), deps().d)).status).toBe("not_shipped");
		d1.exec("DELETE FROM agent_events WHERE event = 'act.consequential'");
		await relay(act("m2", "pr.merge", "gh pr merge 42 --squash", { target: "#42", ok: null }));
		expect((await postReleaseNotes(input(), deps().d)).status).toBe("not_shipped");
		d1.exec("DELETE FROM agent_events WHERE event = 'act.consequential'");
		await relay(act("m3", "pr.merge", "gh pr merge 42 --squash", { target: "#42", mergeUnverified: "not_merged" }));
		expect((await postReleaseNotes(input(), deps().d)).status).toBe("not_shipped");
		d1.exec("DELETE FROM agent_events WHERE event = 'act.consequential'");
		await relay(act("m4", "pr.merge", "gh pr merge 42 --squash", { target: "#42" }));
		expect((await postReleaseNotes(input(), deps().d)).status).toBe("posted");
	});
});

describe("the runner's payload is validated on the way in", () => {
	it("keeps a v1 merge only on a successful pr.merge, and strips it from anything else", () => {
		const [good] = sanitizeEngineActs([merge("m1")]);
		expect(good.merge).toEqual(evidence());
		const [failed] = sanitizeEngineActs([merge("m2", {}, { ok: false })]);
		expect(failed.merge).toBeUndefined();
		const [push] = sanitizeEngineActs([act("p1", "push.trunk", "git push origin main", { target: "origin main", merge: evidence() })]);
		expect(push.merge).toBeUndefined();
	});
	it.each([
		["a wrong version", { v: 2 }],
		["a missing contract version", { v: undefined }],
		["a short SHA", { beforeSha: "abc123" }],
		["identical before and after", { afterSha: sha("a") }],
		["an unknown method", { method: "fast-forward" }],
		["a non-numeric PR", { pr: "42" }],
		["a bad branch", { baseRef: "main; rm -rf /" }],
		["a bad login", { mergedBy: "not a login!" }],
		["an unparseable time", { mergedAt: "yesterday" }],
	])("treats %s as malformed evidence, never as a merge", (_name, patch) => {
		const [a] = sanitizeEngineActs([act("m1", "pr.merge", "gh pr merge 42 --squash", { target: "#42", merge: { ...evidence(), ...patch } })]);
		expect(a.merge).toBeUndefined();
		expect(a.mergeUnverified).toBe("malformed");
	});
	it("accepts the runner's reason codes only from a known list, and a short detail", () => {
		const [known] = sanitizeEngineActs([act("m1", "pr.merge", "gh pr merge 42 --squash", { target: "#42", mergeUnverified: "wrong_branch", mergeDetail: "merged into acme/x:dev" })]);
		expect(known).toMatchObject({ mergeUnverified: "wrong_branch", mergeDetail: "merged into acme/x:dev" });
		const [unknown] = sanitizeEngineActs([act("m2", "pr.merge", "gh pr merge 42 --squash", { target: "#42", mergeUnverified: "trust_me" })]);
		expect(unknown.mergeUnverified).toBeUndefined();
		const [long] = sanitizeEngineActs([act("m3", "pr.merge", "gh pr merge 42 --squash", { target: "#42", mergeUnverified: "unreadable", mergeDetail: "x".repeat(500) })]);
		expect(long.mergeDetail).toBeUndefined();
	});
	it("a runner that predates the contract sends neither field, and none is invented", () => {
		const [old] = sanitizeEngineActs([act("m1", "pr.merge", "gh pr merge 42 --squash", { target: "#42" })]);
		expect(old.merge).toBeUndefined();
		expect(old.mergeUnverified).toBeUndefined();
	});
});
