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
import { createLoopRun } from "./agent-loop-store.js";
import { sanitizeMaxIterations } from "./agent-loop.js";
import { delegationTaskRecord } from "./delegation.js";
import { claimSessionDriver, endSession, listRepos, releaseSessionDriver } from "./coding-store.js";
import { ensureActiveSession } from "./coding-session-open.js";
import { noSessionMessage } from "./coding-session-lifecycle.js";
import { classifySubordinateConnectivity } from "./subordinate-connectivity.js";
import { EMPTY_RUNTIME_FACTS, runtimeConnectivity } from "./instance-connectivity.js";
import type { AgentCapabilities } from "./agent-capabilities.js";
import type { Env } from "../types.js";

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
}

export type LoopStartResult =
	| { ok: true; runId: string; driver: string }
	| { ok: false; status: number; error: string };

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
		const maxIterations = sanitizeMaxIterations(input.maxIterations);
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
export function pickLoopRepo<T extends { id: string }>(repos: readonly T[], repoId?: string | null): LoopRepoChoice<T> {
	if (!repoId) {
		return repos[0]
			? { ok: true, repo: repos[0] }
			: { ok: false, error: "This coding agent has no repository yet — add one on its Coding tab first." };
	}
	const found = repos.find((r) => r.id === repoId);
	return found
		? { ok: true, repo: found }
		: { ok: false, error: "That repository is not on this agent — reload the Coding tab and try again." };
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
		const chosen = pickLoopRepo(repos, input.repoId);
		if (!chosen.ok) return { ok: false, status: 409, error: chosen.error };
		const repo = chosen.repo;
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
			return { ok: false, status: 409, error: noSessionMessage({ repoName: repo.name, connectivity }) };
		}

		// Open one if there isn't one. Requiring a live session made delegation SINGLE-USE — the
		// Pilot ended the session its own driver required, so the second goal always 409'd — and
		// meant a supervisor could not supervise unless a human first sat in the console.
		const ensured = await ensureActiveSession(env, instanceId, userId, repo);
		if (!ensured.ok) {
			return { ok: false, status: 409, error: noSessionMessage({ repoName: repo.name, connectivity, startError: ensured.startError }) };
		}
		const { session, opened } = ensured;

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
				error: `${repo.name} is already being worked on — wait for the current run to finish, or stop it first.`,
			};
		}

		const runId = crypto.randomUUID();
		const maxIterations = sanitizeMaxIterations(input.maxIterations);
		// NOT best-effort — this is the invariant at the top of this file: EVERY driver opens an
		// `agent_loop_runs` row, because that row is what `check_delegation`, `subordinate_status`
		// and the console's `/loop/:runId` poll read. Swallowed, the Pilot workflow still started
		// and the caller still got a `runId`, but `requestCancel(runId)`/`isCancelRequested` had
		// no row to act on — an autonomous run editing the user's repo and spending their tokens
		// that they could not see and could not stop. `chatDriver` never swallowed it; the
		// asymmetry was the bug. Fail the START instead, and give back what was claimed.
		try {
			await createLoopRun(env, {
				runId,
				userId,
				instanceId,
				objective,
				maxIterations,
				budgetId: input.budgetId,
				startedAt: Date.now(),
				delegatedBy: input.onBehalfOf ?? null,
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
				goal: { objective, repo: repo.name, clientType: session.clientType },
				// The number in the caller's "Max iterations" box, honoured (#374).
				//
				// It reached the run ROW and stopped there, so `check_delegation` could report
				// "iteration 40 of 10" — the Pilot's own per-round cap is 40 and nothing told it
				// otherwise. Passed only when the caller actually named one: a supervisor's
				// `delegate_goal` usually does not, and that path keeps the Pilot's default rather
				// than inheriting `sanitizeMaxIterations`'s fallback of 10 and getting shorter runs
				// than it asked for.
				maxSteps: input.maxIterations === undefined ? undefined : maxIterations,
				boardTaskId,
				budgetId: input.budgetId,
				depth: input.depth,
				loopRunId: runId,
				driverId,
				// Ownership (#271). TRUE only when this call created the session, which is what
				// licenses the Pilot to close it. A session the user opened by hand outlives the
				// run — taking it away is what made delegation single-use.
				sessionOpenedByRun: opened,
			},
		});
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

export function loopDriverFor(capabilities: AgentCapabilities | null | undefined): LoopDriver {
	const wf = capabilities?.workflow;
	return (wf && DRIVERS[wf]) || DEFAULT_LOOP_DRIVER;
}

/** Every driver id, for tests and diagnostics. */
export const LOOP_DRIVER_IDS = [DEFAULT_LOOP_DRIVER.id, ...Object.values(DRIVERS).map((d) => d.id)];
