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
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
	const expanded = raw.trim().replace(/^~(?=$|[\\/])/, home);
	let p = resolve(isAbsolute(expanded) ? expanded : join(home, expanded));
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
export function confineWorkDir(raw: string, opts: { home?: string; allow?: readonly string[] } = {}): string {
	const home = realPathOf(opts.home ?? homedir(), opts.home ?? homedir());
	const path = realPathOf(raw, opts.home ?? homedir());
	if (isWithin(home, path)) {
		throw new InspectError(`"${raw}" is ${path === home ? "the home folder" : "a folder that contains the home folder"}, not a repository — register the repository's own folder.`);
	}
	if ((opts.allow ?? []).some((a) => isWithin(path, realPathOf(a, home)))) return path;
	const credential = CREDENTIAL_DIRS.find((d) => isWithin(path, realPathOf(join(home, d), home)));
	if (credential) throw new InspectError(`"${raw}" is inside ~/${credential}, which holds credentials — it cannot be read as a repository.`);
	return path;
}
