// How an agent reads back its OWN runs (#256).
//
// `start_work` gave an agent a way to act. Nothing gave it a way to look. Its resolved tool set —
// after `drive:false` correctly removed `read_terminal` / `send_to_cli` / `list_coding_repos`, so a
// chat could not become a second uncoordinated driver — contained no tool that takes the run id
// `start_work` returns, and `get_activity` is a generic event feed, not an answer to "did the thing
// I started finish?".
//
// That is the mechanism behind #254, not a separate problem. Asked "did YOU pull it or did the
// agent?", the agent had nothing that could settle the question: it could not check the run, read
// the terminal, or see the session. With no evidence it deferred to a system prompt that said it
// could not act, and denied work it had really done.
//
// **An agent that can act but cannot observe its own actions is structurally forced to either
// fabricate or deny.** Both were observed on the same instance within two days. So the fix is a way
// to LOOK, not another instruction to be careful.
//
// Pure and exported: the same rendering serves the `check_work` tool result and the automatic
// "recent work" context block, so the two can never tell different stories about one run.
import type { LoopRunView } from "./agent-loop-store.js";

/** Round to a human interval. Exact ms in a prompt invites the model to quote it back as precision. */
function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

/**
 * How long a `running` run may go quiet before it should be reported as possibly stalled.
 *
 * A Workflow that dies mid-step leaves `status = 'running'` forever, so "running" alone is not
 * evidence that anything is happening — reporting it as live is the same over-claim in a new place.
 * 15 minutes is well past a normal engine step and well short of a long build.
 */
export const STALLED_AFTER_MS = 15 * 60 * 1000;

/** Is this run's `running` status believable right now? */
export function isStalled(run: LoopRunView, now: number): boolean {
	if (run.status !== "running") return false;
	const last = run.lastProgressAt ?? run.startedAt;
	return now - last > STALLED_AFTER_MS;
}

/**
 * One run, in the words the agent should use about it.
 *
 * The outcome is stated FIRST and unhedged. The whole point is that when the user asks "did that
 * actually happen?", the agent has a sentence it can quote instead of a belief it has to form.
 */
export function describeLoopRun(run: LoopRunView, now: number = Date.now()): string {
	const parts: string[] = [];
	const stalled = isStalled(run, now);
	const status = stalled ? "running but STALLED (no progress reported recently — it may have died)" : run.status;
	parts.push(`run ${run.runId}: ${status}`);
	parts.push(`objective: ${run.objective}`);
	parts.push(`step ${run.iteration}/${run.maxIterations}`);
	if (run.stopReason) parts.push(`stopped because: ${run.stopReason}`);
	if (run.detail) parts.push(`result: ${run.detail}`);
	parts.push(`started ${ago(now - run.startedAt)}`);
	if (run.finishedAt) parts.push(`finished ${ago(now - run.finishedAt)}`);
	if (run.cancelRequested && run.status === "running") parts.push("a cancel has been requested");
	return parts.join(" · ");
}

/**
 * The `check_work` tool result.
 *
 * The empty case is a real answer, not an error: "you have not started any work" is exactly what an
 * agent needs to hear before it agrees with a user who thinks it did something. An error would be
 * read as "could not tell", which is the state that produces a guess.
 */
export function describeWorkCheck(runs: readonly LoopRunView[], now: number = Date.now()): string {
	if (!runs.length) {
		return "You have not started any work on this instance — there are no runs. If you told the user you did something, that was wrong; say so.";
	}
	return (
		`${runs.length === 1 ? "The run" : `Your ${runs.length} most recent runs`}, newest first:\n` +
		runs.map((r) => `- ${describeLoopRun(r, now)}`).join("\n") +
		"\n\nThis is the record of what you actually started. Report it as-is; do not soften or retract it."
	);
}

/**
 * The automatic context block — what the agent knows about its own work WITHOUT calling a tool.
 *
 * #256 asks for this explicitly, and it is the stronger half of the fix: the denial happened in a
 * single turn, in reply to a direct challenge, and a model that has to decide to call a tool before
 * it can defend a true statement will often just apologise instead. Having the answer already in
 * the prompt removes the decision.
 *
 * Capped at a few runs — this is orientation, not a log; `check_work` is there for the rest.
 */
export function recentWorkPrompt(runs: readonly LoopRunView[], now: number = Date.now()): string {
	if (!runs.length) return "";
	return (
		"\n\n## Your recent work\nRuns YOU started with `start_work` (newest first). This is fact, from the run record —" +
		" if the user asks whether you did something, answer from here, and call `check_work` for more:\n" +
		runs.map((r) => `- ${describeLoopRun(r, now)}`).join("\n")
	);
}
