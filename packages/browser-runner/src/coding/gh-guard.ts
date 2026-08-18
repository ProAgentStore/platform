/**
 * Containment for the Engine's `gh` writes (#679, absorbing #676).
 *
 * ── The defect
 *
 * `headless.ts` spawns the Engine with `env: mergeEnv(process.env, this.config.env)` — twice, at
 * the persistent stream-json spawn and again in `runOneShot`. The Engine therefore inherits the
 * machine's ENTIRE environment, and with it whatever `git` and `gh` credentials that machine
 * holds. `coding_diagnostics` has been saying so out loud since #676:
 *
 *     "A write naming a repository outside this list halts the run and is recorded. The first such
 *      write still LANDS — the engine uses this machine's own git and gh credentials, which are
 *      not scoped."
 *
 * Detection after the fact is not containment. This is the containment half.
 *
 * ── What this is, and what it deliberately is NOT
 *
 * It is an **allowlist gate on `gh`**, installed as a shim earlier on the Engine's `PATH` than the
 * real binary. A `gh` invocation whose verb is in the closed write vocabulary AND which names a
 * repository outside this session's registered scope is refused before it runs, with the refused
 * repository in stderr. Everything else — every read, every write to the session's own repo — is
 * `exec`'d straight through to the real `gh`, on the machine's own credentials, unchanged.
 *
 * It is **not a credential broker**, and the sketch's "route a repo-scoped installation token for
 * the allowed case" half is deliberately rejected:
 *
 *  - The token that would be routed is a GitHub-App installation token minted in the cloud
 *    (`workers/api/src/lib/git-credentials.ts`) and delivered once at session start, for the
 *    clone. It lives about an hour; a coding session does not. Swapping the machine's working
 *    login for it would turn a containment feature into an outage partway through long runs.
 *  - It would BREAK the one property this ticket says must survive: a cross-repo `gh pr view
 *    --repo <another org>/<repo>` is a different installation, so an installation token cannot
 *    read it. The machine's own login can, and does today.
 *  - It buys nothing. The harm is the wrong-repo write LANDING, and refusing to exec stops that
 *    strictly earlier than handing over a credential that would have failed.
 *
 * It is also **not a change to the machine's git configuration.** No `insteadOf`, no
 * `credential.helper`, no `GIT_SSH_COMMAND`. The owner drives his own work through a custom
 * `github-personal` SSH host alias, and forcing https to gate an agent would take over
 * configuration he uses personally.
 *
 * ── What remains open, and is stated rather than hidden
 *
 *  1. **`git push` is not gated at all.** Remotes here are SSH (`git@github-personal:…`), and
 *     `repo.ts` says why in code: *"Only https carries a credential: git ignores userinfo on an
 *     ssh URL"*. There is no token to withhold, so no credential decision can reach it.
 *  2. **A `PATH` shim is bypassable.** `/opt/homebrew/bin/gh` skips it entirely, and the Engine
 *     has been observed re-exporting its own environment (`export GH_CONFIG_DIR=…`). This raises
 *     the cost of a wrong-repo write; it does not make one impossible.
 *  3. **`gh api graphql` is not classified.** A mutation could travel in the query text, and
 *     deciding that would mean pattern-matching free prose — the judgement this codebase refuses
 *     to make in a gate, because a false positive that halts a run costs more than the finding.
 *     Explicit `gh api --method POST|PATCH|PUT|DELETE` with a `/repos/{owner}/{repo}` path IS
 *     classified.
 *  4. **A write that names no repository is not gated.** `gh` then resolves the target from the
 *     working directory's remote, which the shim cannot see without running git itself. In a
 *     session that is the workdir the platform registered — but the Engine has a shell, so `cd`
 *     into another checkout on this machine reaches that repository instead. Refusing every
 *     unqualified write was rejected: it is the ordinary shape of `gh pr create` inside the repo
 *     the session owns, so it would break the common case to narrow an uncommon one.
 *
 * All three are reported through {@link ghGuardReport} → `coding_diagnostics`, which is where the
 * `enforcement: "acts-observed-halt"` value they replace used to be. A gate that overstates itself
 * is worse than no gate.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The closed WRITE vocabulary — `<command> <subcommand>` pairs that change something on GitHub.
 *
 * A denylist rather than an allowlist, which inverts `repo-write.ts`'s shape, and the inversion is
 * the point rather than an oversight: `gh`'s read surface is enormous and open-ended (`gh api`,
 * `gh run`, `gh release download`, `gh search`, third-party extensions), so an allowlist of reads
 * would refuse working commands nobody enumerated and the Engine would be broken in ways that look
 * like the platform, not like a policy. What has to be complete here is the list of verbs that
 * WRITE, and that list is small, stable and reviewable. Adding to it is a code review.
 *
 * `gh gist` is absent on purpose: a gist belongs to no repository, so there is nothing to scope it
 * against and refusing it would be theatre.
 */
export const GH_WRITE_VERBS: readonly string[] = [
	"pr create", "pr merge", "pr close", "pr reopen", "pr edit", "pr comment", "pr review", "pr ready", "pr lock", "pr unlock",
	"issue create", "issue close", "issue reopen", "issue edit", "issue comment", "issue delete", "issue lock", "issue unlock", "issue pin", "issue unpin", "issue transfer",
	"release create", "release delete", "release edit", "release upload",
	"repo create", "repo delete", "repo edit", "repo rename", "repo archive", "repo unarchive", "repo sync", "repo fork", "repo deploy-key",
	"workflow enable", "workflow disable", "workflow run",
	"run cancel", "run rerun", "run delete",
	"secret set", "secret delete",
	"variable set", "variable delete",
	"label create", "label delete", "label edit", "label clone",
	"cache delete",
	"ruleset check",
];

/** The exit status the shim refuses with — distinct from `gh`'s own 1, so a refusal is telling. */
export const GH_REFUSED_EXIT = 3;

/** The marker a refusal always carries, so the reason is greppable in a pane full of tool output. */
export const GH_REFUSED_MARKER = "pags: refused";

/** Where the generated shims live. Under the runner's existing config root, not a new location. */
export function ghGuardRoot(): string {
	return join(homedir(), ".config", "proagentstore", "gh-guard");
}

/** `owner/repo`, lower-cased, with any `host/` prefix or `.git` suffix removed. */
export function normalizeRepo(raw: string): string {
	const parts = raw
		.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\.git$/i, "")
		.split("/")
		.filter(Boolean);
	return parts.slice(-2).join("/").toLowerCase();
}

/**
 * The `gh` the shim delegates to: the first executable named `gh` on `path`, skipping anything
 * under `guardRoot` — otherwise a shim installed on a previous spawn could be resolved as the
 * "real" one and the second generation would exec the first, forever.
 */
export function findRealGh(path: string | undefined, guardRoot: string): string | null {
	for (const dir of (path ?? "").split(":")) {
		if (!dir || (guardRoot && dir.startsWith(guardRoot))) continue;
		const candidate = join(dir, "gh");
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			/* not here, or not executable — keep looking */
		}
	}
	return null;
}

/**
 * The shim itself, as text.
 *
 * POSIX `sh` and not a Node script, because this runs on every `gh` the Engine invokes and it must
 * not depend on resolving a module out of a bundle whose layout differs between the monorepo
 * (`src/*.ts` under tsx) and the published CLI (`dist/browser-runner/*.js`). The logic is small
 * enough to be read in one screen, and its tests execute THIS text rather than a TypeScript twin
 * of it — so what is verified is the artifact that ships.
 *
 * Every unclassified path ends in `exec`, so a bug here degrades to today's behaviour rather than
 * to a broken `gh`.
 */
export function renderGhShim(opts: { realGh: string; scope: readonly string[] }): string {
	const scope = opts.scope.map(normalizeRepo).filter(Boolean).join(" ");
	// `case` patterns, one per write verb. Generated from the constant so the shim and the
	// reviewable list can never disagree.
	const verbs = GH_WRITE_VERBS.map((v) => `    ${sq(v)}) write=1 ;;`).join("\n");
	return `#!/bin/sh
# ProAgentStore gh guard (#679) — GENERATED. Source of truth:
# packages/browser-runner/src/coding/gh-guard.ts. Editing this file widens what the agent may
# write to; that is a bypass, not a configuration.
REAL=${sq(opts.realGh)}
SCOPE=${sq(scope)}

cmd=""; sub=""; repo=""; method=""; want=""
for a in "$@"; do
  if [ "$want" = "repo" ]; then repo="$a"; want=""; continue; fi
  if [ "$want" = "method" ]; then method="$a"; want=""; continue; fi
  case "$a" in
    --repo=*) repo=\${a#--repo=} ;;
    --method=*) method=\${a#--method=} ;;
    -R|--repo) want="repo" ;;
    -X|--method) want="method" ;;
    -*) : ;;
    *) if [ -z "$cmd" ]; then cmd="$a"; elif [ -z "$sub" ]; then sub="$a"; fi ;;
  esac
done

write=0
case "$cmd $sub" in
${verbs}
esac
# \`gh api\` is the generic escape hatch: only an explicitly mutating method counts, and the target
# comes out of the /repos/{owner}/{repo} path. \`gh api graphql\` is NOT classified — see the module.
if [ "$cmd" = "api" ]; then
  m=$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')
  case "$m" in POST|PATCH|PUT|DELETE) write=1 ;; esac
  if [ -z "$repo" ]; then
    repo=$(printf '%s' "$sub" | sed -n 's|^/\\{0,1\\}repos/\\([^/]*\\)/\\([^/]*\\).*|\\1/\\2|p')
  fi
fi

if [ "$write" = "1" ] && [ -n "$repo" ]; then
  want_repo=$(printf '%s' "$repo" | sed 's|^https\\{0,1\\}://||; s|\\.git$||' | awk -F/ '{ if (NF>1) print $(NF-1)"/"$NF; else print $0 }' | tr '[:upper:]' '[:lower:]')
  allowed=0
  for r in $SCOPE; do
    if [ "$r" = "$want_repo" ]; then allowed=1; fi
  done
  if [ "$allowed" = "0" ]; then
    echo "${GH_REFUSED_MARKER}: \\\`gh $cmd $sub\\\` writes to $want_repo, which this agent session is not registered for (allowed: $SCOPE)." >&2
    echo "Ask the owner to register that repository with the agent, or do the write in a session that owns it. Reads are not affected." >&2
    exit ${GH_REFUSED_EXIT}
  fi
fi

exec "$REAL" "$@"
`;
}

/** Single-quote for `sh`: the only character that needs care inside `'…'` is `'` itself. */
function sq(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** What the machine can say about the guard — reported up so the cloud states facts, not intent. */
export interface GhGuardReport {
	/** Is a shim actually on this Engine's PATH? */
	installed: boolean;
	/** The repositories a `gh` write may name. Empty means the guard was not installed. */
	scope: string[];
	/** Why it is not installed, when it is not. */
	reason?: "no-scope" | "gh-not-found" | "install-failed";
	/** What this does NOT stop. Sent up verbatim so no surface has to re-derive it. */
	gaps: string[];
}

/** The gaps, in one place, so the runner and `coding_diagnostics` cannot drift apart. */
export const GH_GUARD_GAPS: readonly string[] = [
	"`git push` is not gated — this machine's remotes are SSH, so there is no credential to withhold.",
	"A PATH shim is bypassable: invoking `/opt/homebrew/bin/gh` by absolute path, or re-exporting PATH, skips it.",
	"`gh api graphql` is not classified — a mutation can travel inside the query text.",
	"A write with no `--repo` is not gated: gh resolves the target from the working directory, so a `cd` into another checkout on this machine reaches it.",
];

/** Report for a session with no guard installed. */
export function ghGuardReport(scope: string[], reason?: GhGuardReport["reason"]): GhGuardReport {
	return { installed: !reason, scope, ...(reason ? { reason } : {}), gaps: [...GH_GUARD_GAPS] };
}

/** Installed shims, keyed by (scope, real gh) — writing the same file per turn would be silly. */
const installed = new Map<string, string>();

/**
 * Install (idempotently) a shim for `scope` and return its directory, or `null` with the reason.
 *
 * Keyed by a hash of what the shim CONTAINS, so a scope change lands in a different directory and
 * a stale shim can never be handed a scope it was not generated for.
 */
export function installGhGuard(
	scope: readonly string[],
	env: NodeJS.ProcessEnv,
	root = ghGuardRoot(),
): { dir: string } | { reason: NonNullable<GhGuardReport["reason"]> } {
	const repos = scope.map(normalizeRepo).filter(Boolean);
	// No scope is not "allow nothing" — it is "the platform did not say", and a guard that refused
	// every write on that basis would break every session an older cloud starts.
	if (repos.length === 0) return { reason: "no-scope" };
	const realGh = findRealGh(env.PATH, root);
	if (!realGh) return { reason: "gh-not-found" };
	const script = renderGhShim({ realGh, scope: repos });
	const key = createHash("sha256").update(`${root} ${script}`).digest("hex").slice(0, 16);
	const cached = installed.get(key);
	if (cached) return { dir: cached };
	const dir = join(root, key);
	try {
		mkdirSync(dir, { recursive: true });
		const shim = join(dir, "gh");
		if (!existsSync(shim)) writeFileSync(shim, script, { mode: 0o755 });
		installed.set(key, dir);
		return { dir };
	} catch {
		// Fail OPEN and say so. A runner that cannot write to its own config dir must still be able
		// to run the Engine; silently producing a `gh` that does not exist would be far worse.
		return { reason: "install-failed" };
	}
}

/**
 * The Engine's spawn env, with the guard ahead of the real `gh` on `PATH`.
 *
 * Returns `env` untouched whenever the guard could not be installed, which is what makes this safe
 * to put in front of every spawn: the failure mode is today's behaviour, never a broken `gh`.
 */
export function ghGuardEnv(env: NodeJS.ProcessEnv, scope: readonly string[] | undefined, root?: string): NodeJS.ProcessEnv {
	const out = installGhGuard(scope ?? [], env, root);
	if (!("dir" in out)) return env;
	return { ...env, PATH: `${out.dir}:${env.PATH ?? ""}` };
}

/** What to report for a session started with `scope`, derived from the same call the spawn made. */
export function ghGuardStatus(scope: readonly string[] | undefined, env: NodeJS.ProcessEnv, root?: string): GhGuardReport {
	const repos = (scope ?? []).map(normalizeRepo).filter(Boolean);
	const out = installGhGuard(scope ?? [], env, root);
	return "dir" in out ? ghGuardReport(repos) : ghGuardReport(repos, out.reason);
}
