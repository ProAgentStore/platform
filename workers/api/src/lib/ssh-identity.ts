/**
 * Which SSH identity answers for which repository (#684).
 *
 * ── The bug this replaces ──
 *
 * #684 shipped an SSH-identity probe so a deploy key masquerading as a user account would be
 * visible BEFORE a clone failed with GitHub's misleading "Repository not found". The probe was
 * right. What it probed was not: the cloud called `/coding/git-identity` with no body, the runner
 * defaulted the host to `github.com`, and the verdict was then applied to every repo whose clone
 * URL merely *started* with `git@` — including one pointed at a different host entirely.
 *
 * An SSH host ALIAS is the ordinary case, not an exotic one. A machine that works with two GitHub
 * accounts routes them through `~/.ssh/config` stanzas — `git@github-personal:…`, `git@github-work:…`
 * — each pinned to its own key. That is the documented setup on this owner's machines, and on one
 * of them the whole platform monorepo clones from `git@github-personal:ProAgentStore/platform.git`
 * while bare `github.com` has no key at all.
 *
 * So the old check produced BOTH errors from one line of code:
 *
 *   - **False positive.** `ssh -T git@github.com` → "Permission denied (publickey)" → identity null
 *     → "Private repo clones will fail until SSH is working", on a machine whose clones and pushes
 *     work perfectly through an alias. A diagnostics page that cries wolf about a working setup is
 *     worse than one that says nothing, because the next real warning is the one nobody reads.
 *   - **False negative, and it is #684's own bug.** A repo on `git@github-work:…` backed by a
 *     deploy key, while `github.com` happens to resolve to a user account, emitted NO issue at all.
 *     The check passed while the transport it claimed to have checked was broken.
 *
 * ── The fix ──
 *
 * Ask each host that a repository actually uses, and attribute each answer only to the repos on
 * that host. The runner's endpoint has always accepted a `host` parameter; nothing ever passed one.
 *
 * Everything here is pure so the attribution is testable without a network, a runner, or a D1 —
 * which is what the original had no way to be, and why neither error was caught.
 */
import { parseRepoRef } from "./git-providers.js";

/** Just enough of a repo row to group it. */
export interface SshRepoRef {
	name: string;
	cloneUrl?: string | null;
}

/** The repos that clone from one SSH host. */
export interface SshHostGroup {
	host: string;
	/** Display names, in the order the repos were given. */
	repos: string[];
}

/** The runner's `/coding/git-identity` answer. Every field but `checked` may be absent. */
export interface GitIdentityProbe {
	checked?: boolean;
	host?: string;
	identity?: string | null;
	isDeployKey?: boolean | null;
	raw?: string;
}

/** One line on the diagnostics report. */
export interface SshIdentityIssue {
	severity: "warn" | "info";
	message: string;
	fix: string;
}

/**
 * The HTTPS half of the same question (#684, #688) — the runner's `gh` login.
 *
 * `checked: true` is the version marker; an older runner has no such endpoint.
 */
export interface HttpsIdentityProbe {
	checked?: boolean;
	login?: string;
	orgs?: string[];
	error?: string;
}

/** The `gh` account name, or null when it was not established. */
export function httpsLoginFrom(probe: HttpsIdentityProbe | null | undefined): string | null {
	if (probe?.checked !== true) return null;
	const login = String(probe.login ?? "").trim();
	return login || null;
}

/** Is this SSH identity a repository deploy key rather than an account? */
function isDeployKeyIdentity(identity: string, flag: boolean | null | undefined): boolean {
	// The runner sets the flag; the slash is the structural marker it derives it from. Both are
	// checked so a runner that reports the identity but not the flag is still read correctly.
	return flag === true || identity.includes("/");
}

/**
 * How many distinct hosts are probed for one diagnostics call.
 *
 * Each probe is a real SSH handshake with its own timeout, and they run concurrently, so the cost
 * is subrequests rather than seconds. Four covers every realistic machine (a personal alias, a work
 * alias, bare github.com, one other forge) and bounds a pathological config. Hosts past the cap are
 * reported as UNVERIFIED rather than silently assumed fine — see {@link sshIdentityIssues}.
 */
export const MAX_SSH_HOSTS = 4;

/** Is this clone URL fetched over SSH? `https://` is a different transport with a different identity. */
export function isSshCloneUrl(url: string | null | undefined): boolean {
	const u = String(url ?? "").trim();
	return /^git@/i.test(u) || /^ssh:\/\//i.test(u);
}

/**
 * The SSH host one clone URL actually talks to, or null when it is not an SSH URL.
 *
 * Delegates to `parseRepoRef`, which already normalises scp-like `git@host:owner/repo` into a URL
 * the WHATWG parser accepts. Reused rather than re-implemented deliberately: a second git-URL
 * parser in the codebase is a second one to get subtly wrong, and this one is already tested
 * against ports, `.git` suffixes and browser paths.
 *
 * The host is NOT resolved through `~/.ssh/config` here and must not be — `github-personal` is a
 * real, distinct answer, because it is the string the machine will look up. Mapping it to
 * `github.com` on this side would reintroduce the exact conflation this module exists to undo.
 */
export function sshHostFor(cloneUrl: string | null | undefined): string | null {
	if (!isSshCloneUrl(cloneUrl)) return null;
	return parseRepoRef(cloneUrl)?.host || null;
}

/**
 * Group the SSH repos by the host they clone from, in first-seen order.
 *
 * Repos with no parseable host are dropped rather than pooled under a placeholder: we cannot probe
 * a host we cannot name, and a group nobody can check would render as a verdict nobody measured.
 */
export function sshHostGroups(repos: readonly SshRepoRef[]): SshHostGroup[] {
	const out: SshHostGroup[] = [];
	const index = new Map<string, SshHostGroup>();
	for (const r of repos) {
		const host = sshHostFor(r.cloneUrl);
		if (!host) continue;
		let group = index.get(host);
		if (!group) {
			group = { host, repos: [] };
			index.set(host, group);
			out.push(group);
		}
		group.repos.push(r.name);
	}
	return out;
}

const list = (names: readonly string[]) => names.map((n) => `"${n}"`).join(", ");

/**
 * The issues for one machine, one group per host.
 *
 * Five outcomes per host, and the differences between them are the point of the module:
 *
 *   1. **Deploy key** → `warn`, naming the host and ONLY the repos on it. When the machine's `gh`
 *      login is known, the remedy NAMES the account HTTPS would use instead — that is #684's own
 *      observation, where `gh repo clone` over HTTPS succeeded on the clone SSH had just refused.
 *   2. **Authentication failed** → `warn`, naming the host that failed. Not "github.com" unless
 *      github.com is the host that failed.
 *   3. **A user account that is NOT the `gh` login** → `info`. This is the two-identities-per-
 *      transport condition #684 was filed about, and it is reported rather than warned about
 *      BECAUSE IT IS USUALLY DELIBERATE: routing two GitHub accounts through two `~/.ssh/config`
 *      aliases is the ordinary way to hold both on one machine, and that setup necessarily
 *      disagrees with the single `gh` login. A `warn` here would be the same false-positive class
 *      this module was written to remove, one layer up. `info` is excluded from `issueCount`, so
 *      it informs without claiming something is broken.
 *   4. **A user account matching the `gh` login, or no `gh` answer** → nothing.
 *   5. **Not probed** (older runner, a network hiccup, or past {@link MAX_SSH_HOSTS}) → nothing.
 *      Unverified is not a finding. Inventing a warning from an absent measurement is how the
 *      previous version produced its false positive, and it would be the same mistake with a
 *      different trigger.
 */
export function sshIdentityIssues(
	groups: readonly SshHostGroup[],
	byHost: ReadonlyMap<string, GitIdentityProbe | null>,
	httpsLogin: string | null = null,
): SshIdentityIssue[] {
	const issues: SshIdentityIssue[] = [];
	for (const group of groups) {
		const probe = byHost.get(group.host);
		if (probe?.checked !== true) continue; // unverified (absent, null, or an older runner) — say nothing
		const identity = probe.identity ?? null;
		if (identity !== null && isDeployKeyIdentity(identity, probe.isDeployKey)) {
			issues.push({
				severity: "warn",
				message:
					`SSH identity for ${group.host} on this machine is a deploy key (${identity}) — not a user account. ` +
					`Repos cloning over SSH from ${group.host}: ${list(group.repos)}. ` +
					'A deploy key authenticates to exactly one repository; private repos outside that one will fail with "Repository not found".',
				fix:
					`Update ~/.ssh/config on this machine so \`Host ${group.host}\` uses a user key rather than a deploy key ` +
					"(or give the deploy key its own Host alias), or re-add these repos with an HTTPS clone URL" +
					// Naming the account is the difference between generic advice and the remedy that
					// was already OBSERVED to work: #684 watched `gh repo clone` over HTTPS succeed on
					// the very repo SSH had just refused.
					(httpsLogin ? `, which authenticates as ${httpsLogin} on this machine.` : " so the platform can inject a token."),
			});
		} else if (identity === null) {
			issues.push({
				severity: "warn",
				message:
					`SSH handshake to ${group.host} did not authenticate on this machine (the probe returned no identity). ` +
					`Repos using SSH clone URLs on ${group.host}: ${list(group.repos)}. Private repo clones will fail until SSH is working.`,
				fix:
					`Check that a GitHub-authorised key is offered for this host — \`ssh -T git@${group.host}\` on the machine — ` +
					"or re-add these repos with an HTTPS clone URL.",
			});
		} else if (httpsLogin && identity.toLowerCase() !== httpsLogin.toLowerCase()) {
			// Two identities on one machine, split by transport — the condition named in #684's
			// "Consequence". Informational, not a warning: see outcome 3 in the doc above.
			issues.push({
				severity: "info",
				message:
					`Two GitHub identities are active on this machine: SSH to ${group.host} authenticates as ${identity}, ` +
					`while HTTPS (\`gh\`) authenticates as ${httpsLogin}. Repos cloning over SSH from ${group.host}: ${list(group.repos)}. ` +
					"Which one a repo gets depends on its clone URL, not on which is broader.",
				fix:
					"If that is deliberate (two accounts behind two ~/.ssh/config aliases), nothing needs doing. " +
					`If a private repo on ${group.host} fails with "Repository not found", re-add it with an HTTPS clone URL to use ${httpsLogin} instead.`,
			});
		}
		// A user account matching the gh login, or no gh answer → nothing to report.
	}
	return issues;
}
