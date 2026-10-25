/**
 * #1350 — the runner's evidence for a synchronous `gh pr merge`, against deterministic `gh` fixtures.
 * The claim is only ever attached for a completed, non-`--auto` merge into the default branch by this account, in this
 * act's window, whose merge result has the shape that method produces. Everything else is `mergeUnverified` with a code.
 */
import { describe, expect, it } from "vitest";
import type { EngineActRecord } from "./engine-acts.js";
import { collectMergeEvidence, type GhRunner, MERGE_CONTRACT_VERSION, parseMergeCommand, settleMergeLookups, trackMergeLookups, withMergeEvidence } from "./merge-evidence.js";

const BEFORE = "a".repeat(40);
const AFTER = "b".repeat(40);
const AT = "2026-10-25T10:00:00Z";
const NOW = Date.parse("2026-10-25T10:00:30Z");
const OUT = "✓ Merged pull request #42 (feat: thing)";

type Fixture = { list?: unknown; pull?: Record<string, unknown> | null; repo?: Record<string, unknown> | null; user?: Record<string, unknown> | null; commit?: Record<string, unknown> | null; view?: string };
const pull = (extra: Record<string, unknown> = {}) => ({ merged: true, merged_at: "2026-10-25T10:00:10Z", merged_by: { login: "serge" }, merge_commit_sha: AFTER, base: { ref: "main", repo: { full_name: "acme/app" } }, head: { sha: "c".repeat(40) }, commits: 3, ...extra });
/** `n` rebased commits on BEFORE, as `commits?sha=<result>&per_page=n+1` lists them: newest (the result) first, the prior tip last. */
const rebased = (n: number) => [...Array.from({ length: n }, (_x, i) => ({ sha: i === 0 ? AFTER : String(n - i).repeat(40), parents: [{ sha: i === n - 1 ? BEFORE : String(n - i - 1).repeat(40) }] })).map((e, i) => (i === 0 ? { ...e, parents: [{ sha: n === 1 ? BEFORE : String(n - 1).repeat(40) }] } : e)), { sha: BEFORE, parents: [{ sha: "9".repeat(40) }] }];
const commit = (parents: string[]) => ({ sha: AFTER, parents: parents.map((sha) => ({ sha })) });

/** `gh` as GitHub answers it. `null` means that read fails. */
function gh(f: Fixture = {}) {
	const calls: string[][] = [];
	const run: GhRunner = async (args) => {
		calls.push(args);
		const path = args.join(" ");
		const reply = (v: unknown) => (v === null ? { code: 1, stdout: "" } : { code: 0, stdout: typeof v === "string" ? v : JSON.stringify(v) });
		if (path.startsWith("repo view")) return reply(f.view ?? { nameWithOwner: "acme/app" });
		if (/api repos\/[^/]+\/[^/]+\/commits\?sha=/.test(path)) return reply(f.list === undefined ? rebased(3) : f.list);
		if (/api repos\/[^/]+\/[^/]+\/pulls\/\d+/.test(path)) return reply(f.pull === undefined ? pull() : f.pull);
		if (/api repos\/[^/]+\/[^/]+\/commits\//.test(path)) return reply(f.commit === undefined ? commit([BEFORE]) : f.commit);
		if (/^api repos\/[^/]+\/[^/]+$/.test(path)) return reply(f.repo === undefined ? { default_branch: "main" } : f.repo);
		if (path === "api user") return reply(f.user === undefined ? { login: "serge" } : f.user);
		return { code: 1, stdout: "" };
	};
	return { run, calls };
}
const act = (command: string, extra: Partial<EngineActRecord> = {}): EngineActRecord => ({ id: "r:t:0", kind: "pr.merge", command, target: "#42", irreversible: true, ok: true, at: AT, ...extra });

describe("reading the merge command", () => {
	it("takes the PR, repo, method and --auto from the segment that merges", () => {
		expect(parseMergeCommand("gh pr merge 42 --squash")).toEqual({ pr: 42, repo: null, method: "squash", auto: false });
		expect(parseMergeCommand("git push && gh pr merge --rebase 7 -R acme/app")).toEqual({ pr: 7, repo: "acme/app", method: "rebase", auto: false });
		expect(parseMergeCommand("gh pr merge https://github.com/acme/app/pull/9 -m")).toEqual({ pr: 9, repo: "acme/app", method: "merge", auto: false });
		expect(parseMergeCommand("gh pr merge 42 --squash --auto")?.auto).toBe(true);
		expect(parseMergeCommand("gh pr merge 42 --merge-queue --squash")?.auto).toBe(true);
		expect(parseMergeCommand("gh pr view 42")).toBeNull();
	});
});

describe("a completed synchronous merge carries GitHub's evidence (#1350)", () => {
	it.each([
		["merge", "--merge", [BEFORE, "c".repeat(40)]],
		["squash", "--squash", [BEFORE]],
		["rebase", "--rebase", ["2".repeat(40)]],
	])("%s: before is the prior branch tip, after is GitHub's merge commit", async (method, flag, parents) => {
		const found = await collectMergeEvidence(gh({ commit: commit(parents as string[]) }).run, act(`gh pr merge 42 ${flag}`), OUT, NOW);
		expect(found).toEqual({ merge: { v: MERGE_CONTRACT_VERSION, repo: "acme/app", pr: 42, baseRef: "main", method, beforeSha: BEFORE, afterSha: AFTER, mergedAt: "2026-10-25T10:00:10Z", mergedBy: "serge", actor: "serge" } });
	});
	it("a rebase takes its prior tip from the foot of the PR's rebased commits, not from the result's parent", async () => {
		const found = await collectMergeEvidence(gh({ commit: commit(["2".repeat(40)]), pull: pull({ commits: 3 }) }).run, act("gh pr merge 42 --rebase"), OUT, NOW);
		expect(found).toMatchObject({ merge: { method: "rebase", beforeSha: BEFORE, afterSha: AFTER } });
	});
	it("takes the repo from --repo without asking the working directory", async () => {
		const f = gh();
		await collectMergeEvidence(f.run, act("gh pr merge 42 --squash -R acme/app"), OUT, NOW);
		expect(f.calls.some((c) => c[0] === "repo")).toBe(false);
	});
	it("withMergeEvidence attaches it to the act and leaves everything else alone", async () => {
		const merged = await withMergeEvidence(act("gh pr merge 42 --squash"), OUT, gh().run, NOW);
		expect(merged.merge).toMatchObject({ v: 1, beforeSha: BEFORE, afterSha: AFTER });
		expect(merged.mergeUnverified).toBeUndefined();
		const push = act("git push origin main", { kind: "push.trunk" });
		expect(await withMergeEvidence(push, OUT, gh().run, NOW)).toBe(push);
		const failed = act("gh pr merge 42 --squash", { ok: false });
		expect(await withMergeEvidence(failed, "failed", gh().run, NOW)).toBe(failed); // a failed command is not looked up
		const unseen = act("gh pr merge 42 --squash", { ok: null });
		expect(await withMergeEvidence(unseen, "", gh().run, NOW)).toBe(unseen);
	});
});

describe("anything short of a proved completed merge is unverified, with a code", () => {
	const unverified = async (f: Fixture, command: string, out: string, code: string) => {
		const found = await collectMergeEvidence(gh(f).run, act(command), out, NOW);
		expect(found).toMatchObject({ unverified: code });
		expect("merge" in found).toBe(false);
	};
	it("--auto and the merge queue only schedule a merge", async () => {
		await unverified({}, "gh pr merge 42 --squash --auto", "✓ Pull request #42 will be automatically merged via squash when all requirements are met", "auto");
	});
	it("output that says the merge is scheduled or queued", async () => {
		await unverified({}, "gh pr merge 42 --squash", "Pull request #42 will be added to the merge queue for main when ready", "scheduled");
		await unverified({}, "gh pr merge 42 --squash", "Auto-merge enabled for pull request #42", "scheduled");
	});
	it("output that does not say it was merged", async () => {
		await unverified({}, "gh pr merge 42 --squash", "Pull request #42 is still a draft", "unrecognized_output");
		await unverified({}, "gh pr merge 42 --squash", "", "unrecognized_output");
	});
	it("a PR GitHub says is still open", async () => {
		await unverified({ pull: pull({ merged: false, merged_at: null }) }, "gh pr merge 42 --squash", OUT, "not_merged");
	});
	it("a merge into another branch or another repository", async () => {
		await unverified({ pull: pull({ base: { ref: "release", repo: { full_name: "acme/app" } } }) }, "gh pr merge 42 --squash", OUT, "wrong_branch");
		await unverified({ pull: pull({ base: { ref: "main", repo: { full_name: "acme/other" } } }) }, "gh pr merge 42 --squash", OUT, "wrong_branch");
		await unverified({ repo: { default_branch: "develop" } }, "gh pr merge 42 --squash", OUT, "wrong_branch");
	});
	it("no merge method on the command line", async () => {
		await unverified({}, "gh pr merge 42", OUT, "method_unknown");
	});
	it("a result whose shape is not what the method produces", async () => {
		await unverified({ commit: commit([BEFORE]) }, "gh pr merge 42 --merge", OUT, "method_mismatch");
		await unverified({ commit: commit([BEFORE, "c".repeat(40)]) }, "gh pr merge 42 --squash", OUT, "method_mismatch");
	});
	it("a PR merged by someone else, or long before this command", async () => {
		await unverified({ pull: pull({ merged_by: { login: "mallory" } }) }, "gh pr merge 42 --squash", OUT, "actor_mismatch");
		await unverified({ pull: pull({ merged_at: "2026-10-25T08:00:00Z" }) }, "gh pr merge 42 --squash", OUT, "actor_mismatch");
		await unverified({ pull: pull({ merged_at: "2026-10-25T11:00:00Z" }) }, "gh pr merge 42 --squash", OUT, "actor_mismatch");
	});
	it.each([
		["the PR cannot be read", { pull: null }],
		["the account cannot be read", { user: null }],
		["the repository cannot be read", { repo: null }],
		["the merge commit cannot be read", { commit: null }],
		["GitHub reports no merge commit", { pull: pull({ merge_commit_sha: null }) }],
		["the merge commit is not the one asked for", { commit: { sha: "d".repeat(40), parents: [{ sha: BEFORE }] } }],
		["a parent is not a full SHA", { commit: commit(["abc123"]) }],
	])("%s", async (_name, f) => {
		await unverified(f as Fixture, "gh pr merge 42 --squash", OUT, "unreadable");
	});
	it("a rebase it cannot map exactly: not one line, the wrong count, too many commits, or unreadable", async () => {
		const rb = (f: Fixture) => unverified({ commit: commit(["2".repeat(40)]), ...f }, "gh pr merge 42 --rebase", OUT, "method_mismatch");
		const forked = rebased(3).map((e, i) => (i === 1 ? { ...e, parents: [{ sha: "7".repeat(40) }] } : e));
		await rb({ list: forked });
		await rb({ list: rebased(3).slice(1) }); // a commit short
		await rb({ pull: pull({ commits: 150 }) });
		await rb({ pull: pull({ commits: 0 }) });
		await unverified({ commit: commit(["2".repeat(40)]), list: null }, "gh pr merge 42 --rebase", OUT, "unreadable");
	});
	it("a lookup that throws is unverified, never an unhandled error", async () => {
		const boom: GhRunner = async () => { throw new Error("spawn failed"); };
		const result = await withMergeEvidence(act("gh pr merge 42 --squash"), OUT, boom, NOW);
		expect(result).toMatchObject({ mergeUnverified: "unreadable", ok: true });
		expect(result.merge).toBeUndefined();
	});
});

describe("publishing a merge only once GitHub has been asked (#1350)", () => {
	it("does nothing for acts that are not completed merges, so they publish as before", () => {
		const published: EngineActRecord[] = [];
		const pending = new Set<Promise<void>>();
		const acts = [act("git push origin main", { kind: "push.trunk" }), act("gh pr merge 42 --squash", { ok: false }), act("gh pr merge 42 --squash", { ok: null })];
		expect(trackMergeLookups(acts, OUT, () => gh().run, (a) => published.push(a), pending)).toBe(false);
		expect(published).toEqual([]);
		expect(pending.size).toBe(0);
	});
	it("publishes each act exactly once, the merge with its evidence, after the lookup; settling waits for it", async () => {
		const published: EngineActRecord[] = [];
		const pending = new Set<Promise<void>>();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => { release = r; });
		const nowIso = new Date().toISOString(); // these helpers read the real clock, so the fixture is "just now"
		const slow: GhRunner = async (args) => { await gate; return gh({ pull: pull({ merged_at: nowIso }) }).run(args); };
		const push = act("git push origin main", { id: "r:t:0", kind: "push.trunk", at: nowIso });
		const merged = act("gh pr merge 42 --squash", { id: "r:t:1", at: nowIso });
		expect(trackMergeLookups([push, merged], OUT, () => slow, (a) => published.push(a), pending)).toBe(true);
		expect(published).toEqual([]); // nothing is published while the lookup is still out
		const settled = settleMergeLookups(pending);
		release();
		await settled;
		expect(published.map((a) => a.id)).toEqual(["r:t:0", "r:t:1"]);
		expect(published[1].merge).toMatchObject({ v: 1, afterSha: AFTER });
		expect(pending.size).toBe(0);
	});
	it("a lookup that never answers cannot hold the end of a run past the bound", async () => {
		const pending = new Set<Promise<void>>();
		const stuck: GhRunner = () => new Promise(() => undefined);
		trackMergeLookups([act("gh pr merge 42 --squash")], OUT, () => stuck, () => undefined, pending);
		const started = Date.now();
		await settleMergeLookups(pending, 50);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(pending.size).toBe(1);
	});
});
