/**
 * Syncing GitHub App installations into an account, and what of the result may be shown (#1081).
 *
 * Split from `github-app.ts`, which owns the App itself: tokens, the installation list, and the two
 * binding proofs. This file only ORCHESTRATES those proofs for an installation added after the last
 * Connect GitHub, and applies the account-isolation rule to what is reported. It mints nothing and
 * verifies nothing itself.
 */
import type { GithubInstallationCheckReason as InstallationCheckReason, GithubInstallationOutcome as InstallationOutcome, GithubInstallationSyncResponse } from "../agent-types.js";
import type { Env } from "../types.js";
import { cacheInstallationToken, checkInstallationOwnership, listInstallations, listUserInstallations, mintInstallationToken } from "./github-app.js";

export type InstallationSyncResult = Omit<GithubInstallationSyncResponse, "linkStart">;

/** Reasons that are about OTHER people's installations, and are never disclosed — not even counted. */
const UNDISCLOSED: ReadonlySet<InstallationCheckReason> = new Set(["not_member", "not_owner"]);

/**
 * What of a bind or a sync may be shown to THIS user (#1081) — account isolation.
 *
 * The App's installation list is every tenant's. Naming an installation this user is not part of
 * re-opens the enumeration `/v1/github/installations` closed. So an installation is NAMED only when
 * the user is in it (bound, already bound, would bind, or an invitation pending) or when the caller
 * NAMED it themselves (`owner`). Every other refusal is reported as a COUNT by reason — enough to say
 * "one organisation refused the membership read: oauth_app_restricted" — and "not a member" / "not
 * yours" are never reported at all. `app_cannot_read_members` is a property of the App, true for
 * every org at once, so it is a flag rather than a count of other tenants.
 */
export function disclosedOutcomes(
	outcomes: readonly InstallationOutcome[],
	owner?: string | null,
): { orgs: InstallationOutcome[]; unnamed: Partial<Record<InstallationCheckReason, number>>; appCannotReadMembers: boolean } {
	const named = owner?.trim().toLowerCase() || null;
	const orgs: InstallationOutcome[] = [];
	const unnamed: Partial<Record<InstallationCheckReason, number>> = {};
	let appCannotReadMembers = false;
	for (const o of outcomes) {
		const mine = o.result !== "not_bound" || o.reason === "membership_pending";
		if (mine || (named && o.account.toLowerCase() === named)) {
			orgs.push(o);
			continue;
		}
		if (!o.reason || UNDISCLOSED.has(o.reason)) continue;
		if (o.reason === "app_cannot_read_members") appCannotReadMembers = true;
		else unnamed[o.reason] = (unnamed[o.reason] ?? 0) + 1;
	}
	return { orgs, unnamed, appCannotReadMembers };
}

/** At most this many unbound installations are checked by one sync — each check mints a token. */
export const MAX_SYNC_CHECKS = 200;

/**
 * Bind the App installations this user controls but has no binding to yet (#1081) — the server-side
 * half of "Connect GitHub", for an org installed AFTER the last link.
 *
 * Uses the SAME proof `/v1/github/callback` accepts (`checkInstallationOwnership`, via the App's own
 * token): no new authority, no stored user token, no weakened check. `owner` narrows it to one
 * account and discloses that account's exact outcome. `dryRun` runs every check and writes nothing.
 */
export async function syncUserInstallations(env: Env, userId: string, opts: { owner?: string | null; dryRun?: boolean } = {}): Promise<InstallationSyncResult> {
	const owner = opts.owner?.trim() || null;
	const dryRun = opts.dryRun === true;
	const user = await env.DB.prepare("SELECT github_login, linked_github_login FROM users WHERE id = ?1")
		.bind(userId)
		.first<{ github_login: string | null; linked_github_login: string | null }>();
	const githubLogin = user?.linked_github_login ?? user?.github_login ?? null;
	const installs = await listInstallations(env);
	const existing = new Set((await listUserInstallations(env, userId)).map((i) => i.id));
	const candidates = owner ? installs.filter((i) => i.account.login.toLowerCase() === owner.toLowerCase()) : installs;
	const outcomes: InstallationOutcome[] = [];
	if (owner && candidates.length === 0) outcomes.push({ account: owner, type: "", installationId: 0, result: "not_installed" });
	let checked = 0;
	let truncated = false;
	let bound = 0;
	for (const inst of candidates) {
		const base = { account: inst.account.login, type: inst.account.type || "User", installationId: inst.id };
		if (existing.has(inst.id)) {
			outcomes.push({ ...base, result: "already_bound" });
			continue;
		}
		if (checked >= MAX_SYNC_CHECKS) {
			truncated = true;
			break;
		}
		checked++;
		const check = await checkInstallationOwnership(env, githubLogin, inst);
		if (!check.ok) {
			outcomes.push({ ...base, result: "not_bound", reason: check.reason, ...(check.status ? { status: check.status } : {}) });
			continue;
		}
		if (dryRun) {
			outcomes.push({ ...base, result: "would_bind" });
			continue;
		}
		const minted = await mintInstallationToken(env, inst.id).catch(() => null);
		if (!minted) {
			outcomes.push({ ...base, result: "not_bound", reason: "mint_failed" });
			continue;
		}
		await cacheInstallationToken(env, userId, inst.id, minted.token, minted.expiresAt, { login: inst.account.login, type: inst.account.type });
		bound++;
		outcomes.push({ ...base, result: "bound" });
	}
	return { githubLogin, owner, dryRun, ...disclosedOutcomes(outcomes, owner), bound, truncated };
}

