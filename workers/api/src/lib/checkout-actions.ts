/**
 * Stash and discard as first-class runner actions, and the pull-before-run auto-stash (#1324).
 *
 * A run stopped on a dirty tree — a fast-forward git refuses because an incoming commit touches a
 * changed file — waited for a person at the keyboard of THAT machine, and when the owner decided
 * "discard it" nothing could act on the decision. This module is the decision made remotely:
 *
 *   * {@link runCheckoutAction}: `stash` or `discard` on one repo's checkout, on the machine that
 *     holds it, each with a backup the machine records (`checkout-clean.ts` in the runner), each
 *     optionally followed by the fast-forward. Refused while anything is working in that checkout,
 *     and every way it cannot reach the machine is a NAMED failure, never silence.
 *   * {@link attemptSyncSelfHealWithStash}: the #802 self-heal, and — only when the owner approved it
 *     ({@link autoStashApproved}) — a stash of the blocking local changes and one more try. Without
 *     approval the refusal says what to do (the tool, the policy), not just that it failed.
 */
import { callRunner, getBoundRunnerConn, getRunnerConn, type RunnerConn } from "./runner-client.js";
import { describeOwner, repoOwners } from "./coding-ownership.js";
import { getRepo } from "./coding-store.js";
import { clipMarked } from "./clip-marked.js";
import { runnerUpgradeClause } from "./runner-upgrade.js";
import { isRunnerUnreachable } from "./runner-unreachable.js";
import { parseConfigBlob } from "./instance-config.js";
import { attemptSyncSelfHeal, type SyncHealOutcome } from "./repo-sync-gate.js";
import type { Env } from "../types.js";

/** The CLI release whose runner serves `/coding/checkout-clean`. Named in the refusal. */
export const CHECKOUT_CLEAN_MIN_CLI = "0.4.182";

/** Above the runner's own 30s pull cap plus the git work, so a slow fetch is reported rather than cut off. */
export const CHECKOUT_CLEAN_TIMEOUT_MS = 90_000;

export type CheckoutAction = "stash" | "discard";

/** What the runner reports, redeclared: `workers/api` does not depend on the runner package. */
export interface CheckoutCleanWire {
	ok: boolean;
	action: CheckoutAction;
	files: number;
	backup: { kind: "stash"; ref: string; commit: string } | { kind: "patch"; path: string; untrackedList: string; untracked: number } | null;
	head: string | null;
	clean: boolean;
	pulled: { changed: boolean; from: string | null; to: string | null; commits: number | null; refused?: string; error?: string } | null;
	error?: string;
}

/** Why an action did not run, as a value: `unreachable` is a machine problem, `busy` a live session, `old_runner` a CLI below the floor. */
export type CheckoutActionFailure = "no_repo" | "unreachable" | "busy" | "old_runner" | "refused" | "failed";

export type CheckoutActionOutcome =
	| { ok: true; action: CheckoutAction; machine: string | null; result: CheckoutCleanWire; summary: string }
	| { ok: false; reason: CheckoutActionFailure; machine: string | null; error: string; result?: CheckoutCleanWire };

/** A commit id for a sentence a person reads: eight characters, which is how git itself shortens it. An id is not prose, so it carries no cut marker. */
const shortSha = (sha: string | null | undefined): string | undefined => sha?.slice(0, 8);

export const checkoutLabel = (s: string): string => s.replace(/[^A-Za-z0-9 ._:#/@-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "pags";

/** One sentence for the owner: what was kept, where, and where the checkout stands now. */
export function describeCheckoutAction(action: CheckoutAction, r: CheckoutCleanWire): string {
	const verb = action === "stash" ? "Stashed" : "Discarded";
	if (r.files === 0) return `The checkout had no local changes, so nothing was ${action === "stash" ? "stashed" : "discarded"}.${r.pulled?.changed ? ` Fast-forwarded to ${shortSha(r.head)}.` : ""}`;
	const kept = !r.backup
		? ""
		: r.backup.kind === "stash"
			? ` Saved as \`${r.backup.ref}\` (${shortSha(r.backup.commit)}); \`git stash apply ${r.backup.commit}\` in that checkout brings it back.`
			: ` Backup patch: ${r.backup.path}${r.backup.untracked ? `; ${r.backup.untracked} untracked file${r.backup.untracked === 1 ? "" : "s"} listed in ${r.backup.untrackedList} (their contents were not kept)` : ""}.`;
	const pulled = r.pulled ? (r.pulled.error || r.pulled.refused ? ` The fast-forward did not run: ${r.pulled.error ?? r.pulled.refused}.` : r.pulled.changed ? ` Then fast-forwarded to ${shortSha(r.head)} (${r.pulled.commits ?? "?"} commit${r.pulled.commits === 1 ? "" : "s"}).` : " It was already current.") : "";
	return `${verb} ${r.files} changed file${r.files === 1 ? "" : "s"}.${kept}${pulled} The checkout is ${r.clean ? "clean" : "NOT clean"} at ${shortSha(r.head) ?? "an unknown commit"}.`;
}

/**
 * Stash or discard this repo's local changes on the machine that holds it. Never throws.
 * `node` names a machine; omitted, the instance's pinned machine is used.
 */
export async function runCheckoutAction(
	env: Env,
	input: { instanceId: string; userId: string; repoId: string; action: CheckoutAction; label: string; pull?: boolean; node?: string | null },
	deps: { conn?: RunnerConn | null; call?: typeof callRunner } = {},
): Promise<CheckoutActionOutcome> {
	const repo = await getRepo(env, input.instanceId, input.userId, input.repoId).catch(() => null);
	if (!repo) return { ok: false, reason: "no_repo", machine: null, error: `repo ${input.repoId} is not registered on this instance` };
	// Refused while anything is working in the checkout: stashing under a live engine would pull the files out from under it.
	const owner = (await repoOwners(env, { instanceId: input.instanceId, userId: input.userId, repoId: input.repoId }).catch(() => []))[0];
	if (owner) return { ok: false, reason: "busy", machine: input.node ?? null, error: `Refused: ${describeOwner(owner, repo.name)} Stop or wait for it, then try again — nothing was changed.` };
	const conn = deps.conn !== undefined ? deps.conn : input.node ? await getRunnerConn(env, input.instanceId, input.userId, input.node).catch(() => null) : await getBoundRunnerConn(env, input.instanceId, input.userId).catch(() => null);
	const machine = conn?.runnerNode ?? input.node ?? null;
	if (!conn) {
		return { ok: false, reason: "unreachable", machine, error: `${machine ? `The machine ${machine}` : "The machine that holds this checkout"} is not connected (offline, its \`pags up\` is not running, or it is not reachable), so the ${input.action} was not run and nothing was changed. Bring it online and try again.` };
	}
	try {
		const result = await (deps.call ?? callRunner)<CheckoutCleanWire>(
			conn,
			"/coding/checkout-clean",
			{ workDir: repo.workdir || undefined, repoId: repo.id, action: input.action, label: checkoutLabel(input.label), pull: input.pull === true, branch: repo.branch || undefined },
			{ timeoutMs: CHECKOUT_CLEAN_TIMEOUT_MS },
		);
		if (!result.ok) return { ok: false, reason: "failed", machine, error: `${result.error ?? "the machine reported a failure"} ${describeCheckoutAction(input.action, result)}`.trim(), result };
		return { ok: true, action: input.action, machine, result, summary: describeCheckoutAction(input.action, result) };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (/→ 404|not found/i.test(message)) return { ok: false, reason: "old_runner", machine, error: runnerUpgradeClause({ what: `${input.action} this checkout`, minCli: CHECKOUT_CLEAN_MIN_CLI, node: machine }) };
		if (isRunnerUnreachable(e)) return { ok: false, reason: "unreachable", machine, error: `${machine ? `The machine ${machine}` : "The machine"} went away before it answered (${clipMarked(message, 120, { within: true })}), so it is not known whether the ${input.action} ran. Read the checkout's state before retrying.` };
		return { ok: false, reason: /→ 400/.test(message) ? "refused" : "failed", machine, error: `The machine declined or failed the ${input.action}: ${clipMarked(message, 200, { within: true })}` };
	}
}

// ── Auto-stash on the pull-before-run self-heal ─────────────────────────────────────────────────

/**
 * Has the owner approved stashing a dirty checkout so a run can proceed (#1324)? Per instance
 * (`config.autoStashDirty`), or once for this run (`oneOff`, from the run's payload). Default off:
 * the platform never moves somebody's uncommitted work unless it was told it may.
 */
export function autoStashApproved(config: unknown, oneOff?: boolean): boolean {
	if (oneOff === true) return true;
	const blob = typeof config === "string" ? parseConfigBlob(config) : ((config as Record<string, unknown> | null) ?? {});
	return blob.autoStashDirty === true;
}

export async function readAutoStashPolicy(env: Pick<Env, "DB">, instanceId: string, userId: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ config: string | null }>().catch(() => null);
	return row ? autoStashApproved(row.config) : false;
}

/** Did the fast-forward fail because local changes are in its way? (git's own sentences, and the runner's `dirty` refusal.) */
export function blockedByLocalChanges(h: SyncHealOutcome): boolean {
	return (h.status === "failed" || h.status === "refused") && /would be overwritten|local changes|untracked working tree|uncommitted changes/i.test(h.detail);
}

/** The sentence a refusal carries when a heal was blocked by local changes and no approval exists — actionable, not just "failed". */
export const AUTO_STASH_HINT =
	"To let runs get past this by themselves, approve stashing (set `autoStashDirty` on the agent, or start the run with `autoStash: true`); to clear it now, use the `stash_checkout` tool (keeps the work) or `discard_checkout` (backs it up, then discards).";

/**
 * {@link attemptSyncSelfHeal}, and when local changes block it and the owner approved, stash them
 * (with a backup the machine records) and try once more. The outcome carries what was stashed so the
 * run can record it; without approval it carries {@link AUTO_STASH_HINT}. Never throws.
 */
export async function attemptSyncSelfHealWithStash(
	conn: RunnerConn,
	input: { repo: Parameters<typeof attemptSyncSelfHeal>[1]["repo"]; sessionId: string | null; branch: string; runLabel: string; approved: boolean },
	deps: { heal?: typeof attemptSyncSelfHeal; call?: typeof callRunner } = {},
): Promise<SyncHealOutcome> {
	const heal = deps.heal ?? attemptSyncSelfHeal;
	const first = await heal(conn, { repo: input.repo, sessionId: input.sessionId, branch: input.branch });
	if (!blockedByLocalChanges(first)) return first;
	if (!input.approved) return { ...first, detail: `${first.detail} ${AUTO_STASH_HINT}` };
	try {
		const stash = await (deps.call ?? callRunner)<CheckoutCleanWire>(
			conn,
			"/coding/checkout-clean",
			{ workDir: input.repo.workdir || undefined, repoId: input.repo.id, action: "stash", label: checkoutLabel(`auto ${input.runLabel}`), pull: false },
			{ timeoutMs: CHECKOUT_CLEAN_TIMEOUT_MS },
		);
		if (!stash.ok) return { ...first, detail: `${first.detail} Auto-stash was approved but did not complete: ${stash.error ?? "the machine reported a failure"}.` };
		const stashed: NonNullable<SyncHealOutcome["stashed"]> = { ref: stash.backup?.kind === "stash" ? stash.backup.ref : null, commit: stash.backup?.kind === "stash" ? stash.backup.commit : null, files: stash.files, summary: describeCheckoutAction("stash", stash) };
		const second = await heal(conn, { repo: input.repo, sessionId: input.sessionId, branch: input.branch });
		return { ...second, stashed };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		const why = /→ 404|not found/i.test(message) ? runnerUpgradeClause({ what: "stash this checkout itself", minCli: CHECKOUT_CLEAN_MIN_CLI, node: conn.runnerNode }) : `the machine ${isRunnerUnreachable(e) ? "went away" : "failed"}: ${clipMarked(message, 160, { within: true })}`;
		return { ...first, detail: `${first.detail} Auto-stash was approved but could not run — ${why}` };
	}
}
