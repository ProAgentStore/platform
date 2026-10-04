// Cleanup and finalization logic for a coding session

import type { WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import {
	endSession,
	getRepo,
	releaseSessionDriver,
} from "../../lib/coding-store.js";
import { enforceRepoPolicies } from "../../lib/repo-policy-act.js";
import { callRunner } from "../../lib/runner-client.js";
import {
	readRepoSync,
	describeRepoSync,
} from "../../lib/repo-sync.js";
import {
	appendTimeline,
	appendEngineUsageTimeline,
} from "../../lib/coding-timeline.js";
import {
	recordEngineUsage,
	recordEngineActs,
	recordAuthorityViolations,
	recordRepoScopeViolations,
	sanitizeEngineUsage,
	sanitizeEngineActs,
} from "../../lib/engine-acts.js";
import {
	shouldEndSessionAfterRun,
	stopReasonFor,
} from "../../lib/coding-pause.js";
import { statusFor } from "../../lib/agent-loop.js";
import { setCodingSessionCardStatus } from "../../lib/coding-board.js";
import { traceCodingRun } from "../../lib/coding-run-trace.js";
import { notifyUser } from "../../routes/push.js";
import { codingSessionLink } from "../../lib/console-links.js";
import type { RunnerConn } from "../../lib/runner-client.js";
import type { CodingResult } from "../../lib/coding-loop.js";
import type { CodingGoal } from "../../lib/coding-loop.js";
import type { MergePolicy } from "../../lib/coding-authority.js";
import type { LoopStopReason } from "../../lib/coding-pause.js";
import type { Env } from "../../types.js";
import type { CodingSessionParams } from "../coding-session-params.js";
import type { TraceContext } from "./types.js";

const READ_TIMEOUT_MS = 30_000;

export async function cleanupAfterRun(
	env: Env,
	event: WorkflowEvent<CodingSessionParams>,
	step: WorkflowStep,
	conn: RunnerConn,
	instanceId: string,
	userId: string,
	sessionId: string,
	repoId: string,
	result: CodingResult,
	mergePolicy: MergePolicy,
	writeScope: string[],
	goal: CodingGoal,
	crashReason: LoopStopReason | null,
	traceCtx: TraceContext,
): Promise<void> {
	// Enforce repo policies
	await step.do("repo-state-end", async () => {
		await enforceRepoPolicies(env, {
			conn,
			instanceId,
			userId,
			repoId,
			repoLabel: goal.repo,
			sessionId,
		});
		return null;
	});

	// Check sync at end
	await step.do("repo-sync-end", async () => {
		const repo = await getRepo(env, instanceId, userId, repoId).catch(() => null);
		if (!repo) return null;
		const v = await readRepoSync(conn, {
			workDir: repo.workdir,
			sessionId,
			branch: repo.branch,
			forceFetch: true,
		}).catch(() => null);
		const line = v ? describeRepoSync(v) : null;
		if (!line) return null;
		await appendTimeline(env, {
			sessionId,
			instanceId,
			userId,
			type: "brain",
			content: `Upstream sync at end of run: ${line}`,
		}).catch(() => undefined);
		if (v && (v.state === "behind" || v.state === "diverged" || v.state === "ahead"))
			await env.DB.prepare(
				`INSERT INTO coding_timeline (id, instance_id, user_id, session_id, type, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(crypto.randomUUID(), instanceId, userId, sessionId, "system", `**Repository sync at end of run** — ${line}`, new Date().toISOString())
				.run()
				.catch(() => undefined);
		return null;
	});

	// Final drain of engine acts
	await step.do("acts-final-drain", async () => {
		const snap = await callRunner<{ usage?: unknown; acts?: unknown }>(
			conn,
			"/coding/capture",
			{ sessionId, drainUsage: true },
			{ timeoutMs: READ_TIMEOUT_MS },
		).catch(() => null);
		if (!snap) return null;
		const closingUsageRecords = sanitizeEngineUsage(snap.usage);
		await recordEngineUsage(
			env,
			{
				userId,
				sessionId,
				instanceId,
				authResolved: (snap as { authResolved?: unknown }).authResolved ?? null,
			},
			closingUsageRecords,
		).catch(() => undefined);
		await appendEngineUsageTimeline(env, { sessionId, instanceId, userId }, closingUsageRecords);
		const closing = sanitizeEngineActs(snap.acts);
		await recordEngineActs(env, { userId, sessionId, instanceId, traceId: event.payload.loopRunId ?? null }, closing).catch(() => undefined);
		await recordAuthorityViolations(
			env,
			{ userId, instanceId, sessionId, repoLabel: goal.repo, traceId: event.payload.loopRunId ?? null },
			mergePolicy,
			closing,
		).catch(() => null);
		await recordRepoScopeViolations(
			env,
			{ userId, instanceId, sessionId, repoLabel: goal.repo, traceId: event.payload.loopRunId ?? null },
			writeScope,
			closing,
		).catch(() => null);
		return null;
	});

	// End session
	await step.do("end", async () => {
		if (shouldEndSessionAfterRun({ openedByRun: event.payload.sessionOpenedByRun === true })) {
			const ended = await callRunner<{ ok?: boolean; acts?: unknown }>(conn, "/coding/end", { sessionId }).catch(() => null);
			await recordEngineActs(
				env,
				{ userId, sessionId, instanceId, traceId: event.payload.loopRunId ?? null },
				sanitizeEngineActs(ended?.acts),
			).catch(() => undefined);
			const status = result.outcome === "failed" || result.outcome === "max_steps" ? "error" : "ended";
			await endSession(env, instanceId, userId, sessionId, status);
		} else if (event.payload.driverId) {
			await releaseSessionDriver(env, instanceId, userId, sessionId, event.payload.driverId);
		}
		await setCodingSessionCardStatus(env, instanceId, userId, sessionId, statusFor(crashReason ?? stopReasonFor(result.outcome))).catch(() => undefined);
		await appendTimeline(env, {
			sessionId,
			instanceId,
			userId,
			type: "outcome",
			content: `${result.outcome}${result.detail ? ` — ${result.detail}` : ""}`,
		});
		await traceCodingRun(
			env,
			traceCtx,
			"coding.run.end",
			`${result.outcome}${result.detail ? ` — ${result.detail}` : ""}`,
			{
				outcome: result.outcome,
				stopReason: crashReason ?? stopReasonFor(result.outcome),
			},
		);
		return null;
	});

	// Notify user
	await step.do("notify-end", async () => {
		const ok = result.outcome === "done";
		const title = ok ? "✅ Coder finished" : "⚠️ Coder stopped";
		const body = `${goal.repo}: ${result.detail || result.outcome}`;
		await notifyUser(env, userId, "coding", title, body, codingSessionLink(instanceId, sessionId), {
			key: `coding-end:${sessionId}`,
			instanceId,
		}).catch(() => undefined);
		return null;
	});
}
