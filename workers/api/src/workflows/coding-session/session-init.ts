// Session initialization logic - setup and validation

import type { WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { readMergePolicyForRun, describeAuthority, type MergePolicy } from "../../lib/coding-authority.js";
import { registeredRepoSlugs } from "../../lib/repo-write-scope.js";
import { accountTimeZone } from "../../lib/account-timezone.js";
import {
	callRunner,
	getRunnerConnIgnoringLiveness,
	getBoundRunnerConn,
	relayConnected,
} from "../../lib/runner-client.js";
import { reassignSessionNode } from "../../lib/coding-store.js";
import { makeRunnerGuard, RUNNER_PROBE_INTERVAL } from "../../lib/runner-availability.js";
import { normalizeRunnerNode } from "../../lib/runtime-nodes.js";
import { runtimeConnectivity } from "../../lib/instance-connectivity.js";
import { CodingRunProbe } from "../../lib/coding-failure.js";
import type { RunnerConn, RunStep } from "../../lib/runner-availability.js";
import type { CodingGoal } from "../../lib/coding-loop.js";
import type { Env } from "../../types.js";
import type { CodingSessionParams } from "../coding-session-params.js";

export interface InitializationResult {
	mergePolicy: MergePolicy;
	writeScope: string[];
	authorityNote: string;
	conn: RunnerConn | null;
	guard: ((retry: RunStep, name: string, fn: () => Promise<unknown>) => Promise<unknown>) | null;
	probe: CodingRunProbe;
}

export async function initializeSession(
	env: Env,
	event: WorkflowEvent<CodingSessionParams>,
	step: WorkflowStep,
	goal: CodingGoal,
	postToChat: (content: string) => void,
): Promise<InitializationResult> {
	const { instanceId, userId, sessionId, repoId, runnerNode } = event.payload;

	// Initialize policies and settings
	const mergePolicy = (await step.do("merge-authority", () =>
		readMergePolicyForRun(env, { instanceId, userId, repoId }),
	)) as MergePolicy;
	goal.mergePolicy = mergePolicy;

	const writeScope = (await step.do("repo-write-scope", () =>
		registeredRepoSlugs(env, instanceId, userId),
	)) as string[];

	goal.timeZone = ((await step.do("owner-timezone", async () =>
		(await accountTimeZone(env, userId)) ?? null,
	)) as string | null) ?? undefined;

	const authorityNote = describeAuthority(mergePolicy, goal.clientType);

	// Setup runner connection
	let startConn = await getRunnerConnIgnoringLiveness(env, instanceId, userId, runnerNode ?? null);
	const live = await relayConnected(env, instanceId, runnerNode ?? null).catch(() => false);
	if (!live) {
		const fallback = await getBoundRunnerConn(env, instanceId, userId);
		if (fallback && normalizeRunnerNode(fallback.runnerNode) !== normalizeRunnerNode(runnerNode)) {
			await reassignSessionNode(env, instanceId, userId, sessionId, fallback.runnerNode ?? null).catch(() => undefined);
			startConn = fallback;
		}
	}

	if (!startConn) {
		return { mergePolicy, writeScope, authorityNote, conn: null, guard: null, probe: new CodingRunProbe() };
	}

	// Setup runner guard for reconnection handling
	const probe = new CodingRunProbe();
	let conn = startConn;

	const guard = makeRunnerGuard({
		wait: {
			probe: () => runtimeConnectivity(env, instanceId, userId),
			sleep: (label) => step.sleep(label, RUNNER_PROBE_INTERVAL),
			announce: postToChat,
			tick: async () => {
				if (event.payload.driverId) {
					const { touchSessionDriver, touchSessionActivity } = await import("../../lib/coding-store.js");
					await touchSessionDriver(env, instanceId, userId, sessionId, event.payload.driverId).catch(() => undefined);
					await touchSessionActivity(env, instanceId, userId, sessionId).catch(() => undefined);
				}
			},
		},
		reconnect: async (label) => {
			const back = await getBoundRunnerConn(env, instanceId, userId).catch(() => null);
			if (back) {
				if (normalizeRunnerNode(back.runnerNode) !== normalizeRunnerNode(conn.runnerNode)) {
					await reassignSessionNode(env, instanceId, userId, sessionId, back.runnerNode ?? null).catch(() => undefined);
				}
				conn = back;
			}
			// Note: The actual restart is handled in the main orchestrator
		},
	});

	return { mergePolicy, writeScope, authorityNote, conn, guard, probe };
}
