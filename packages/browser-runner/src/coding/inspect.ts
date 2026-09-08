import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

/**
 * Is `dir` inside a git WORK TREE — not merely "does it contain `.git`" (#785)?
 *
 * Three functions in this file gated on `existsSync(resolve(workDir, ".git"))`, while
 * `checkWorkdir` (repo.ts, #405) deliberately asks `git rev-parse --is-inside-work-tree` because
 * `~/dev/monorepo/apps/thing` is a perfectly good workdir with no `.git` of its own. So the
 * staleness check called a subdirectory workdir healthy and `repo_git` in the same folder answered
 * "not a git repo". One question, one answer: this is the gate every git-running function uses.
 *
 * A missing directory, a missing git binary and a plain folder all read as `false` — every one
 * of them makes the git command that follows fail, and "not a git repo" is the message
 * `saysNotAGitRepo` (workers/api/src/lib/repo-state.ts) already matches on the cloud side.
 */
export function insideWorkTree(dir: string): boolean {
	try {
		const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: dir,
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.trim() === "true";
	} catch {
		return false;
	}
}

/** The one gate. The message is load-bearing: the cloud matches "not a git repo" (#548). */
function requireWorkTree(workDir: string): void {
	if (!insideWorkTree(workDir)) throw new InspectError("not a git repo");
}

/**
 * Environment for any git command that may touch the NETWORK (#785).
 *
 * A fetch that hits an expired credential must fail, not hang the runner's request loop on a
 * password prompt nobody can see: `GIT_TERMINAL_PROMPT=0` for https, `BatchMode=yes` for ssh.
 * The user's own `GIT_SSH_COMMAND` wins when set — it may carry a key or a proxy we must keep.
 */
function networkGitEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
	};
}

/**
 * Read-only code inspection for the coding runtime — the "eyes" the Co-pilot/Chat use
 * to GROUND their answers in the real repo (read a file, `git diff`, list the tree)
 * WITHOUT driving the live CLI. All access is confined to the session's workDir.
 *
 * Two pure, separately-tested primitives carry the safety:
 *   - resolveInside(): rejects any path escaping the repo root (../, absolute, sibling
 *     prefix, symlink escape).
 *   - gitArgv(): maps a fixed command enum to a fixed argv — no user string ever
 *     becomes a git token except a resolveInside-validated path after a literal `--`.
 */

/** Resolve `rel` under `root`, refusing anything that escapes it. Pure (no fs) EXCEPT the
 *  optional symlink check, which is what defends against a symlink inside the repo pointing
 *  at e.g. ~/.ssh. Throws on any escape. */
export function resolveInside(root: string, rel: string, opts: { checkSymlink?: boolean } = {}): string {
	const rootAbs = resolve(root);
	const abs = resolve(rootAbs, rel);
	// `resolve` collapses `..`, so a traversal or absolute escape lands outside rootAbs.
	// The explicit `+ sep` blocks a sibling-prefix attack (/repo vs /repo-secrets).
	if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
		throw new InspectError(`path escapes the repo: ${rel}`);
	}
	if (opts.checkSymlink && existsSync(abs)) {
		// A symlink inside the repo could still point outside it — resolve the real path and
		// re-check the same invariant.
		const real = realpathSync(abs);
		const realRoot = realpathSync(rootAbs);
		if (real !== realRoot && !real.startsWith(realRoot + sep)) {
			throw new InspectError(`path resolves (via symlink) outside the repo: ${rel}`);
		}
	}
	return abs;
}

export type GitCmd = "status" | "diff" | "diff-stat" | "log" | "ls-files" | "show";

/**
 * A revision a caller may name (#785). One shape, checked once, used by every command that takes
 * a `ref`.
 *
 * The rule that matters is the FIRST character: git reads a leading `-` as a flag, so a ref may not
 * start with one, and then no character class below can become an option. Everything else git
 * accepts as a revision is allowed — a sha, `HEAD~3`, `origin/main`, `v1.2`, `main..feature`,
 * `@{u}` — because all of those are READS and the argv around them is fixed.
 */
const REF_PATTERN = /^[A-Za-z0-9_@][A-Za-z0-9._/^~@{}-]{0,127}$/;

export function validateRef(ref: string): string {
	const r = ref.trim();
	if (!r) throw new InspectError("`ref` is empty");
	if (!REF_PATTERN.test(r)) throw new InspectError(`\`ref\` is not a valid git revision: ${ref.slice(0, 64)}`);
	return r;
}

/** Map a whitelisted command enum to a fixed git argv. `path` (already validated by the
 *  caller via resolveInside) is only ever appended after a literal `--` separator, and `ref`
 *  (already validated by `validateRef`) only ever lands where git expects a revision. */
export function gitArgv(cmd: GitCmd, opts: { relPath?: string; n?: number; ref?: string } = {}): string[] {
	const clampN = Math.max(1, Math.min(200, Math.floor(opts.n ?? 20)));
	const path = opts.relPath ? ["--", opts.relPath] : [];
	// `ref` is a REVISION and belongs before `--`; `path` is a PATHSPEC and belongs after it. That
	// ordering is what keeps the two from being confused for each other by git, whatever they hold.
	const rev = opts.ref ? [opts.ref] : [];
	switch (cmd) {
		case "status":
			// `--branch` adds ONE header line (`## main...origin/main [ahead 1]`). Without it a
			// caller can learn a tree is dirty but never which branch it is dirty on, which is how
			// a delegated run pushed a PR branch and left the checkout parked there unnoticed
			// (#276). Additive: every existing consumer keeps the same file lines it always got.
			//
			// `path` reaches this one too (#508). Narrowing every command rather than four of the
			// five is what lets the tool description say "it applies" with no caveat — and a
			// caveat is what a model has to reason about and can get wrong.
			return ["status", "--short", "--branch", ...path];
		// `path` used to reach exactly ONE of these five (#508). It is advertised on the tool as
		// "Limit the command to one file or folder", `runRepoGit` resolves and validates it, and
		// then four of the five branches dropped it on the floor — so
		// `repo_git {cmd:"ls-files", path:"admin/lib/features/events"}` answered with every tracked
		// file in the repository, truncated mid-list at 12KB. `git ls-files -- <path>` is the
		// file-finder a Repo Coder has been missing, and the parameter to reach it was already in
		// the schema and already validated; it was dropped one function later.
		//
		// Every one of these is git's own `--` pathspec discipline, unchanged: the validated path
		// is appended after a literal separator and can never be read as a flag or a revision.
		case "diff":
			return ["diff", ...rev, ...path];
		case "diff-stat":
			return ["diff", "--stat", ...rev, ...path];
		// `ref` on `log` is what #785 reached for as `git log -1 <sha>` and found silently ignored:
		// the input never existed, so the tool answered the canned 20-line list and nothing said
		// the argument had gone nowhere. Now `{cmd:"log", ref, n:1}` is that command.
		case "log":
			return ["log", "--oneline", "-n", String(clampN), ...rev, ...path];
		case "ls-files":
			return ["ls-files", ...path];
		// `show` is `--stat <sha>`, the other thing #785 tried: what ONE commit changed. `--stat`
		// rather than the patch, because the patch of an arbitrary commit is unbounded and the
		// file list is what a reader deciding whether to `diff` one file actually needs. A `show`
		// with no ref would show HEAD, which is a guess dressed as an answer — required instead.
		case "show":
			if (!rev.length) throw new InspectError("`show` needs a `ref` — the commit to describe");
			return ["show", "--stat", "--format=medium", ...rev, ...path];
		default:
			throw new InspectError(`unsupported git command: ${cmd as string}`);
	}
}

export class InspectError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "InspectError";
	}
}

const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const HARD_MAX_FILE_BYTES = 128 * 1024;

/** Read a text file inside the repo. Rejects traversal, oversize, and binary files. */
export function readRepoFile(workDir: string, relPath: string, maxBytes?: number): { path: string; size: number; truncated: boolean; content?: string; binary?: boolean } {
	const abs = resolveInside(workDir, relPath, { checkSymlink: true });
	const st = statSync(abs);
	if (!st.isFile()) throw new InspectError(`not a regular file: ${relPath}`);
	const cap = Math.min(maxBytes ?? DEFAULT_MAX_FILE_BYTES, HARD_MAX_FILE_BYTES);
	const buf = readFileSync(abs);
	// Binary sniff: a NUL byte in the first 8KB → don't feed bytes to the model.
	const head = buf.subarray(0, 8192);
	if (head.includes(0)) return { path: relPath, size: st.size, truncated: false, binary: true };
	const truncated = buf.length > cap;
	return { path: relPath, size: st.size, truncated, content: buf.subarray(0, cap).toString("utf-8") };
}

/** Run a whitelisted read-only git command in the repo. Never uses a shell. */
export function runRepoGit(
	workDir: string,
	cmd: GitCmd,
	opts: { path?: string; n?: number; ref?: string; maxBytes?: number } = {},
): { cmd: string; output: string; truncated: boolean; pathApplied: boolean; refApplied: boolean } {
	requireWorkTree(workDir);
	const relPath = opts.path ? relative(workDir, resolveInside(workDir, opts.path)) : undefined;
	const ref = opts.ref ? validateRef(opts.ref) : undefined;
	const argv = gitArgv(cmd, { relPath, n: opts.n, ref });
	// Did the path the caller asked for actually reach git? Reported rather than assumed, because
	// a runner is a SEPARATE release from the cloud that calls it: before #508 four of the five
	// commands ignored `path` silently, and the answer — the whole repository — was indistinguishable
	// from a correct one. An older runner omits this field entirely, which is what lets the cloud
	// say "your machine ignored the filter" instead of relaying a wrong answer as a right one.
	const pathApplied = relPath !== undefined && argv.includes(relPath);
	// Same idiom for `ref` (#785): a runner older than this drops it, and the cloud tells the caller
	// so — the alternative is the exact silence the issue reported, a `log -1 <sha>` answered by
	// the newest twenty commits with nothing to say the sha went nowhere.
	const refApplied = ref !== undefined && argv.includes(ref);
	let out = "";
	try {
		out = execFileSync("git", argv, { cwd: workDir, encoding: "utf-8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
	} catch (e) {
		// git exits non-zero for benign cases (e.g. `diff` on nothing) — surface stdout if present.
		const err = e as { stdout?: string; message?: string };
		out = err.stdout ?? "";
		if (!out) throw new InspectError(err.message || `git ${cmd} failed`);
	}
	const cap = opts.maxBytes ?? 64 * 1024;
	const truncated = out.length > cap;
	return { cmd, output: truncated ? out.slice(0, cap) : out, truncated, pathApplied, refApplied };
}

/** Read the repo's `origin` remote URL — used to auto-associate a local checkout with its
 *  GitHub repo (so build status can query Actions). Fixed argv, no shell, no user input;
 *  returns null when it's not a git repo or has no `origin` remote. */
export function readGitRemoteOrigin(workDir: string): string | null {
	if (!insideWorkTree(workDir)) return null;
	try {
		const out = execFileSync("git", ["config", "--get", "remote.origin.url"], {
			cwd: workDir,
			encoding: "utf-8",
			timeout: 10_000,
		});
		return out.trim() || null;
	} catch {
		return null;
	}
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage", ".wrangler"]);

/**
 * Search the repo — the capability a Repo Coder never had (#508).
 *
 * Before this there was no grep, no filename match, no content match anywhere in the connector or
 * the runner, so locating a file meant walking the tree by hand and guessing when it ran out.
 *
 * ── The bounds, and why each one is here rather than "cap the bytes at the end"
 *
 * A byte cap alone just moves the problem into the tool-result cap (#503): the model receives an
 * arbitrary prefix of a list and no statement that a list was cut. Every bound below is COUNTED,
 * so the result can say `50 of 812` and the model knows to narrow rather than conclude.
 *
 *   MAX_RESULTS   the whole answer, not per file — one number the caller can reason about.
 *   PER_FILE      git's own `--max-count`, so a minified bundle cannot spend the whole budget.
 *   MAX_LINE      a matching line from a generated file can be tens of KB on its own.
 *   maxBuffer     git's stdout is read into memory before any of the above can apply.
 *
 * Worst case is ~50 × (path + 160) ≈ 11KB, comfortably inside the 12KB the connector allows and
 * the 24,000 chars a tool result may carry.
 *
 * ── Fixed strings, not regexes
 *
 * `-F`. The job is "where does this identifier / filename appear", which is what a model supplies
 * naturally, and a bare `foo(` — the obvious thing to search for in code — is an invalid regex.
 * It also means no pattern the model invents can become a pathological match on the owner's own
 * machine. Deliberate deviation from the argv sketched in #508, which used `-e` alone.
 *
 * ── The safety property is unchanged
 *
 * `path` is still resolveInside-validated and still appended after a literal `--`. The PATTERN is
 * never a git token in `path` mode (the filter runs here, in JS) and in `content` mode it is the
 * fixed operand of `-e`, which git cannot read as a flag whatever it contains.
 */
export const SEARCH_MAX_RESULTS = 50;
const SEARCH_PER_FILE = 5;
const SEARCH_MAX_LINE = 160;
const SEARCH_MAX_PATTERN = 200;

export type RepoSearchMode = "content" | "path";
export interface RepoSearchResult {
	mode: RepoSearchMode;
	pattern: string;
	matches: Array<{ path: string; line?: number; text?: string }>;
	shown: number;
	total: number;
	truncated: boolean;
}

export function repoSearch(workDir: string, opts: { pattern: string; path?: string; mode?: RepoSearchMode; maxResults?: number }): RepoSearchResult {
	requireWorkTree(workDir);
	const pattern = (opts.pattern ?? "").trim();
	if (!pattern) throw new InspectError("a search `pattern` is required");
	if (pattern.length > SEARCH_MAX_PATTERN) throw new InspectError(`search pattern is too long (max ${SEARCH_MAX_PATTERN} characters)`);
	const mode: RepoSearchMode = opts.mode === "path" ? "path" : "content";
	const limit = Math.max(1, Math.min(SEARCH_MAX_RESULTS, Math.floor(opts.maxResults ?? SEARCH_MAX_RESULTS)));
	const relPath = opts.path ? relative(workDir, resolveInside(workDir, opts.path)) : undefined;

	const argv =
		mode === "content"
			? ["grep", "-n", "-I", "-i", "-F", "--untracked", "--max-count", String(SEARCH_PER_FILE), "-e", pattern]
			: // Tracked PLUS untracked-not-ignored: a file created ten minutes ago is exactly the one
				// somebody is trying to find, and `ls-files` alone would deny it exists.
				["ls-files", "--cached", "--others", "--exclude-standard"];
	// `.` rather than nothing: `git grep` run from a subdirectory would otherwise search the whole
	// tree, and the caller asked for a folder.
	if (relPath && relPath !== "") argv.push("--", relPath);

	let out: string;
	try {
		out = execFileSync("git", argv, { cwd: workDir, encoding: "utf-8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
	} catch (e) {
		const err = e as { stdout?: string; code?: string; status?: number; message?: string };
		// `git grep` exits 1 for "no matches", which is an ANSWER, not a failure.
		if (err.status === 1) out = err.stdout ?? "";
		else if (err.code === "ENOBUFS") throw new InspectError(`too many matches for "${pattern}" to read safely — search a narrower path, or a longer/more specific pattern`);
		else if (err.stdout) out = err.stdout;
		else throw new InspectError(err.message || `git ${mode} search failed`);
	}

	const lines = out.split("\n").filter((l) => l !== "");
	const all =
		mode === "content"
			? lines.map(parseGrepLine).filter((m): m is { path: string; line: number; text: string } => m !== null)
			: // The pattern never reaches git here — the filter is a plain case-insensitive substring
				// over the path, which is what "find the file called X" actually means.
				lines.filter((p) => p.toLowerCase().includes(pattern.toLowerCase())).map((p) => ({ path: p }));
	return { mode, pattern, matches: all.slice(0, limit), shown: Math.min(all.length, limit), total: all.length, truncated: all.length > limit };
}

/** `path:line:text` — split on the FIRST two colons only, since code is full of them. */
function parseGrepLine(line: string): { path: string; line: number; text: string } | null {
	const first = line.indexOf(":");
	if (first <= 0) return null;
	const second = line.indexOf(":", first + 1);
	if (second < 0) return null;
	const n = Number.parseInt(line.slice(first + 1, second), 10);
	if (!Number.isFinite(n)) return null;
	return { path: line.slice(0, first), line: n, text: line.slice(second + 1).trim().slice(0, SEARCH_MAX_LINE) };
}

/** The deepest `maxDepth` this will honour. Named because the TOOL has to say it (#508). */
export const TREE_MAX_DEPTH = 4;

/**
 * Bounded recursive file tree (names/type/size only — no contents).
 *
 * Two caps stop it, and until #508 only ONE of them was reported. `truncated` was set by the
 * ENTRY cap alone; a directory sitting at the depth boundary was emitted as an entry and its
 * children simply not queued, so it rendered exactly like a directory with nothing in it.
 *
 * From the model's side "this folder is empty" and "this folder is deeper than I am allowed to
 * look" were the same observation, and it cannot navigate on that: asked about a file seven
 * segments down, it saw a leaf, decided the leaf WAS the file, and called `repo_read_file` on a
 * directory — twice in the turn that produced this ticket. `deeper` is the per-entry fact that
 * removes the ambiguity, and it is deliberately "contents not listed" rather than "has more
 * inside": checking the latter costs a readdir per boundary directory, and the model's next move
 * (call again with `path`) is the same either way.
 */
export function repoTree(
	workDir: string,
	relPath = ".",
	maxDepth = 3,
	maxEntries = 500,
): { root: string; entries: Array<{ path: string; type: string; size?: number; deeper?: boolean }>; truncated: boolean; truncatedByDepth: boolean; depthCap: number } {
	const start = resolveInside(workDir, relPath, { checkSymlink: true });
	const depthCap = Math.max(1, Math.min(TREE_MAX_DEPTH, maxDepth));
	const entryCap = Math.max(1, Math.min(1000, maxEntries));
	const entries: Array<{ path: string; type: string; size?: number; deeper?: boolean }> = [];
	const queue: Array<{ dir: string; depth: number }> = [{ dir: start, depth: 0 }];
	let truncated = false;
	let truncatedByDepth = false;
	while (queue.length) {
		const { dir, depth } = queue.shift()!;
		let items: import("node:fs").Dirent[];
		try {
			items = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const it of items) {
			if (it.name.startsWith(".") || IGNORE_DIRS.has(it.name)) continue;
			if (entries.length >= entryCap) {
				truncated = true;
				return { root: relPath, entries, truncated, truncatedByDepth, depthCap };
			}
			const abs = resolve(dir, it.name);
			const rel = relative(workDir, abs);
			if (it.isDirectory()) {
				const walk = depth + 1 < depthCap;
				entries.push(walk ? { path: rel, type: "dir" } : { path: rel, type: "dir", deeper: true });
				if (walk) queue.push({ dir: abs, depth: depth + 1 });
				else truncatedByDepth = true;
			} else if (it.isFile()) {
				let size: number | undefined;
				try {
					size = statSync(abs).size;
				} catch {
					// Benign, and traced rather than assumed (#291). `size` stays `undefined`, which JSON
					// drops, so the entry reaches the model as `{path, type: "file"}` — the same listing a
					// successful stat produces, because `repo-local.ts`'s renderer prints `e.path` and has
					// never shown a size at all. The test is whether the fallback can be mistaken for a
					// real answer: `size: 0` would be a claim about an empty file; an absent field is not
					// a claim. The entry itself is still emitted because `readdir` saw it, and the one
					// case where that is already stale — deleted between the readdir and this stat —
					// degrades into an honest error from `repo_read_file`, not into a wrong listing.
				}
				entries.push({ path: rel, type: "file", size });
			}
		}
	}
	return { root: relPath, entries, truncated, truncatedByDepth, depthCap };
}

/**
 * Where this checkout stands against its upstream (#785).
 *
 * The incident: a coder run pushed 6da7c9a1 to `main`; a later orchestrator session read the
 * SAME folder through `repo_read_file`/`repo_find`/`repo_git`, found none of the shipped files —
 * they were genuinely not on disk — and filed a bug against a feature that existed. Nothing had
 * fetched since the push, and nothing said so. This is the question the read tools now ask
 * before they answer, and the one a Pilot run asks at its start and its end.
 *
 * ── What it does, and what it deliberately does not
 *
 * A `git fetch` updates REMOTE-TRACKING refs (`refs/remotes/origin/*`) and nothing else: not the
 * working tree, not the index, not the branch the Engine is committing on. That is why it is safe
 * to run under a session mid-edit, and why this never pulls — a pull is a merge into the branch,
 * which can conflict with work in flight and is a decision for the caller, stated in the issue.
 *
 * ── The fetch is CACHED, the counts are not
 *
 * One fetch per checkout per minute. A single turn on a large repo can make eighteen read calls
 * (#508's measurement); eighteen fetches would turn a 50ms relay answer into a network round trip
 * each. The COUNTS are always recomputed, so a commit the Engine makes locally shows as `ahead`
 * on the very next call, and a fetch that just happened is not re-run to learn it.
 *
 * `checked: true` is the version marker, same idiom as `WorkdirCheck` (#405): an older runner
 * 404s `/coding/sync`, and the cloud reads the absent field as "unverified", never as "in sync".
 */
export interface RepoSyncCheck {
	checked: true;
	/** The work-tree root the counts are about — one cache entry per root, `~` expanded. */
	path: string;
	/** The checked-out branch, or null when HEAD is detached. */
	branch: string | null;
	/** The remote-tracking ref compared against, e.g. `origin/main`; null when there is none. */
	upstream: string | null;
	localHead: string | null;
	remoteHead: string | null;
	/** Commits on the branch that are not on upstream. Null when there is no upstream. */
	ahead: number | null;
	/** Commits on upstream that are not on the branch — the number that says "stale". */
	behind: number | null;
	/** A fetch of the upstream's remote ran within {@link SYNC_FETCH_TTL_MS} and succeeded. */
	fetched: boolean;
	/** When that fetch ran (epoch ms), so a reader knows how old "behind N" is. Null if never. */
	fetchedAt: number | null;
	/** Why the most recent fetch attempt failed, when it did — the counts then describe the LAST successful fetch. */
	fetchError: string | null;
}

export const SYNC_FETCH_TTL_MS = 60_000;

/** Per work-tree root: when the last fetch attempt was made and how it went. */
const fetchLog = new Map<string, { at: number; error: string | null; okAt: number | null }>();

/** Test seam: forget every cached fetch. */
export function resetSyncCache(): void {
	fetchLog.clear();
}

export function repoSync(workDir: string, opts: { branch?: string; forceFetch?: boolean; now?: () => number } = {}): RepoSyncCheck {
	requireWorkTree(workDir);
	const now = opts.now ?? Date.now;
	const git = (args: string[], timeout = 10_000): string =>
		execFileSync("git", args, { cwd: workDir, encoding: "utf-8", timeout, stdio: ["ignore", "pipe", "pipe"], env: networkGitEnv() }).trim();
	const tryGit = (args: string[], timeout?: number): string | null => {
		try {
			return git(args, timeout);
		} catch {
			return null;
		}
	};
	const root = tryGit(["rev-parse", "--show-toplevel"]) ?? resolve(workDir);
	const abbrev = tryGit(["rev-parse", "--abbrev-ref", "HEAD"]);
	const branch = abbrev && abbrev !== "HEAD" ? abbrev : null;
	// The upstream git itself records for the branch, else the same-named branch on `origin` if
	// that ref exists, else the configured branch on `origin`. Named rather than assumed: a
	// `main` checkout whose upstream is `upstream/main` must be compared against THAT.
	let upstream = tryGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	if (!upstream) {
		for (const candidate of [branch, opts.branch].filter((b): b is string => Boolean(b))) {
			if (tryGit(["rev-parse", "--verify", "--quiet", `origin/${candidate}`]) !== null) {
				upstream = `origin/${candidate}`;
				break;
			}
		}
	}
	const remote = upstream?.includes("/") ? upstream.slice(0, upstream.indexOf("/")) : "origin";

	const entry = fetchLog.get(root);
	const t = now();
	if (opts.forceFetch || !entry || t - entry.at > SYNC_FETCH_TTL_MS) {
		try {
			// `--quiet` so a successful fetch prints nothing to stderr worth parsing; 20s because a
			// fetch is a network call and the relay's read timeout is above that.
			git(["fetch", "--quiet", remote], 20_000);
			fetchLog.set(root, { at: t, error: null, okAt: t });
		} catch (e) {
			const err = e as { stderr?: string; message?: string };
			// git's stderr is several lines and the diagnosis is the FIRST `fatal:`/`error:` one —
			// the tail is boilerplate ("and the repository exists.") that names nothing.
			const lines = String(err.stderr || err.message || "")
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
			const detail = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? "fetch failed";
			fetchLog.set(root, { at: t, error: detail.replace(/^(fatal|error):\s*/i, "").slice(0, 200), okAt: entry?.okAt ?? null });
		}
	}
	const fetchState = fetchLog.get(root) ?? { at: t, error: null, okAt: null };
	// Upstream may only exist AFTER the first fetch of a fresh clone — look once more.
	if (!upstream) {
		for (const candidate of [branch, opts.branch].filter((b): b is string => Boolean(b))) {
			if (tryGit(["rev-parse", "--verify", "--quiet", `origin/${candidate}`]) !== null) {
				upstream = `origin/${candidate}`;
				break;
			}
		}
	}

	const localHead = tryGit(["rev-parse", "HEAD"]);
	const remoteHead = upstream ? tryGit(["rev-parse", upstream]) : null;
	let ahead: number | null = null;
	let behind: number | null = null;
	if (upstream && remoteHead) {
		const counts = tryGit(["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
		const m = counts?.match(/^(\d+)\s+(\d+)$/);
		if (m) {
			ahead = Number.parseInt(m[1], 10);
			behind = Number.parseInt(m[2], 10);
		}
	}
	return {
		checked: true,
		path: root,
		branch,
		upstream,
		localHead,
		remoteHead,
		ahead,
		behind,
		fetched: fetchState.okAt !== null && t - fetchState.okAt <= SYNC_FETCH_TTL_MS,
		fetchedAt: fetchState.okAt,
		fetchError: fetchState.error,
	};
}
