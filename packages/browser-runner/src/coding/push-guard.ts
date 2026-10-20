/**
 * Containment for the Engine's `git push` (#1252) — at the transport, not the command line.
 *
 * ── The incident
 *
 * A PAS coder session registered for `proappstore-online/template-app` pushed eight commits to
 * `proappstore-online/tennis-clubs` and three to `ProAgentStore/runner-router`, and moved a tag there,
 * from a temp clone in `/tmp/rr`. The `gh` guard (#679) refused the same session's `gh run cancel` on
 * tennis-clubs — it only ever saw `gh`. Its own gap list said so: "`git push` is not gated".
 *
 * ── Why the transport
 *
 * Matching `git push` in a command line misses `/usr/bin/git push`, a push inside a script, a tag or
 * mirror push, and any clone anywhere on disk. Every one of those still goes through git's TRANSPORT,
 * and git asks the transport for exactly one thing when it writes: `git-receive-pack <repository>`.
 * So the decision is made there, from the repository git itself is about to write to:
 *
 *  - **SSH** (this machine's remotes, through whatever host alias `~/.ssh/config` defines):
 *    `GIT_SSH_COMMAND` points at a wrapper that reads the remote command git hands ssh. A
 *    `git-receive-pack` for a repository outside the scope is refused before ssh runs; everything
 *    else — every fetch, every in-scope push — is exec'd to the real ssh unchanged, so the owner's
 *    aliases and keys keep working. Set in the Engine's env only: the machine's git config is not
 *    touched, which is what #679 required.
 *  - **HTTPS**: `url.pags-push::https://github.com/.pushInsteadOf` (via `GIT_CONFIG_COUNT`, the
 *    env-only config git ≥ 2.31 reads) routes every push to github.com through
 *    `git-remote-pags-push`, which refuses an out-of-scope repository and execs git's own
 *    `git-remote-https` for an in-scope one. Fetches are not rewritten.
 *
 * Both cover a tag push, a force push, `--mirror`, `--no-verify` (no hook is involved), a push from
 * any clone in any directory, and git invoked by absolute path: they live in the environment every
 * git the Engine starts inherits. No scope means no guard — "the platform did not say" is not "allow
 * nothing", the same rule as the `gh` guard.
 *
 * ── What it does not stop, stated rather than hidden
 *
 * {@link PUSH_GUARD_GAPS}. A refusal is reported from its marker line in the tool result
 * ({@link PUSH_REFUSED_MARKER}), which the cloud reads into the run's evidence check and the
 * instance's activity log.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeRepo } from "./gh-guard.js";

/** Distinct from git's own statuses, like the other guards'. */
export const PUSH_REFUSED_EXIT = 3;
/**
 * The refusal line. The cloud parses `pags: refused write-scope: <how> to <owner/repo>` out of a tool
 * result (`workers/api/src/lib/write-scope-refusals.ts`), so its shape is a contract: change both.
 */
export const PUSH_REFUSED_MARKER = "pags: refused write-scope:";

/** The transport name the HTTPS rewrite routes through (`git-remote-<name>`). */
export const PUSH_HELPER_TRANSPORT = "pags-push";

/** Pushes to these prefixes go through the helper. GitHub only: the scope is GitHub slugs. */
export const HTTPS_PUSH_PREFIXES: readonly string[] = ["https://github.com/", "http://github.com/"];

export const PUSH_GUARD_GAPS: readonly string[] = [
	"An Engine that unsets or overrides GIT_SSH_COMMAND or GIT_CONFIG_COUNT for its own command (e.g. `env -u GIT_SSH_COMMAND git push`) is not guarded.",
	"An https remote with an explicit `remote.<name>.pushurl` skips git's pushInsteadOf rewrite; ssh remotes have no such gap.",
	"Only GitHub is guarded over https; an ssh push to any host is checked by repository name alone.",
];

export function pushGuardRoot(): string {
	return join(homedir(), ".config", "proagentstore", "push-guard");
}

const sq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The shared sh: normalise a path or URL to `owner/repo`, and refuse unless it is in SCOPE. */
function checkScope(scope: string): string {
	return `SCOPE=${sq(scope)}
norm() {
  printf '%s' "$1" | sed "s|^[a-zA-Z+.-]*://||; s|^[^/:]*:||; s|'||g; s|/*$||; s|\\.git$||" | awk -F/ '{ if (NF>1) print $(NF-1)"/"$NF; else print $0 }' | tr '[:upper:]' '[:lower:]'
}
refuse_unless_in_scope() {
  want=$(norm "$2")
  for r in $SCOPE; do [ "$r" = "$want" ] && return 0; done
  echo "${PUSH_REFUSED_MARKER} $1 to \${want:-an unnamed repository} — this agent session is registered for: $SCOPE" >&2
  echo "The push was refused before anything was sent. Ask the owner to register that repository with the agent, or push from a session that owns it." >&2
  exit ${PUSH_REFUSED_EXIT}
}`;
}

/**
 * The `ssh` git runs for an ssh remote. git passes the remote command as the LAST argument —
 * `git-receive-pack 'owner/repo.git'` for a push, `git-upload-pack …` for a fetch.
 */
export function renderSshWrapper(opts: { scope: readonly string[]; realSsh: string }): string {
	return `#!/bin/sh
# ProAgentStore push guard (#1252) — GENERATED. Source of truth:
# packages/browser-runner/src/coding/push-guard.ts. Editing this file lets an agent push to any
# repository; that is a bypass, not a configuration.
${checkScope(opts.scope.map(normalizeRepo).join(" "))}
for last in "$@"; do :; done
case "$last" in
  *git-receive-pack*)
    refuse_unless_in_scope "git push" "$(printf '%s' "$last" | sed 's/^.*git-receive-pack[ ]*//')" ;;
esac
# Delegate the way git would have without us: the command the machine's env or config named, else ssh.
if [ -n "$PAGS_REAL_GIT_SSH_COMMAND" ]; then exec sh -c "$PAGS_REAL_GIT_SSH_COMMAND \\"\\$@\\"" ssh "$@"; fi
if [ -n "$PAGS_REAL_GIT_SSH" ]; then exec "$PAGS_REAL_GIT_SSH" "$@"; fi
cfg=$(git config --get core.sshCommand 2>/dev/null)
if [ -n "$cfg" ]; then exec sh -c "$cfg \\"\\$@\\"" ssh "$@"; fi
exec ${sq(opts.realSsh)} "$@"
`;
}

/** `git-remote-pags-push <remote> <url>` — refuse, or become git's own https transport. */
export function renderPushHelper(opts: { scope: readonly string[]; realHelperDir: string }): string {
	return `#!/bin/sh
# ProAgentStore push guard (#1252) — GENERATED. Source of truth:
# packages/browser-runner/src/coding/push-guard.ts.
${checkScope(opts.scope.map(normalizeRepo).join(" "))}
url="$2"
refuse_unless_in_scope "git push" "$url"
case "$url" in http://*) transport=http ;; *) transport=https ;; esac
exec ${sq(opts.realHelperDir)}/git-remote-$transport "$1" "$url"
`;
}

/** First executable `name` on `path`, skipping our own directories. */
function findOnPath(name: string, path: string | undefined, skip: string): string | null {
	for (const dir of (path ?? "").split(":")) {
		if (!dir || dir.startsWith(skip)) continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			/* keep looking */
		}
	}
	return null;
}

const execPaths = new Map<string, string | null>();

/** Where git keeps `git-remote-https` — asked of the machine's real git, once per git. */
function gitExecPath(env: NodeJS.ProcessEnv, root: string): string | null {
	const git = findOnPath("git", env.PATH, root);
	if (!git) return null;
	if (!execPaths.has(git)) {
		let out: string | null = null;
		try {
			out = execFileSync(git, ["--exec-path"], { encoding: "utf8", env: { PATH: env.PATH ?? "" } }).trim() || null;
		} catch {
			/* no answer: no guard, never a broken push */
		}
		execPaths.set(git, out);
	}
	return execPaths.get(git) ?? null;
}

const installed = new Map<string, { ssh: string; bin: string }>();

/** Install (idempotently) the wrapper and helper for `scope`; null when they cannot be. */
export function installPushGuard(scope: readonly string[], env: NodeJS.ProcessEnv, root = pushGuardRoot(), realHelperDir?: string): { ssh: string; bin: string } | null {
	const repos = scope.map(normalizeRepo).filter(Boolean);
	if (!repos.length) return null;
	const realSsh = findOnPath("ssh", env.PATH, root) ?? "ssh";
	const helperDir = realHelperDir ?? gitExecPath(env, root);
	if (!helperDir) return null;
	const wrapper = renderSshWrapper({ scope: repos, realSsh });
	const helper = renderPushHelper({ scope: repos, realHelperDir: helperDir });
	const key = createHash("sha256").update(`${root} ${wrapper} ${helper}`).digest("hex").slice(0, 16);
	const cached = installed.get(key);
	if (cached) return cached;
	// The wrapper is named `ssh` so git treats it as OpenSSH, and lives OFF the Engine's PATH so its
	// own `exec ssh` can never resolve to itself. The helper must be ON the PATH for git to find it.
	const out = { ssh: join(root, key, "ssh"), bin: join(root, key, "bin") };
	try {
		mkdirSync(out.ssh, { recursive: true });
		mkdirSync(out.bin, { recursive: true });
		if (!existsSync(join(out.ssh, "ssh"))) writeFileSync(join(out.ssh, "ssh"), wrapper, { mode: 0o755 });
		const helperPath = join(out.bin, `git-remote-${PUSH_HELPER_TRANSPORT}`);
		if (!existsSync(helperPath)) writeFileSync(helperPath, helper, { mode: 0o755 });
		installed.set(key, out);
		return out;
	} catch {
		// The other guards' rule: a runner that cannot write its config dir still runs the Engine.
		return null;
	}
}

/**
 * `env` with every push checked against `scope`; untouched when no scope was named or the guard
 * could not be installed. Existing `GIT_CONFIG_COUNT` entries are kept and appended to.
 */
export function pushGuardEnv(env: NodeJS.ProcessEnv, scope: readonly string[] | undefined, root = pushGuardRoot(), realHelperDir?: string): NodeJS.ProcessEnv {
	const dirs = installPushGuard(scope ?? [], env, root, realHelperDir);
	if (!dirs) return env;
	const out: NodeJS.ProcessEnv = { ...env, PATH: `${dirs.bin}:${env.PATH ?? ""}`, GIT_SSH_COMMAND: sq(join(dirs.ssh, "ssh")) };
	// The machine's own choice of ssh, so the wrapper delegates exactly as git would have — never to itself.
	// An env that is already guarded keeps the delegate it recorded.
	if (env.GIT_SSH_COMMAND && !env.GIT_SSH_COMMAND.includes(root)) out.PAGS_REAL_GIT_SSH_COMMAND = env.GIT_SSH_COMMAND;
	if (env.GIT_SSH) out.PAGS_REAL_GIT_SSH = env.GIT_SSH;
	let count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
	for (const prefix of HTTPS_PUSH_PREFIXES) {
		out[`GIT_CONFIG_KEY_${count}`] = `url.${PUSH_HELPER_TRANSPORT}::${prefix}.pushInsteadOf`;
		out[`GIT_CONFIG_VALUE_${count}`] = prefix;
		count++;
	}
	out.GIT_CONFIG_COUNT = String(count);
	return out;
}
