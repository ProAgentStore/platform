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
import { getActiveSessionForRepo, listRepos } from "./coding-store.js";
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
	 * Open an observable "Delegated: …" board card. Only a SUPERVISOR's run gets one — an owner
	 * pressing Loop on their own agent was not delegated to by anybody, and a card that says so
	 * would be a lie. Their coding run is already on the board as its session card (#206).
	 */
	delegated?: boolean;
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
			},
		});
		return { ok: true, runId, driver: chatDriver.id };
	},
};

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
		const repo = repos[0];
		if (!repo) {
			return { ok: false, status: 409, error: "This coding agent has no repository yet — add one on its Coding tab first." };
		}
		const session = await getActiveSessionForRepo(env, instanceId, userId, repo.id);
		if (!session) {
			return {
				ok: false,
				status: 409,
				error: `${repo.name} has no live coding session — start one on its Coding tab (and run \`pags up\`), then try again.`,
			};
		}

		const runId = crypto.randomUUID();
		const maxIterations = sanitizeMaxIterations(input.maxIterations);
		await createLoopRun(env, {
			runId,
			userId,
			instanceId,
			objective,
			maxIterations,
			budgetId: input.budgetId,
			startedAt: Date.now(),
		}).catch(() => undefined);

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
				boardTaskId,
				budgetId: input.budgetId,
				depth: input.depth,
				loopRunId: runId,
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
