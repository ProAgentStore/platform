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
			return ["status", "--short"];
		case "diff":
			return opts.relPath ? ["diff", "--", opts.relPath] : ["diff"];
		case "diff-stat":
			return ["diff", "--stat"];
		case "log":
			return ["log", "--oneline", "-n", String(clampN)];
		case "ls-files":
			return ["ls-files"];
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
export function runRepoGit(workDir: string, cmd: GitCmd, opts: { path?: string; n?: number; maxBytes?: number } = {}): { cmd: string; output: string; truncated: boolean } {
	if (!existsSync(resolve(workDir, ".git"))) throw new InspectError("not a git repo");
	const relPath = opts.path ? relative(workDir, resolveInside(workDir, opts.path)) : undefined;
	const argv = gitArgv(cmd, { relPath, n: opts.n });
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
	return { cmd, output: truncated ? out.slice(0, cap) : out, truncated };
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage", ".wrangler"]);

/** Bounded recursive file tree (names/type/size only — no contents). */
export function repoTree(workDir: string, relPath = ".", maxDepth = 3, maxEntries = 500): { root: string; entries: Array<{ path: string; type: string; size?: number }>; truncated: boolean } {
	const start = resolveInside(workDir, relPath, { checkSymlink: true });
	const depthCap = Math.max(1, Math.min(4, maxDepth));
	const entryCap = Math.max(1, Math.min(1000, maxEntries));
	const entries: Array<{ path: string; type: string; size?: number }> = [];
	const queue: Array<{ dir: string; depth: number }> = [{ dir: start, depth: 0 }];
	let truncated = false;
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
				return { root: relPath, entries, truncated };
			}
			const abs = resolve(dir, it.name);
			const rel = relative(workDir, abs);
			if (it.isDirectory()) {
				entries.push({ path: rel, type: "dir" });
				if (depth + 1 < depthCap) queue.push({ dir: abs, depth: depth + 1 });
			} else if (it.isFile()) {
				let size: number | undefined;
				try {
					size = statSync(abs).size;
				} catch {}
				entries.push({ path: rel, type: "file", size });
			}
		}
	}
	return { root: relPath, entries, truncated };
}
