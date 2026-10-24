// "Work on this objective autonomously" — one verb, one row, many drivers (#210).
//
// The platform had TWO ways to start autonomous work and they were reachable by different people:
//
//   • a supervisor calling `delegate_goal` got the RIGHT driver, because `delegate-instance.ts`
//     had `if (workflow === "CODING_SESSION") delegateToPilot() else AGENT_LOOP`
//   • the OWNER, pressing Loop in their own chat, always got AGENT_LOOP — the chat loop — even on
//     an agent whose chat has no write tools at all (`drive:false`), where it can only read in a
//     circle and never act
//
// So the dispatch already existed; it just wasn't reachable from the one place a human types. This
// turns that `if` into a table and points BOTH callers at it.
//
// The key fact that makes one Loop button possible: EVERY driver opens an `agent_loop_runs` row.
// That is the run record `check_delegation`, `subordinate_status` and the console's `/loop/:runId`
// poll all read, so the UI, the supervisor and the API need no idea which driver actually ran.
//
// Adding an agent type is an entry here — not a route change, not a button, not a branch in the
// console. And when `capabilities.workflow` is finally retired in favour of composed steps
// (docs/agent-platform-strategy.md), this is the single place that has to learn the new form.
import type { ObjectiveOrigin } from "./coding-objective-origin.js";
import { createLoopRun, finishLoopRun } from "./agent-loop-store.js";
import { linkRunToIssue } from "./issue-tickets.js";
import { MAX_ITERATIONS_CAP, sanitizeMaxIterations } from "./agent-loop.js";
import { resolveAccountCeilings } from "./delegation-budget-store.js";
import { clampIterations, hasLoopLimits, PILOT_DEFAULT_MAX_STEPS, type LoopLimitsConfig } from "./loop-limits.js";
import { readLoopLimits } from "./loop-limits-store.js";
import { delegationTaskRecord } from "./delegation.js";
import { claimSessionDriver, endSession, listRepos, releaseSessionDriver } from "./coding-store.js";
import { ensureActiveSession } from "./coding-session-open.js";
import { admitRepoForRun } from "./coding-repo-admission.js";
import { releaseRecoveryClaim, resolveRepoHandoff } from "./coding-handoff-store.js";
import { referencedIssue } from "./objective-dedupe.js";
import { checkWorkdirVia } from "./coding-workdir.js";
import { cloneSourceFor } from "./git-providers.js";
import { callRunner, getBoundRunnerConn, getRunnerConn } from "./runner-client.js";
import { pausedStartRefusal } from "./instance-pause.js";
import { describeOwner, repoFreeForRun, repoOwners, runnerEngineProbe } from "./coding-ownership.js";
import { codingRunRefusal } from "./billing.js";
import { noSessionMessage } from "./coding-session-lifecycle.js";
import { noteUnmeteredHeadlessDrive } from "./engine-metering.js";
import { recordEngineAuthRefusal } from "./engine-auth-refusal.js";
import { classifySubordinateConnectivity } from "./subordinate-connectivity.js";
import { EMPTY_RUNTIME_FACTS, runtimeConnectivity } from "./instance-connectivity.js";
import { checkJobCapabilityRequirements } from "./machine-capabilities.js";
import { currentGateState, DEFAULT_GATE_STATE, describeRejection, rejectionFor } from "./runner-admission-gate.js";
import type { AgentCapabilities } from "./agent-capabilities.js";
import { checkStartIdempotency, quarantineRefusal, startIssueFor } from "./start-idempotency.js";
import type { Env } from "../types.js";

/**
 * How many iterations this run actually gets: the caller's request, the account's ceiling (#477)
 * and the instance's own bounds (#820), in that order of authority.
 *
 * Resolved HERE and not only at the routes, because the routes are not the only way in. A
 * supervisor's `delegate_goal` reaches `start()` having named no number at all, and #820's whole
 * premise is that the floor must not depend on whoever is calling — an owner who sets 30 on their
 * Coder means 30 whether the run was started from the console, from chat, from the objective
 * queue, or by another agent. The routes clamp too, so that the number they REPORT back is the
 * number that will run; both clamps are the same function over the same inputs, so the second is
 * idempotent rather than a second opinion.
 */
async function boundedIterations(input: LoopStartInput): Promise<{
	maxIterations: number;
	limits: LoopLimitsConfig;
	ceiling: number;
}> {
	const [limits, ceilings] = await Promise.all([
		readLoopLimits(input.env, input.instanceId, input.userId).catch(() => ({}) as LoopLimitsConfig),
		resolveAccountCeilings(input.env, input.userId).catch(() => ({ loopMaxIterations: MAX_ITERATIONS_CAP })),
	]);
	const ceiling = ceilings.loopMaxIterations;
	return {
		limits,
		ceiling,
		maxIterations: clampIterations(sanitizeMaxIterations(input.maxIterations, ceiling), limits, ceiling),
	};
}

export interface LoopStartInput {
	env: Env;
	instanceId: string;
	userId: string;
	objective: string;
	maxIterations?: number;
	budgetId: string;
	/** Depth in the supervision tree. 0 when the owner starts it from their own chat. */
	depth: number;
	/**
	 * WHICH repository, for a driver that has more than one to choose from (#374).
	 *
	 * Absent means "you pick", which is what a supervisor delegating a goal has always meant — it
	 * knows an agent, not a checkout. The Coding tab knows exactly which repo the user is looking
	 * at, and on a multi-repo Coder `repos[0]` is simply the wrong engine to drive.
	 */
	repoId?: string;
	/**
	 * Refuse, rather than pick, when `repoId` is absent and the agent has more than one repo (#877).
	 *
	 * Opt-in because "absent means you pick" is still the right contract for the callers that know an
	 * agent and not a checkout — a supervisor's `delegate_goal`, the queue drainer, the console's
	 * instance-page Loop. `coding_loop_start` sets it: an MCP caller CAN name the repo, and a run on a
	 * multi-repo instance that silently lands on whichever repo was touched last is the bug #877 reports.
	 */
	requireRepoChoice?: boolean;
	/**
	 * The GitHub issue this run works on (#895), when the caller knows it — `coding_loop_start`'s `issue`,
	 * or a ticket that IS an issue. Absent, the objective's own subject is used. Coding driver only.
	 */
	issue?: number;
	/**
	 * Open an observable "Delegated: …" board card. Only a SUPERVISOR's run gets one — an owner
	 * pressing Loop on their own agent was not delegated to by anybody, and a card that says so
	 * would be a lie. Their coding run is already on the board as its session card (#206).
	 */
	delegated?: boolean;
	/**
	 * Which supervisor asked for this — AUDIT ONLY, never an authority (#185, and see
	 * `lib/execution-authority.ts`). Threaded into the chat loop so a delegated turn records who
	 * it was acting for. It lived only in `delegate-instance.ts`'s own AGENT_LOOP call, which is
	 * how it would have gone missing the moment that duplicate was folded into this table.
	 */
	onBehalfOf?: string;
	/**
	 * Where the platform VERIFIED `objective` came from (#1019) — a submission through the owner's
	 * authenticated account, a supervisor's delegation, a trigger's composition. Never a claim about who
	 * typed it. Absent means unverified, and the engine is told exactly that.
	 */
	objectiveOrigin?: ObjectiveOrigin;
	/**
	 * Start a REPAIR run (#804): the sync gate lets it through and the Pilot's objective becomes
	 * the platform's repair brief — bring the checkout back in sync without discarding anything.
	 * Only the coding driver knows what a checkout is; the route refuses it for any other.
	 */
	repairCheckout?: boolean;
	/**
	 * How far back this run's resume note may look for the run it continues (#806 item 4).
	 *
	 * Set only by `POST /:id/loop/:runId/continue`, where a human named one stopped run and the
	 * default six-hour floor would brief the successor on nothing. Threaded rather than decided
	 * here because only the workflow composes the note, and only the route knows a human chose.
	 * The chat driver ignores it: a chat loop has no repository and no resume note to widen.
	 */
	resumeLookbackMs?: number;
	/**
	 * The run this one explicitly continues (#984) — set by `POST /:id/loop/:runId/continue`.
	 *
	 * It is the owner naming the work they are picking back up, which is what lets a continue inherit
	 * an interrupted run's uncommitted checkout when that run had no issue to match on. Any other
	 * caller leaves it absent: inheriting a tree must be a statement, never an inference.
	 */
	continueFromRunId?: string;
	/** Start although the issue is closed or was finished recently (#1253). Needs `forceReason`; never overrides a run in flight. */
	force?: boolean;
	/** Why — posted as a comment on the issue. */
	forceReason?: string;
	/**
	 * What the machine must be able to do (#1312): `webkit`, `node>=22`, `wrangler`, `docker`… Checked against the
	 * machine's reported capability record before anything starts; a machine that cannot meet them refuses the run
	 * with each missing thing named, and waiting does not fix it.
	 */
	requires?: string[];
}

export type LoopStartResult =
	| { ok: true; runId: string; driver: string }
	| {
			ok: false;
			status: number;
			error: string;
			/**
			 * WHICH 409 this is, for the callers that must tell them apart (#788).
			 *
			 * `busy` is the single-flight claim below: a run is in flight and waiting is a real
			 * remedy. Every other refusal at this status — no repo on the agent, no runner, a
			 * checkout that failed admission — is structural, and waiting fixes none of them. The
			 * objective queue turns on exactly that distinction: `queue_if_busy` on a `busy` refusal
			 * parks the objective until the lock clears, while parking it on "this agent has no
			 * repository yet" would queue work that can never drain.
			 *
			 * `recovery_required` (#984) is the second waitable one: the repo holds work owned by a run
			 * the platform closed, or an engine still executing a dead run's instruction. Waiting IS
			 * the remedy — a person recovers it, or a run for that same issue continues it — so a
			 * queued objective must keep its place rather than fail. See {@link startRefusalIsWaitable}.
			 *
			 * `runner_offline` (#1161) is the third: the agent's machine is not connected. A closed lid or
			 * a night away is transient, so a queued objective waits for it — and is drained when the
			 * machine's relay connects again (`routes/relay.ts`) — instead of failing and stranding the
			 * rest of the queue behind it.
			 *
			 * `runner_overloaded` (#1264) is the fourth: the machine is connected but past its admission
			 * gate's thresholds (CPU, memory, disk or session count) — see `runner-admission-gate.ts`.
			 * Nothing fixes it by itself the way a reconnect does; it is waited on a TIMED backoff
			 * instead (`objective-queue.ts`'s `next_retry_at`), which only this reason sets.
			 *
			 * Absent rather than `"other"`: a driver that has not thought about this question should
			 * not be able to answer it by accident.
			 */
			reason?: "busy" | "engine_auth" | "recovery_required" | "paused" | "runner_offline" | "runner_overloaded" | "capability_missing" | "duplicate" | "issue_closed" | "already_done" | "quarantined";
			/** Set with `duplicate` / `issue_closed` / `already_done` (#1253): the prior run, issue and times. */
			detail?: Record<string, unknown>;
			/**
			 * Set with `reason: "engine_auth"` (#891): the refused run was RECORDED, finished with that
			 * stop reason, so sign-in tooling can find it and `continue` can pick it back up.
			 */
			runId?: string;
	  };

/**
 * Is this refusal one that WAITING fixes?
 *
 * Three callers have to tell waitable from structural — `queue_if_busy` on the start route, the
 * ticket queue's release-vs-refuse, and the objective queue's requeue-vs-fail — and each one wrote
 * `reason === "busy"` by hand. #984 added a second waitable reason, which is exactly the shape of
 * change that leaves two of three call sites behind, so the question is asked in one place.
 */
export function startRefusalIsWaitable(reason: string | undefined): boolean {
	// `paused` (#1015): the owner switched the agent off; resuming it is what unblocks the entry.
	// `runner_offline` (#1161): the machine is away; its relay reconnecting drains the queue.
	// `runner_overloaded` (#1264): the machine is over its admission gate's thresholds; a timed
	// backoff retries it as the metric recovers — see `objective-queue.ts`'s `next_retry_at`.
	return reason === "busy" || reason === "recovery_required" || reason === "paused" || reason === "runner_offline" || reason === "runner_overloaded";
}

export interface LoopDriver {
	/** Stable id, for logs and the `driver` field callers get back. */
	id: string;
	/** What this driver actually does, in the words a user would use. */
	label: string;
	start(input: LoopStartInput): Promise<LoopStartResult>;
}

/**
 * Loop the agent's CHAT: think, call tools, decide whether to continue. The default, and the right
 * one for any agent whose work happens through its own tools — a pipeline agent, a doc agent, a
 * connector agent.
 */
const chatDriver: LoopDriver = {
	id: "chat",
	label: "its own chat and tools",
	async start(input) {
		const runId = crypto.randomUUID();
		const { maxIterations } = await boundedIterations(input);
		await createLoopRun(input.env, {
			runId,
			userId: input.userId,
			instanceId: input.instanceId,
			objective: input.objective,
			maxIterations,
			budgetId: input.budgetId,
			startedAt: Date.now(),
			// #318: the run record is the only thing a supervisor can later read back, and its runs
			// are never on its own instance. Recorded on EVERY driver for the same reason every
			// driver opens a run row at all — a supervisor must not have to know which one ran.
			delegatedBy: input.onBehalfOf ?? null,
		});
		try {
			await input.env.AGENT_LOOP.create({
				id: runId,
				params: {
					runId,
					instanceId: input.instanceId,
					userId: input.userId,
					objective: input.objective,
					maxIterations,
					budgetId: input.budgetId,
					depth: input.depth,
					onBehalfOf: input.onBehalfOf,
				},
			});
		} catch (err) {
			// The row is opened BEFORE the workflow exists, so a create that throws used to leave a
			// run stuck at `running` for ever: every reader reported the agent as busy, and the stale
			// sweep (#207C) was the only thing that ever closed it. A caller retrying — the #968
			// wake-up does, through the outbox — would then be told "already taking a turn" by the
			// wreckage of its own last attempt. Close it here, then rethrow: the caller still learns
			// the start failed, and nothing is left claiming to run.
			await finishLoopRun(input.env, runId, "failed", `the run could not be started: ${err instanceof Error ? err.message : String(err)}`, Date.now()).catch(() => undefined);
			throw err;
		}
		return { ok: true, runId, driver: chatDriver.id };
	},
};

export type LoopRepoChoice<T> = { ok: true; repo: T } | { ok: false; error: string };

/**
 * Which repo a coding run is for, and what to say when there isn't one.
 *
 * Pure, because it is a DECISION with two distinct failure messages and it used to be `repos[0]`.
 * That was correct for the only caller it had (a supervisor delegating to an agent), and wrong the
 * moment the Coding tab's Loop started coming through here (#374): a multi-repo Coder open on its
 * third repo would have handed the objective to its first, claimed THAT session's driver, and
 * driven an engine the user was not looking at.
 *
 * A named repo that is not on this agent is refused rather than falling back to the first one.
 * Silently working the wrong repository is exactly the outcome a fallback produces, and it is not
 * recoverable — the engine has already edited a checkout nobody asked it to touch.
 */
export function pickLoopRepo<T extends { id: string; name?: string }>(
	repos: readonly T[],
	repoId?: string | null,
	opts: { requireChoice?: boolean } = {},
): LoopRepoChoice<T> {
	if (!repoId) {
		if (!repos[0]) return { ok: false, error: "This coding agent has no repository yet — add one on its Coding tab first." };
		// #877: more than one, and the caller said it would choose — list them instead of guessing.
		if (opts.requireChoice && repos.length > 1) {
			return { ok: false, error: `This agent has ${repos.length} repositories, so the run needs a repo_id to say which one. Registered: ${repoList(repos)}.` };
		}
		return { ok: true, repo: repos[0] };
	}
	const found = repos.find((r) => r.id === repoId);
	return found
		? { ok: true, repo: found }
		: { ok: false, error: `That repository (${repoId}) is not on this agent — reload the Coding tab and try again. Its repositories: ${repoList(repos) || "none"}.` };
}

/** `id (name)` per repo — the id is what a caller passes back, the name is how a person recognises it. */
function repoList(repos: readonly { id: string; name?: string }[]): string {
	return repos.map((r) => (r.name ? `${r.id} (${r.name})` : r.id)).join(", ");
}

/**
 * Drive the coding ENGINE through the durable Pilot.
 *
 * For a Repo Coder this is the only driver that can do anything: its chat declares `drive:false`
 * because its Lead steers it, so looping the chat would read files forever and change nothing.
 */
const codingDriver: LoopDriver = {
	id: "coding",
	label: "the coding engine on its repo",
	async start(input) {
		const { env, instanceId, userId, objective } = input;
		const repos = await listRepos(env, instanceId, userId).catch(() => []);
		const chosen = pickLoopRepo(repos, input.repoId, { requireChoice: input.requireRepoChoice });
		if (!chosen.ok) return { ok: false, status: 409, error: chosen.error };
		const repo = chosen.repo;
		// One unit of work, started once (#1253): the same issue in this repo is not worked twice, whichever
		// path started it. A repair and an explicit continue are the deliberate exceptions.
		if (input.repairCheckout !== true && !input.continueFromRunId) {
			const refused = await checkStartIdempotency(env, { userId, instanceId, repo: { id: repo.id, githubRepo: repo.githubRepo ?? null }, objective, issue: input.issue, force: input.force, forceReason: input.forceReason });
			if (refused) return { ok: false, status: 409, reason: refused.reason, error: refused.error, detail: refused.detail };
		} else if (input.repairCheckout !== true) {
			// A continue (auto-resume included) skips the duplicate/done checks, but not the per-issue hard stop (#1336).
			const githubRepo = repo.githubRepo ?? null;
			const issue = startIssueFor({ issue: input.issue, objective, githubRepo });
			const stopped = issue == null ? null : await quarantineRefusal(env, { userId, githubRepo, repoId: repo.id, issue });
			if (stopped) return { ok: false, status: 409, reason: stopped.reason, error: stopped.error, detail: stopped.detail };
		}
		// Connectivity FIRST, and from the same resolver delegation itself uses — so the refusal
		// names the real blocker. The old code went straight to "no live session" and appended
		// "(and run `pags up`)" unconditionally, which fired with the runner connected and
		// heartbeating and sent a real user chasing a runner that was already up (#271).
		const facts = await runtimeConnectivity(env, instanceId, userId).catch(() => null);
		const connectivity = classifySubordinateConnectivity({
			// This driver only ever runs for `workflow: "CODING_SESSION"`, which by definition has
			// local hands — so a runner is required, unconditionally.
			requiresRunner: true,
			// SPREAD, never enumerate (#468) — see `EMPTY_RUNTIME_FACTS`. Enumerating here is what
			// left `start_work` and the Loop button prescribing `pags up --force` to an owner whose
			// agent is pinned to a machine that is switched off.
			...(facts ?? EMPTY_RUNTIME_FACTS),
		});
		if (!connectivity.canWork) {
			// Only the MACHINE being away is waitable (#1161); a runner that is attached but blocked by the budget ceiling is not.
			const reason = connectivity.state === "attached" ? undefined : ("runner_offline" as const);
			return { ok: false, status: 409, error: noSessionMessage({ repoName: repo.name, connectivity }), ...(reason ? { reason } : {}) };
		}

		// The admission gate (#1264): the machine IS reachable, but every heartbeat re-judges it
		// against CPU/memory/disk/session thresholds (`runner-admission-gate.ts`, `updateGateState`),
		// and this reads that verdict — no re-sampling here, just the state the last heartbeat wrote.
		// AFTER connectivity (a dead machine's stale gate state would be a wrong reason for the real
		// blocker) and BEFORE the checkout/handoff checks below, which would needlessly touch a repo
		// on a machine this run should not land on at all. Never reached for a run already under way:
		// this driver's `start` is only called to BEGIN an objective, and an admitted one keeps
		// running — the gate controls admission, never a session already open.
		if (facts?.node) {
			const gate = await currentGateState(env, instanceId, userId, facts.node).catch(() => DEFAULT_GATE_STATE);
			const rejection = rejectionFor(gate, facts.node);
			if (rejection) return { ok: false, status: 409, reason: "runner_overloaded", error: describeRejection(rejection), detail: { ...rejection } };
		}

		// Capability requirements (#1312), after the machine is known to be reachable and not overloaded: the run names what
		// it needs (WebKit, a Node version, a CLI) and the machine's own record answers. Fail fast, naming each missing thing —
		// not waitable, because a laptop that cannot launch WebKit will not be able to in ten minutes.
		if (input.requires?.length) {
			const machine = facts?.node ? await env.DB.prepare("SELECT machine_id FROM instance_runtime_nodes WHERE instance_id = ?1 AND runner_node = ?2").bind(instanceId, facts.node).first<{ machine_id: string | null }>().catch(() => null) : null;
			const verdict = await checkJobCapabilityRequirements(env, userId, machine?.machine_id ?? null, input.requires);
			if (!verdict.ok) return { ok: false, status: 409, reason: "capability_missing", error: `This machine cannot run the job: ${verdict.failures.join("; ")}. Pin the agent to a machine that can, or install what is missing.`, detail: { failures: verdict.failures } };
		}

		// Is the CHECKOUT usable? (#548)
		//
		// The fourth admission check, and the one that was missing: a machine being reachable says
		// nothing about the folder on it. `~/dev/aipa` has no `.git`, the row said so
		// (`needs_attention`, written by a probe that actually looked), and three `git pull` runs
		// were admitted onto it anyway — 45 minutes and nine BYOK decisions to arrive at "stuck not
		// resolved in time", while the platform held the sentence "not inside a git working tree"
		// in D1 the whole time.
		//
		// AFTER connectivity, deliberately. With the machine off, a `needs_attention` verdict may
		// be days stale and the runner diagnosis is both truer and more actionable; leading with
		// the repo verdict there would send an owner to inspect a folder on a laptop that is shut.
		// With the machine up, the verdict IS the live blocker and is said first.
		//
		// The gate is on the RUN, not on the session. The incident's session was `alive: true` —
		// reattached, reused and useless — so gating only the OPENING of a new session would have
		// admitted all three of those runs.
		//
		// A stored verdict that condemns the path is re-asked once of the machine about to run
		// (#828): if the checkout there is absent or empty and the repo names a source, the session
		// start below clones into it — for an unpinned instance that is simply a machine that has
		// never cloned this repo, and refusing sent the owner to clone it by hand.
		let admission = admitRepoForRun(repo);
		if (!admission.ok && repo.workdir && cloneSourceFor(repo)) {
			const conn = await getBoundRunnerConn(env, instanceId, userId).catch(() => null);
			const live = conn ? await checkWorkdirVia(conn, repo.workdir) : null;
			admission = admitRepoForRun(repo, live);
		}
		if (!admission.ok) return { ok: false, status: 409, error: admission.message };

		// Whose work is in that checkout, and is the previous engine actually stopped? (#984)
		//
		// The fifth admission check, and the one the #978/#982 incident needed: a repo can be
		// reachable, its session `active`, no row `running` and its checkout present, and STILL be
		// mid-handover. The sweeper closes a run that stopped heartbeating without ever asking the
		// machine whether the engine stopped or what the tree holds, and `claimSessionDriver` treats
		// a heartbeat older than fifteen minutes as takeable — so the next objective was admitted
		// into a live CLI that was still being told to commit, push and close the PREVIOUS issue.
		//
		// BEFORE `ensureActiveSession`, deliberately: opening (or cloning into) a session for a run
		// that must not start is the litter the claim path below already warns about, and the claim
		// may belong to a session that is already ended while the checkout it dirtied is the one this
		// run would use. The check is on the REPO for that reason, not on the session.
		//
		// It refuses the HANDOVER and never the work: see `coding-handoff.ts` for why nothing here
		// resets, stashes or commits anything, and for the two ways out that preserve it.
		const handoff = await resolveRepoHandoff(env, {
			instanceId,
			userId,
			repo,
			incoming: {
				// The caller's explicit issue, else the objective's own subject — the SAME reading
				// `linkRunToIssue` makes, so what the run will be attributed to is what decides
				// whether it may inherit this checkout.
				issue: input.issue ?? referencedIssue(objective),
				repair: input.repairCheckout === true,
				continueFromRunId: input.continueFromRunId ?? null,
			},
		});
		if (!handoff.admit) return { ok: false, status: 409, reason: "recovery_required", error: handoff.detail };

		// A direct turn already holding this checkout refuses the run BEFORE a session is opened (#1015).
		// The check below needs the session it is about to use, so it ran after `ensureActiveSession`
		// had already launched an engine — one per refused attempt, each left running when the refusal
		// closed only its row. With no session named, only a direct claim blocks here; a run or driver
		// is still the post-open check's and `claimSessionDriver`'s to answer.
		const knownOwner = await repoFreeForRun(env, { instanceId, userId, repoId: repo.id, sessionId: null }, runnerEngineProbe(env, instanceId, userId));
		if (!knownOwner.free) return { ok: false, status: 409, reason: "busy", error: describeOwner(knownOwner.owner, repo.name) };

		// Open one if there isn't one. Requiring a live session made delegation SINGLE-USE — the
		// Pilot ended the session its own driver required, so the second goal always 409'd — and
		// meant a supervisor could not supervise unless a human first sat in the console.
		//
		// And ask the machine whether it can run the engine, on a reused session too (#891): a fresh
		// open always did, but a reused one was admitted on an engine that had since lost its login,
		// and each turn then spent its time failing a 401 before the Pilot gave up.
		const ensured = await ensureActiveSession(env, instanceId, userId, repo, { preflightEngine: true });
		if (!ensured.ok && ensured.engine?.state === "signed-out") {
			const { maxIterations } = await boundedIterations(input);
			const message = ensured.startError ?? `The coding engine is not signed in on the machine that runs ${repo.name}.`;
			const runId = await recordEngineAuthRefusal(env, {
				instanceId,
				userId,
				objective,
				maxIterations,
				budgetId: input.budgetId,
				sessionId: ensured.engine.sessionId,
				delegatedBy: input.onBehalfOf ?? null,
				preflightMessage: message,
			}).catch(() => undefined);
			return { ok: false, status: 409, reason: "engine_auth", runId, error: message };
		}
		if (!ensured.ok) {
			return { ok: false, status: 409, error: noSessionMessage({ repoName: repo.name, connectivity, startError: ensured.startError }) };
		}
		const { session, opened } = ensured;

		// One writer per CHECKOUT, not per session (#1015). A direct turn on any session of this repo —
		// including a retained one whose run already ended — or a run on another session still owns it.
		// `busy`, so a queued objective is REQUEUED with this sentence rather than failed, and the
		// watcher that follows the direct turn drains it once the runner confirms the engine idle.
		const free = await repoFreeForRun(env, { instanceId, userId, repoId: repo.id, sessionId: session.id }, runnerEngineProbe(env, instanceId, userId));
		if (!free.free) {
			// A claim taken in the gap since the check above. The engine this call launched goes with
			// its row — that session's engine only, on its own machine — and nothing is drained: this
			// start may itself be a drain, and the owner it lost to drains when it finishes.
			if (opened) {
				const conn = await getRunnerConn(env, instanceId, userId, session.runnerNode ?? null).catch(() => null);
				if (conn) await callRunner(conn, "/coding/end", { sessionId: session.id }).catch(() => undefined);
				await endSession(env, instanceId, userId, session.id, "ended").catch(() => undefined);
			}
			return { ok: false, status: 409, reason: "busy", error: describeOwner(free.owner, repo.name) };
		}

		// Single-flight, same as `/sessions/:id/run` (#208). Without it a Lead delegating a goal —
		// or the owner pressing Loop — starts a SECOND Pilot on a session that is already being
		// driven, and the two interleave `tmux send-keys` into the same pane, each reasoning over
		// a terminal the other is writing to. #208 added the claim to the route only; these paths
		// reach the same engine and were left open, so the guarantee was a sixth of a guarantee.
		const driverId = crypto.randomUUID();
		if (!(await claimSessionDriver(env, instanceId, userId, session.id, driverId))) {
			// Only reachable on a reused session (a freshly opened one has no driver), but if we
			// DID open it, close it — a session opened purely for a run that never started is
			// litter that the next attempt would then reuse and never own.
			if (opened) await endSession(env, instanceId, userId, session.id, "ended").catch(() => undefined);
			return {
				ok: false,
				status: 409,
				// The one 409 here that WAITING fixes (#788) — see `LoopStartResult.reason`.
				reason: "busy",
				// Names WHO can do the stopping (#540). The owner read this sentence at 12:07, in a
				// bubble produced by the agent's own `start_work` call, and the only actor in the room
				// who could act on it was him — twelve minutes later he asked the agent to stop and was
				// told a machine on his desk owned the control. `stop_work` is in BASE, so the agent
				// reading this refusal has the tool it names.
				error: `${repo.name} is already being worked on — wait for the current run to finish, or stop it first with stop_work.`,
			};
		}

		const runId = crypto.randomUUID();
		const { maxIterations, limits, ceiling } = await boundedIterations(input);
		// NOT best-effort — this is the invariant at the top of this file: EVERY driver opens an
		// `agent_loop_runs` row, because that row is what `check_delegation`, `subordinate_status`
		// and the console's `/loop/:runId` poll read. Swallowed, the Pilot workflow still started
		// and the caller still got a `runId`, but `requestCancel(runId)`/`isCancelRequested` had
		// no row to act on — an autonomous run editing the user's repo and spending their tokens
		// that they could not see and could not stop. `chatDriver` never swallowed it; the
		// asymmetry was the bug. Fail the START instead, and give back what was claimed.
		let created: boolean;
		try {
			created = await createLoopRun(env, {
				runId,
				userId,
				instanceId,
				objective,
				maxIterations,
				budgetId: input.budgetId,
				startedAt: Date.now(),
				delegatedBy: input.onBehalfOf ?? null,
				// #465: link the run to its session so `check_work` can reach the live `runState`
				// via `/coding/capture` and report "the engine is working" instead of only "NOT stalled".
				sessionId: session.id,
				// The atomic repo lock (#1253): the checks above are reads, so two starts can both pass them. The
				// INSERT itself refuses while another run holds this repo, and the loser queues like any busy start.
				exclusiveRepoId: repo.id,
			});
		} catch (e) {
			await releaseSessionDriver(env, instanceId, userId, session.id, driverId).catch(() => undefined);
			if (opened) await endSession(env, instanceId, userId, session.id, "ended").catch(() => undefined);
			return {
				ok: false,
				status: 500,
				error: `Could not start the run: ${e instanceof Error ? e.message : String(e)}`,
			};
		}

		if (!created) {
			await releaseSessionDriver(env, instanceId, userId, session.id, driverId).catch(() => undefined);
			if (opened) await endSession(env, instanceId, userId, session.id, "ended").catch(() => undefined);
			const owner = (await repoOwners(env, { instanceId, userId, repoId: repo.id }).catch(() => []))[0];
			return { ok: false, status: 409, reason: "busy", error: owner ? describeOwner(owner, repo.name) : `${repo.name} is already being worked on — wait for the current run to finish.` };
		}

		// The checkout's owner, now that the run has an id (#984). Written at the moment the run row
		// exists so the claim, the active-run record and the issue link cannot disagree about who is
		// working in that tree: "#982 did not start clean here — it continued #978" is a recorded
		// fact rather than something a reader reconstructs from timestamps.
		if (handoff.recovering && handoff.claim) {
			await releaseRecoveryClaim(env, {
				instanceId,
				userId,
				sessionId: handoff.claim.sessionId,
				resolvedBy: runId,
				state: handoff.state,
				detail: handoff.detail,
			}).catch(() => undefined);
		}

		// The run's issue card (#895): explicit, else the objective's subject. Never fails the start.
		await linkRunToIssue(env, { instanceId, userId, runId, sessionId: session.id, repoId: repo.id, githubRepo: repo.githubRepo ?? null, objective, issue: input.issue }).catch(() => undefined);

		let boardTaskId: string | undefined;
		if (input.delegated) {
			boardTaskId = `deleg-${crypto.randomUUID()}`;
			await env.DB.prepare(
				`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
				 VALUES (?1, ?2, ?3, 'delegation', 'running', ?4, datetime('now'), datetime('now'))`,
			)
				.bind(
					boardTaskId,
					instanceId,
					userId,
					JSON.stringify(delegationTaskRecord({ id: boardTaskId, targetLabel: repo.name, objective, status: "running", now: new Date().toISOString() })),
				)
				.run()
				.catch(() => undefined);
		}

		await env.CODING_SESSION.create({
			params: {
				instanceId,
				userId,
				sessionId: session.id,
				repoId: repo.id,
				runnerNode: session.runnerNode ?? null,
				cloneUrl: repo.cloneUrl ?? undefined,
				branch: repo.branch || undefined,
				goal: { objective, objectiveOrigin: input.repairCheckout === true ? undefined : input.objectiveOrigin, repo: repo.name, clientType: session.clientType, repairCheckout: input.repairCheckout === true ? true : undefined },
				// The number in the caller's "Max iterations" box, honoured (#374).
				//
				// It reached the run ROW and stopped there, so `check_delegation` could report
				// "iteration 40 of 10" — the Pilot's own per-round cap is 40 and nothing told it
				// otherwise. Passed only when the caller actually named one: a supervisor's
				// `delegate_goal` usually does not, and that path keeps the Pilot's default rather
				// than inheriting `sanitizeMaxIterations`'s fallback of 10 and getting shorter runs
				// than it asked for.
				// #820 widened this by exactly one case. When the caller named a number it is still
				// honoured, now clamped by the instance's bounds as well. When the caller named
				// NOTHING the Pilot's own default still applies — unless the owner configured
				// bounds, in which case the number that gets clamped is the PILOT's default and not
				// `sanitizeMaxIterations`'s fallback of 10. That distinction is load-bearing both
				// ways: clamping 10 would CUT an unnamed delegation from 40 steps to a floor of 30,
				// turning a minimum into a maximum, while leaving it undefined would let a
				// configured CEILING of 20 be ignored on the one path that never names a number.
				maxSteps:
					input.maxIterations === undefined
						? hasLoopLimits(limits)
							? clampIterations(PILOT_DEFAULT_MAX_STEPS, limits, ceiling)
							: undefined
						: maxIterations,
				boardTaskId,
				budgetId: input.budgetId,
				depth: input.depth,
				loopRunId: runId,
				driverId,
				// Ownership (#271). TRUE only when this call created the session, which is what
				// licenses the Pilot to close it. A session the user opened by hand outlives the
				// run — taking it away is what made delegation single-use.
				sessionOpenedByRun: opened,
				// #806: a CONTINUE reaches further back for its predecessor than an ordinary start.
				resumeLookbackMs: input.resumeLookbackMs,
			},
		});
		// The last of the Pilot's entry points (#556). Everything the Workflow subsequently drives
		// through this engine happens inside `workflows/coding-session.ts`; recording the absence
		// at every entry means the day's row exists before the first of those acts runs.
		await noteUnmeteredHeadlessDrive(env, { userId, instanceId, traceId: runId }, session);
		return { ok: true, runId, driver: codingDriver.id };
	},
};

/**
 * `capabilities.workflow` → the driver that serves it. An agent declaring a workflow with no entry
 * falls back to the chat loop rather than failing: its tools are still reachable that way, which is
 * strictly better than "this agent cannot be looped".
 */
const DRIVERS: Record<string, LoopDriver> = {
	CODING_SESSION: codingDriver,
};

export const DEFAULT_LOOP_DRIVER = chatDriver;

/**
 * Refuse a run on a PAUSED instance, before any driver does anything (#825).
 *
 * ── Why the gate is here and not at the five call sites
 *
 * Every `driver.start()` in the tree gets its driver from {@link loopDriverFor} — `POST /:id/loop`,
 * the continue route, `delegate_goal`/`start_work` through the tool registry, the delegation
 * helper, and the objective-queue drainer. Wrapping the driver is therefore ONE gate that covers
 * all five and, more to the point, covers the sixth that has not been written yet. Gating at the
 * call sites is how `lib/trigger-eligibility.ts`'s own header says the background version of this
 * bug happened: a fix applied at one writer covers only that writer, and a later one forgets.
 *
 * ── Why it wraps rather than living inside each driver
 *
 * A driver's job is to decide whether the WORK can run — is there a repo, a machine, a usable
 * checkout. Whether the agent is switched on at all is a question about the instance, asked once,
 * and answering it twice in two drivers is how two answers start disagreeing.
 *
 * It runs BEFORE the driver's own checks deliberately. A paused coding agent with its laptop shut
 * should be told it is paused — that is the fact the owner can act on and the one they created —
 * rather than being sent to go and run `pags up` for a run that would be refused anyway.
 *
 * The extra read is one indexed lookup by primary key on a path that already makes several, and it
 * is skipped entirely for the overwhelmingly common case only in the sense that the row is almost
 * always `active` — it is always READ, because a gate that trusts a cached status is a gate that
 * admits a run onto an instance paused a second ago.
 */
function withPauseGate(driver: LoopDriver): LoopDriver {
	return {
		id: driver.id,
		label: driver.label,
		async start(input) {
			const row = await input.env.DB.prepare("SELECT status FROM agent_instances WHERE id = ?1 AND user_id = ?2")
				.bind(input.instanceId, input.userId)
				.first<{ status: string | null }>()
				.catch(() => null);
			// A failed read does NOT refuse. This gate exists to stop work on an agent the owner
			// switched off, not to make a dropped D1 read look like one — and the run is about to
			// make several more reads that will fail honestly if D1 is genuinely down.
			const refusal = row ? pausedStartRefusal(row.status) : null;
			if (refusal) return { ok: false, status: 409, reason: "paused", error: refusal };
			return driver.start(input);
		},
	};
}

/**
 * Refuse a CODING run for an account without Pro (#870), at the same one door as the pause gate.
 *
 * A coding run drives the owner's own machine, which is a Pro feature (#868). `POST /:id/loop`
 * refused it with `requirePro`, but the ticket queue and supervisor delegation start runs with no
 * session and never passed that route — so the run was created and failed later at the runner.
 * Gating the driver covers every entry point, including the next one. Callers that open a budget
 * pool before starting ask {@link codingRunRefusal} first, so a refused run opens nothing.
 */
function withProGate(driver: LoopDriver): LoopDriver {
	if (driver.id !== codingDriver.id) return driver;
	return {
		id: driver.id,
		label: driver.label,
		async start(input) {
			const refusal = await codingRunRefusal(input.env, input.userId);
			if (refusal) return { ok: false, status: 402, error: refusal };
			return driver.start(input);
		},
	};
}

/**
 * Refuse autonomous work on an agent whose WORKFLOW is retired (#979), at the same one door.
 *
 * A retired agent's own start path refuses, but its chat loop would not: the Loop button,
 * `start_instance_loop` (now `coding_loop_start`), a trigger and a supervisor's `delegate_goal` would all start a run on an
 * agent whose work cannot run — burning the owner's tokens to arrive at the migration message the
 * refusal could have given for nothing. #979 asks for exactly that: no silent no-op, an explanatory
 * migration message instead. (No workflow is retired today: JOB_APPLY was restored at #1062.)
 *
 * 410 and not 409: this is permanent. A caller that retries a 409 is right to; retrying this is
 * the mistake the status code exists to prevent. Synchronous, because the capabilities the caller
 * already resolved carry the verdict — no read, and nothing to fail.
 */
function withRetirementGate(capabilities: AgentCapabilities | null | undefined, driver: LoopDriver): LoopDriver {
	const retired = capabilities?.retired;
	if (!retired) return driver;
	return {
		id: driver.id,
		label: driver.label,
		async start() {
			return { ok: false, status: 410, error: `${retired.label}. ${retired.migration}` };
		},
	};
}

export function loopDriverFor(capabilities: AgentCapabilities | null | undefined): LoopDriver {
	const wf = capabilities?.workflow;
	return withRetirementGate(capabilities, withPauseGate(withProGate((wf && DRIVERS[wf]) || DEFAULT_LOOP_DRIVER)));
}

/** Every driver id, for tests and diagnostics. */
export const LOOP_DRIVER_IDS = [DEFAULT_LOOP_DRIVER.id, ...Object.values(DRIVERS).map((d) => d.id)];
