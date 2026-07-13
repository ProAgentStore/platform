import { runUserWorkersAi } from "./user-ai.js";
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
}

/** What the orchestrator "sees": the current pane plus the CLI's run-state. */
export interface CodingPaneSnapshot {
	pane: string;
	runState: "idle" | "thinking" | "responding";
	ready: boolean;
	alive: boolean;
	/** True when the user pressed Stop — the loop halts immediately. */
	cancelled?: boolean;
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

export async function runCodingLoop(deps: CodingDeps, goal: CodingGoal, opts: { maxSteps?: number } = {}): Promise<CodingResult> {
	const maxSteps = opts.maxSteps ?? 30;
	const transcript: string[] = [];
	const actionLog: string[] = [];

	for (let step = 0; step < maxSteps; step++) {
		let snap = await deps.snapshot();
		if (snap.cancelled) return { outcome: "cancelled", steps: step, transcript };
		if (!snap.alive) return { outcome: "failed", detail: "coding session is not running", steps: step, transcript };

		// Let the CLI finish whatever it's doing before deciding the next move.
		if (snap.runState !== "idle") {
			snap = await deps.waitIdle();
			if (snap.cancelled) return { outcome: "cancelled", steps: step, transcript };
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
	{
		name: "press_keys",
		description: "Send a raw key to the CLI (e.g. 'Enter', 'Escape', 'C-c') — for menus/prompts, not normal instructions.",
		parameters: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] },
	},
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
		"- Only use press_keys for menu/confirmation prompts the CLI shows.",
		"- When the objective is satisfied, call finish(status:'done'). If it's impossible, finish(status:'failed').",
		"- If a value is required that only the user has, call request_user_info — NEVER invent secrets, tokens, or personal data.",
		"- If you hit something a human must handle live (interactive login, captcha), call request_human.",
		"Never output step-by-step thinking; just call one tool.",
	);
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
			return { action: { kind: "keys", keys: str(a.keys) } };
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
