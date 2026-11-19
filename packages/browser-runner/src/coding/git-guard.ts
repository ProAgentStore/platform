/**
 * The Engine may not restore or discard the repo-global stash by POSITION (#1021).
 *
 * ── The incident
 *
 * Setting up a fail-before comparison, an Engine composed `SRC="a.ts b.ts"; git stash push -- $SRC;
 * …; git stash pop`. zsh passed `$SRC` as ONE pathspec, so the save failed and created nothing — and
 * the chained `pop` restored the top of the stack anyway: someone else's retained recovery stash,
 * applied into the active checkout as merge conflicts. The stash is repo-global; `pop`, `drop` and
 * `stash@{n}` name a position in everyone's stack, not the thing this command saved.
 *
 * The Pilot's `no_stash_restore` refusal (`workers/api/src/lib/coding-scope-constraints.ts`) only
 * screens what the PILOT sends. The incident command was composed by the Engine itself, which
 * runs with `--dangerously-skip-permissions`, so the only enforcement point it cannot talk its way
 * past is the `git` it executes. This is that point.
 *
 * ── What the shim does
 *
 * A POSIX `sh` script named `git`, first on every Engine's `PATH` (all engines, every session —
 * unlike the `gh` guard it needs no scope). For `git [global options] stash <action> …`:
 *
 *   pop, drop, clear     refused — each consumes or discards by position, and there is no form of
 *                        them that names an exact object.
 *   apply, branch        allowed only with an exact object id (40 or 64 hex) — what `git stash
 *                        create` printed — so a restore is tied to an object this command made.
 *
 * Refusal exits {@link GIT_REFUSED_EXIT} BEFORE git runs, with {@link GIT_REFUSED_MARKER} on stderr.
 * Everything else — including `git stash push`, `list`, `show`, `create` — is `exec`'d to the real
 * git with its own exit status. Its tests run THIS text against real temporary repositories.
 *
 * ── #1489: the repo-wide discards, and a record of who ran what
 *
 * The same shim also refuses the commands that wipe EVERY actor's uncommitted work in a shared checkout (the
 * 2026-11-04 incident: tracked edits and an untracked test vanished, reflog "reset: moving to HEAD"):
 *
 *   reset --hard                                    discards every tracked change, whoever made it
 *   clean (unless -n / --dry-run)                   deletes untracked files and directories
 *   checkout / switch -f, --force, --discard-changes  throw away local changes in order to switch
 *   checkout / restore of the WHOLE tree (".", ":/")  the worktree-wide form of the same
 *
 * A targeted restore (`git checkout HEAD -- a.ts`), a staging change (`reset`, `restore --staged`), a branch switch,
 * rebase, merge and commit are untouched: they cannot reach another actor's files by accident. For bulk compare or
 * discard, use an isolated `git worktree add --detach` checkout, which nobody else shares. The text lives in
 * `git-guard-shell.ts`.
 *
 * Every mutating subcommand through the shim, allowed or refused, appends one tab-separated line to the audit log
 * ({@link GIT_AUDIT_FILE} beside the shim, or `PAGS_GIT_AUDIT_LOG`): time, decision, subcommand, the session id the
 * runner put in `PAGS_SESSION_ID`, pid, parent pid, working directory and argv. It is best-effort evidence — a log that
 * cannot be written never blocks git — and names the session whose shim ran the command, not that it intended it.
 *
 * ── What it does not stop, stated rather than hidden
 *
 * {@link GIT_GUARD_GAPS}: a PATH shim is bypassed by an absolute `/usr/bin/git` or a rewritten PATH,
 * and a git alias that expands to `stash pop` is resolved inside git, past the shim.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUDIT_AND_CLASSIFY, destructiveChecks } from "./git-guard-shell.js";

/** Distinct from git's own 1/128/129, so a refusal is recognisable from its status alone. */
export const GIT_REFUSED_EXIT = 3;
export const GIT_REFUSED_MARKER = "pags: refused";

/** The shim's default audit log, beside its installed copies (#1489). */
export const GIT_AUDIT_FILE = "audit.log";

export const GIT_GUARD_GAPS: readonly string[] = [
	"The audit records only commands that went THROUGH the shim: an absolute-path git, a rewritten PATH or another tool's libgit2 leave no line, and a line names the session whose environment ran it, not an intent.",
	"A bulk discard spelled another way — `git checkout HEAD -- <every file listed>`, `rm` then `git checkout`, `git update-ref` — is not refused; only the whole-tree forms are.",
	"A PATH shim is bypassable: invoking git by absolute path (/usr/bin/git), or rewriting PATH, skips it.",
	"A git alias that expands to `stash pop`/`drop`/`clear` is expanded inside git, past the shim.",
];

export function gitGuardRoot(): string {
	return join(homedir(), ".config", "proagentstore", "git-guard");
}

/** The first executable `git` on `path` that is not one of our own shims. */
export function findRealGit(path: string | undefined, guardRoot: string): string | null {
	for (const dir of (path ?? "").split(":")) {
		if (!dir || dir.startsWith(guardRoot)) continue;
		const candidate = join(dir, "git");
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			/* not here — keep looking */
		}
	}
	return null;
}

const sq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function renderGitShim(realGit: string, auditFile = join(gitGuardRoot(), GIT_AUDIT_FILE)): string {
	return `#!/bin/sh
# ProAgentStore git stash guard (#1021) — GENERATED. Source of truth:
# packages/browser-runner/src/coding/git-guard.ts. Editing this file lets an agent restore or discard
# someone else's stash; that is a bypass, not a configuration.
REAL=${sq(realGit)}
AUDIT=${sq(auditFile)}
set -f

state=global; skip=0; sub=""; subidx=0; idx=0; action=""; ref1=""; ref2=""
for a in "$@"; do
  idx=$((idx + 1))
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  if [ "$state" = global ]; then
    case "$a" in
      -C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix) skip=1 ;;
      -*) : ;;
      *) sub="$a"; subidx=$idx; state=args ;;
    esac
    continue
  fi
  [ "$sub" = stash ] || break
  case "$a" in
    -*) : ;;
    *) if [ -z "$action" ]; then action="$a"; elif [ -z "$ref1" ]; then ref1="$a"; elif [ -z "$ref2" ]; then ref2="$a"; fi ;;
  esac
done

${AUDIT_AND_CLASSIFY}
refuse() {
  audit refused
  echo "${GIT_REFUSED_MARKER}: \\\`git stash $action\\\` $1 The stash is shared by everyone working in this repository, so a position in it is not what you saved." >&2
  echo "Restore only an exact object you just created: S=\\$(git stash create) && [ -n \\"\\$S\\" ] && … && git stash apply \\"\\$S\\" — or compare in an isolated \\\`git worktree add --detach\\\` checkout, which never touches the stash." >&2
  exit ${GIT_REFUSED_EXIT}
}

exact_object() {
  case "$1" in ""|*[!0-9a-f]*) return 1 ;; esac
  [ \${#1} -eq 40 ] || [ \${#1} -eq 64 ]
}

${destructiveChecks(GIT_REFUSED_MARKER, GIT_REFUSED_EXIT)}
if [ "$sub" = stash ]; then
  case "$action" in
    pop) refuse "restores and DROPS the top of the stack, whoever saved it." ;;
    drop) refuse "discards a stack entry by position." ;;
    clear) refuse "discards every entry, including other people's recovery work." ;;
    apply) exact_object "$ref1" || refuse "needs an exact object id, not a stack position (got '\${ref1:-top of stack}')." ;;
    branch) exact_object "$ref2" || refuse "needs an exact object id, not a stack position (got '\${ref2:-top of stack}')." ;;
  esac
fi

audit allowed
exec "$REAL" "$@"
`;
}

const installed = new Map<string, string>();

/** Install (idempotently) the shim and return its directory, or null when it cannot be. */
export function installGitGuard(env: NodeJS.ProcessEnv, root = gitGuardRoot()): string | null {
	const realGit = findRealGit(env.PATH, root);
	if (!realGit) return null;
	const script = renderGitShim(realGit, join(root, GIT_AUDIT_FILE));
	const key = createHash("sha256").update(`${root} ${script}`).digest("hex").slice(0, 16);
	const cached = installed.get(key);
	if (cached) return cached;
	const dir = join(root, key);
	try {
		mkdirSync(dir, { recursive: true });
		const shim = join(dir, "git");
		if (!existsSync(shim)) writeFileSync(shim, script, { mode: 0o755 });
		installed.set(key, dir);
		return dir;
	} catch {
		// The gh guard's rule: a runner that cannot write its own config dir still runs the Engine,
		// with the machine's git — never with a `git` that does not exist.
		return null;
	}
}

/** `env` with the guard first on PATH; untouched when it could not be installed. */
export function gitGuardEnv(env: NodeJS.ProcessEnv, root?: string): NodeJS.ProcessEnv {
	const dir = installGitGuard(env, root);
	return dir ? { ...env, PATH: `${dir}:${env.PATH ?? ""}` } : env;
}
