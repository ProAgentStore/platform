import { runUserWorkersAi } from "./user-ai.js";
import { hitOutputCap } from "./reply-truncation.js";
import { authorityInstruction, screenInstruction, type MergePolicy } from "./coding-authority.js";
import type { UsageContext } from "./usage.js";
import type { Env } from "../types.js";

/**
 * The coding orchestrator's brain loop.
 *
 * The local coding CLI (Claude Code / Gemini / …) is itself an agent running in
 * a tmux pane; this loop is the *orchestrator* over it (AgentCoder's "Option B"):
 * look at the pane, decide the single next instruction to send (or that the goal
 * is met / a human is needed), send it, wait for idle, repeat. Pure orchestration
 * over {@link CodingDeps} so it unit-tests without tmux, an LLM, or a Workflow —
 * exactly like {@link runApplyLoop} for the browser runtime.
 */

export interface CodingGoal {
	/** What the user wants done in this repo (the high-level task). */
	objective: string;
	/** Repo display name / path, for context. */
	repo: string;
	clientType: "claude" | "gemini" | "codex" | "grok";
	/** The user's free-text rules (Special Instructions), injected at top of prompt. */
	specialInstructions?: string;
	/** Live free-text message the user sent while the agent was paused/stuck. */
	userHint?: string;
	/** Test mode: plan + send guidance but NEVER let a destructive action through. */
	dryRun?: boolean;
	/**
	 * What this run may do with the repo's trunk (#314). Resolved once by the workflow from the
	 * repo override / agent setting / platform default — see lib/coding-authority.ts. Absent behaves
	 * as `merge`, which is the pre-existing behaviour.
	 */
	mergePolicy?: MergePolicy;
}

/** What the orchestrator "sees": the current pane plus the CLI's run-state. */
export interface CodingPaneSnapshot {
	pane: string;
	runState: "idle" | "thinking" | "responding";
	ready: boolean;
	alive: boolean;
	/** True when the user pressed Stop — the loop halts immediately. */
	cancelled?: boolean;
	/**
	 * Why the run was stopped, when it was stopped by something other than the user's Stop button.
	 *
	 * Without it every halt reported the bare outcome "cancelled", which is indistinguishable from
	 * a human pressing Stop — so a run halted for merging against policy (#314) would look like the
	 * owner had changed their mind.
	 */
	stopReason?: string;
}

/**
 * What the cloud can ask a coding session to do.
 *
 * `{kind:"keys"}` was removed in #448. It had no producer left — the brain stopped offering
 * `press_keys` (see `CODING_TOOLS` below) and `/message` now refuses `{keys}` with a 409 — but
 * while the kind stayed in this union the mapping back into it was one line away from being
 * re-added, which is exactly how it survived the first fix. The engine is a child process with
 * no PTY; there is no keystroke to send, and the type now says so.
 */
export type CodingActionKind = { kind: "message"; text: string } | { kind: "interrupt" };

export type CodingOutcome = "done" | "stuck" | "needs_input" | "failed" | "max_steps" | "cancelled";

export interface CodingDecision {
	thought?: string;
	action?: CodingActionKind;
	finish?: { status: "done" | "failed"; detail: string };
	/** The orchestrator can't proceed without a human (stuck handoff). */
	stuck?: { why: string };
	/** A value only the user can provide (ask-and-hold). */
	needsInput?: { field: string; why?: string };
	usage?: { input: number; output: number };
	/**
	 * The provider stopped this decision at its output cap (#504).
	 *
	 * `stopReason` reached this path with #397 and was thrown away here — its only reader was the
	 * chat path — so "the brain was cut off mid-instruction" and "the brain said nothing" arrived
	 * looking identical. They call for different words to the owner and different next steps, so
	 * the fact is carried rather than re-inferred from the shape of an empty reply.
	 */
	truncated?: boolean;
}

export interface CodingResult {
	outcome: CodingOutcome;
	detail?: string;
	fieldNeeded?: string;
	steps: number;
	transcript?: string[];
}

/** Side-effecting hooks — real ones hit the runner; tests mock them. */
export interface CodingDeps {
	snapshot: () => Promise<CodingPaneSnapshot>;
	act: (action: CodingActionKind) => Promise<CodingPaneSnapshot>;
	decide: (params: { goal: CodingGoal; actionLog: string[]; snapshot: CodingPaneSnapshot }) => Promise<CodingDecision>;
	/** Wait for the CLI to go idle (poll), returning the final snapshot. */
	waitIdle: () => Promise<CodingPaneSnapshot>;
	onEvent?: (type: string, message: string, data?: unknown) => Promise<void> | void;
}

/**
 * How many refusals the merge-authority screen may issue before the run finishes.
 *
 * The screen is a heuristic over natural language (see coding-authority.ts), so it needs a bound:
 * a brain that keeps rephrasing the same forbidden instruction must not burn all 40 BYOK-Claude
 * decisions doing it. Three is enough for the brain to genuinely change course after reading the
 * refusal in its own step log, and small enough that a false positive costs a stopped run with a
 * clear reason rather than a long silent one.
 */
const MAX_REFUSALS = 3;

/**
 * How many empty instructions in a row end the run (#504).
 *
 * CONSECUTIVE, and reset by any instruction that is actually sent, because the production run this
 * comes from recovered on its own: eleven of nineteen steps were empty, but the brain went back to
 * a short instruction each time it was told nothing had been sent. Three in a row is the point at
 * which it is not recovering, and stopping there costs a named failure instead of the 4.6 minutes
 * of engine turns and BYOK decisions that run spent driving "" into a live coding CLI.
 */
const MAX_EMPTY_INSTRUCTIONS = 3;

export async function runCodingLoop(deps: CodingDeps, goal: CodingGoal, opts: { maxSteps?: number } = {}): Promise<CodingResult> {
	const maxSteps = opts.maxSteps ?? 30;
	const transcript: string[] = [];
	const actionLog: string[] = [];
	let refusals = 0;
	let emptyInstructions = 0;

	for (let step = 0; step < maxSteps; step++) {
		let snap = await deps.snapshot();
		if (snap.cancelled) return { outcome: "cancelled", detail: snap.stopReason, steps: step, transcript };
		if (!snap.alive) return { outcome: "failed", detail: "coding session is not running", steps: step, transcript };

		// Let the CLI finish whatever it's doing before deciding the next move.
		if (snap.runState !== "idle") {
			snap = await deps.waitIdle();
			if (snap.cancelled) return { outcome: "cancelled", detail: snap.stopReason, steps: step, transcript };
		}

		const decision = await deps.decide({ goal, actionLog, snapshot: snap });
		if (decision.thought) await deps.onEvent?.("thought", decision.thought);

		if (decision.finish) {
			transcript.push(`finish: ${decision.finish.status} — ${decision.finish.detail}`);
			return {
				outcome: decision.finish.status === "done" ? "done" : "failed",
				detail: decision.finish.detail,
				steps: step,
				transcript,
			};
		}
		if (decision.stuck) {
			return { outcome: "stuck", detail: decision.stuck.why, steps: step, transcript };
		}
		if (decision.needsInput) {
			return { outcome: "needs_input", detail: decision.needsInput.why, fieldNeeded: decision.needsInput.field, steps: step, transcript };
		}
		if (!decision.action) {
			// No action and no terminal verdict → treat prose as a stuck signal.
			return { outcome: "stuck", detail: decision.thought ?? "no action chosen", steps: step, transcript };
		}

		// AN INSTRUCTION WITH NO WORDS IS NOT AN INSTRUCTION (#504). It was driven into the engine
		// anyway — `session.input("")` writes an empty user turn to Claude Code's stdin, the pane
		// flips to "thinking", and the loop then waits out a turn that was asked nothing. The owner
		// watching the Assistant tab read eleven "**Loop → engine** (step N): message:" lines with
		// nothing after them.
		//
		// Handled HERE, not in `toDecision`, because the invariant is about `deps.act` and this is the
		// only place every decider passes through — the workflow wraps `decide` in a budget
		// reservation, and a guard inside the Claude-backed mapper would not cover it.
		//
		// Fed back through `actionLog` exactly as a merge refusal is: the loop already talks to itself
		// through the step log the next decision renders, and the brain demonstrably reacts to it. The
		// note names the remedy (be shorter) because the leading hypothesis for the empties is an
		// instruction truncated at the output cap.
		if (decision.action.kind === "message" && !decision.action.text.trim()) {
			emptyInstructions++;
			const why = decision.truncated
				? "it was cut off at the model's output limit before any text arrived"
				: "the brain returned an instruction with no text";
			const note = `empty instruction not sent (${why}) — send a SHORTER, self-contained instruction`;
			actionLog.push(note);
			transcript.push(note);
			await deps.onEvent?.("empty", note);
			if (emptyInstructions >= MAX_EMPTY_INSTRUCTIONS) {
				return {
					outcome: "failed",
					detail: `The orchestrator produced ${emptyInstructions} empty instructions in a row (${why}). Nothing was sent to the engine — try again with a narrower objective.`,
					steps: step,
					transcript,
				};
			}
			continue;
		}
		emptyInstructions = 0;

		// MERGE AUTHORITY (#314): the orchestrator's own instruction is screened before it reaches
		// the Engine. This is the layer that would have stopped run 73ffc073 — its objective said
		// "merge each before starting the next" and the Pilot dutifully relayed it three times.
		//
		// The refusal goes into `actionLog`, which is rendered back to the brain as "Steps so far"
		// on the next decision, so it ADAPTS rather than repeating: the loop already communicates
		// with itself through that log and this needs no new channel. A no-op under the default
		// policy, where `screenInstruction` returns null for everything.
		const refusal = decision.action.kind === "message" ? screenInstruction(goal.mergePolicy ?? "merge", decision.action.text) : null;
		if (refusal) {
			refusals++;
			const note = `refused (merge authority): ${refusal}`;
			actionLog.push(note);
			transcript.push(note);
			await deps.onEvent?.("refused", refusal);
			// Finish with the reason rather than exhausting the step budget in silence. "failed" is
			// the honest status: the objective as given cannot be completed under this policy, and
			// the detail says exactly why so the owner can approve the merge themselves.
			if (refusals >= MAX_REFUSALS) return { outcome: "failed", detail: refusal, steps: step, transcript };
			continue;
		}

		const label = describe(decision.action);
		actionLog.push(label);
		transcript.push(label);
		// The ACTION rides along with its label. `describe` truncates to 120 characters and
		// prefixes the kind, which is right for a step log and useless as a transcript entry —
		// and the Pilot has to write the instruction it drove into `coding_timeline` VERBATIM
		// (#374). That record used to come from the `/message` route the browser Loop relayed
		// through, and nothing replaces it once the Pilot drives the engine instead.
		await deps.onEvent?.("action", label, decision.action);
		await deps.act(decision.action);
		// After sending an instruction, let the CLI run to completion before the
		// next decision — otherwise the brain reasons over a stale (pre-response)
		// pane and may double-send. waitIdle settles, then polls until idle.
		if (decision.action.kind === "message") await deps.waitIdle();
	}

	return { outcome: "max_steps", detail: `gave up after ${maxSteps} steps`, steps: maxSteps, transcript };
}

function describe(a: CodingActionKind): string {
	switch (a.kind) {
		case "message":
			return `message: ${a.text.slice(0, 120)}`;
		case "interrupt":
			return "interrupt (Ctrl-C)";
	}
}

// ── The Claude-backed decision (the actual "brain") ─────────────────────────

/**
 * Output ceiling for one Pilot decision (#504).
 *
 * This call inherited `runAnthropic`'s 1024-token fallback — the number #397's own docstring says
 * is "picked for nothing in particular" and lists every other caller as having replaced. The Pilot
 * is a caller that legitimately writes long: a `send_message` argument routinely carries a shell
 * script or a multi-file plan, and a tool call cut off at the cap is the empty instruction this
 * issue is about.
 *
 * 2048 tokens ≈ 8,000 characters of instruction, which fits a script comfortably, and
 * `generationBudgetMs(2048)` is 88s — inside both `AI_TOTAL_TIMEOUT_MS` (180s) and the decide
 * step's 3-minute Workflow timeout, which 4096 (156s) would leave almost no margin under. The
 * ceiling is the one that is affordable to WAIT for, not the largest one the model would accept.
 */
const PILOT_MAX_TOKENS = 2048;

const CODING_TOOLS = [
	{
		name: "send_message",
		description: "Send a natural-language instruction to the coding CLI (the next single step toward the objective).",
		parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	},
	// NO press_keys. `HeadlessSession.key()` is an unconditional no-op — correct, because a
	// headless engine has no TTY to receive keystrokes — but the tool was still advertised, mapped
	// to `{kind:"keys"}`, routed into `key()` and answered with a normal snapshot, indistinguishable
	// from success. So a menu ("1) Sign in with…") produced: brain calls press_keys("Enter") →
	// nothing sent → unchanged pane → `waitIdle` is skipped for non-message actions → the next
	// decision sees the identical pane and repeats. The run burned all 40 decisions of BYOK Claude
	// and ended `max_steps` having done nothing. A menu is now a `request_human`, which is true.
	// #448 finished the job at the HTTP boundary: `POST …/message {keys}` answers 409 instead of
	// 200-with-a-snapshot, and `{kind:"keys"}` is gone from `CodingActionKind` entirely.
	{
		name: "finish",
		description: "The objective is complete (status 'done') or cannot be completed (status 'failed').",
		parameters: { type: "object", properties: { status: { type: "string", enum: ["done", "failed"] }, detail: { type: "string" } }, required: ["status", "detail"] },
	},
	{
		name: "request_human",
		description: "You are stuck and a human must take over the live session (e.g. an interactive auth prompt you can't answer).",
		parameters: { type: "object", properties: { why: { type: "string" } }, required: ["why"] },
	},
	{
		name: "request_user_info",
		description: "Ask the user for a specific value you do not have and must not invent (ask-and-hold).",
		parameters: { type: "object", properties: { field: { type: "string" }, why: { type: "string" } }, required: ["field"] },
	},
] as const;

function systemPrompt(goal: CodingGoal): string {
	const lines: string[] = [];
	if (goal.specialInstructions) lines.push(`USER RULES (highest priority):\n${goal.specialInstructions}\n`);
	lines.push(
		`You orchestrate a local "${goal.clientType}" AI coding CLI running in a terminal in the repo "${goal.repo}".`,
		`OBJECTIVE: ${goal.objective}`,
		"",
		"You see the terminal pane. Decide the SINGLE next step and call exactly one tool.",
		"- Drive the CLI with natural-language instructions via send_message; it does the editing/running.",
		"- You CANNOT send keystrokes: the CLI runs headless with no terminal attached. If it is waiting on a menu or a y/n prompt, either phrase the answer as an instruction via send_message, or call request_human.",
		"- When the objective is satisfied, call finish(status:'done'). If it's impossible, finish(status:'failed').",
		"- If a value is required that only the user has, call request_user_info — NEVER invent secrets, tokens, or personal data.",
		"- If you hit something a human must handle live (interactive login, captcha), call request_human.",
		"Never output step-by-step thinking; just call one tool.",
	);
	// Placed AFTER the objective and the user rules, and worded as overriding both, because the
	// conflict this exists for is with the objective itself — "merge each before starting the next"
	// is what a human typed. Null under the default policy, so the unconfigured prompt is unchanged.
	const authority = authorityInstruction(goal.mergePolicy ?? "merge");
	if (authority) lines.push(`\n${authority}`);
	if (goal.dryRun) lines.push("\nTEST MODE: avoid destructive or irreversible instructions; prefer read-only/plan steps.");
	if (goal.userHint) lines.push(`\nThe user just told you: ${goal.userHint}`);
	return lines.join("\n");
}

export async function decideCodingAction(
	env: Env,
	userId: string,
	params: { goal: CodingGoal; actionLog: string[]; snapshot: CodingPaneSnapshot },
	usageCtx?: UsageContext,
): Promise<CodingDecision> {
	const userMsg = [
		`Steps so far:\n${params.actionLog.length ? params.actionLog.map((a, i) => `${i + 1}. ${a}`).join("\n") : "(none yet)"}`,
		`\nTERMINAL (run-state: ${params.snapshot.runState}):`,
		params.snapshot.pane.slice(-6000),
		"\nDo the single next step toward the objective. Call exactly one tool.",
	].join("\n");

	const res = (await runUserWorkersAi(env, userId, "claude-sonnet-4-6", {
		messages: [
			{ role: "system", content: systemPrompt(params.goal) },
			{ role: "user", content: userMsg },
		],
		tools: CODING_TOOLS,
		maxTokens: PILOT_MAX_TOKENS,
	}, usageCtx)) as {
		response?: string;
		tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>;
		usage?: { input: number; output: number };
		stopReason?: string;
	};

	const truncated = hitOutputCap(res.stopReason);
	const call = res.tool_calls?.[0];
	if (!call) {
		// The two endings that used to read identically. "No action chosen" is a brain that replied
		// in prose; a cap stop is a brain whose tool call did not fit, which is a different problem
		// with a different remedy, and the owner is told which one happened.
		const why = truncated
			? "The decision was cut off at the model's output limit before it named an action."
			: res.response || "no action chosen";
		return { thought: res.response, stuck: { why }, usage: res.usage, truncated };
	}
	return { ...toDecision(call), usage: res.usage, thought: res.response, truncated };
}

function toDecision(call: { name: string; arguments: Record<string, unknown> }): CodingDecision {
	const a = call.arguments ?? {};
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	switch (call.name) {
		case "send_message":
			return { action: { kind: "message", text: str(a.text) } };
		case "press_keys":
			// No longer offered; if an older/cached tool list produces one, say so honestly rather
			// than routing it into a no-op that reads as success.
			return { stuck: { why: "Tried to press a key, but this session has no terminal attached — a human needs to answer the prompt." } };
		case "finish":
			return { finish: { status: str(a.status) === "failed" ? "failed" : "done", detail: str(a.detail) } };
		case "request_human":
			return { stuck: { why: str(a.why) || "needs a human" } };
		case "request_user_info":
			return { needsInput: { field: str(a.field) || "a value", why: str(a.why) } };
		default:
			return { stuck: { why: `unknown tool ${call.name}` } };
	}
}
