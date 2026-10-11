import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { CodingPaneSnapshot, CodingResult } from "../lib/coding-loop.js";
import type { CodingSessionParams } from "./coding-session-params.js";
import { callRunner, getRunnerConnIgnoringLiveness, READ_TIMEOUT_MS } from "../lib/runner-client.js";
import { appendTimeline, contextForCopilot, lastTerminal } from "../lib/coding-timeline.js";
import { terminalSnapshotChanged, terminalSnapshotContent } from "../lib/terminal-snapshot.js";
import { copilotSummary } from "../lib/coding-copilot.js";
import { deepLinkFor } from "../lib/console-links.js";
import { notifyUser } from "../routes/push.js";
import { markDirectivesProcessed, runnerEngineProbe, settleDirectTurns } from "../lib/coding-ownership.js";
import { tryDequeueAndStart } from "../lib/objective-queue-start.js";
import type { Env } from "../types.js";

/**
 * The "watch" mode of {@link CodingSessionWorkflow}, lifted out of it (#341).
 *
 * This is a DIFFERENT job from the autonomous Pilot run that shares the workflow class: the human
 * typed the instruction themselves and nothing here decides anything or drives the engine. It only
 * shared the file because it shares a workflow binding.
 *
 * It moved because `coding-session.ts` crossed the file-size ratchet's 800-line threshold while the
 * runner-disconnect guard was added to it, and the guard makes the autonomous run's shape harder to
 * hold in one head, not easier. The ratchet offers two answers — pin the new size on purpose, or
 * split — and this seam already existed: `runWatch` was a separate private method with its own doc
 * saying it was another mode. Behaviour is unchanged; the step names are unchanged, which matters
 * because a durable workflow identifies its journal entries by name.
 *
 * Watch a manually-driven session: the user typed an instruction into the CLI (➤ Agent). Wait for
 * the pane to settle to idle, then summarize what happened, persist it to the chat thread, and
 * notify the user — so "the agent comes back to you" the same way the autonomous run does, even
 * with the console closed.
 */
export async function runWatchSession(env: Env, event: WorkflowEvent<CodingSessionParams>, step: WorkflowStep): Promise<CodingResult> {
	const { instanceId, userId, sessionId, runnerNode, goal } = event.payload;
	// IGNORING LIVENESS, deliberately (#532) — and this one is a REGRESSION AVOIDED, not a saved
	// probe.
	//
	// The null on the next line is terminal: unlike the autonomous run in `coding-session.ts`, this
	// mode is NOT behind #341's `makeRunnerGuard`, so nothing here can turn a disconnect into a
	// pause. Its whole tolerance for a runner that is momentarily away is that it proceeds to
	// `callRunner`, which raises the typed `RunnerUnreachableError` after the 2.5s settle and one
	// 2s step retry. Small — and #341's argument is precisely that a budget under the runner's 30s
	// reconnect cap loses by construction — but resolving live here would delete even that and fail
	// the watch before a single command was attempted.
	//
	// Nothing is lost by holding the row: this mode makes no online CLAIM to anyone (#532 is about
	// resolutions that report as connected), and liveness is decided one line later by the command
	// itself, which is a fact rather than a probe. Giving this path a real pause is #341 follow-up
	// work, not this ticket's.
	const conn = await getRunnerConnIgnoringLiveness(env, instanceId, userId, runnerNode ?? null);
	if (!conn) return { outcome: "failed", detail: "No coding runner connected.", steps: 0 };

	// Wait for the just-sent instruction to run to completion (pane goes idle).
	const finalPane = (await step.do(
		"watch-idle",
		{ retries: { limit: 1, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "15 minutes" as const },
		async () => {
			const capture = () => callRunner<CodingPaneSnapshot & { sessionId: string }>(conn, "/coding/capture", { sessionId }, { timeoutMs: READ_TIMEOUT_MS });
			await sleep(2500); // let the CLI receive the input
			let snap = await capture();
			// Phase 1: wait for Claude to actually START on it (go non-idle), up to ~24s.
			// A quick/no-op message may never go busy — fall through and summarize anyway,
			// rather than reading a premature idle and reporting "nothing happened".
			for (let i = 0; i < 12 && snap.runState === "idle" && snap.alive && !snap.cancelled; i++) {
				await sleep(2000);
				snap = await capture();
			}
			// Phase 2: wait for it to FINISH (return to idle).
			for (let poll = 0; poll < 360 && snap.runState !== "idle" && snap.alive && !snap.cancelled; poll++) {
				await sleep(2000);
				snap = await capture();
			}
			return snap;
		},
	)) as CodingPaneSnapshot;

	// Release the direct turn's claim on the checkout (#1015) — only on the runner's word that the
	// engine is idle or gone — mark the owner's directives the engine has since processed, and start
	// whatever the claim held back in the queue. Every watcher runs this (each re-probes, so a stale
	// one cannot release a newer turn). A turn still busy keeps its claim; the watcher looks again a
	// bounded number of times, and past that the next send or run start re-probes it.
	for (let attempt = 0; attempt < 7; attempt++) {
		if (attempt > 0) await step.sleep(`direct-turn-wait-${attempt}`, "5 minutes");
		const settled = (await step.do(`direct-turn-settle-${attempt}`, async () => settleAfterDirectTurn(env, { instanceId, userId, sessionId, repoId: event.payload.repoId, turnId: event.payload.directTurnId, finalPane: attempt === 0 ? finalPane : null }))) as boolean;
		if (settled) break;
	}

	// Bow out if a later send superseded this watcher — only the latest one
	// notifies, so one completion can't fire several push notifications.
	const stillLatest = (await step.do("watch-is-latest", async () => {
		if (!event.payload.watchId) return true;
		const row = await env.DB.prepare("SELECT watch_workflow_id FROM coding_sessions WHERE id = ?1")
			.bind(sessionId)
			.first<{ watch_workflow_id: string | null }>();
		return !row?.watch_workflow_id || row.watch_workflow_id === event.payload.watchId;
	})) as boolean;
	if (!stillLatest) return { outcome: "done", detail: "superseded by a newer send", steps: 0 };

	// Summarize what the agent did, post it to the thread, and ping the user.
	await step.do("watch-summarize", async () => {
		const memory = await contextForCopilot(env, sessionId);
		const reply = await copilotSummary(env, userId, { finished: true, memory, pane: finalPane.pane || "", instanceId }).catch(() => "");
		if (reply) await appendTimeline(env, { sessionId, instanceId, userId, type: "chat_assistant", content: reply });
		// Save the actual terminal transcript too (deduped) — the audit trail of what
		// Claude really did, not just the summary. Otherwise the manual chat flow only
		// keeps your message + the gist, and the real work isn't recorded anywhere.
		// ONE cap across all three writers (#466). This one stored a 12,000-char tail while
		// `/capture` and `/explain` stored 8,000, so even a correct compare would have seen a
		// "change" every time the writers alternated. Nothing downstream depended on the longer
		// tail: `contextForCopilot` already slices terminal entries to -1200.
		const pane = finalPane.pane || "";
		const stored = terminalSnapshotContent(pane);
		if (stored) {
			const prev = await lastTerminal(env, sessionId).catch(() => null);
			if (terminalSnapshotChanged(pane, prev)) {
				await appendTimeline(env, { sessionId, instanceId, userId, type: "terminal", content: stored }).catch(() => undefined);
			}
		}
		await notifyUser(
			env,
			userId,
			"coding",
			"✅ Coder finished",
			`${goal.repo}: ${reply ? reply.slice(0, 140) : "done — open to see what it did"}`,
			deepLinkFor({ kind: "coding-session", instanceId, sessionId }),
			// One watcher, one completion. Migration 0024 already deduped the WATCHERS; this keys
			// the notification on the same fact so a second watcher for a session cannot re-buzz.
			{ key: `coding-watch-end:${sessionId}`, instanceId },
		).catch(() => undefined);
		return null;
	});
	return { outcome: "done", detail: "watched to idle", steps: 0 };
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * One settle pass after a direct turn (#1015). True once no direct claim remains on the repo.
 * Exported so the release + drain rule is tested without a Workflow.
 */
export async function settleAfterDirectTurn(
	env: Env,
	input: { instanceId: string; userId: string; sessionId: string; repoId?: string | null; turnId?: string; finalPane: { consumedInputs?: string[] | null } | null },
	probe = runnerEngineProbe(env, input.instanceId, input.userId),
): Promise<boolean> {
	if (!input.repoId) return true;
	// Only the runner's correlation of a completed turn with the input it read is evidence (#1019) — not
	// a turn that merely ended after the directive was sent, which is how a message queued behind that
	// turn was credited to it. An older runner reports none, and its directives stay "not yet confirmed".
	await markDirectivesProcessed(env, { instanceId: input.instanceId, userId: input.userId, sessionId: input.sessionId, consumed: input.finalPane?.consumedInputs }).catch(() => 0);
	// Scoped to this watcher's own turn (#1015): a newer send's reservation on the same session is that send's to settle.
	const remaining = await settleDirectTurns(env, { instanceId: input.instanceId, userId: input.userId, repoId: input.repoId }, probe, input.turnId ? { sessionId: input.sessionId, turnId: input.turnId } : undefined);
	// A newer send on this session holds its own reservation: this watcher's turn is settled, and the
	// drain belongs to that send's watcher, which will see the checkout free when it truly is.
	const newer = remaining.some((o) => o.kind === "direct" && input.turnId !== undefined && o.sessionId === input.sessionId && o.turnId !== input.turnId);
	if (remaining.some((o) => o.kind === "direct") && !newer) return false;
	if (!remaining.length) await tryDequeueAndStart(env, input.instanceId, input.repoId, input.userId);
	return true;
}
