import { capToolCalls, type EngineToolCall, toolCallsForSnapshot } from "./engine-tool-calls.js";
import type { EngineUsageReport } from "./engine-usage.js";
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
	| "system"
	/**
	 * One engine turn's measured spend (#674).
	 *
	 * Written at each capture drain alongside the `ai_usage` ledger row. `content` is a compact
	 * JSON string `{"turns":[{…}]}` carrying the same fields `EngineUsageReport` holds. Absent
	 * rather than present with `turns:[]` when the drain produced no records — which is every poll
	 * where no turn completed.
	 */
	| "usage";

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

/**
 * Append a `usage` entry recording the spend for one or more engine turns (#674).
 *
 * Called alongside `recordEngineUsage` at every capture drain — the capture poll (every 3 s),
 * the session-end drain, and the Pilot Workflow drain. Each call receives the same validated
 * records `sanitizeEngineUsage` returned; it stores them compact-JSON so the feed reader can
 * expose them as structured `EngineUsageTurn[]` without re-validating.
 *
 * No-ops when `records` is empty (no turn completed on this drain) rather than writing a row
 * carrying an empty array — an empty-turns entry would read as "the engine was free this turn",
 * which is the same confident-but-unfounded claim this codebase has declined each time.
 *
 * Best-effort: instrumentation must never break the drain it observes.
 */
export async function appendEngineUsageTimeline(
	env: Env,
	args: { sessionId: string; instanceId: string; userId: string },
	records: EngineUsageReport[],
): Promise<void> {
	if (!records.length) return;
	const turns = records.map((r) => ({
		provider: r.provider,
		model: r.model,
		in: r.inputTokens,
		out: r.outputTokens,
		cacheRead: r.cacheReadTokens,
		cacheWrite: r.cacheWriteTokens,
		costUsd: r.costUsd,
	}));
	await appendTimeline(env, {
		sessionId: args.sessionId,
		instanceId: args.instanceId,
		userId: args.userId,
		type: "usage",
		content: JSON.stringify({ turns }),
	}).catch(() => undefined);
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

// ── The cursored feed: what a run is doing right now (#581), and what it did (#527) ──────────
//
// WHAT THIS RECORD ACTUALLY CONTAINS, measured before it was built rather than assumed.
//
// #581 recorded one open question — whether a `brain` row carries the instruction sent to the
// engine, "the difference between a live feed worth having and a list of timestamps". It does
// NOT, and the answer matters to anyone reading a page of this:
//
//   · `brain` is written THREE times per run, all at the start (`coding-session.ts:611-616`):
//     the objective, the repo's working state, and the merge authority. Never per iteration.
//   · the per-iteration instruction is a `command` row (`coding-session.ts:524`) — `driven`, the
//     verbatim text the Pilot sent the engine, ungated by `loopRunId` so a hand-driven session
//     records it too. THIS is the per-step narrative.
//   · `terminal` is the engine's pane, `outcome` the run's verdict, `system` its loop events.
//
// Sampled from production D1 on 2026-08-15 across 2,757 rows: `command` n=483, mean 427 chars
// (a real instruction, e.g. "Please read issue #26 … using the github_read_issue tool"); `brain`
// n=118, mean 608; `outcome` n=105, mean 361 ("done — Issue #120 is fully resolved. Commit
// `1fbb124` landed on `main` …"). So the narrative is worth reading.
//
// ── The structured half, closed at read time (#581 AC7)
//
// The paragraph that used to end here said the argument/result pairs #581 also asked for existed
// only for CONSEQUENTIAL acts, in `agent_events`, and that closing the gap was write-side work.
// The first claim was right about `agent_events` and wrong about this record. Sampled from the same
// production D1: **883 of 914 `terminal` rows carry the engine's own `⚙ <tool> <input>` /
// `↳ <result>` framing**, a mean of **12.05 calls per row** — the argument/result pairs were in
// every page this feed already served, and {@link FEED_TERMINAL_CHARS}'s 400-char tail of an
// 8,000-char pane was cutting ~95% of them away. So a `terminal` row now carries `toolCalls`,
// parsed by `engine-tool-calls.ts`, which states why deriving beats writing.
//
// Whether a call SUCCEEDED was the one field that record could not produce, and #597 closed it at
// the source: the runner welds its verdict onto the arrow (`↳✓`/`↳✗`) instead of computing it and
// dropping it. `ok` is `null` — explicitly, never absent — for a call still in flight and for every
// row written by a runner predating the marker, which is every row already in D1. That is a runner
// change, so it arrives with a CLI publish and each machine's upgrade, not retroactively.
//
// The tail STAYS beside them, and that is deliberate: #580's case is an engine error printed to the
// pane, not a tool call, and a reader that only ever saw tool calls would have missed the one thing
// AC6 was written to prove is visible.
//
// ── The payload bound, and why `limit` is not it
//
// `terminal` is 914 of those 2,757 rows at a mean of 8,068 chars and a max of 12,000 — five
// untouched snapshots overflow a 64 KiB MCP response on their own. #569 is the standing lesson
// here: a guard passed at ~54 KB while production served 66,042 B, because the size was asserted
// one layer above the one that serialises. A row cap alone repeats that mistake, since it bounds
// the COUNT of rows and nothing bounds a row.
//
// So the page is bounded twice, and the second bound is the real one:
//
//   1. per row — a `terminal` snapshot keeps its TAIL ({@link FEED_TERMINAL_CHARS}), because the
//      end of a pane is the live part; every other type keeps its HEAD
//      ({@link FEED_NARRATIVE_CHARS}), because an instruction says what it wants first. A cut row
//      carries `chars`, its true length, so a reader is never told a truncation was the whole
//      thing.
//   2. per page — events are appended until {@link FEED_BYTE_BUDGET} of SERIALISED bytes, counted
//      on `JSON.stringify` of the row itself so escaping and multi-byte characters are inside the
//      measurement rather than outside it. Hitting the budget sets `hasMore` and stops; it never
//      drops a row silently. The first row is always emitted even if it alone exceeds the budget —
//      otherwise a single large row would stall the cursor forever, which is a liveness bug
//      wearing a size fix's clothes.
//
// ── Cursor semantics: TWO arms, and which end a caller who names neither gets (#674)
//
// `since` is an EXCLUSIVE `seq`, rows come back oldest→newest, and `nextSeq` is the last seq
// returned — so the next call resumes strictly after it and consecutive pages can neither overlap
// nor skip, whichever of the two bounds ended the page. On an empty page `nextSeq` echoes the
// cursor back rather than answering null, so a poll that finds nothing does not restart from the
// beginning of the session next time (the same rule `loadTerminalSnapshots`' `after` arm follows).
// `seq` is the table's AUTOINCREMENT primary key and `idx_coding_timeline_session (session_id,
// seq)` covers the scan, so a row appended mid-poll cannot shift a page.
//
// `before` is the other arm, and it is the same one `loadTerminalSnapshots` below already carries
// over this same table: EXCLUSIVE, selected descending and reversed, so a page still renders
// oldest→newest while the WINDOW walks backwards. `hasMore` and `oldestSeq` describe the OLD end —
// whether history exists behind this page — which is a different question from the forward arm's
// `hasMore` ("more is waiting for your next poll"), and the reason both are not one field.
//
// ── Why an absent cursor answers with the NEWEST page, and what that fixed (#674)
//
// It used to answer with the oldest. A caller that passes no cursor has said nothing about where it
// wants to be, and for an append-only log the useful end is the end — the same reasoning
// `loadRepoTimeline` states below ("the cap has to keep the LATEST rows, and `ORDER BY seq ASC
// LIMIT n` would keep the oldest"). This reader was the one place in the file that contradicted it.
//
// The cost was measured, not theorised. Every instruction in a run precedes every piece of output,
// so page 1 of a real run was `brain, brain, command` with `hasMore: true`, and the owner watching
// it over MCP concluded the engine's output was not recorded at all (#674). It was recorded; it was
// behind paging. And it scaled the wrong way — the more work a run did, the further its latest
// output sat from page 1, on the tool whose stated purpose is finding out what a run is doing.
//
// What was deliberately NOT done, because both treat the symptom or buy it with a race:
//
//   · **Defaulting by session state** (finished ⇒ newest, live ⇒ oldest). The Pilot ends a session
//     on every finished run, so a live poller walking forward would be re-pointed at the newest
//     page MID-POLL — silently re-delivering or skipping, which is exactly the guarantee the
//     forward cursor exists to provide. It is also invisible: the caller can neither ask for a
//     direction nor tell from the reply which rule applied.
//   · **Guaranteeing one `terminal` row per page.** It leaves the scaling problem in place, and it
//     cannot be honoured under {@link FEED_BYTE_BUDGET} without either breaking the budget or
//     dropping the narrative rows that say why the terminal looks like that.
//
// A caller that passes `since` is untouched, byte for byte. That is the whole compatibility story:
// the poller names its cursor and keeps its direction, and only the caller who named nothing moves.

/** Rows per page when the caller does not say. */
export const FEED_DEFAULT_LIMIT = 40;
/** Ceiling on `limit`. NOT the payload bound — {@link FEED_BYTE_BUDGET} is. */
export const FEED_MAX_LIMIT = 200;
/** Chars kept from the START of a narrative row (`brain`/`command`/`outcome`/chat/`system`). */
export const FEED_NARRATIVE_CHARS = 1200;
/** Chars kept from the END of a `terminal` snapshot — a pane's tail is its live part. */
export const FEED_TERMINAL_CHARS = 400;
/**
 * Serialised-event budget for one page, in bytes. 40,000 against the 64 KiB (65,536 B) limit the
 * host in #569 applied: the remaining ~25 KB is headroom for the envelope and for JSON escaping
 * that a character count cannot see.
 */
export const FEED_BYTE_BUDGET = 40_000;
/**
 * Serialised bytes of `toolCalls` one `terminal` row may carry (#581 AC7).
 *
 * Sized so that the PAGE bound does the bounding, and this one almost never fires — because the two
 * are not equivalent losses:
 *
 *   · a call dropped by THIS cap is gone. No cursor reaches it, no second call returns it.
 *   · a row dropped by {@link FEED_BYTE_BUDGET} costs one more poll. `hasMore` says so and the
 *     cursor resumes exactly where it stopped, which is the property #581 AC2 already proved.
 *
 * Two passes got this wrong before production data settled it, and both errors are worth keeping:
 *
 *   · **1,600** — sized from the page's point of view. 40 rows at 21,354 B, and **9 of every 12
 *     calls permanently omitted**: a feed reporting a quarter of the record while claiming to carry
 *     it.
 *   · **6,000** — sized from the MEAN production row (12.05 calls at ~420 B serialised), with a
 *     docblock claiming omission was "reserved for a genuinely abnormal row". Replaying 86 real
 *     `terminal` rows through this function said otherwise: **124 of 610 calls omitted across 17
 *     rows, 20%**. The mean was the wrong statistic. A row that lost continuity re-emits its whole
 *     window (`toolCallGap`), and 35 of those 86 rows did — so the row that has to fit is the
 *     largest, not the average.
 *
 * 12,000 was the measured knee on that data, not a round number: omission reached **0** and the
 * largest real row serialised to **11,331 B**. 16,000 and 24,000 delivered exactly the same 610
 * calls, so nothing above it bought anything. #597's `ok` adds a fixed 10-11 B per call
 * (`,"ok":null`) and did not move the number.
 *
 * **Raised to 24,000 for #700**, and the reason is arithmetic rather than a new measurement: that
 * knee was measured against results the runner had already cut to 240 characters. A result may now
 * be up to `RESULT_RENDERED_MAX` (~1,840 characters, ~2,100 B serialised once its newlines are
 * escaped), so the same 12-call row that fitted in 11,331 B reaches ~25,000 B when most of its
 * calls are `Read`/`Bash`. Leaving the cap at 12,000 would have converted a widened pane into
 * PERMANENT omission in the feed — the one loss this constant exists to avoid — while the corpus
 * that set the knee kept reading as if nothing had changed, because its rows predate the change.
 * 24,000 is chosen from the two numbers already shown to be behaviour-identical on that corpus.
 *
 * A page of nothing but call-bearing snapshots simply returns fewer rows with `hasMore: true` —
 * which is the trade this is sized around, because a row dropped by {@link FEED_BYTE_BUDGET} costs
 * one more poll and a call dropped here is gone for good.
 */
export const FEED_TOOLCALL_BYTES = 24_000;

/**
 * One engine turn's token/cost record as it appears in a feed event (#674).
 *
 * Field names are compact because this appears inside every `FeedEvent` on a `usage` row and the
 * page is already byte-budgeted — verbose names multiply across every turn. Mirrors the validated
 * fields from `EngineUsageReport` without re-validating them on read.
 */
export interface EngineUsageTurn {
	model: string;
	/** Prompt / input tokens. */
	in: number;
	/** Completion / output tokens. */
	out: number;
	/** Prompt cache read tokens (Anthropic extended thinking / prompt caching). */
	cacheRead: number;
	/** Prompt cache write tokens. */
	cacheWrite: number;
	/** Notional cost in USD (tokens × list price, as reported by the CLI). */
	costUsd: number;
}

/** One timeline row, cut to fit. */
export interface FeedEvent {
	seq: number;
	type: TimelineType;
	content: string;
	createdAt: string;
	/** The FULL length of `content` in characters — present only when it was cut. */
	chars?: number;
	/**
	 * The engine's tool calls in this snapshot, with their arguments and results (#581 AC7).
	 *
	 * `terminal` rows only, and only the calls this snapshot ADDS — consecutive snapshots overlap
	 * by ~41%, so the raw parse would re-deliver the same calls on every poll. Absent (rather than
	 * empty) when the engine writes no such framing at all, which is every raw-spawn engine.
	 */
	toolCalls?: EngineToolCall[];
	/** Calls dropped by {@link FEED_TOOLCALL_BYTES}. Present only when it cut something. */
	toolCallsOmitted?: number;
	/** Continuity with the previous snapshot was lost — see `SnapshotToolCalls.gap`. */
	toolCallGap?: true;
	/**
	 * Per-turn token and cost accounting for a `usage` row (#674).
	 *
	 * `usage` rows only. Each element is one engine turn that completed since the previous drain.
	 * Absent on all other row types.
	 */
	usage?: EngineUsageTurn[];
}

export interface TimelineFeed {
	events: FeedEvent[];
	/**
	 * Pass as the next call's `since` to POLL FORWARD from this page. Echoes the cursor back when a
	 * forward page is empty; on a backward page it is the newest seq returned, which is what lets a
	 * caller read the newest page and then switch to polling from it.
	 */
	nextSeq: number;
	/**
	 * More rows exist in the direction this page was travelling — forward of `nextSeq` on a `since`
	 * page, OLDER than `oldestSeq` on a backward one. The two are not the same question, which is
	 * why `oldestSeq` accompanies it rather than being inferred from `events[0]`.
	 */
	hasMore: boolean;
	/** Oldest seq on this page — pass as the next call's `before` to walk back. Backward pages only. */
	oldestSeq?: number;
	/** How much was withheld by the per-row caps, when anything was. */
	truncated?: { events: number; chars: number };
}

/** Cut one row to its type's cap, recording its true length when that cuts anything. */
export function budgetFeedEvent(e: TimelineEntry): FeedEvent {
	const cap = e.type === "terminal" ? FEED_TERMINAL_CHARS : FEED_NARRATIVE_CHARS;
	const base = { seq: e.seq, type: e.type, createdAt: e.createdAt };
	if (e.content.length <= cap) return { ...base, content: e.content };
	// Terminal from the tail, everything else from the head — see the header.
	return { ...base, content: e.type === "terminal" ? e.content.slice(-cap) : e.content.slice(0, cap), chars: e.content.length };
}

/**
 * The tool-call anchor a page RESUMES from — the last settled call at or before the cursor.
 *
 * Without it the first `terminal` row of every page would be parsed with no predecessor and emit
 * its whole overlapping window, so a 3-second poll would re-deliver the same twelve calls forever.
 * That is the same defect `since` fixes for events, one level down, and it is fixed the same way:
 * by reading the row the cursor sits on. One indexed lookup per page, on the index
 * `(session_id, type, seq)` that `loadTerminalSnapshots` already relies on.
 */
async function anchorAt(env: Env, sessionId: string, since: number): Promise<EngineToolCall | null> {
	if (since <= 0) return null;
	const row = await env.DB.prepare(
		"SELECT content FROM coding_timeline WHERE session_id = ?1 AND type = 'terminal' AND seq <= ?2 ORDER BY seq DESC LIMIT 1",
	)
		.bind(sessionId, since)
		.first<{ content: string }>();
	return row ? toolCallsForSnapshot(row.content, null).anchor : null;
}

/**
 * A page of a session's timeline, bounded by rows AND by bytes.
 *
 * Direction is chosen by the cursor the caller names, and a caller who names neither gets the
 * NEWEST page — see the header for what that fixed (#674) and what was rejected instead.
 *
 *   · `sinceSeq` — forward from an exclusive cursor. The live poll.
 *   · `before`   — backward from an exclusive cursor. Walking a finished run's history.
 *   · neither    — the newest page, i.e. `before` at the end of the log.
 */
export async function loadTimelineFeed(
	env: Env,
	args: { sessionId: string; sinceSeq?: number; before?: number; limit?: number },
): Promise<TimelineFeed> {
	// Refused rather than resolved by precedence: the two arms answer opposite questions, and a
	// caller that sent both has a bug this would otherwise hide behind a plausible-looking page.
	if (args.sinceSeq !== undefined && args.before !== undefined) {
		throw new Error("coding timeline: pass `since` or `before`, not both — they page in opposite directions");
	}
	const limit = Math.max(1, Math.min(FEED_MAX_LIMIT, args.limit ?? FEED_DEFAULT_LIMIT));
	// `undefined` and `0` are DIFFERENT: `since=0` is an explicit "poll me from the beginning" and
	// must stay on the forward arm, while an absent cursor is the one that now means "the newest".
	const forward = args.sinceSeq !== undefined;
	const since = forward && Number.isFinite(args.sinceSeq) && (args.sinceSeq as number) > 0 ? (args.sinceSeq as number) : 0;
	const before = Number.isFinite(args.before) && (args.before as number) > 0 ? (args.before as number) : Number.MAX_SAFE_INTEGER;

	// One row over the limit, purely to answer `hasMore` without a second COUNT query.
	const { results } = forward
		? await env.DB.prepare(
				"SELECT seq, type, content, created_at FROM coding_timeline WHERE session_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
			)
				.bind(args.sessionId, since, limit + 1)
				.all<Row>()
		: await env.DB.prepare(
				"SELECT seq, type, content, created_at FROM coding_timeline WHERE session_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3",
			)
				.bind(args.sessionId, before, limit + 1)
				.all<Row>();
	const selected = (results ?? []).map(toEntry);
	let hasMore = selected.length > limit;
	// The backward arm selected newest-first so the LIMIT would keep the newest rows; the page is
	// reversed here because render order is oldest→newest on both arms, and because the tool-call
	// anchor below only means anything walking forwards.
	const rows = hasMore ? selected.slice(0, limit) : selected;
	const page = forward ? rows : [...rows].reverse();

	const encoder = new TextEncoder();
	const built: FeedEvent[] = [];
	// The row the page RESUMES from: the cursor on the forward arm, the row before this page's
	// first on the backward one. Without it the first `terminal` row would re-emit its whole
	// overlapping window — see {@link anchorAt}.
	let anchor = await anchorAt(env, args.sessionId, forward ? since : (page.length ? page[0].seq - 1 : 0));
	let cutEvents = 0;
	let cutChars = 0;
	for (const entry of page) {
		const ev = budgetFeedEvent(entry);
		if (entry.type === "terminal") {
			const found = toolCallsForSnapshot(entry.content, anchor);
			anchor = found.anchor;
			// Absent rather than empty when there is nothing: a raw-spawn engine writes no such
			// framing at all, and `"toolCalls": []` would read as "it called nothing".
			if (found.calls.length) {
				const capped = capToolCalls(found.calls, FEED_TOOLCALL_BYTES);
				ev.toolCalls = capped.calls;
				if (capped.omitted) ev.toolCallsOmitted = capped.omitted;
				if (found.gap) ev.toolCallGap = true;
			}
		} else if (entry.type === "usage") {
			// Parse the compact JSON `appendEngineUsageTimeline` wrote; silently skip any row
			// that cannot be decoded rather than surfacing a parse error to the caller (#674).
			try {
				const parsed = JSON.parse(entry.content) as { turns?: EngineUsageTurn[] };
				if (Array.isArray(parsed.turns) && parsed.turns.length) ev.usage = parsed.turns;
			} catch {
				/* best-effort: a malformed row is omitted, not a 500 */
			}
		}
		built.push(ev);
	}

	// ── The byte budget, applied from the end the page is travelling AWAY from
	//
	// Forward pages drop their newest rows (the next poll fetches them); backward pages drop their
	// OLDEST (the next `before` fetches them). Trimming the wrong end would hand a caller asking for
	// the newest page a budget-shaped slice of the middle. Either way `hasMore` says so and no row
	// is dropped silently, and the first row of the direction of travel is always emitted — a row
	// bigger than the whole budget must not stall the cursor forever.
	const events: FeedEvent[] = [];
	let bytes = 0;
	const order = forward ? built : [...built].reverse();
	for (const ev of order) {
		const cost = encoder.encode(JSON.stringify(ev)).length + 1; // +1 for the array separator
		if (events.length > 0 && bytes + cost > FEED_BYTE_BUDGET) {
			hasMore = true;
			break;
		}
		bytes += cost;
		events.push(ev);
	}
	if (!forward) events.reverse();
	for (const ev of events) {
		if (ev.chars !== undefined) {
			cutEvents++;
			cutChars += ev.chars - ev.content.length;
		}
	}

	return {
		events,
		// Always the NEWEST seq on the page, on both arms: it is the cursor you poll forward from,
		// which is how a caller reads the newest page and then tails it.
		nextSeq: events.length ? events[events.length - 1].seq : forward ? since : 0,
		hasMore,
		...(forward ? {} : { oldestSeq: events.length ? events[0].seq : undefined }),
		...(cutEvents ? { truncated: { events: cutEvents, chars: cutChars } } : {}),
	};
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
	args: { instanceId: string; userId: string; repoId: string; limit?: number; since?: number },
): Promise<TimelineEntry[]> {
	const limit = Math.max(1, Math.min(2000, args.limit ?? 500));
	// OPTIONAL, and OFF by default (#737). The one caller that sets it is `seedBriefForRepo`, whose
	// output an ENGINE reads as context: a repo-scoped read spans every session the repo ever had,
	// so without a bound the brief could open with an instruction from six weeks ago introduced as
	// "recent history" — while `resolveSessionContinuity`, one function away, had already refused to
	// resume that same conversation for being four days stale. The window is that function's
	// `RESUME_WINDOW_MS`, imported by the caller rather than restated here, so this module keeps no
	// policy of its own.
	//
	// The DEFAULT must stay unbounded. `GET …/coding/repos/:repoId/timeline` is the human-facing
	// history the console renders, and a person scrolling back through their own work is asking a
	// different question from an engine being told what is still true.
	//
	// Compared as text, in the column's own format: `created_at` is `datetime('now')`, so
	// `YYYY-MM-DD HH:MM:SS` in UTC, and that shape sorts lexicographically. Formatting the cutoff to
	// match is what makes it comparable — `toISOString()` unedited would put a `T` where the column
	// has a space, and `T` sorts ABOVE every digit, so the comparison would silently keep everything.
	const since = typeof args.since === "number" && Number.isFinite(args.since) ? new Date(args.since).toISOString().slice(0, 19).replace("T", " ") : null;
	const { results } = await env.DB.prepare(
		`SELECT t.seq, t.type, t.content, t.created_at, t.audio_key, t.session_id
		   FROM coding_timeline t
		   JOIN coding_sessions s ON s.id = t.session_id
		  WHERE t.instance_id = ?1 AND t.user_id = ?2 AND s.repo_id = ?3
		    AND (?5 IS NULL OR t.created_at >= ?5)
		  ORDER BY t.seq DESC LIMIT ?4`,
	)
		.bind(args.instanceId, args.userId, args.repoId, limit, since)
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
 *
 * ── `after`: the other half of the cursor, and why a gap answers with the whole page (#550)
 *
 * The console keeps the page it last rendered (`terminal-cache.ts`), so the read it makes on the
 * next load is "what has been appended since `seq`" — the same query with the comparison flipped.
 * For the common case that is an empty array instead of ~41 KB.
 *
 * The failure mode of a tail is a GAP: more rows were appended than one page holds, so the delta
 * does not join what the client is holding, and stitching it would weld two moments together with
 * an hour missing between them. That is answered here, by falling through to the newest page and
 * saying `tail:false` — one query more in the rare case, rather than a second round trip in it,
 * and the client's two branches stay "extend what I have" and "replace what I have".
 *
 * `hasMore`/`oldestSeq` are deliberately UNDEFINED on a tail reply. They describe how far back a
 * page reaches, which a delta does not know; returning the delta's own values would let a client
 * overwrite a good "load older" cursor with one pointing at the newest rows, and silently lose the
 * scrollback it was caching in the first place.
 */
export async function loadTerminalSnapshots(
	env: Env,
	args: { sessionId: string; before?: number; after?: number; limit?: number },
): Promise<{ entries: TimelineEntry[]; hasMore?: boolean; oldestSeq?: number | null; newestSeq: number | null; tail: boolean }> {
	const limit = Math.max(1, Math.min(50, args.limit ?? 5));
	const before = Number.isFinite(args.before) && (args.before as number) > 0 ? (args.before as number) : Number.MAX_SAFE_INTEGER;
	const after = Number.isFinite(args.after) && (args.after as number) > 0 ? (args.after as number) : null;
	if (after !== null) {
		// Ascending from the cursor, one row over the limit to detect the gap.
		const { results } = await env.DB.prepare(
			"SELECT seq, type, content, created_at, audio_key FROM coding_timeline WHERE session_id = ?1 AND type = 'terminal' AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
		)
			.bind(args.sessionId, after, limit + 1)
			.all<Row>();
		const rows = results ?? [];
		if (rows.length <= limit) {
			const entries = rows.map(toEntry);
			// `newestSeq` falls back to the cursor when nothing was appended: the client's cache is
			// still current, and answering `null` would make it re-ask from the beginning next time.
			return { entries, newestSeq: entries.length ? entries[entries.length - 1].seq : after, tail: true };
		}
	}
	// One row over the limit, purely to answer `hasMore` without a second COUNT query.
	const { results } = await env.DB.prepare(
		"SELECT seq, type, content, created_at, audio_key FROM coding_timeline WHERE session_id = ?1 AND type = 'terminal' AND seq < ?2 ORDER BY seq DESC LIMIT ?3",
	)
		.bind(args.sessionId, before, limit + 1)
		.all<Row>();
	const rows = results ?? [];
	const hasMore = rows.length > limit;
	const page = (hasMore ? rows.slice(0, limit) : rows).map(toEntry).reverse();
	return { entries: page, hasMore, oldestSeq: page.length ? page[0].seq : null, newestSeq: page.length ? page[page.length - 1].seq : null, tail: false };
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
 * Prune excess `terminal` rows for one session — keep the newest {@link TERMINAL_KEEP_PER_SESSION},
 * delete the rest in a bounded batch.
 *
 * WHY PER-SESSION CAP, NOT AGE CUTOFF (#466):
 * Migration 0077 records the user promise: "I should see history forever — it should be from the DB."
 * An age cutoff deletes the oldest rows, which is precisely the history users expect to persist.
 * A per-session cap keeps the newest N rows and discards the BEGINNING of one very long session —
 * a far smaller loss, because consecutive snapshots overlap nearly entirely (each is the same
 * 8,000-char tail with minor scrollback additions), and `terminal-history.ts` stitches them anyway.
 *
 * ONLY `terminal` rows are pruned. Conversation rows (`chat_user`, `chat_assistant`, `command`,
 * `brain`, `outcome`, `system`) total <2 MB/year across all sessions and are kept forever.
 *
 * Returns the number of rows deleted.
 */
export const TERMINAL_KEEP_PER_SESSION = 300; // ≈ 2.4 MB/session at 8 KB/row
const TERMINAL_PRUNE_BATCH = 200; // max rows deleted per call — bounds one tick's DELETE cost

export async function pruneTerminalSnapshots(
	env: Env,
	sessionId: string,
	keep = TERMINAL_KEEP_PER_SESSION,
	limit = TERMINAL_PRUNE_BATCH,
): Promise<number> {
	// Delete the oldest `terminal` rows for this session whose seq is lower than the
	// Nth newest row's seq — i.e. everything outside the retention window. Bounded by
	// `limit` so a single call can never be the expensive part of a cron tick.
	//
	// The correlated subquery `(SELECT seq … ORDER BY seq DESC LIMIT 1 OFFSET keep-1)`
	// resolves to the seq of the row at position `keep` from the newest end; rows older
	// than that are candidates. `idx_coding_timeline_session_type (session_id, type, seq)`
	// makes both the inner and outer scans index-only.
	const res = await env.DB.prepare(
		`DELETE FROM coding_timeline
		  WHERE rowid IN (
		    SELECT rowid FROM coding_timeline
		    WHERE session_id = ?1 AND type = 'terminal'
		      AND seq < (
		        SELECT seq FROM coding_timeline
		        WHERE session_id = ?1 AND type = 'terminal'
		        ORDER BY seq DESC LIMIT 1 OFFSET ?2
		      )
		    ORDER BY seq ASC
		    LIMIT ?3
		  )`,
	)
		.bind(sessionId, keep - 1, limit)
		.run();
	return res.meta?.changes ?? 0;
}

/**
 * How many sessions with over-cap `terminal` rows a single cron tick inspects.
 * Bounded so one tick can never own the whole backlog.
 */
const TERMINAL_SWEEP_SESSIONS = 20;

/**
 * Sweep sessions with more than {@link TERMINAL_KEEP_PER_SESSION} terminal rows,
 * pruning each one in a bounded pass. Returns total rows deleted.
 *
 * Wired into the per-minute cron alongside the other independent sweeps. Swallows its
 * own errors — a failed prune is a capacity nuisance, not data loss.
 */
export async function sweepTerminalSnapshots(env: Env): Promise<number> {
	try {
		// Find sessions that have exceeded the cap. Ordered by count DESC so the worst
		// offenders are visited first. `idx_coding_timeline_session_type` covers the
		// GROUP BY (session_id, type) efficiently.
		const { results } = await env.DB.prepare(
			`SELECT session_id FROM coding_timeline
			  WHERE type = 'terminal'
			  GROUP BY session_id
			  HAVING COUNT(*) > ?1
			  ORDER BY COUNT(*) DESC
			  LIMIT ?2`,
		)
			.bind(TERMINAL_KEEP_PER_SESSION, TERMINAL_SWEEP_SESSIONS)
			.all<{ session_id: string }>();
		let deleted = 0;
		for (const { session_id: sessionId } of results ?? []) {
			deleted += await pruneTerminalSnapshots(env, sessionId);
		}
		return deleted;
	} catch {
		return 0;
	}
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
		usage: "Engine spend",
	};
	return entries
		.map((e) => {
			// Terminal snapshots are long — keep only a tail in the rolling context.
			const body = e.type === "terminal" ? e.content.slice(-1200) : e.content.slice(0, 2000);
			return `[${label[e.type] ?? e.type}] ${body}`;
		})
		.join("\n");
}
