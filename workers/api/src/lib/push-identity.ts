/**
 * Turn the runner's `/coding/push-capability` answer into diagnostics issues (#1465).
 *
 * ── The gap this closes ──
 *
 * `coding_diagnostics` already reported a checkout as ready and a repository as in the
 * session's registered write scope — both true, both irrelevant to whether `git push` would
 * actually work. A GitHub App installation can be correctly bound (`gh`'s own login, #688,
 * agreeing), while the machine's OS-level git credential helper independently resolves a
 * DIFFERENT, cached identity for plain https — a third identity source neither the SSH probe
 * (#684) nor the `gh`-login probe (#688) ever asks about. That mismatch is invisible until
 * delivery fails with a 403, which is exactly the live incident #1465 was filed from.
 *
 * Pure so the attribution is testable without a network, a runner, or a D1 — the same reason
 * `ssh-identity.ts` exists as pure functions rather than inline route logic.
 */

/** The runner's `/coding/push-capability` answer. Every field but `checked` may be absent on an
 *  older runner — that is unverified, not "fine". */
export interface HttpsPushCapabilityProbe {
	checked?: boolean;
	host?: string;
	identity?: string | null;
	repos?: Array<{ repo: string; pushable: boolean | null; reason?: string }>;
}

/** One line on the diagnostics report. */
export interface PushCapabilityIssue {
	severity: "error" | "warn" | "info";
	message: string;
	fix: string;
}

/**
 * Three outcomes per repo the probe actually measured:
 *
 *   1. `pushable === false` → `error`. The repo is readable (the probe got a real answer from
 *      GitHub) but not writable by the credential plain `git push` will use. This is the live
 *      failure #1465 records: ready + in-scope + still cannot deliver.
 *   2. `pushable === true` → nothing. The credential that will push can.
 *   3. `pushable === null`, or the probe itself unverified (`checked` not `true`) → nothing.
 *      Unverified is not a finding — inventing a warning from an absent measurement is the exact
 *      mistake #684's own history (`ssh-identity.ts`) already removed once.
 *
 * Names the mismatch explicitly when the resolved identity disagrees with `gh`'s own login
 * (`httpsLogin`, #688) — the two-identities-per-transport condition this repo's bug actually
 * was, stated as fact rather than left for the reader to infer from two separate fields.
 */
export function pushCapabilityIssues(probe: HttpsPushCapabilityProbe | null | undefined, httpsLogin: string | null = null): PushCapabilityIssue[] {
	if (probe?.checked !== true) return [];
	const issues: PushCapabilityIssue[] = [];
	const mismatch = !!(httpsLogin && probe.identity && httpsLogin.toLowerCase() !== probe.identity.toLowerCase());
	for (const r of probe.repos ?? []) {
		if (r.pushable !== false) continue;
		issues.push({
			severity: "error",
			message:
				`This machine's git push credential${probe.identity ? ` (${probe.identity})` : ""} can read ${r.repo} but cannot push to it.` +
				(mismatch ? ` A different account (${httpsLogin}) is what gh/the GitHub App authenticates as — plain \`git push\` over HTTPS is not using it.` : ""),
			fix: mismatch
				? `Update this machine's git credential for ${probe.host ?? "github.com"} to ${httpsLogin} (\`gh auth setup-git\`, or clear the cached credential so git re-resolves it), then retry delivery.`
				: `Grant ${probe.identity ?? "this account"} push access to ${r.repo}, or deliver from a session whose credential already has it.`,
		});
	}
	return issues;
}

/** The repo-scope list `/coding/push-capability` is asked to check — `owner/repo` slugs only;
 *  a repo with no GitHub slug (a local-only checkout) has nothing to probe. */
export function pushCapabilityRepos(repos: ReadonlyArray<{ githubRepo?: string | null }>): string[] {
	return [...new Set(repos.map((r) => r.githubRepo).filter((r): r is string => !!r))];
}
