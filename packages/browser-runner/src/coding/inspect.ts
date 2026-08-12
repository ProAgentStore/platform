import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

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

export type GitCmd = "status" | "diff" | "diff-stat" | "log" | "ls-files";

/** Map a whitelisted command enum to a fixed git argv. `path` (already validated by the
 *  caller via resolveInside) is only ever appended after a literal `--` separator. */
export function gitArgv(cmd: GitCmd, opts: { relPath?: string; n?: number } = {}): string[] {
	const clampN = Math.max(1, Math.min(200, Math.floor(opts.n ?? 20)));
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
			return opts.relPath ? ["status", "--short", "--branch", "--", opts.relPath] : ["status", "--short", "--branch"];
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
			return opts.relPath ? ["diff", "--", opts.relPath] : ["diff"];
		case "diff-stat":
			return opts.relPath ? ["diff", "--stat", "--", opts.relPath] : ["diff", "--stat"];
		case "log":
			return opts.relPath ? ["log", "--oneline", "-n", String(clampN), "--", opts.relPath] : ["log", "--oneline", "-n", String(clampN)];
		case "ls-files":
			return opts.relPath ? ["ls-files", "--", opts.relPath] : ["ls-files"];
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
export function runRepoGit(workDir: string, cmd: GitCmd, opts: { path?: string; n?: number; maxBytes?: number } = {}): { cmd: string; output: string; truncated: boolean; pathApplied: boolean } {
	if (!existsSync(resolve(workDir, ".git"))) throw new InspectError("not a git repo");
	const relPath = opts.path ? relative(workDir, resolveInside(workDir, opts.path)) : undefined;
	const argv = gitArgv(cmd, { relPath, n: opts.n });
	// Did the path the caller asked for actually reach git? Reported rather than assumed, because
	// a runner is a SEPARATE release from the cloud that calls it: before #508 four of the five
	// commands ignored `path` silently, and the answer — the whole repository — was indistinguishable
	// from a correct one. An older runner omits this field entirely, which is what lets the cloud
	// say "your machine ignored the filter" instead of relaying a wrong answer as a right one.
	const pathApplied = relPath !== undefined && argv.includes(relPath);
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
	return { cmd, output: truncated ? out.slice(0, cap) : out, truncated, pathApplied };
}

/** Read the repo's `origin` remote URL — used to auto-associate a local checkout with its
 *  GitHub repo (so build status can query Actions). Fixed argv, no shell, no user input;
 *  returns null when it's not a git repo or has no `origin` remote. */
export function readGitRemoteOrigin(workDir: string): string | null {
	if (!existsSync(resolve(workDir, ".git"))) return null;
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
	if (!existsSync(resolve(workDir, ".git"))) throw new InspectError("not a git repo");
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
