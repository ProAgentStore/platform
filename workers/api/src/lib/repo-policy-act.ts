/**
 * The acting half of standing policies (#322): ask the machine to restore ONE declared invariant,
 * then say what actually happened.
 *
 * ── The reporting standard, and why it has five answers and not two
 *
 * #408 landed a resume policy that reports what the cloud ASKED versus what the machine CONFIRMED,
 * because an old runner silently drops a field and "we sent it" is not "it happened". A write on
 * somebody's real checkout deserves at least that. So every remediation here ends in one of five
 * outcomes, and only ONE of them is allowed to say the repo was changed:
 *
 *   confirmed    the write returned AND an INDEPENDENT read-only `git status` says the checkout is
 *                on the target branch. This is the only outcome that closes the card, and the card
 *                it writes names the branch it came from and the command that undoes it.
 *   unconfirmed  the cloud asked and the machine did not corroborate — the socket went away, or the
 *                re-read disagrees. The violation card STAYS OPEN and says exactly that. Never
 *                reported as done.
 *   unsupported  the runner has no `/coding/git-write` (a CLI older than the one that shipped it).
 *                Named as an old runner WITH the version floor, not as a failure, because the fix is
 *                `npm i -g` and not debugging a repo.
 *   refused      the machine declined a precondition it checks for itself — most importantly a
 *                DIRTY tree. Nothing was touched.
 *   failed       git itself errored. Nothing was touched.
 *
 * ── What can never happen here
 *
 * There is exactly one verb (`switch_branch`) and it reaches exactly one fixed argv on the runner.
 * No commit, no push, no `checkout .`, no `reset`, no `clean`, and specifically no `git stash` —
 * the stash is repo-global ACROSS worktrees and is how uncommitted work gets swallowed. A policy
 * that cannot restore its invariant without destroying something reports and stops.
 *
 * ── And it never acts on a stale verdict
 *
 * The trigger is a finding computed from a read taken moments earlier in the same step. A repo row
 * can carry a five-day-old `clone_status` written by a dropped WebSocket (#440) — that column is
 * not consulted here, at all. If the fresh read fails, the finding is `unknown` and nothing acts:
 * a transport failure must never be able to move a branch.
 */
import { callRunner, READ_TIMEOUT_MS, type RunnerConn } from "./runner-client.js";
import { runnerUpgradeClause } from "./runner-upgrade.js";
import { isRunnerUnreachable } from "./runner-unreachable.js";
import { getRepo } from "./coding-store.js";
import { readRepoWorkingState } from "./repo-state.js";
import { evaluateRepoPolicies, repoPolicyDef, type RepoPolicyFinding, type RepoPolicyId, type RepoPolicyRemediation } from "./repo-policies.js";
import { closeWorkCards, upsertWorkCard } from "./work-card.js";
import { appendTimeline } from "./coding-timeline.js";
import { logEvent } from "./events.js";
import type { CodingRepo } from "./coding-types.js";
import type { Env } from "../types.js";

export type RepoPolicyActStatus = "confirmed" | "unconfirmed" | "unsupported" | "refused" | "failed";

export interface RepoPolicyActOutcome {
	status: RepoPolicyActStatus;
	/** What the cloud asked for. */
	requested: RepoPolicyRemediation;
	/** The branch the machine says it was on before. Null when it could not tell. */
	from: string | null;
	/** Where an INDEPENDENT read says the checkout is now. Null when that read failed. */
	observed: string | null;
	/** One clause naming the machine's own reason, when it gave one. */
	detail: string;
}

/**
 * The runner's reply, redeclared because `workers/api` does not (and should not) depend on the
 * runner package. Kept structurally identical to `SwitchBranchResult` in
 * `packages/browser-runner/src/coding/repo-write.ts`; every field is optional here, because a
 * runner of a different vintage is exactly the case this must survive.
 */
interface SwitchBranchWire {
	ok?: boolean;
	changed?: boolean;
	from?: string | null;
	to?: string;
	branch?: string | null;
	/** `null` from a runner that could not read `git status` back; absent from one before #291. */
	dirty?: boolean | null;
	refused?: string;
	error?: string;
}

/** The machine's refusal codes, in the owner's language. An unknown code is quoted, not hidden. */
const REFUSAL_TEXT: Record<string, string> = {
	dirty: "the working tree has uncommitted changes, which a checkout would carry across",
	"unknown-branch": "that branch does not exist in this checkout, and a policy never creates one",
	"not-a-repo": "the path is not a git checkout",
	"unknown-head": "git could not say which commit the checkout is on",
};

/** The CLI release that first serves `/coding/git-write`. Named on the card — "update the CLI"
 *  without a number is a version somebody has to go and find. */
export const SWITCH_BRANCH_MIN_CLI = "0.4.48";

/**
 * Classify a `callRunner` failure. Pure, because the difference between "your CLI is old" and "the
 * write failed" is the difference between a one-line fix and an investigation.
 *
 * The disconnect arm goes through `isRunnerUnreachable` rather than matching words: that module
 * owns the judgement, including the marker that survives a Workflow step boundary (which hands the
 * receiving side a message, not a prototype).
 */
export function classifyRunnerError(e: unknown, node?: string | null): { status: RepoPolicyActStatus; detail: string } {
	const message = e instanceof Error ? e.message : String(e);
	if (/→ 404|not found/i.test(message)) {
		// NAMES THE MACHINE (#524). It said "this machine", which an owner with two runners reads
		// as the one in front of him — and the remedy has to be run on the other one. The clause is
		// built by `lib/runner-upgrade.ts` so this and the repo-search refusal cannot drift into
		// two different accounts of the same fact; the caller passes `conn.runnerNode`, which it
		// already holds, so naming it costs no query.
		return { status: "unsupported", detail: runnerUpgradeClause({ what: "switch branch", minCli: SWITCH_BRANCH_MIN_CLI, node }) };
	}
	if (isRunnerUnreachable(e)) return { status: "unconfirmed", detail: "the machine went away before it answered" };
	return { status: "failed", detail: message.slice(0, 160) };
}

/**
 * Ask the machine to switch, then CONFIRM with a separate read-only status call.
 *
 * The confirmation is deliberately a different endpoint from the write: `/coding/git-write` reads
 * HEAD back itself, but a card that says "done" on the strength of the writer's own account of its
 * work is the failure #408 is about. The read-only path is the one every other surface trusts.
 */
export async function runRepoPolicyRemediation(
	conn: RunnerConn,
	input: { repo: CodingRepo; sessionId: string | null; remediation: RepoPolicyRemediation },
): Promise<RepoPolicyActOutcome> {
	const { repo, sessionId, remediation } = input;
	const base = { requested: remediation, from: null as string | null, observed: null as string | null };
	let wire: SwitchBranchWire;
	try {
		wire = await callRunner<SwitchBranchWire>(
			conn,
			"/coding/git-write",
			{ sessionId: sessionId || undefined, workDir: repo.workdir || undefined, cmd: "switch-branch", branch: remediation.branch },
			{ timeoutMs: READ_TIMEOUT_MS },
		);
	} catch (e) {
		return { ...base, ...classifyRunnerError(e, conn.runnerNode) };
	}
	const from = typeof wire.from === "string" ? wire.from : null;
	if (wire.refused) {
		return {
			...base,
			status: "refused",
			from,
			observed: from,
			detail: REFUSAL_TEXT[wire.refused] ?? `the machine refused (${String(wire.refused).slice(0, 40)})`,
		};
	}
	if (wire.error) return { ...base, status: "failed", from, observed: typeof wire.branch === "string" ? wire.branch : null, detail: wire.error.slice(0, 160) };

	// The independent read. A null here is NOT a failure of the switch — it is the absence of
	// corroboration, which is `unconfirmed`, because nothing may report a change it cannot see.
	const after = await readRepoWorkingState(conn, { repo, sessionId }).catch(() => null);
	const observed = after?.branch ?? null;
	if (observed && observed === remediation.branch) {
		return { ...base, status: "confirmed", from, observed, detail: "" };
	}
	return {
		...base,
		status: "unconfirmed",
		from,
		observed,
		detail: observed ? `the checkout still reads \`${observed}\`` : "the checkout could not be read back",
	};
}

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 300;

/**
 * Turn an outcome into the card the human reads. Pure.
 *
 * The rule the ticket names as its acceptance criterion — "why is there a new branch?" answerable
 * without reading a diff — is stronger for an action than for an observation: the card says what
 * was done AND the command that undoes it. Only `confirmed` closes; every other outcome leaves the
 * violation card open, because the invariant still does not hold.
 */
export function describeRepoPolicyAct(
	policy: RepoPolicyId,
	repoLabel: string,
	outcome: RepoPolicyActOutcome,
): { status: "completed" | "needs_human"; title: string; description: string; type: string } {
	const def = repoPolicyDef(policy);
	const type = def?.cardType ?? "coding.policy";
	const attribution = ` (standing policy \`${policy}\`)`;
	const clip = (s: string) => `${s.slice(0, Math.max(0, MAX_DESCRIPTION - attribution.length))}${attribution}`;
	const to = outcome.requested.branch;
	if (outcome.status === "confirmed") {
		const undo = outcome.from ? ` Undo: \`git checkout ${outcome.from}\`.` : "";
		const was = outcome.from ? `Was on \`${outcome.from}\`.` : "";
		return {
			status: "completed",
			type,
			title: `Switched ${repoLabel} back to ${to}`.slice(0, MAX_TITLE),
			// "nothing came with it" is the load-bearing half: it is why this was safe to do
			// unattended, and it is what the reader needs in order to trust the next one.
			description: clip(`${was} The tree was clean, so nothing came with it.${undo}`),
		};
	}
	const asked = `Asked this machine to switch ${repoLabel} back to \`${to}\`; it did not happen`;
	return {
		status: "needs_human",
		type,
		title: `${repoLabel} is not on ${to}`.slice(0, MAX_TITLE),
		description: clip(`${asked} — ${outcome.detail || outcome.status}. Nothing was changed.`),
	};
}

/**
 * The run-end hook, whole: read the checkout, judge every declared invariant, act on the ones the
 * owner promoted, and leave the board saying what is true.
 *
 * Lives here rather than in `workflows/coding-session.ts` so the workflow keeps one line about it
 * and the decisions keep their tests. Best-effort throughout — a policy that cannot be evaluated is
 * a visibility problem, and failing the run that triggered it would be strictly worse.
 */
export async function enforceRepoPolicies(
	env: Env,
	opts: { conn: RunnerConn; instanceId: string; userId: string; repoId: string; repoLabel: string; sessionId: string | null },
): Promise<RepoPolicyFinding[]> {
	const { conn, instanceId, userId, repoId, repoLabel, sessionId } = opts;
	const repo = await getRepo(env, instanceId, userId, repoId).catch(() => null);
	if (!repo) return [];
	// Unknown ≠ clean. A null state still evaluates, because a policy the repo has STOPPED claiming
	// must have its card closed whether or not the machine answered.
	const state = await readRepoWorkingState(conn, { repo, sessionId }).catch(() => null);
	// The repo ROW's branch, not the run payload's: a write's target has to be the declaration as it
	// stands now, and a run started hours ago carries a snapshot of it.
	const configuredBranch = (repo.branch || "").trim() || null;
	const findings = evaluateRepoPolicies({ repoId, repoLabel, declared: repo.policies, state, configuredBranch });
	const now = new Date().toISOString();
	for (const f of findings) {
		if (f.status === "violated" && f.remediation) {
			const remediation = f.remediation;
			const outcome = await runRepoPolicyRemediation(conn, { repo, sessionId, remediation }).catch(
				(e): RepoPolicyActOutcome => ({ requested: remediation, from: null, observed: null, ...classifyRunnerError(e, conn.runnerNode) }),
			);
			const card = describeRepoPolicyAct(f.policy, repoLabel, outcome);
			await upsertWorkCard(env, {
				instanceId,
				userId,
				id: f.cardId,
				task: { id: f.cardId, ...card, status: card.status, policy: f.policy, act: outcome.status, createdAt: now, updatedAt: now },
			});
			// …and in the RUN LOG, which is #322's other acceptance surface: "why is there a new
			// branch" has to be answerable from the trace, not only from a board card somebody may
			// have already closed. `agent_events` is the one every debugging path already reads
			// (GET /trace, MCP `agent_trace`), and unlike the timeline it does not need a session.
			await logEvent(env, {
				source: "coding",
				event: "policy.act",
				level: outcome.status === "confirmed" ? "info" : "warn",
				userId,
				instanceId,
				traceId: sessionId,
				message: `standing policy \`${f.policy}\`: ${card.title}`,
				context: { policy: f.policy, repoId, verb: remediation.verb, branch: remediation.branch, status: outcome.status, from: outcome.from, observed: outcome.observed, detail: outcome.detail },
			});
			// The session conversation gets it too, when there is one — that is where the human was
			// looking when it happened.
			if (sessionId) {
				await appendTimeline(env, {
					sessionId,
					instanceId,
					userId,
					type: "system",
					content: `standing policy \`${f.policy}\`: ${card.title} — ${card.description}`,
				}).catch(() => undefined);
			}
			continue;
		}
		if (f.status === "violated" && f.card) {
			await upsertWorkCard(env, {
				instanceId,
				userId,
				id: f.cardId,
				task: { id: f.cardId, ...f.card, status: "needs_human", policy: f.policy, createdAt: now, updatedAt: now },
			});
		} else if (f.status === "held" || f.status === "unclaimed") {
			await closeWorkCards(env, instanceId, userId, [f.cardId], "completed");
		}
	}
	return findings;
}
