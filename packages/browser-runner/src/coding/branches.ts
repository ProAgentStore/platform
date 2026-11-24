import { execFileSync } from "node:child_process";
import { InspectError, networkGitEnv } from "./inspect.js";
import type { GhRunner } from "./merge-evidence.js";

/**
 * Branch inventory, comparison, integration and removal on the machine that holds the checkout (#1700).
 *
 * ── The rules every function here keeps
 *
 *   * Fixed argv, no shell. The only caller-supplied tokens are a branch name (a conservative alphabet, no `..`)
 *     and a full 40-hex SHA.
 *   * Inventory and comparison are READS. They never move a ref the caller can see; the only write is a fetch of
 *     the default branch's tracking ref, which `compareBranch` says it did.
 *   * Every mutation takes the tip the caller READ, and re-reads it at execution. A tip that moved between
 *     preview and execution is `stale_tip`, never a best effort. Local deletion is `update-ref -d <ref> <old>`,
 *     which git itself refuses if the ref no longer holds that SHA.
 *   * No force push, no `--force-with-lease`, no bypass: integration is a plain push of a tip that fast-forwards
 *     the default branch, so GitHub's own branch protection and required checks still decide, and we check them
 *     first so the refusal is named instead of a rejected push.
 *   * Every answer is built from a re-read (the remote's live tip, the ref's presence), not from an exit code.
 *   * Whether a branch is protected is only claimed when GitHub said so. Otherwise it is `null` (unknown), and the
 *     conventional names (`main`, `master`, `release/*`...) are refused regardless.
 *
 * The workflow integration supports is a direct fast-forward of the default branch. A repo that requires pull
 * requests answers the push with a rejection that is passed back as `push_rejected`; opening PRs is a separate
 * decision this file does not make.
 */

export const BRANCH_LIST_MAX = 200;
export const COMPARE_COMMITS_MAX = 50;
export const COMPARE_FILES_MAX = 200;
const REMOTE = "origin";
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,127}$/;
const SHA = /^[0-9a-f]{40}$/;
const PROTECTED_NAME = /^(main|master|trunk|develop|development|production|prod|release\/.+|releases\/.+)$/;

export const isProtectedName = (name: string): boolean => PROTECTED_NAME.test(name);

export function git(workDir: string, argv: string[], timeout = 30_000): string {
	return execFileSync("git", argv, { cwd: workDir, encoding: "utf-8", timeout, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: networkGitEnv() }).trimEnd();
}

export function gitTry(workDir: string, argv: string[], timeout?: number): string | null {
	try {
		return git(workDir, argv, timeout);
	} catch {
		return null;
	}
}

export function gitMessage(e: unknown): string {
	const raw = String((e as { stderr?: unknown }).stderr || (e instanceof Error ? e.message : e) || "git failed");
	return (raw.split("\n").map((l) => l.trim()).find((l) => l && !/^hint:/i.test(l)) ?? "git failed").replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<remote>").slice(0, 240);
}

export function requireCheckout(workDir: string): void {
	if (gitTry(workDir, ["rev-parse", "--git-dir"]) === null) throw new InspectError(`not a git checkout: ${workDir}`);
}

export function validBranch(name: unknown): string {
	if (typeof name !== "string" || !BRANCH.test(name) || name.includes("..") || name.includes("//") || /(\.lock|\/|\.)$/.test(name)) throw new InspectError("`branch` is not a usable branch name");
	return name;
}

export function validSha(sha: unknown, what = "expected_tip"): string {
	if (typeof sha !== "string" || !SHA.test(sha)) throw new InspectError(`\`${what}\` must be the full 40-character commit SHA`);
	return sha;
}

// ── Reads shared by the functions below ─────────────────────────────────────────────────────────

/** `owner/repo` of the origin remote when it is a GitHub one; never the URL, which may carry a credential. */
export function originSlug(workDir: string): string | null {
	const url = gitTry(workDir, ["config", "--get", `remote.${REMOTE}.url`]);
	const m = url ? /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url) : null;
	return m ? `${m[1]}/${m[2]}` : null;
}

interface LiveHeads {
	ok: boolean;
	heads: Map<string, string>;
	defaultName: string | null;
	error?: string;
}

/** The remote's heads as the remote reports them NOW (`ls-remote`), plus its default branch. */
export function liveRemote(workDir: string): LiveHeads {
	const heads = new Map<string, string>();
	let defaultName: string | null = null;
	try {
		for (const line of git(workDir, ["ls-remote", "--symref", REMOTE, "HEAD", "refs/heads/*"], 25_000).split("\n")) {
			const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
			if (sym) defaultName = sym[1];
			const m = /^([0-9a-f]{40})\trefs\/heads\/(\S+)$/.exec(line);
			if (m) heads.set(m[2], m[1]);
		}
		return { ok: true, heads, defaultName };
	} catch (e) {
		return { ok: false, heads, defaultName: null, error: gitMessage(e) };
	}
}

function cachedHeads(workDir: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of (gitTry(workDir, ["for-each-ref", "--format=%(refname)\t%(objectname)", `refs/remotes/${REMOTE}/`]) ?? "").split("\n").filter(Boolean)) {
		const [ref, sha] = line.split("\t");
		const name = ref.slice(`refs/remotes/${REMOTE}/`.length);
		if (name && name !== "HEAD") out.set(name, sha);
	}
	return out;
}

/** Each branch checked out in ANY work tree of this repository — the main one and every linked one. */
export function checkedOutBranches(workDir: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	let path = "";
	for (const line of (gitTry(workDir, ["worktree", "list", "--porcelain"]) ?? "").split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice(9);
		const b = /^branch refs\/heads\/(.+)$/.exec(line);
		if (b) out.set(b[1], [...(out.get(b[1]) ?? []), path]);
	}
	return out;
}

/** The names GitHub says are protected, or null when it cannot be read (no `gh`, no access, not GitHub). */
async function protectedOnRemote(gh: GhRunner | undefined, slug: string | null): Promise<Set<string> | null> {
	if (!gh || !slug) return null;
	const r = await gh(["api", `repos/${slug}/branches?protected=true&per_page=100`, "--jq", "[.[].name]"]);
	if (r.code !== 0) return null;
	try {
		const names = JSON.parse(r.stdout) as unknown;
		return Array.isArray(names) ? new Set(names.filter((n): n is string => typeof n === "string")) : null;
	} catch {
		return null;
	}
}

function defaultFrom(workDir: string, live: LiveHeads): { name: string; source: "live" | "cached" } | null {
	if (live.defaultName) return { name: live.defaultName, source: "live" };
	const sym = gitTry(workDir, ["symbolic-ref", "--short", `refs/remotes/${REMOTE}/HEAD`]);
	return sym?.startsWith(`${REMOTE}/`) ? { name: sym.slice(REMOTE.length + 1), source: "cached" } : null;
}

const counts = (workDir: string, from: string, to: string): { ahead: number; behind: number } | null => {
	const r = gitTry(workDir, ["rev-list", "--left-right", "--count", `${from}...${to}`]);
	if (!r) return null;
	const [behind, ahead] = r.split(/\s+/).map(Number);
	return { ahead, behind };
};

// ── Inventory ───────────────────────────────────────────────────────────────────────────────────

export interface LocalBranch {
	name: string;
	tip: string;
	upstream: string | null;
	/** Against its own upstream, from the cached tracking ref. Null with no upstream, or when it is gone. */
	upstreamAhead: number | null;
	upstreamBehind: number | null;
	upstreamGone: boolean;
	/** Against the default branch's tracking ref (cached). */
	aheadOfDefault: number | null;
	behindDefault: number | null;
	isDefault: boolean;
	checkedOutAt: string[];
	/** `byName`: a conventional protected name. `onRemote`: GitHub's answer, null when it could not be read. */
	protected: { byName: boolean; onRemote: boolean | null };
}

export interface RemoteBranch {
	name: string;
	/** The live tip, or — for `cached-only` — the tracking ref's last known tip. */
	tip: string;
	/** `live`: the remote reported it just now. `cached-only`: a tracking ref the remote no longer reports (stale), or every ref when the remote was unreachable. */
	source: "live" | "cached-only";
	cachedTip: string | null;
	/** Live tip differs from the tracking ref: the local cache is behind. */
	cacheStale: boolean;
	isDefault: boolean;
	protected: { byName: boolean; onRemote: boolean | null };
}

export interface BranchInventory {
	slug: string | null;
	remote: { name: string; live: boolean; error?: string };
	defaultBranch: { name: string; source: "live" | "cached" } | null;
	current: { branch: string | null; detached: boolean };
	local: LocalBranch[];
	remoteBranches: RemoteBranch[];
	truncated: { local: number | null; remote: number | null };
	/** Whether GitHub's protection list could be read; false means `onRemote` is null everywhere. */
	protectionKnown: boolean;
	readAt: string;
}

export async function branchInventory(workDir: string, deps: { gh?: GhRunner; now?: () => Date } = {}): Promise<BranchInventory> {
	requireCheckout(workDir);
	const live = liveRemote(workDir);
	const def = defaultFrom(workDir, live);
	const slug = originSlug(workDir);
	const prot = await protectedOnRemote(deps.gh, slug);
	const protect = (name: string) => ({ byName: isProtectedName(name), onRemote: prot ? prot.has(name) : null });
	const worktrees = checkedOutBranches(workDir);
	const cached = cachedHeads(workDir);
	const defaultRef = def && cached.has(def.name) ? `refs/remotes/${REMOTE}/${def.name}` : null;

	const rows = (git(workDir, ["for-each-ref", "--sort=refname", "--format=%(refname)\t%(objectname)\t%(upstream)\t%(upstream:track)", "refs/heads/"]) || "").split("\n").filter(Boolean);
	const local: LocalBranch[] = rows.slice(0, BRANCH_LIST_MAX).map((row) => {
		const [ref, tip, upstream, track] = row.split("\t");
		const name = ref.slice("refs/heads/".length);
		const toDefault = defaultRef ? counts(workDir, defaultRef, ref) : null;
		const gone = /\[gone\]/.test(track ?? "");
		const t = /ahead (\d+)/.exec(track ?? "");
		const b = /behind (\d+)/.exec(track ?? "");
		const tracking = upstream && !gone;
		return {
			name,
			tip,
			upstream: upstream ? upstream.replace(/^refs\/remotes\//, "") : null,
			upstreamAhead: tracking ? (t ? Number(t[1]) : 0) : null,
			upstreamBehind: tracking ? (b ? Number(b[1]) : 0) : null,
			upstreamGone: gone,
			aheadOfDefault: toDefault ? toDefault.ahead : null,
			behindDefault: toDefault ? toDefault.behind : null,
			isDefault: def?.name === name,
			checkedOutAt: worktrees.get(name) ?? [],
			protected: protect(name),
		};
	});

	const remoteBranches: RemoteBranch[] = [];
	for (const [name, tip] of live.heads) remoteBranches.push({ name, tip, source: "live", cachedTip: cached.get(name) ?? null, cacheStale: cached.get(name) !== tip, isDefault: def?.name === name, protected: protect(name) });
	for (const [name, tip] of cached) if (!live.heads.has(name)) remoteBranches.push({ name, tip, source: "cached-only", cachedTip: tip, cacheStale: live.ok, isDefault: def?.name === name, protected: protect(name) });
	remoteBranches.sort((a, b) => a.name.localeCompare(b.name));

	const head = gitTry(workDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	return {
		slug,
		remote: { name: REMOTE, live: live.ok, ...(live.error ? { error: live.error } : {}) },
		defaultBranch: def,
		current: { branch: head, detached: head === null },
		local,
		remoteBranches: remoteBranches.slice(0, BRANCH_LIST_MAX),
		truncated: { local: rows.length > BRANCH_LIST_MAX ? rows.length : null, remote: remoteBranches.length > BRANCH_LIST_MAX ? remoteBranches.length : null },
		protectionKnown: prot !== null,
		readAt: (deps.now?.() ?? new Date()).toISOString(),
	};
}

// ── Comparison ──────────────────────────────────────────────────────────────────────────────────

export interface BranchComparison {
	branch: string;
	/** Where the tip was read: the local branch, or its cached remote-tracking ref. */
	resolvedFrom: "local" | "remote-cached";
	tip: string;
	base: string;
	baseTip: string | null;
	/** The default branch's tracking ref was refreshed just now. False: the comparison is against a cached ref. */
	baseFetched: boolean;
	baseFetchError?: string;
	mergeBase: string | null;
	ahead: number | null;
	behind: number | null;
	commits: { sha: string; author: string; date: string; subject: string }[];
	commitsTotal: number;
	files: { status: string; path: string }[];
	filesTotal: number;
	shortstat: string;
	/** Everything the branch holds is already on the base. */
	merged: boolean;
}

export function resolveTip(workDir: string, branch: string): { tip: string; from: "local" | "remote-cached" } | null {
	const local = gitTry(workDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
	if (local) return { tip: local, from: "local" };
	const cached = gitTry(workDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${branch}^{commit}`]);
	return cached ? { tip: cached, from: "remote-cached" } : null;
}

export function compareBranch(workDir: string, input: { branch: string; base?: string }): BranchComparison {
	requireCheckout(workDir);
	const branch = validBranch(input.branch);
	const live = liveRemote(workDir);
	const base = input.base ? validBranch(input.base) : defaultFrom(workDir, live)?.name;
	if (!base) throw new InspectError("the default branch could not be determined (no live remote answer and no cached origin/HEAD); pass `base`");
	const from = resolveTip(workDir, branch);
	if (!from) throw new InspectError(`no branch "${branch}" locally or in the cached remote refs`);
	let baseFetched = false;
	let baseFetchError: string | undefined;
	try {
		git(workDir, ["fetch", "--quiet", REMOTE, `+refs/heads/${base}:refs/remotes/${REMOTE}/${base}`], 30_000);
		baseFetched = true;
	} catch (e) {
		baseFetchError = gitMessage(e);
	}
	const baseRef = gitTry(workDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${base}`]) ? `refs/remotes/${REMOTE}/${base}` : `refs/heads/${base}`;
	const baseTip = gitTry(workDir, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
	if (!baseTip) throw new InspectError(`no base branch "${base}" to compare against`);
	const c = counts(workDir, baseTip, from.tip);
	const range = `${baseTip}..${from.tip}`;
	const total = Number(gitTry(workDir, ["rev-list", "--count", range]) ?? 0);
	const commits = (gitTry(workDir, ["log", `-n${COMPARE_COMMITS_MAX}`, "--format=%H%x09%an%x09%cI%x09%s", range]) ?? "")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [sha, author, date, ...subject] = l.split("\t");
			return { sha, author, date, subject: subject.join("\t").slice(0, 200) };
		});
	const diffRange = `${baseTip}...${from.tip}`;
	const fileLines = (gitTry(workDir, ["diff", "--name-status", "-M", diffRange]) ?? "").split("\n").filter(Boolean);
	return {
		branch,
		resolvedFrom: from.from,
		tip: from.tip,
		base,
		baseTip,
		baseFetched,
		...(baseFetchError ? { baseFetchError } : {}),
		mergeBase: gitTry(workDir, ["merge-base", baseTip, from.tip]),
		ahead: c?.ahead ?? null,
		behind: c?.behind ?? null,
		commits,
		commitsTotal: total,
		files: fileLines.slice(0, COMPARE_FILES_MAX).map((l) => {
			const [status, ...path] = l.split("\t");
			return { status, path: path.join(" -> ") };
		}),
		filesTotal: fileLines.length,
		shortstat: (gitTry(workDir, ["diff", "--shortstat", diffRange]) ?? "").trim(),
		merged: total === 0,
	};
}

// ── Mutations: integrate and delete ─────────────────────────────────────────────────────────────

export type BranchRefusal =
	| "not_found"
	| "stale_tip"
	| "protected"
	| "default_branch"
	| "checked_out"
	| "remote_unreachable"
	| "no_default"
	| "diverged"
	| "nothing_to_integrate"
	| "checks_failed"
	| "checks_pending"
	| "checks_unverifiable"
	| "push_rejected"
	| "readback_mismatch"
	| "failed";

export type ChecksState = "passed" | "none_required" | "failed" | "pending" | "unverifiable";

export interface ChecksReading {
	state: ChecksState;
	/** The contexts the default branch's protection requires; null when unprotected or unreadable. */
	required: string[] | null;
	items: { name: string; state: "ok" | "pending" | "failed" }[];
	detail?: string;
}

export interface Unique {
	commits: { sha: string; subject: string }[];
	commitsTotal: number;
	files: { status: string; path: string }[];
	filesTotal: number;
}

export interface BranchActionResult {
	ok: boolean;
	dryRun: boolean;
	action: "integrate" | "delete_local" | "delete_remote";
	branch: string;
	reason?: BranchRefusal;
	error?: string;
	/** The tip the caller expects, the tip actually read, and the default branch's. */
	expectedTip: string | null;
	tip: string | null;
	defaultBranch: string | null;
	/** What the branch holds that the default branch does not — shown BEFORE anything is done. */
	unique?: Unique;
	/** Commits that exist on no remote head: deleting the local branch would leave them only in the reflog. */
	unpushed?: number | null;
	checks?: ChecksReading;
	/** Integrate only: the default branch's live tip before, and after. */
	remoteTipBefore?: string | null;
	remoteTipAfter?: string | null;
	/** Present only when the change was made and read back. */
	receipt?: { at: string; slug: string | null; from: string | null; to: string | null; recover: string | null };
}

const uniqueAgainst = (workDir: string, baseRef: string, tip: string): Unique => {
	const range = `${baseRef}..${tip}`;
	const files = (gitTry(workDir, ["diff", "--name-status", "-M", `${baseRef}...${tip}`]) ?? "").split("\n").filter(Boolean);
	return {
		commits: (gitTry(workDir, ["log", "-n20", "--format=%H%x09%s", range]) ?? "").split("\n").filter(Boolean).map((l) => {
			const [sha, ...s] = l.split("\t");
			return { sha, subject: s.join("\t").slice(0, 160) };
		}),
		commitsTotal: Number(gitTry(workDir, ["rev-list", "--count", range]) ?? 0),
		files: files.slice(0, 100).map((l) => {
			const [status, ...p] = l.split("\t");
			return { status, path: p.join(" -> ") };
		}),
		filesTotal: files.length,
	};
};

/** Read the checks that gate `sha` onto `defaultName`: GitHub's required contexts (when readable) against the commit's check runs and statuses. */
export async function readChecks(gh: GhRunner | undefined, slug: string | null, sha: string, defaultName: string): Promise<ChecksReading> {
	if (!gh || !slug) return { state: "unverifiable", required: null, items: [], detail: !slug ? "the origin remote is not a GitHub repository" : "`gh` is not available on this machine" };
	const read = async (endpoint: string, jq: string): Promise<unknown | undefined> => {
		const r = await gh(["api", endpoint, "--jq", jq]);
		if (r.code !== 0) return undefined;
		try {
			return JSON.parse(r.stdout);
		} catch {
			return undefined;
		}
	};
	const branch = (await read(`repos/${slug}/branches/${defaultName}`, "{protected: .protected, contexts: (.protection.required_status_checks.contexts // [])}")) as { protected?: boolean; contexts?: unknown } | undefined;
	const runs = (await read(`repos/${slug}/commits/${sha}/check-runs?per_page=100`, "[.check_runs[] | {name, status, conclusion}]")) as { name: string; status: string; conclusion: string | null }[] | undefined;
	const statuses = (await read(`repos/${slug}/commits/${sha}/status`, "[.statuses[] | {context, state}]")) as { context: string; state: string }[] | undefined;
	if (!branch || !runs || !statuses) return { state: "unverifiable", required: null, items: [], detail: "GitHub did not answer the branch-protection or check reads (no access, or the commit is not on GitHub)" };
	const items: ChecksReading["items"] = [
		...runs.map((r) => ({ name: r.name, state: (r.status !== "completed" ? "pending" : ["success", "neutral", "skipped"].includes(r.conclusion ?? "") ? "ok" : "failed") as "ok" | "pending" | "failed" })),
		...statuses.map((s) => ({ name: s.context, state: (s.state === "success" ? "ok" : s.state === "pending" ? "pending" : "failed") as "ok" | "pending" | "failed" })),
	];
	const required = Array.isArray(branch.contexts) && branch.contexts.length > 0 ? (branch.contexts as string[]) : null;
	const relevant = required ? required.map((name) => items.filter((i) => i.name === name)) : items.map((i) => [i]);
	const verdicts = relevant.map((group) => (group.length === 0 ? "pending" : group.some((i) => i.state === "failed") ? "failed" : group.some((i) => i.state === "pending") ? "pending" : "ok"));
	const state: ChecksState = verdicts.includes("failed") ? "failed" : verdicts.includes("pending") ? "pending" : required || items.length > 0 ? "passed" : "none_required";
	return { state, required, items };
}

const CHECK_REFUSAL: Partial<Record<ChecksState, BranchRefusal>> = { failed: "checks_failed", pending: "checks_pending", unverifiable: "checks_unverifiable" };

function base(action: BranchActionResult["action"], branch: string, expectedTip: string | null, dryRun: boolean): BranchActionResult {
	return { ok: false, dryRun, action, branch, expectedTip, tip: null, defaultBranch: null };
}

/** Integrate: fast-forward the default branch to this local branch's tip, through its protection and checks. */
export async function integrateBranch(workDir: string, input: { branch: string; expectedTip?: string; dryRun: boolean }, deps: { gh?: GhRunner; now?: () => Date } = {}): Promise<BranchActionResult> {
	requireCheckout(workDir);
	const branch = validBranch(input.branch);
	const expected = input.expectedTip === undefined ? null : validSha(input.expectedTip);
	const out = base("integrate", branch, expected, input.dryRun);
	const tip = gitTry(workDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
	if (!tip) return { ...out, reason: "not_found", error: `no local branch "${branch}"` };
	out.tip = tip;
	const live = liveRemote(workDir);
	if (!live.ok) return { ...out, reason: "remote_unreachable", error: `the remote did not answer, so the default branch's tip is unknown: ${live.error}` };
	const def = defaultFrom(workDir, live)?.name ?? null;
	if (!def) return { ...out, reason: "no_default", error: "the remote did not name a default branch" };
	out.defaultBranch = def;
	if (branch === def) return { ...out, reason: "default_branch", error: `"${branch}" is the default branch; there is nothing to integrate it into` };
	if (!input.dryRun && !expected) throw new InspectError("`expected_tip` is required to integrate: preview first and pass the tip it returned");
	if (expected && expected !== tip) return { ...out, reason: "stale_tip", error: `"${branch}" is at ${tip}, not the ${expected} that was previewed — it moved; preview again` };
	const before = live.heads.get(def) ?? null;
	out.remoteTipBefore = before;
	if (!before) return { ...out, reason: "remote_unreachable", error: `the remote reported no head for ${def}` };
	if (before === tip) return { ...out, reason: "nothing_to_integrate", error: `${def} is already at ${tip}` };
	// The remote default's objects must be here to prove fast-forward; fetch it (a tracking-ref write only).
	gitTry(workDir, ["fetch", "--quiet", REMOTE, `+refs/heads/${def}:refs/remotes/${REMOTE}/${def}`], 30_000);
	if (gitTry(workDir, ["merge-base", "--is-ancestor", before, tip]) === null) {
		return { ...out, reason: "diverged", unique: uniqueAgainst(workDir, before, tip), error: `${def} (${before.slice(0, 8)}) is not an ancestor of "${branch}": it has changes the branch lacks. Update the branch from ${def} first — integration only fast-forwards, it never merges or forces.` };
	}
	out.unique = uniqueAgainst(workDir, before, tip);
	const slug = originSlug(workDir);
	out.checks = await readChecks(deps.gh, slug, tip, def);
	const refusal = CHECK_REFUSAL[out.checks.state];
	if (refusal) return { ...out, reason: refusal, error: `${def} requires its checks to pass before it takes ${tip.slice(0, 8)}: ${out.checks.state}${out.checks.detail ? ` (${out.checks.detail})` : ""}` };
	if (input.dryRun) return { ...out, ok: true };
	try {
		git(workDir, ["push", "--porcelain", REMOTE, `${tip}:refs/heads/${def}`], 90_000);
	} catch (e) {
		return { ...out, reason: "push_rejected", error: `the remote declined the push: ${gitMessage(e)}` };
	}
	const after = liveRemote(workDir).heads.get(def) ?? null;
	out.remoteTipAfter = after;
	gitTry(workDir, ["fetch", "--quiet", REMOTE, `+refs/heads/${def}:refs/remotes/${REMOTE}/${def}`], 30_000);
	if (after !== tip) return { ...out, reason: "readback_mismatch", error: `the push returned but ${def} reads back as ${after ?? "absent"}, not ${tip}` };
	return { ...out, ok: true, receipt: { at: (deps.now?.() ?? new Date()).toISOString(), slug, from: before, to: tip, recover: null } };
}

/** Delete one exact branch, locally or on the remote, after re-reading its tip. */
export async function deleteBranch(workDir: string, input: { scope: "local" | "remote"; branch: string; expectedTip?: string; dryRun: boolean }, deps: { gh?: GhRunner; now?: () => Date } = {}): Promise<BranchActionResult> {
	requireCheckout(workDir);
	const branch = validBranch(input.branch);
	const expected = input.expectedTip === undefined ? null : validSha(input.expectedTip);
	const action = input.scope === "local" ? "delete_local" : "delete_remote";
	const out = base(action, branch, expected, input.dryRun);
	if (!input.dryRun && !expected) throw new InspectError("`expected_tip` is required to delete: preview first and pass the tip it returned");
	const live = liveRemote(workDir);
	const def = defaultFrom(workDir, live)?.name ?? null;
	out.defaultBranch = def;
	if (def === branch) return { ...out, reason: "default_branch", error: `"${branch}" is the default branch and is never deleted` };
	if (isProtectedName(branch)) return { ...out, reason: "protected", error: `"${branch}" has a protected-branch name and is never deleted here` };
	const slug = originSlug(workDir);
	const prot = await protectedOnRemote(deps.gh, slug);
	if (prot?.has(branch)) return { ...out, reason: "protected", error: `GitHub reports "${branch}" as protected` };
	const where = checkedOutBranches(workDir).get(branch);
	if (where) return { ...out, reason: "checked_out", error: `"${branch}" is checked out in ${where.join(", ")}; switch that work tree away first` };

	let tip: string | null;
	if (input.scope === "local") {
		tip = gitTry(workDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
		if (!tip) return { ...out, reason: "not_found", error: `no local branch "${branch}"` };
	} else {
		if (!live.ok) return { ...out, reason: "remote_unreachable", error: `the remote did not answer: ${live.error}` };
		tip = live.heads.get(branch) ?? null;
		if (!tip) return { ...out, reason: "not_found", error: `the remote has no branch "${branch}" (a cached tracking ref, if any, is stale)` };
		// Objects for the preview; a failure leaves the preview without it and says so below.
		gitTry(workDir, ["fetch", "--quiet", REMOTE, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`], 30_000);
	}
	out.tip = tip;
	if (expected && expected !== tip) return { ...out, reason: "stale_tip", error: `"${branch}" is at ${tip}, not the ${expected} that was previewed — it moved; preview again` };

	const defRef = def && gitTry(workDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${def}`]) ? `refs/remotes/${REMOTE}/${def}` : null;
	const haveObjects = gitTry(workDir, ["cat-file", "-e", `${tip}^{commit}`]) !== null;
	if (defRef && haveObjects) out.unique = uniqueAgainst(workDir, defRef, tip);
	if (input.scope === "local" && haveObjects) {
		const containing = (gitTry(workDir, ["branch", "-r", "--contains", tip]) ?? "").split("\n").filter((l) => l.trim() && !l.includes("->"));
		out.unpushed = containing.length === 0 ? (out.unique?.commitsTotal ?? null) : 0;
	}
	if (input.dryRun) return { ...out, ok: true };

	const at = (deps.now?.() ?? new Date()).toISOString();
	if (input.scope === "local") {
		try {
			// Git refuses this unless the ref still holds exactly `tip`: the check and the delete are one operation.
			git(workDir, ["update-ref", "-d", `refs/heads/${branch}`, tip]);
		} catch (e) {
			return { ...out, reason: "failed", error: `the delete did not run: ${gitMessage(e)}` };
		}
		if (gitTry(workDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== null) return { ...out, reason: "readback_mismatch", error: `"${branch}" still exists after the delete` };
		return { ...out, ok: true, receipt: { at, slug, from: tip, to: null, recover: `git branch ${branch} ${tip}` } };
	}
	try {
		git(workDir, ["push", "--porcelain", REMOTE, `:refs/heads/${branch}`], 60_000);
	} catch (e) {
		return { ...out, reason: "push_rejected", error: `the remote declined the delete: ${gitMessage(e)}` };
	}
	const stillThere = liveRemote(workDir).heads.get(branch);
	gitTry(workDir, ["update-ref", "-d", `refs/remotes/${REMOTE}/${branch}`]);
	if (stillThere) return { ...out, reason: "readback_mismatch", error: `the remote still reports "${branch}" at ${stillThere} after the delete` };
	return { ...out, ok: true, receipt: { at, slug, from: tip, to: null, recover: `git push ${REMOTE} ${tip}:refs/heads/${branch}` } };
}
