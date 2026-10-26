/**
 * What a caller-supplied `workDir` may be (#1165).
 *
 * The read-only inspection routes (`read-file`, `tree`, `search`, `git`) confine every PATH to the
 * `workDir` — but took the `workDir` itself from the request. `{ workDir: "~", path: ".ssh/id_ed25519" }`
 * was a perfectly confined read of a private key. The cloud sends the owner's registered repo folder
 * (`coding_repos.workdir`), and registration accepts any local path, `~` included; this runner has no
 * copy of that registry to check against. So it refuses what can never be a repository it should
 * read inside, whoever asked:
 *
 *   • the filesystem root, the home folder, or any folder ABOVE the home folder — a root that holds
 *     everything the owner has;
 *   • a folder inside a credential directory ({@link CREDENTIAL_DIRS}) — `~/.ssh`, `~/.gnupg`, the
 *     cloud CLIs' config, and ProAgentStore's own (`~/.config/proagentstore`, which holds the account
 *     session), except the managed clones the runner itself makes there.
 *
 * Resolved through symlinks first (the nearest existing ancestor, for a folder a clone will create), so
 * `~/dev/innocent -> ~/.ssh` is the credential directory it points at.
 *
 * Then an ALLOW-list (#1193). A deny-list leaves `~/Documents` readable and cannot name every app's token store, so a folder
 * must also be one of:
 *   • inside a git working tree whose root is below the home folder — a repository, which is what these routes exist to read;
 *   • inside a root the owner registered on this machine (`runner-roots.ts`, `pags runner roots add`).
 * Anything else is refused with the folder named and the command that fixes it. The credential check still comes first: a
 * registered root cannot be a credential directory.
 */
import { existsSync, realpathSync } from "node:fs";
import { readRoots } from "./runner-roots.js";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { resolveHomePath } from "./home-path.js";
import { InspectError } from "./inspect.js";

/** Folders under the home folder whose contents are credentials, never a repository to read. */
export const CREDENTIAL_DIRS = [
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".kube",
	".docker",
	".password-store",
	".config/gcloud",
	".config/gh",
	".config/proagentstore",
	"Library/Keychains",
] as const;

/** `~` expanded; resolved through symlinks as far as the path exists. */
export function realPathOf(raw: string, home = homedir()): string {
	let p = resolveHomePath(raw, { home }).path;
	const tail: string[] = [];
	while (!existsSync(p)) {
		const up = dirname(p);
		if (up === p) break;
		tail.unshift(basename(p));
		p = up;
	}
	let real = p;
	try {
		real = realpathSync(p);
	} catch {
		// Unreadable: judge the path as written.
	}
	return tail.length ? join(real, ...tail) : real;
}

/** Is `child` the same as `parent` or inside it? */
export function isWithin(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The `workDir` a request may name, or an {@link InspectError} saying why not. `allow` lists folders the
 * runner itself manages inside a credential directory — the managed clone root — which stay usable.
 */
/** The nearest folder at or above `path` that holds a `.git` (a directory, or the file a worktree or submodule has), or null. */
export function gitRootOf(path: string): string | null {
	let p = path;
	for (;;) {
		if (existsSync(join(p, ".git"))) return p;
		const up = dirname(p);
		if (up === p) return null;
		p = up;
	}
}

export function confineWorkDir(raw: string, opts: { home?: string; allow?: readonly string[]; roots?: readonly string[] } = {}): string {
	const home = realPathOf(opts.home ?? homedir(), opts.home ?? homedir());
	const path = realPathOf(raw, opts.home ?? homedir());
	if (isWithin(home, path)) {
		throw new InspectError(`"${raw}" is ${path === home ? "the home folder" : "a folder that contains the home folder"}, not a repository — register the repository's own folder.`);
	}
	if ((opts.allow ?? []).some((a) => isWithin(path, realPathOf(a, home)))) return path;
	const credential = CREDENTIAL_DIRS.find((d) => isWithin(path, realPathOf(join(home, d), home)));
	if (credential) throw new InspectError(`"${raw}" is inside ~/${credential}, which holds credentials — it cannot be read as a repository.`);
	// The allow-list (#1193): a registered root, else a git working tree that is not the home folder's own.
	const registered = (opts.roots ?? readRoots(opts.home ?? homedir())).map((r) => realPathOf(r, home));
	if (registered.some((r) => !isWithin(home, r) && isWithin(path, r))) return path;
	const repo = gitRootOf(path);
	if (repo && !isWithin(home, repo)) return path;
	throw new InspectError(
		`"${raw}" is not a git repository or a folder you have allowed on this machine, so it cannot be read through the runner. ` +
			`If it is a project, run \`pags runner roots add "${path}"\` on that machine (or put it under git); a registered or forged path outside both is refused.`,
	);
}
