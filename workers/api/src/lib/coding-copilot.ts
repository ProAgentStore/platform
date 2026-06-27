import { runUserWorkersAi } from "./user-ai.js";
import type { Env } from "../types.js";

/**
 * The coding co-pilot — a read-only observer that watches the CLI's terminal and
 * tells the user the gist in plain language. Shared by the `/explain` route (you
 * Ask it) and the workflow watcher (it proactively reports when the CLI finishes).
 */
const SYSTEM =
	"You are a co-pilot watching the terminal of an AI coding agent working in the user's repo. The user is NOT reading the terminal — they want the GIST, not a report.\n" +
	"DEFAULT (no specific question): MAXIMUM 2 short sentences (~30 words). First say anything NEEDED FROM THE USER (a decision/answer/approval, or that it's stuck/done); else one line like \"Working on X — nothing needed yet.\" NO bullet lists, NO step-by-step, NO code blocks. Shorter is better.\n" +
	"PROGRESSIVE DETAIL: only when the user asks a follow-up (\"more\", \"details\", \"why\", \"show me\") give MORE than your previous reply — and even then stay tight, add one layer at a time. NEVER dump the whole terminal.\n" +
	"Use the session memory below for continuity. Plain language. Never pad or restate the obvious.";

export interface CopilotArgs {
	/** A user follow-up question; empty = auto status/summary. */
	question?: string;
	/** Recent persisted timeline, for continuity. */
	memory?: string;
	/** The terminal pane the agent is reasoning over. */
	pane?: string;
	/** Reframe as an after-the-fact summary of a just-completed instruction. */
	finished?: boolean;
	/** Combined instance + repo special instructions. */
	specialInstructions?: string;
}

/** Generate a co-pilot reply. Returns "" if the model gave nothing. */
export async function copilotSummary(env: Env, userId: string | undefined, args: CopilotArgs): Promise<string> {
	const question = (args.question || "").trim();
	const pane = args.pane || "";
	const lead = args.finished
		? "The agent just FINISHED the instruction you see at the end of the terminal. In at most 2 short sentences, say what it did and whether it now needs anything from you.\n\n"
		: question
			? `My question: ${question}\n\n`
			: "One-line status: what's happening, and what (if anything) do you need from me?\n\n";
	const userMsg =
		lead +
		(args.specialInstructions ? `USER INSTRUCTIONS (follow these):\n${args.specialInstructions}\n\n` : "") +
		(args.memory ? `SESSION MEMORY (recent, oldest→newest):\n${args.memory}\n\n` : "") +
		`TERMINAL (most recent output):\n${pane.slice(-6000) || "(no live terminal — the runner is offline or the session hasn't started)"}`;

	const res = (await runUserWorkersAi(env, userId, "claude-sonnet-4-6", {
		messages: [
			{ role: "system", content: SYSTEM },
			{ role: "user", content: userMsg },
		],
		maxTokens: question ? 600 : 160,
	})) as { response?: string };
	return res.response || "";
}
