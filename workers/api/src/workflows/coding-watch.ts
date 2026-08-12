import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { CodingPaneSnapshot, CodingResult } from "../lib/coding-loop.js";
import type { CodingSessionParams } from "./coding-session-params.js";
import { callRunner, getRunnerConnIgnoringLiveness, READ_TIMEOUT_MS } from "../lib/runner-client.js";
import { appendTimeline, contextForCopilot, lastTerminal } from "../lib/coding-timeline.js";
import { terminalSnapshotChanged, terminalSnapshotContent } from "../lib/terminal-snapshot.js";
import { copilotSummary } from "../lib/coding-copilot.js";
import { codingSessionLink } from "../lib/console-links.js";
import { notifyUser } from "../routes/push.js";
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
			codingSessionLink(instanceId, sessionId),
			// One watcher, one completion. Migration 0024 already deduped the WATCHERS; this keys
			// the notification on the same fact so a second watcher for a session cannot re-buzz.
			{ key: `coding-watch-end:${sessionId}` },
		).catch(() => undefined);
		return null;
	});
	return { outcome: "done", detail: "watched to idle", steps: 0 };
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
