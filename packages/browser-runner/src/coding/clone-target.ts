/** #1446: provisioning a new checkout is not permission to read an arbitrary folder. */
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative } from "node:path";
import { resolveHomePath } from "./home-path.js";
import { InspectError } from "./inspect.js";
import { readRoots } from "./runner-roots.js";
import { credentialDirectoryAt, gitRootOf, isWithin, realPathOf } from "./workdir-guard.js";

export interface CloneTargetOptions {
	home?: string;
	managed?: string;
	roots?: readonly string[];
}

/**
 * Resolve only a clone's location, never its contents. Safe for polling a known job whose
 * destination is partly written. Nothing here registers a root or grants file-read access.
 */
export function resolveCloneLocation(raw: string, opts: CloneTargetOptions = {}): string {
	const homeInput = opts.home ?? homedir();
	const homeWritten = resolveHomePath("~", { home: homeInput }).path;
	const home = realPathOf(homeWritten, homeInput);
	const written = resolveHomePath(raw, { home: homeInput }).path;
	const path = realPathOf(written, homeInput);
	if (isWithin(home, path)) throw new InspectError("A clone destination cannot be the home folder or an ancestor of it.");
	if (written.split(/[\\/]/).some((part) => part.toLowerCase() === ".git") || path.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) {
		throw new InspectError("A clone destination cannot be inside git administration (.git).");
	}
	const managedWritten = opts.managed ? resolveHomePath(opts.managed, { home: homeInput }).path : undefined;
	const managed = managedWritten ? realPathOf(managedWritten, homeInput) : undefined;
	const sameManaged = managed !== undefined && relative(managed, path) === "";
	const inManaged = managed !== undefined && !sameManaged && isWithin(path, managed);
	if (sameManaged) throw new InspectError("Clone into a child of the managed repository folder, not the folder itself.");
	if (!inManaged) {
		const dir = credentialDirectoryAt(raw, homeInput, true);
		if (dir) throw new InspectError(`A clone destination cannot contain or be inside ~/${dir}, which holds credentials.`);
	}
	const roots = (opts.roots ?? readRoots(homeInput)).map((root) => ({ written: resolveHomePath(root, { home: homeInput }).path, path: realPathOf(root, homeInput) })).filter((root) => !isWithin(home, root.path));
	const boundary = inManaged ? { path: managed, written: managedWritten! } : isWithin(path, home) ? { path: home, written: homeWritten } : roots.find((root) => isWithin(path, root.path));
	if (!boundary) throw new InspectError("A fresh clone must be below this machine's home folder or an owner-registered project root.");
	// Do not follow even a dangling symlink below the allowed boundary. Symlinked homes and
	// OS aliases above it (/var on macOS) are fine; a clone cannot redirect below that point.
	let component = written;
	while (relative(component, boundary.written) !== "" && relative(component, boundary.path) !== "") {
		try {
			if (lstatSync(component).isSymbolicLink()) throw new InspectError("A clone destination cannot traverse a symlink below its project root.");
			// A differently cased spelling of the boundary is the same existing directory on
			// some filesystems. Check symlinks first so a child alias back to home is still refused.
			if (relative(realPathOf(component, homeInput), boundary.path) === "") break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = dirname(component);
		if (parent === component) throw new InspectError("Could not resolve the clone's project boundary.");
		component = parent;
	}
	return path;
}

/** #1455: bare and separate Git administration directories need not be named `.git`. */
function requireOutsideGit(path: string): void {
	if (gitRootOf(dirname(path))) throw new InspectError("Not cloning a second repository inside another git checkout.");
	let ancestor = dirname(path);
	for (;;) {
		try {
			if (!statSync(ancestor).isDirectory()) throw new InspectError("The clone destination has a parent that is not a directory.");
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw new InspectError("Could not inspect the clone destination's parent.");
			ancestor = parent;
		}
	}
	// Inspect THIS location, not the repository inherited from the runner's launch environment.
	const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	const result = spawnSync("git", ["rev-parse", "--is-inside-git-dir", "--is-inside-work-tree"], { cwd: ancestor, env, encoding: "utf8", timeout: 10_000 });
	if (!result.error && result.status === 128 && /^fatal: not a git repository(?: \(|:|$)/.test(result.stderr)) return;
	if (!result.error && result.status === 0) {
		const [administration, worktree] = result.stdout.trim().split(/\r?\n/);
		if (administration === "true") throw new InspectError("A clone destination cannot be inside git administration.");
		if (worktree === "true") throw new InspectError("Not cloning a second repository inside another git checkout.");
		if (administration === "false" && worktree === "false") return;
	}
	throw new InspectError("Could not verify that the clone destination is outside git administration; check git and the folder's permissions.");
}

/** Strict eligibility: unreadable is never empty; missing children of a repo are not new repos. */
export function requireEmptyCloneTarget(path: string): void {
	requireOutsideGit(path);
	try {
		const at = lstatSync(path);
		if (!at.isDirectory() || at.isSymbolicLink()) throw new InspectError("The clone destination is not a plain directory.");
		if (readdirSync(path).length !== 0) throw new InspectError("The clone destination is not empty — never cloned into.");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** The missing/empty-only path used by preflight and fresh clone requests. */
export function confineCloneTarget(raw: string, opts: CloneTargetOptions = {}): string {
	const path = resolveCloneLocation(raw, opts);
	requireEmptyCloneTarget(path);
	return path;
}
