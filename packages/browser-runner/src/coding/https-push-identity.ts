/**
 * Which identity plain `git push` over HTTPS actually uses, and whether it can push to a
 * specific repo (#1465) — a THIRD identity source, distinct from both `gh`'s own login
 * (`github-browse.ts`, #688) and the SSH identity probe (`repo.ts`, #684).
 *
 * The live failure: a GitHub App installation was correctly bound, and the repository was in
 * the session's registered write scope — `coding_diagnostics` reported both as fine. But the
 * machine's OS-level git credential helper (git-credential-manager, osxkeychain, …) independently
 * resolved a DIFFERENT, cached account for `git`'s own https transport, and nothing had ever
 * asked THAT credential whether it could push to THIS repo. Delivery discovered the 403 only
 * after implementation and tests were already done.
 *
 * `git credential fill` asks the machine's configured helper what it would hand `git` for a
 * host, without performing any git operation — the same question `git push` itself asks,
 * answered without pushing anything. The resolved password/token is used in memory for exactly
 * one GitHub API read per repo and is never returned, logged, or persisted: only the identity
 * (a login name) and a push boolean are safe to report.
 */
import { spawnSync } from "node:child_process";

export interface HttpsCredential {
	username: string;
	password: string;
}

/**
 * Never throws — the same contract {@link probeGitSshIdentity} in `repo.ts` has: a failure is
 * simply `null`, because a transparency probe must not become a reason the diagnostics endpoint
 * itself breaks.
 */
export function resolveHttpsCredential(host: string): HttpsCredential | null {
	let result: ReturnType<typeof spawnSync>;
	try {
		result = spawnSync("git", ["credential", "fill"], {
			input: `protocol=https\nhost=${host}\n\n`,
			encoding: "utf-8",
			timeout: 10_000,
			// A machine with no credential helper configured would otherwise wait on a terminal
			// prompt nobody sees, hanging this diagnostic probe — the same failure class
			// `push-guard.ts` guards the real push transport against (#1252).
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
	} catch {
		return null;
	}
	if (result.status !== 0) return null;
	const out = String(result.stdout ?? "");
	const username = /^username=(.*)$/m.exec(out)?.[1]?.trim();
	const password = /^password=(.*)$/m.exec(out)?.[1]?.trim();
	return username && password ? { username, password } : null;
}

export interface RepoPushCapability {
	repo: string;
	/** Whether THIS credential can push to THIS repo. `null` means undetermined — never guessed
	 *  from an absent or unexpected API answer. */
	pushable: boolean | null;
	reason?: string;
}

export interface HttpsPushCapabilityReport {
	/** The version marker every probe in this family carries (#684, #688) — absent on an older
	 *  runner, which means unverified, NOT "no problem". */
	checked: true;
	host: string;
	/** The account this machine's git https credential helper resolves — safe identity metadata
	 *  only. The credential VALUE never appears on this report. */
	identity: string | null;
	repos: RepoPushCapability[];
}

export interface HttpsPushCapabilityDeps {
	resolveCredential: (host: string) => HttpsCredential | null;
	/** Injectable so tests never make a real network call. `null` means the answer could not be
	 *  established (network error, non-200, no boolean `permissions.push` field) — never guessed. */
	checkPush: (credential: HttpsCredential, repo: string) => Promise<boolean | null>;
}

/** One read-only call per repo: `GET /repos/{owner}/{repo}` carries `permissions.push` for the
 *  authenticated credential. No push is attempted; nothing is written anywhere. */
async function checkPushLive(credential: HttpsCredential, repo: string): Promise<boolean | null> {
	try {
		const res = await fetch(`https://api.github.com/repos/${repo}`, {
			headers: {
				Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
				"User-Agent": "proagentstore-runner",
				Accept: "application/vnd.github+json",
			},
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { permissions?: { push?: unknown } };
		return typeof body.permissions?.push === "boolean" ? body.permissions.push : null;
	} catch {
		return null;
	}
}

export const liveHttpsPushCapabilityDeps: HttpsPushCapabilityDeps = { resolveCredential: resolveHttpsCredential, checkPush: checkPushLive };

/**
 * Resolves the credential ONCE, then checks every repo CONCURRENTLY — one `git credential fill`
 * call and one GitHub API read per repo, regardless of how many repos are named. Never throws.
 */
export async function probeHttpsPushCapability(
	host: string,
	repos: readonly string[],
	deps: HttpsPushCapabilityDeps = liveHttpsPushCapabilityDeps,
): Promise<HttpsPushCapabilityReport> {
	const credential = deps.resolveCredential(host);
	if (!credential) {
		return { checked: true, host, identity: null, repos: repos.map((repo) => ({ repo, pushable: null, reason: `no https credential is configured on this machine for ${host}` })) };
	}
	const repoResults = await Promise.all(
		repos.map(async (repo) => {
			const pushable = await deps.checkPush(credential, repo);
			const reason = pushable === false ? `${credential.username} can read ${repo} but not push to it` : pushable === null ? "could not be verified against the GitHub API" : undefined;
			return { repo, pushable, ...(reason ? { reason } : {}) };
		}),
	);
	return { checked: true, host, identity: credential.username, repos: repoResults };
}
