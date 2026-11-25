import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { commandFromToolInput } from "./engine-acts.js";

/**
 * Which files an Engine's SHELL command changed (#1717, a slice of #1670) — the second kind of ownership evidence a shared-checkout park accepts,
 * beside the files the Engine's own write tools named (`edited-paths.ts`).
 *
 * A `sed -i` or a `git mv` writes no `Edit` block, so the first kind can never see it. A dirty tree alone proves nothing either: another editor
 * working in the same checkout produces the same `git status`. So a path is claimed only when ALL of these hold:
 *
 *   1. it was CLEAN (or already provably this run's) when the command started — a path somebody had already left dirty is never claimed, whatever
 *      the command then does to it;
 *   2. it is different after the command ended — a changed status or a changed size/mtime;
 *   3. the command's own text NAMES it, as a whole argument or as a directory containing it. A glob, `$(find …)` or `biome --write .` names nothing,
 *      so what those touch stays unowned and the park refuses, as it always did.
 *
 * What remains: someone else writing that same, clean, named file during the few seconds the command runs. A gap here costs a refused park;
 * a false claim would stash somebody's edit (onto a ref, never lost — but still not ours), which is why 1 and 3 are required and not just 2.
 */

/** path → a fingerprint of its state. A rename's source is its own entry. */
export type DirtyState = Map<string, string>;

const PENDING_MAX = 32;

/** The checkout's dirty paths with a fingerprint each, or null when git could not say. Reads only. */
export function dirtyState(workDir: string): DirtyState | null {
	let out: string;
	try {
		out = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: workDir, encoding: "utf-8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return null;
	}
	const state: DirtyState = new Map();
	const fields = out.split("\0").filter(Boolean);
	const stamp = (code: string, path: string): string => {
		try {
			const s = statSync(join(workDir, path));
			return `${code}:${s.size}:${s.mtimeMs}`;
		} catch {
			return `${code}:gone`;
		}
	};
	for (let i = 0; i < fields.length; i++) {
		const entry = fields[i];
		const code = `${entry[0]}${entry[1]}`; // the two-letter status, a fixed-width prefix of the porcelain entry
		state.set(entry.slice(3), stamp(code, entry.slice(3)));
		if (code[0] === "R" || code[0] === "C") {
			const source = fields[++i];
			if (source) state.set(source, `${code}:source`);
		}
	}
	return state;
}

/** Does the command name this repo-relative path — as an argument, or as a directory that contains it? Globs and `.` name nothing. */
export function namedInCommand(path: string, command: string, workDir: string): boolean {
	const root = resolve(workDir);
	for (const raw of command.split(/[\s'"`;|&()<>=,]+/)) {
		if (!raw || /[*?[\]{}$~]/.test(raw)) continue;
		const rel = relative(root, isAbsolute(raw) ? resolve(raw) : resolve(root, raw)).replaceAll("\\", "/");
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue; // the root itself, or outside the checkout
		if (path === rel || path.startsWith(`${rel}/`)) return true;
	}
	return false;
}

/** The paths one command provably changed: clean before, different after, and named by the command. */
export function shellOwned(before: DirtyState, after: DirtyState, command: string, workDir: string, alreadyOwned: ReadonlySet<string>): string[] {
	const out: string[] = [];
	for (const [path, fp] of after) {
		const was = before.get(path);
		if (was === fp) continue; // untouched by this command
		if (was !== undefined && !alreadyOwned.has(path)) continue; // somebody else's edit it then touched: not claimed
		if (namedInCommand(path, command, workDir)) out.push(path);
	}
	return out;
}

/** Watches one session's shell commands, adding the files they provably changed to `owned` (the session's `editedPaths`). */
export class ShellEditTracker {
	private pending = new Map<string, { before: DirtyState; command: string }>();

	constructor(
		private readonly workDir: string,
		private readonly owned: Set<string>,
	) {}

	/** A tool call started: remember the tree as it was, if the call carries a command. */
	begin(id: string, input: unknown): void {
		const command = commandFromToolInput(input);
		if (!id || !command || this.pending.size >= PENDING_MAX) return;
		const before = dirtyState(this.workDir);
		if (before) this.pending.set(id, { before, command });
	}

	/** Its result arrived: claim what it changed. */
	end(id: string): void {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		const after = dirtyState(this.workDir);
		if (after) for (const path of shellOwned(p.before, after, p.command, this.workDir, this.owned)) this.owned.add(path);
	}

	/** The turn ended: no result is coming for anything still pending. */
	clear(): void {
		this.pending.clear();
	}
}
