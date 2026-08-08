import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Repo/workdir helpers for the coding engine.
 *
 * These lived in `coding/tmux.ts` and have nothing to do with tmux — `ensureRepo` runs `git
 * clone`. The coding engine stopped using tmux when it moved to the structured stream-json
 * interface, so anyone cleaning up that module found its two most load-bearing functions
 * inside it (#247). Split out so the tmux module is only tmux, and only the terminal-operator
 * agents depend on it.
 */

/**
 * What is ACTUALLY at a configured workdir (#405).
 *
 * The cloud used to write `clone_status = "ready"` for a local path the moment someone typed it,
 * without asking the machine that would run in it. An empty directory then answered every read
 * tool with a true-but-useless sentence ("(no files found at that path)") and the model, with no
 * diagnosis to relay, invented the repository instead — the transcript in #395.
 *
 * This is the question nobody was asking, and only the runner can answer it. Deliberately three
 * separate facts rather than one boolean, because the remedies differ: a path that is GONE has
 * moved, a path that is EMPTY was never cloned into, and a path that is a plain folder is not a
 * checkout at all.
 *
 * `checked: true` is a version marker, not decoration. An older runner 404s this endpoint and the
 * cloud gets `{error:"Not found"}` back through the relay — which must mean "unverified", never
 * "broken", or a CLI skew would condemn every healthy repo on the machine.
 */
export interface WorkdirCheck {
	checked: true;
	/** The path as the runner resolved it (`~` expanded) — what any message should name. */
	path: string;
	exists: boolean;
	isDirectory: boolean;
	/** Entries directly inside it, dotfiles included. 0 for a missing path. */
	entryCount: number;
	/**
	 * Is this inside a git WORK TREE — not merely "does it contain `.git`"?
	 *
	 * `~/dev/monorepo/apps/thing` is a perfectly good workdir with no `.git` of its own, and an
	 * existence test on `.git` would condemn every subdirectory of every monorepo checkout. Only
	 * `git rev-parse` knows the difference.
	 */
	insideWorkTree: boolean;
	/**
	 * Did `git` actually run? A machine without git on PATH answers "not a work tree" for every
	 * path on it, and a checkout must not be condemned by a missing binary. `false` means
	 * `insideWorkTree` carries no information.
	 */
	gitChecked: boolean;
}

/**
 * Inspect a workdir: does it exist, does it hold anything, is it a checkout. Never throws —
 * every failure is a `false`, because this function exists to REPORT a broken path and one that
 * threw would be reported as a broken runner instead.
 */
export function checkWorkdir(dir: string): WorkdirCheck {
	const absent = { checked: true, path: dir, exists: false, isDirectory: false, entryCount: 0, insideWorkTree: false, gitChecked: true } as const;
	let isDirectory = false;
	try {
		isDirectory = statSync(dir).isDirectory();
	} catch {
		return { ...absent };
	}
	if (!isDirectory) return { ...absent, exists: true };
	let entryCount = 0;
	try {
		entryCount = readdirSync(dir).length;
	} catch {
		// Unreadable (permissions) — reported as empty rather than as a crash; the cloud's
		// message for "empty" tells the owner to look at the path either way.
	}
	let insideWorkTree = false;
	let gitChecked = true;
	try {
		const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: dir,
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		insideWorkTree = out.trim() === "true";
	} catch (e) {
		// Exit 128 ("not a git repository") is an ANSWER. ENOENT is git missing from PATH, which
		// is not — and reporting it as "not a checkout" would condemn every repo on that machine.
		if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") gitChecked = false;
	}
	return { checked: true, path: dir, exists: true, isDirectory, entryCount, insideWorkTree, gitChecked };
}

/**
 * A safe, collision-resistant label derived from an arbitrary string.
 *
 * Named for tmux because that is where it started, but the coding engine uses it purely as a
 * display/identity label — no tmux target is derived from it (#247).
 */
export function sanitizeSessionName(label: string): string {
	return label.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "session";
}

/**
 * The clone URL with the credential embedded, or the URL untouched.
 *
 * PURE and exported so the one line that decides where a credential goes is unit-testable
 * without a network or a git binary. `username` is provider-specific — GitHub wants
 * `x-access-token`, GitLab `oauth2`, Bitbucket `x-token-auth` (#221) — and it defaults to the
 * value this function used to hardcode, so a cloud that sends only `token` behaves as before.
 *
 * Only https carries a credential: git ignores userinfo on an ssh URL, so injecting there would
 * be pure exposure for no effect. Both halves are percent-encoded — a secret containing `@`,
 * `/` or `:` would otherwise re-parse the URL into a DIFFERENT host and send the credential
 * there. GitHub's tokens contain none of those, so nothing changes for the existing provider.
 */
export function authenticatedCloneUrl(cloneUrl: string, token?: string, username?: string): string {
	if (!token || !/^https:\/\//i.test(cloneUrl)) return cloneUrl;
	const user = encodeURIComponent(username || "x-access-token");
	return cloneUrl.replace(/^https:\/\//i, `https://${user}:${encodeURIComponent(token)}@`);
}

/**
 * Ensure a repo is present at `dir`, cloning it from `cloneUrl` if not. Idempotent
 * — an existing checkout is left alone (no clobber). For private repos the cloud
 * sends a token, injected as the password half of an https URL. The coding CLI then
 * runs in this directory.
 *
 * `tokenUsername` is the USERNAME half, and it is provider-specific: GitHub wants
 * `x-access-token`, GitLab `oauth2`, Bitbucket `x-token-auth` (#221). It defaults to
 * `x-access-token` — the value this function used to hardcode — so an older cloud that
 * sends only `token` behaves exactly as before.
 *
 * Returns the absolute working directory. Throws on clone failure so the caller
 * can surface it (a session can't start without its repo).
 */
export function ensureRepo(dir: string, opts: { cloneUrl?: string; branch?: string; token?: string; tokenUsername?: string } = {}): string {
	// A real checkout (has .git) is reused as-is.
	if (existsSync(join(dir, ".git"))) return dir;
	if (!opts.cloneUrl) {
		// No source to clone from — just make the directory the engine will run in.
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		return dir;
	}
	// The dir exists but has no `.git`. It could be a half-cloned/empty managed dir
	// (safe to clear) OR a real user directory the caller passed as an explicit workDir
	// (deleting it = data loss). NEVER recursively delete a non-empty non-git dir — refuse
	// instead, so a mis-wired workDir+cloneUrl can't nuke a user's files. An empty dir is
	// fine to remove (git clone needs an empty/absent target).
	if (existsSync(dir)) {
		const entries = readdirSync(dir);
		if (entries.length > 0) {
			throw new Error(`Refusing to clone into non-empty directory "${dir}" (no .git found) — move it aside or point at an empty path.`);
		}
		rmSync(dir, { recursive: true, force: true });
	}
	const url = authenticatedCloneUrl(opts.cloneUrl, opts.token, opts.tokenUsername);
	const args = ["clone", "--depth", "1"];
	if (opts.branch) args.push("--branch", opts.branch);
	args.push(url, dir);
	execFileSync("git", args, { stdio: "pipe", timeout: 180_000 });
	return dir;
}
