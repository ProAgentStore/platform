import { runUserWorkersAi } from "./user-ai.js";
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

export type CodingActionKind =
	| { kind: "message"; text: string }
	| { kind: "keys"; keys: string }
	| { kind: "interrupt" };

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

export async function runCodingLoop(deps: CodingDeps, goal: CodingGoal, opts: { maxSteps?: number } = {}): Promise<CodingResult> {
	const maxSteps = opts.maxSteps ?? 30;
	const transcript: string[] = [];
	const actionLog: string[] = [];
	let refusals = 0;

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
		await deps.onEvent?.("action", label);
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
		case "keys":
			return `keys: ${a.keys}`;
		case "interrupt":
			return "interrupt (Ctrl-C)";
	}
}

// ── The Claude-backed decision (the actual "brain") ─────────────────────────

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
	}, usageCtx)) as { response?: string; tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>; usage?: { input: number; output: number } };

	const call = res.tool_calls?.[0];
	if (!call) return { thought: res.response, stuck: { why: res.response || "no action chosen" }, usage: res.usage };
	return { ...toDecision(call), usage: res.usage, thought: res.response };
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
