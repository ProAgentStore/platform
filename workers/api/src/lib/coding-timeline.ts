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
	/** R2 turn id of this turn's saved voice recording (chat_user dictated by voice). */
	audioKey?: string;
}

interface Row {
	seq: number;
	type: string;
	content: string;
	created_at: string;
	audio_key?: string | null;
}

const toEntry = (r: Row): TimelineEntry => ({ seq: r.seq, type: r.type as TimelineType, content: r.content, createdAt: r.created_at, audioKey: r.audio_key ?? undefined });

/** Append one entry to a session's timeline. */
export async function appendTimeline(
	env: Env,
	args: { sessionId: string; instanceId: string; userId: string; type: TimelineType; content: string; audioKey?: string },
): Promise<void> {
	if (!args.content) return;
	const audioKey = typeof args.audioKey === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(args.audioKey) ? args.audioKey : null;
	await env.DB.prepare(
		"INSERT INTO coding_timeline (session_id, instance_id, user_id, type, content, audio_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
	)
		.bind(args.sessionId, args.instanceId, args.userId, args.type, args.content.slice(0, 100_000), audioKey)
		.run();
}

/** The full timeline for a session, oldest→newest (capped). */
export async function loadTimeline(env: Env, sessionId: string, limit = 500): Promise<TimelineEntry[]> {
	const { results } = await env.DB.prepare(
		"SELECT seq, type, content, created_at, audio_key FROM coding_timeline WHERE session_id = ?1 ORDER BY seq DESC LIMIT ?2",
	)
		.bind(sessionId, limit)
		.all<Row>();
	return (results ?? []).map(toEntry).reverse();
}

/** The conversation turns the console renders as the chat thread. Includes `command`
 * (things you sent the CLI manually) so they show as your turns, not vanish. */
export async function loadChat(env: Env, sessionId: string, limit = 200): Promise<TimelineEntry[]> {
	const { results } = await env.DB.prepare(
		"SELECT seq, type, content, created_at, audio_key FROM coding_timeline WHERE session_id = ?1 AND type IN ('chat_user','chat_assistant','command') ORDER BY seq DESC LIMIT ?2",
	)
		.bind(sessionId, limit)
		.all<Row>();
	return (results ?? []).map(toEntry).reverse();
}

/** Clear the conversation turns for a session (the console "Clear" button). Keeps
 * the activity log (terminal/brain/outcome) — only the chat thread is wiped. Also
 * deletes any saved voice recordings for those turns so their R2 blobs don't orphan. */
export async function clearChat(env: Env, sessionId: string, userId: string, instanceId: string): Promise<void> {
	// Collect the saved-recording ids BEFORE deleting the rows so we can drop the blobs.
	const { results } = await env.DB.prepare(
		"SELECT audio_key FROM coding_timeline WHERE session_id = ?1 AND type = 'chat_user' AND audio_key IS NOT NULL",
	)
		.bind(sessionId)
		.all<{ audio_key: string }>();
	await env.DB.prepare(
		"DELETE FROM coding_timeline WHERE session_id = ?1 AND type IN ('chat_user','chat_assistant','command')",
	)
		.bind(sessionId)
		.run();
	for (const r of results ?? []) {
		if (r.audio_key && env.STORAGE) {
			await env.STORAGE.delete(`voice-audio/${userId}/${instanceId}/${r.audio_key}`).catch(() => undefined);
		}
	}
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
