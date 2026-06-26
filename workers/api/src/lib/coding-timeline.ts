import type { Env } from "../types.js";

/**
 * Persistent per-session coding history (the `coding_timeline` table).
 *
 * One append-only, chronologically-ordered log per session that interleaves the
 * co-pilot conversation, terminal snapshots, commands, brain actions, and
 * outcomes. The console reloads the conversation from here; the co-pilot reads
 * the recent slice for continuity ("what did we discuss / what did the agent do
 * / how did it turn out"). All access is owner-scoped at the route layer.
 */

export type TimelineType =
	| "chat_user"
	| "chat_assistant"
	| "terminal"
	| "command"
	| "brain"
	| "outcome"
	| "system";

export interface TimelineEntry {
	seq: number;
	type: TimelineType;
	content: string;
	createdAt: string;
}

interface Row {
	seq: number;
	type: string;
	content: string;
	created_at: string;
}

const toEntry = (r: Row): TimelineEntry => ({ seq: r.seq, type: r.type as TimelineType, content: r.content, createdAt: r.created_at });

/** Append one entry to a session's timeline. */
export async function appendTimeline(
	env: Env,
	args: { sessionId: string; instanceId: string; userId: string; type: TimelineType; content: string },
): Promise<void> {
	if (!args.content) return;
	await env.DB.prepare(
		"INSERT INTO coding_timeline (session_id, instance_id, user_id, type, content) VALUES (?1, ?2, ?3, ?4, ?5)",
	)
		.bind(args.sessionId, args.instanceId, args.userId, args.type, args.content.slice(0, 100_000))
		.run();
}

/** The full timeline for a session, oldest→newest (capped). */
export async function loadTimeline(env: Env, sessionId: string, limit = 500): Promise<TimelineEntry[]> {
	const { results } = await env.DB.prepare(
		"SELECT seq, type, content, created_at FROM coding_timeline WHERE session_id = ?1 ORDER BY seq DESC LIMIT ?2",
	)
		.bind(sessionId, limit)
		.all<Row>();
	return (results ?? []).map(toEntry).reverse();
}

/** Just the conversation turns (what the console renders as the chat thread). */
export async function loadChat(env: Env, sessionId: string, limit = 200): Promise<TimelineEntry[]> {
	const { results } = await env.DB.prepare(
		"SELECT seq, type, content, created_at FROM coding_timeline WHERE session_id = ?1 AND type IN ('chat_user','chat_assistant') ORDER BY seq DESC LIMIT ?2",
	)
		.bind(sessionId, limit)
		.all<Row>();
	return (results ?? []).map(toEntry).reverse();
}

/** The most recent stored terminal snapshot (used to dedupe before storing a new one). */
export async function lastTerminal(env: Env, sessionId: string): Promise<string | null> {
	const row = await env.DB.prepare(
		"SELECT content FROM coding_timeline WHERE session_id = ?1 AND type = 'terminal' ORDER BY seq DESC LIMIT 1",
	)
		.bind(sessionId)
		.first<{ content: string }>();
	return row?.content ?? null;
}

/**
 * Render the recent timeline into a compact context block for the co-pilot
 * prompt — so it remembers the conversation, what the agent did, and outcomes.
 */
export async function contextForCopilot(env: Env, sessionId: string, limit = 40): Promise<string> {
	const entries = await loadTimeline(env, sessionId, limit);
	if (!entries.length) return "";
	const label: Record<TimelineType, string> = {
		chat_user: "You(user)",
		chat_assistant: "You(copilot)",
		terminal: "Terminal",
		command: "Command sent",
		brain: "Agent action",
		outcome: "Outcome",
		system: "System",
	};
	return entries
		.map((e) => {
			// Terminal snapshots are long — keep only a tail in the rolling context.
			const body = e.type === "terminal" ? e.content.slice(-1200) : e.content.slice(0, 2000);
			return `[${label[e.type] ?? e.type}] ${body}`;
		})
		.join("\n");
}
