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
 *    `git-remote-https` for an in-scope one. Fetches are not rewritten. The machine's own rewrites
 *    away from https (an `insteadOf` to an ssh host alias) are kept for pushes ({@link pushRewrites}),
 *    and the helper never waits on a terminal prompt (`GIT_TERMINAL_PROMPT=0`).
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

/** Distinct from both the refusal exit and a bare `timeout(1)` rc=124 (#1403). */
export const PUSH_TIMEOUT_EXIT = 4;
/**
 * The timeout line. The cloud parses `pags: push timed out: <url>` out of a tool result
 * (`workers/api/src/lib/write-scope-refusals.ts`), so its shape is a contract: change both.
 */
export const PUSH_TIMEOUT_MARKER = "pags: push timed out:";
/**
 * How long the helper waits on the REAL transport before giving up (#1403): comfortably under the
 * Engine's own ~120s outer tool-call timeout, so this message is what the Pilot sees instead of the
 * opaque rc=124 from that outer kill. A genuinely slow but working push (a large first push) still
 * has this long; one that needs longer is exactly the "report what it was waiting on, then let the
 * Pilot retry" case the issue asks for, not a reason to raise this closer to the outer bound.
 */
export const PUSH_DELEGATE_TIMEOUT_SECONDS = 45;

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
export function renderPushHelper(opts: { scope: readonly string[]; realHelperDir: string; timeoutSeconds?: number }): string {
	const timeoutSeconds = opts.timeoutSeconds ?? PUSH_DELEGATE_TIMEOUT_SECONDS;
	return `#!/bin/sh
# ProAgentStore push guard (#1252, #1403) — GENERATED. Source of truth:
# packages/browser-runner/src/coding/push-guard.ts.
${checkScope(opts.scope.map(normalizeRepo).join(" "))}
url="$2"
refuse_unless_in_scope "git push" "$url"
case "$url" in http://*) transport=http ;; *) transport=https ;; esac
# Nobody can see a terminal prompt in an Engine's tool call: a push with no usable credential fails
# NOW, with git's own reason, instead of waiting on a Username prompt until the tool times out.
GIT_TERMINAL_PROMPT=0; export GIT_TERMINAL_PROMPT
# #1403: the real transport has no bound of its own — a stalled credential helper, a DNS lookup or a
# TLS handshake hangs here with NOTHING on stderr, until the Engine's own outer tool-call timeout
# kills the whole call with the opaque rc=124. Bounded here in portable sh, deliberately not
# \`timeout(1)\`: it ships on neither macOS nor every base image a runner machine might use.
real=${sq(opts.realHelperDir)}/git-remote-$transport
# Job control (#1403), so the backgrounded delegate gets its OWN process group: \`sh -c 'sleep 300'\`
# may fork rather than exec-replace itself depending on the shell and how it was invoked, and a
# plain \`kill "$cpid"\` then kills only the interpreter — the actual delegate survives as an orphan,
# still holding git's end of the pipe open, which hangs the WHOLE call past this timeout rather than
# fixing it. Killing the group (\`kill -- "-$cpid"\`) reaches every descendant it forked, not just
# the one PID $! happens to name.
set -m 2>/dev/null || true
"$real" "$1" "$url" &
cpid=$!
waited=0
while kill -0 "$cpid" 2>/dev/null; do
  if [ "$waited" -ge ${timeoutSeconds} ]; then
    kill -- "-$cpid" 2>/dev/null
    kill "$cpid" 2>/dev/null
    echo "${PUSH_TIMEOUT_MARKER} $(norm "$url") did not complete within ${timeoutSeconds}s — delegated to git-remote-$transport for auth, network and the remote's own response; nothing further is known from here. Check credential.helper / network / github.com reachability, then retry." >&2
    exit ${PUSH_TIMEOUT_EXIT}
  fi
  sleep 1
  waited=$((waited + 1))
done
wait "$cpid"
exit $?
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
export function installPushGuard(scope: readonly string[], env: NodeJS.ProcessEnv, root = pushGuardRoot(), realHelperDir?: string, timeoutSeconds?: number): { ssh: string; bin: string } | null {
	const repos = scope.map(normalizeRepo).filter(Boolean);
	if (!repos.length) return null;
	const realSsh = findOnPath("ssh", env.PATH, root) ?? "ssh";
	const helperDir = realHelperDir ?? gitExecPath(env, root);
	if (!helperDir) return null;
	const wrapper = renderSshWrapper({ scope: repos, realSsh });
	const helper = renderPushHelper({ scope: repos, realHelperDir: helperDir, timeoutSeconds });
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
export function pushGuardEnv(env: NodeJS.ProcessEnv, scope: readonly string[] | undefined, root = pushGuardRoot(), realHelperDir?: string, timeoutSeconds?: number): NodeJS.ProcessEnv {
	const dirs = installPushGuard(scope ?? [], env, root, realHelperDir, timeoutSeconds);
	if (!dirs) return env;
	const out: NodeJS.ProcessEnv = { ...env, PATH: `${dirs.bin}:${env.PATH ?? ""}`, GIT_SSH_COMMAND: sq(join(dirs.ssh, "ssh")) };
	// The machine's own choice of ssh, so the wrapper delegates exactly as git would have — never to itself.
	// An env that is already guarded keeps the delegate it recorded.
	if (env.GIT_SSH_COMMAND && !env.GIT_SSH_COMMAND.includes(root)) out.PAGS_REAL_GIT_SSH_COMMAND = env.GIT_SSH_COMMAND;
	if (env.GIT_SSH) out.PAGS_REAL_GIT_SSH = env.GIT_SSH;
	let count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
	for (const [base, value] of pushRewrites(machineUrlRewrites(env))) {
		out[`GIT_CONFIG_KEY_${count}`] = `url.${base}.pushInsteadOf`;
		out[`GIT_CONFIG_VALUE_${count}`] = value;
		count++;
	}
	out.GIT_CONFIG_COUNT = String(count);
	return out;
}

/** One `url.<base>.insteadOf|pushInsteadOf = <value>` rule from the machine's git config. */
export interface UrlRewrite {
	base: string;
	value: string;
	push: boolean;
}

/** The machine's own url rewrites (global/system config and GIT_CONFIG_COUNT), read once per env. */
export function machineUrlRewrites(env: NodeJS.ProcessEnv): UrlRewrite[] {
	let raw = "";
	try {
		raw = execFileSync("git", ["config", "--get-regexp", "^url\\..*\\.(push)?insteadof$"], {
			encoding: "utf8",
			cwd: "/",
			env: { ...env, GIT_TERMINAL_PROMPT: "0" },
			timeout: 5_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		/* none configured (git exits 1), or no git: nothing to preserve */
	}
	const out: UrlRewrite[] = [];
	for (const line of raw.split("\n")) {
		const m = /^url\.(.+)\.(pushinsteadof|insteadof) (.+)$/i.exec(line.trim());
		if (m) out.push({ base: m[1], value: m[3], push: m[2].toLowerCase() === "pushinsteadof" });
	}
	return out;
}

/**
 * The `pushInsteadOf` rules the guard adds, as `[base, value]`.
 *
 * #1252 routed every https push to github.com through the helper with ONE `pushInsteadOf`. But git
 * consults `insteadOf` for a push only when NO `pushInsteadOf` matches — so that rule silently
 * replaced the owner's own rewrite (`url."git@github-personal:".insteadOf https://github.com/`, how
 * his https remotes reach GitHub over ssh with the right key). Every push from such a checkout was
 * forced onto plain https, where the machine has no credential: `git-remote-https` asked for a
 * Username on a terminal nobody sees and hung until the Engine's 2-minute tool timeout (Grass Karma
 * #33). A rewrite the owner points AWAY from https github.com is therefore kept as a push rule: the
 * push goes where it always went, and over ssh it is still checked, by the ssh wrapper.
 */
export function pushRewrites(machine: readonly UrlRewrite[]): Array<[string, string]> {
	const leavesHttps = (base: string) => !HTTPS_PUSH_PREFIXES.some((p) => base.toLowerCase().startsWith(p));
	const rules: Array<[string, string]> = [];
	for (const prefix of HTTPS_PUSH_PREFIXES) {
		// git's order for a push: pushInsteadOf rules if any applies, else insteadOf; longest value wins.
		const applies = (r: UrlRewrite) => prefix.startsWith(r.value) || r.value.startsWith(prefix);
		const push = machine.filter((r) => r.push && applies(r));
		const relevant = (push.length ? push : machine.filter((r) => !r.push && applies(r))).filter((r) => leavesHttps(r.base));
		// A rule more specific than the prefix: re-stated as a push rule, it out-matches ours.
		for (const r of relevant) if (r.value.length > prefix.length && r.value.startsWith(prefix)) rules.push([r.base, r.value]);
		// A rule covering the whole prefix: the prefix goes where it sends it, not to the helper.
		const covering = relevant.filter((r) => prefix.startsWith(r.value)).sort((a, b) => b.value.length - a.value.length)[0];
		rules.push(covering ? [covering.base + prefix.slice(covering.value.length), prefix] : [`${PUSH_HELPER_TRANSPORT}::${prefix}`, prefix]);
	}
	return rules;
}
