/**
 * What became of the engine turn a run was waiting on, once a runner restart or an engine relaunch
 * may have cut it off (#1053). PURE — the workflow calls it with journalled values only, so a replay
 * reaches the same decision the first pass did.
 *
 * ── The defect
 *
 * After a restart the relaunched engine is IDLE, so the run's wait for the turn returned and the Pilot
 * carried on as if the turn had finished. Nothing compared the engine that answered with the engine the
 * instruction went to; nothing noticed the instruction was accepted and never read to completion. The
 * input ledger (#1019) already holds both facts — `ledger` names the runner's record, `epoch` names the
 * engine process, `consumed` lists what a COMPLETED turn read — and #1019 kept a lost reply from being
 * re-sent. This closes the other half: a lost TURN is detected, and either resumed exactly once or ends
 * the run, never silently skipped and never re-sent as if new.
 *
 * ── The checkpoint
 *
 * {@link InflightTurn}: the act's input id, its text, and the ledger + epoch it was ACCEPTED by — or,
 * when its reply was lost (`unknown`), the ledger + epoch it was DISPATCHED to. Every field comes from a
 * journalled step result (the act receipt, the panes before it), so the checkpoint survives a workflow
 * eviction with the journal and needs no store of its own.
 *
 * ── The rule, in order
 *
 *   1. No ledger identity on either side (an older runner)            → intact: nothing can be proven.
 *   2. A completed turn read it (any process of this ledger)          → intact: it ran. A FAILED turn is
 *      still consumed (runner: every exit but a kill), so this never turns a failure into a loss.
 *   3. The runner holds different content under the id               → block: never guess which ran.
 *   4. Same ledger, same process                                      → intact: the engine survived; only
 *      the controller lost sight of it. A turn WE killed (interrupt, wedge) lands here and is unchanged.
 *   5. Another machine answers                                        → block: its checkout cannot show what the
 *      lost turn did on the first one, so a resume there could repeat it (#1019: B never re-runs A's act).
 *   6. The engine is not running after the relaunch                   → block: nothing to resume into.
 *   7. This turn was already the one recovery turn                    → block: never a second resume.
 *   8. Otherwise                                                      → resume ONCE, under a deterministic
 *      id, so a retry or a replay of the recovery is refused by the ledger instead of run twice.
 *
 * ── The resume never repeats the command
 *
 * The recovery turn names the cut-off turn and asks the engine what of it took effect; it does NOT carry the
 * lost instruction. Claude and Codex resume their own conversation, raw engines get the platform's per-turn
 * replay (#693) — so the engine knows what it was asked — and re-sending the command is exactly the duplicate
 * this must never produce. What remains is the Pilot's next decision, made over the engine's report.
 */
import type { ActOutcome } from "./coding-act-send.js";
import type { CodingPaneSnapshot } from "./coding-loop.js";
import { normalizeRunnerNode } from "./runtime-nodes.js";

/** The turn a run is waiting on — its correlation state, from journalled values only. */
export interface InflightTurn {
	inputId: string;
	/** The ledger and engine process that accepted it, or that it was dispatched to when the reply was lost. */
	ledger: string | null;
	epoch: number | null;
	node: string | null;
	receipt: ActOutcome;
	/** When the act's step returned. */
	sentAt: number;
	/** True for the one recovery turn: its own loss is never resumed again. */
	recovery: boolean;
}

export type TurnRecoveryReason =
	| "unverifiable_runner"
	| "consumed"
	| "same_process"
	| "content_conflict"
	| "machine_changed"
	| "engine_absent"
	| "recovery_lost"
	| "engine_replaced";

export type TurnRecoveryDecision =
	| { decision: "intact"; reason: "unverifiable_runner" | "consumed" | "same_process" }
	| { decision: "resume"; reason: "engine_replaced"; resumeInputId: string }
	| { decision: "block"; reason: "content_conflict" | "machine_changed" | "engine_absent" | "recovery_lost" };

/** The deterministic id of a turn's one recovery — the same on every retry and replay. */
export const recoveryInputId = (inputId: string): string => `${inputId}:recover`;

export function decideTurnRecovery(turn: InflightTurn, pane: Pick<CodingPaneSnapshot, "alive" | "engine" | "consumedInputs">, node: string | null): TurnRecoveryDecision {
	const e = pane.engine;
	if (!e || !turn.ledger) return { decision: "intact", reason: "unverifiable_runner" };
	const read = e.consumed.some(([id]) => id === turn.inputId) || (pane.consumedInputs ?? []).includes(turn.inputId);
	if (read) return { decision: "intact", reason: "consumed" };
	if (turn.receipt === "conflict") return { decision: "block", reason: "content_conflict" };
	if (e.ledger === turn.ledger && e.epoch === turn.epoch) return { decision: "intact", reason: "same_process" };
	if (normalizeRunnerNode(node) !== normalizeRunnerNode(turn.node)) return { decision: "block", reason: "machine_changed" };
	if (!pane.alive) return { decision: "block", reason: "engine_absent" };
	if (turn.recovery) return { decision: "block", reason: "recovery_lost" };
	return { decision: "resume", reason: "engine_replaced", resumeInputId: recoveryInputId(turn.inputId) };
}

/** The one recovery turn: names the cut-off turn and asks what of it took effect — never the command again. */
export function recoveryInstruction(turn: InflightTurn): string {
	return [
		`[platform] Your previous turn (${turn.inputId}) was cut off: the runner restarted or the engine process was replaced before it finished, so whether it took effect is unknown.`,
		"Do not redo it. Check what already happened — `git status`, `git log -5`, and whether anything was pushed, merged or opened — then report what of that turn took effect and what remains.",
	].join("\n");
}

const SAFE_ACTION: Record<TurnRecoveryReason, string> = {
	unverifiable_runner: "None — this runner does not report an input ledger, so a lost turn cannot be told apart from a finished one.",
	consumed: "None — the turn completed.",
	same_process: "None — the same engine process is still running the turn.",
	machine_changed: "Inspect the first machine's worktree (or what it pushed) before continuing: the run moved to another machine, whose checkout cannot show what the lost turn did, so nothing was re-sent there.",
	content_conflict: "Inspect the worktree (git status / git log) before continuing: the runner holds different content under this turn's id, so nothing is re-sent automatically.",
	engine_absent: "Bring the runner back (`pags up`), inspect the worktree for partial work, then continue the run — its briefing says the last turn was lost. Nothing was re-sent.",
	recovery_lost: "Inspect the worktree (git status / git log) for partial work before continuing: the turn and its one recovery were both lost, and nothing more is re-sent automatically.",
	engine_replaced: "None needed — ONE recovery turn asked the engine what of the cut-off turn took effect; the command itself was not re-sent.",
};

/** The owner-scoped diagnostic record of one decision: correlation, decision, reason, timestamps, safe next action. */
export function turnRecoveryRecord(
	turn: InflightTurn,
	pane: Pick<CodingPaneSnapshot, "alive" | "engine">,
	d: TurnRecoveryDecision,
	ctx: { runId: string | null; sessionId: string; node: string | null; detectedAt: number },
) {
	return {
		runId: ctx.runId,
		sessionId: ctx.sessionId,
		turnInputId: turn.inputId,
		recoveryInputId: d.decision === "resume" ? d.resumeInputId : null,
		decision: d.decision,
		reason: d.reason,
		receipt: turn.receipt,
		before: { ledger: turn.ledger, epoch: turn.epoch, node: turn.node },
		after: { ledger: pane.engine?.ledger ?? null, epoch: pane.engine?.epoch ?? null, node: ctx.node, alive: pane.alive },
		restarted: !!pane.engine && !!turn.ledger && pane.engine.ledger !== turn.ledger,
		sentAt: new Date(turn.sentAt).toISOString(),
		detectedAt: new Date(ctx.detectedAt).toISOString(),
		safeAction: SAFE_ACTION[d.reason],
	};
}

/** One line for the owner's timeline and the run's stop detail. */
export function describeTurnRecovery(r: ReturnType<typeof turnRecoveryRecord>): string {
	const what = r.restarted ? "the runner restarted" : "the engine process was replaced";
	const head =
		r.decision === "resume"
			? `**Lost engine turn recovered** — ${what} before turn \`${r.turnInputId}\` finished; one recovery turn \`${r.recoveryInputId}\` checks what took effect.`
			: `**Lost engine turn** — turn \`${r.turnInputId}\` did not finish (${r.reason.replace(/_/g, " ")}); the run stops here (turn_lost).`;
	return `${head} Sent ${r.sentAt}, detected ${r.detectedAt}. Next: ${r.safeAction}`;
}
