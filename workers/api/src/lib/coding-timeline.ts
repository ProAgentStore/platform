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
	/**
	 * Which session produced this entry. Only populated by the repo-scoped read, where entries
	 * from several sessions are interleaved and the boundaries are what the UI draws separators
	 * from — a per-session read already knows the answer and would just repeat it on every row.
	 */
	sessionId?: string;
}

interface Row {
	seq: number;
	type: string;
	content: string;
	created_at: string;
	audio_key?: string | null;
	session_id?: string | null;
}

const toEntry = (r: Row): TimelineEntry => ({ seq: r.seq, type: r.type as TimelineType, content: r.content, createdAt: r.created_at, audioKey: r.audio_key ?? undefined, sessionId: r.session_id ?? undefined });

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

/**
 * A REPO's history, across every session that ever ran on it (#257).
 *
 * The read that was missing. `loadTimeline` above is per session, and a session is a short-lived
 * thing the platform ends by itself — the Pilot closes one every time a run finishes, the orphan
 * reaper closes the rest on each `pags up` restart. So "the terminal" as a user means it (the
 * output for this repo, in order, forever) had no query, and the console rendered "Start a session"
 * over a database full of exactly what they were asking for.
 *
 * Owner-scoped in the SQL itself rather than at the route: this is reached from a repo id, and a
 * repo id that is not the caller's must return nothing here even if a route ever forgets to check.
 *
 * Newest-first + reverse, matching `loadTimeline`: the cap has to keep the LATEST rows, and
 * `ORDER BY seq ASC LIMIT n` would keep the oldest — a repo with long history would show its first
 * session forever and never the run that just finished.
 */
export async function loadRepoTimeline(
	env: Env,
	args: { instanceId: string; userId: string; repoId: string; limit?: number },
): Promise<TimelineEntry[]> {
	const limit = Math.max(1, Math.min(2000, args.limit ?? 500));
	const { results } = await env.DB.prepare(
		`SELECT t.seq, t.type, t.content, t.created_at, t.audio_key, t.session_id
		   FROM coding_timeline t
		   JOIN coding_sessions s ON s.id = t.session_id
		  WHERE t.instance_id = ?1 AND t.user_id = ?2 AND s.repo_id = ?3
		  ORDER BY t.seq DESC LIMIT ?4`,
	)
		.bind(args.instanceId, args.userId, args.repoId, limit)
		.all<Row>();
	return (results ?? []).map(toEntry).reverse();
}

/**
 * A page of a session's terminal snapshots, newest page first (#432).
 *
 * The terminal had no scrollback: `?full=1` shipped every `terminal` row of the session and the
 * client kept the LAST one and dropped the rest. So the payload was already the size of the whole
 * history while the UI could only ever show one pane of it.
 *
 * The cursor is a keyset on `seq`: `before` is EXCLUSIVE, rows come back oldest→newest (render
 * order), and `hasMore` says whether anything older exists. `seq` is the table's AUTOINCREMENT
 * primary key, so it is stable, gapless-enough and already indexed by `(session_id, type, seq)` —
 * no offset scan, and a row appended mid-scroll cannot shift a page. Deliberately the same
 * `before`/`limit`/`hasMore` shape the chat thread needs (#428), so one convention covers both.
 */
export async function loadTerminalSnapshots(
	env: Env,
	args: { sessionId: string; before?: number; limit?: number },
): Promise<{ entries: TimelineEntry[]; hasMore: boolean; oldestSeq: number | null }> {
	const limit = Math.max(1, Math.min(50, args.limit ?? 5));
	const before = Number.isFinite(args.before) && (args.before as number) > 0 ? (args.before as number) : Number.MAX_SAFE_INTEGER;
	// One row over the limit, purely to answer `hasMore` without a second COUNT query.
	const { results } = await env.DB.prepare(
		"SELECT seq, type, content, created_at, audio_key FROM coding_timeline WHERE session_id = ?1 AND type = 'terminal' AND seq < ?2 ORDER BY seq DESC LIMIT ?3",
	)
		.bind(args.sessionId, before, limit + 1)
		.all<Row>();
	const rows = results ?? [];
	const hasMore = rows.length > limit;
	const page = (hasMore ? rows.slice(0, limit) : rows).map(toEntry).reverse();
	return { entries: page, hasMore, oldestSeq: page.length ? page[0].seq : null };
}

/** The most recent stored terminal snapshot (used to dedupe before storing a new one). */
export async function lastTerminal(env: Env, sessionId: string): Promise<string | null> {
	return (await lastTerminalRow(env, sessionId))?.content ?? null;
}

/**
 * The most recent terminal snapshot AND when it was written.
 *
 * `lastTerminal` above keeps its exact signature — eight call sites want the text and nothing
 * else. The write gate in `/capture` needs the timestamp too, because it now throttles instead of
 * waiting for idle (#432, `lib/terminal-snapshot.ts`), and `created_at` is UTC without a zone
 * suffix, which is why the parsing is done there rather than assumed here.
 */
export async function lastTerminalRow(env: Env, sessionId: string): Promise<{ content: string; createdAt: string } | null> {
	const row = await env.DB.prepare(
		"SELECT content, created_at FROM coding_timeline WHERE session_id = ?1 AND type = 'terminal' ORDER BY seq DESC LIMIT 1",
	)
		.bind(sessionId)
		.first<{ content: string; created_at: string }>();
	return row ? { content: row.content, createdAt: row.created_at } : null;
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
