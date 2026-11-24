import { gitMessage, git, gitTry, requireCheckout, validSha } from "./branches.js";

/**
 * Stash inventory, inspection and exact removal on the machine that holds the checkout (#1701).
 *
 * A stash entry is addressed by its COMMIT SHA, never by `stash@{n}`: the index shifts whenever any
 * stash is pushed or dropped (a run, another tool, a person), so an index read at preview time can
 * name a different entry at execution time. The SHA is immutable; the index is looked up fresh, inside
 * the same call that uses it, and what git reports it dropped is checked against the SHA asked for.
 * If git dropped something else, that entry is put straight back with `git stash store`.
 *
 * Nothing here applies, pops or clears a stash. `listStashes` and `inspectStash` are reads;
 * `dropStash` removes one entry from the stash list and nothing else — the commit stays recoverable
 * (the receipt carries the `git stash store` line), and any `refs/pags/*` pin pointing at it is left
 * alone and reported.
 *
 * Attribution is only claimed where the entry's own message says it: `pags-park <run>` (a parked run,
 * park-snapshot.ts) and `pags-stash <stamp> <label>` (a checkout stash, checkout-clean.ts). Anything
 * else is `unknown` — never guessed from a branch name or a date.
 */

export const STASH_LIST_MAX = 100;
export const STASH_FILES_MAX = 200;

export type StashAttribution = { kind: "run"; runId: string } | { kind: "checkout-stash"; label: string; stamp: string } | { kind: "unknown" };

export interface StashEntry {
	sha: string;
	/** Where it sits NOW. Informational only: it shifts, and nothing here acts on it. */
	index: number;
	date: string;
	message: string;
	/** The commit the stash was made on top of. */
	base: string | null;
	/** The branch it was made on, from git's own message; null when the message does not say. */
	branch: string | null;
	attribution: StashAttribution;
	/** `refs/pags/*` refs that point at this exact commit. */
	pins: string[];
	/** Tracked changes plus untracked files it holds. */
	filesTotal: number;
}

export interface StashList {
	stashes: StashEntry[];
	total: number;
	truncated: boolean;
	readAt: string;
}

export interface StashFile {
	status: string;
	path: string;
	untracked: boolean;
	/** The default branch already holds this exact content for the path: nothing unique here. */
	onDefault: boolean;
}

export interface StashInspection extends StashEntry {
	defaultBranch: string | null;
	/** Commits on the default branch since this stash's base — how far the stash has drifted. */
	defaultAheadOfBase: number | null;
	files: StashFile[];
	/** Cut at STASH_FILES_MAX; `filesTotal` (from the entry) is how many paths the stash really holds. */
	/** Files with content the default branch does not have. */
	uniqueFiles: number;
	shortstat: string;
}

function attribute(message: string): StashAttribution {
	const body = message.replace(/^(?:WIP on|On) [^:]+: /, "");
	const park = /^pags-park (\S+)$/.exec(body);
	if (park) return { kind: "run", runId: park[1] };
	const stash = /^pags-stash (\d{8}T\d{6}) (.+)$/.exec(body);
	if (stash) return { kind: "checkout-stash", stamp: stash[1], label: stash[2] };
	return { kind: "unknown" };
}

const lines = (s: string | null): string[] => (s ?? "").split("\n").filter(Boolean);

function defaultRef(workDir: string): { name: string; ref: string } | null {
	const sym = gitTry(workDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	const candidates = [sym?.startsWith("origin/") ? sym.slice(7) : null, "main", "master"].filter((n): n is string => !!n);
	for (const name of candidates) {
		for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) if (gitTry(workDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) return { name, ref };
	}
	return null;
}

interface Raw {
	sha: string;
	index: number;
	date: string;
	base: string | null;
	message: string;
}

function readRaw(workDir: string): Raw[] {
	return lines(gitTry(workDir, ["stash", "list", "--format=%H%x09%cI%x09%P%x09%gs"])).map((l, index) => {
		const [sha, date, parents, ...msg] = l.split("\t");
		return { sha, index, date, base: parents.split(" ")[0] || null, message: msg.join("\t") };
	});
}

const trackedFiles = (workDir: string, r: Raw): { status: string; path: string }[] =>
	r.base ? lines(gitTry(workDir, ["diff", "--name-status", "-M", r.base, r.sha])).map((l) => { const [status, ...p] = l.split("\t"); return { status, path: p.join(" -> ") }; }) : [];

const untrackedFiles = (workDir: string, r: Raw): string[] => lines(gitTry(workDir, ["ls-tree", "-r", "--name-only", `${r.sha}^3`]));

function entry(workDir: string, r: Raw): StashEntry {
	const branch = /^(?:WIP on|On) ([^:]+):/.exec(r.message)?.[1] ?? null;
	return {
		sha: r.sha,
		index: r.index,
		date: r.date,
		message: r.message,
		base: r.base,
		branch,
		attribution: attribute(r.message),
		pins: lines(gitTry(workDir, ["for-each-ref", "--points-at", r.sha, "--format=%(refname)", "refs/pags/"])),
		filesTotal: trackedFiles(workDir, r).length + untrackedFiles(workDir, r).length,
	};
}

export function listStashes(workDir: string, deps: { now?: () => Date } = {}): StashList {
	requireCheckout(workDir);
	const raw = readRaw(workDir);
	return { stashes: raw.slice(0, STASH_LIST_MAX).map((r) => entry(workDir, r)), total: raw.length, truncated: raw.length > STASH_LIST_MAX, readAt: (deps.now?.() ?? new Date()).toISOString() };
}

export function inspectStash(workDir: string, shaIn: string): StashInspection | null {
	requireCheckout(workDir);
	const sha = validSha(shaIn, "sha");
	const r = readRaw(workDir).find((x) => x.sha === sha);
	if (!r) return null;
	const def = defaultRef(workDir);
	const blob = (rev: string, path: string): string | null => gitTry(workDir, ["rev-parse", "--verify", "--quiet", `${rev}:${path}`]);
	const files: StashFile[] = [
		...trackedFiles(workDir, r).map((f) => ({ ...f, untracked: false, onDefault: def ? (f.status.startsWith("D") ? blob(def.ref, f.path) === null : blob(def.ref, f.path) !== null && blob(def.ref, f.path) === blob(r.sha, f.path)) : false })),
		...untrackedFiles(workDir, r).map((path) => ({ status: "A", path, untracked: true, onDefault: def ? blob(def.ref, path) !== null && blob(def.ref, path) === blob(`${r.sha}^3`, path) : false })),
	];
	return {
		...entry(workDir, r),
		defaultBranch: def?.name ?? null,
		defaultAheadOfBase: def && r.base ? Number(gitTry(workDir, ["rev-list", "--count", `${r.base}..${def.ref}`]) ?? NaN) || 0 : null,
		files: files.slice(0, STASH_FILES_MAX),
		uniqueFiles: files.filter((f) => !f.onDefault).length,
		shortstat: (r.base ? (gitTry(workDir, ["diff", "--shortstat", r.base, r.sha]) ?? "") : "").trim(),
	};
}

export type StashDropRefusal = "not_found" | "index_shifted" | "readback_mismatch" | "failed";

export interface StashDropResult {
	ok: boolean;
	dryRun: boolean;
	sha: string;
	reason?: StashDropRefusal;
	error?: string;
	/** The entry as it was read — what the caller is asked to approve losing. */
	stash?: StashInspection;
	/** The SHA was no longer in the list: it was already gone, nothing was dropped by this call. */
	alreadyGone?: boolean;
	stashesBefore?: number;
	stashesAfter?: number;
	receipt?: { at: string; sha: string; message: string; pinsKept: string[]; recover: string };
}

export function dropStash(workDir: string, input: { sha: string; dryRun: boolean }, deps: { now?: () => Date } = {}): StashDropResult {
	requireCheckout(workDir);
	const sha = validSha(input.sha, "sha");
	const out: StashDropResult = { ok: false, dryRun: input.dryRun, sha };
	const before = readRaw(workDir);
	out.stashesBefore = before.length;
	const target = before.find((x) => x.sha === sha);
	if (!target) return { ...out, ok: true, alreadyGone: true, stashesAfter: before.length };
	const stash = inspectStash(workDir, sha);
	if (stash) out.stash = stash;
	if (input.dryRun) return { ...out, ok: true };
	let printed: string;
	try {
		// The index was found a moment ago, in this call. If another process shifted the list in between, git
		// reports the SHA of what it actually dropped, and that is checked below.
		printed = git(workDir, ["stash", "drop", `stash@{${target.index}}`]);
	} catch (e) {
		return { ...out, reason: "failed", error: `the drop did not run: ${gitMessage(e)}` };
	}
	const dropped = /\(([0-9a-f]{40})\)/.exec(printed)?.[1];
	if (dropped !== sha) {
		if (dropped) {
			// Put back what was dropped by mistake, under its own message.
			const wrong = before.find((x) => x.sha === dropped);
			gitTry(workDir, ["stash", "store", "-m", wrong?.message ?? "restored by pags", dropped]);
		}
		return { ...out, reason: "index_shifted", error: `the stash list changed while the drop ran; git dropped ${dropped ?? "an unreadable entry"} instead of ${sha}${dropped ? ", which was put back" : ""}. Nothing was lost — preview again.` };
	}
	const after = readRaw(workDir);
	out.stashesAfter = after.length;
	if (after.some((x) => x.sha === sha)) return { ...out, reason: "readback_mismatch", error: "the entry is still in the stash list after the drop" };
	return {
		...out,
		ok: true,
		receipt: { at: (deps.now?.() ?? new Date()).toISOString(), sha, message: target.message, pinsKept: stash?.pins ?? [], recover: `git stash store -m ${JSON.stringify(target.message)} ${sha}` },
	};
}
