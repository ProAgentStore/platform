import type { Env } from "../types.js";
import type { TimelineEntry, TimelineType } from "./coding-timeline.js";
import { jsonPath } from "./sql.js";
import { removeInstanceConfigKey } from "./instance-config.js";
import { shouldPersistSnapshot, terminalSnapshotContent } from "./terminal-snapshot.js";

/**
 * The durable record of a repo-less terminal (#878) — `terminal_history` (migration 0165) plus
 * `config.lastTerminalTarget`.
 *
 * ── Why this exists
 *
 * A terminal-operator instance (tmux.control, no repo) drives the machine through the `tmux_*` /
 * `terminal_*` connector tools. Those never create a `coding_sessions` row — that row needs a repo —
 * so everything the coding surface persists (snapshots, instructions, a session to resolve) had no
 * equivalent here. Measured in #878: a long Homebrew build in tmux session `shell` ended, and
 * afterwards every read answered "no session", `activeTerminalTarget` was null, and nothing the
 * platform held could say whether the build had finished.
 *
 * `activeTerminalTarget` was null for a reason worth stating, because it is not the one it looks
 * like: nothing CLEARS it when a session ends. It is only ever WRITTEN by a click in the console's
 * Tmux tab or `set_instance_terminal_session` — driving a terminal through its tools never recorded
 * which one was being driven. So `lastTerminalTarget` is written here, by USE, and is deliberately a
 * second key: `activeTerminalTarget` stays what an owner chose, and this one is what was last
 * driven. Neither is cleared by a session ending; both survive until cleared on purpose.
 *
 * ── What is recorded, and from where
 *
 * {@link recordTerminalToolUse} is called by `runRegistryTool` after a terminal connector handler
 * returns, so every surface — chat, `POST …/tools/:name`, MCP, the pipeline runner — records
 * through the one dispatcher all of them already pass, and a call a gate refused records nothing.
 * Panes are deduped and throttled by the SAME rule a coding snapshot is (`shouldPersistSnapshot`):
 * the console polls a capture every 4s, and without the dedup an idle pane would append an
 * identical row on every poll (#466 measured exactly that on `coding_timeline`).
 */

/** Newest rows kept per instance. Oldest rows of a very long history are what is dropped — see the
 *  migration header — and at ≤ 8,000 characters a pane this bounds an instance at ~1.6 MB. */
export const TERMINAL_HISTORY_KEEP = 200;

/** A typed command is an instruction, not a pane — cap it like the narrative rows it reads as. */
const COMMAND_CHARS = 2000;

export type TerminalHistoryType = Extract<TimelineType, "terminal" | "command" | "system">;

export interface TerminalHistoryEntry extends TimelineEntry {
	/** The target the row is about, backend-prefixed (`tmux:shell`). */
	target: string;
}

const PANE_READS = new Set(["tmux_capture_pane", "terminal_capture"]);
const CREATES = new Set(["tmux_new_session", "terminal_new_target"]);
const KILLS = new Set(["tmux_kill_session", "terminal_kill_target"]);

/** What a write tool TYPED, as the text a reader would recognise; null for a tool that types nothing. */
function typedText(name: string, input: Record<string, unknown>): string | null {
	const str = (v: unknown) => (v == null ? "" : String(v));
	switch (name) {
		case "tmux_run_command":
		case "terminal_run_command":
			return str(input.command);
		case "tmux_send_message":
		case "terminal_send_message":
			return str(input.message);
		case "tmux_send_keys":
		case "terminal_send_keys": {
			const keys = Array.isArray(input.keys) ? input.keys.map(String) : str(input.keys).split(",");
			const named = keys.map((k) => k.trim()).filter(Boolean);
			return [str(input.text), named.length ? `[${named.join(", ")}]` : ""].filter(Boolean).join(" ");
		}
		default:
			return null;
	}
}

/**
 * The backend-prefixed target a terminal tool call addressed, or null when it named none.
 *
 * `tmux_*` tools take a bare session name; `terminal_*` tools take a target that is usually already
 * prefixed. The prefixed form is the one `activeTerminalTarget` and the console use (`tmux:shell`),
 * so both families land in one vocabulary.
 */
export function terminalTargetOf(name: string, input: Record<string, unknown>, content = ""): string | null {
	const clean = (v: unknown) => String(v ?? "").trim().slice(0, 200);
	if (name.startsWith("tmux_")) {
		const session = clean(input.session);
		return session ? `tmux:${session}` : null;
	}
	if (!name.startsWith("terminal_")) return null;
	if (name === "terminal_new_target") {
		// The runner answers with the target it made; a tmux name is its own target either way.
		try {
			const made = JSON.parse(content) as { target?: unknown; id?: unknown };
			const t = clean(made?.target ?? made?.id);
			if (t.includes(":")) return t;
		} catch {
			// not JSON — fall through to the name
		}
		const backend = clean(input.backend);
		const label = clean(input.name);
		return backend === "tmux" && label ? `tmux:${label}` : null;
	}
	const target = clean(input.target);
	if (!target) return null;
	if (target.includes(":")) return target;
	const backend = clean(input.backend);
	return backend ? `${backend}:${target}` : target;
}

/** Point `config.lastTerminalTarget` at `target` — a no-op write when it already does. */
export async function rememberTerminalTarget(env: Env, instanceId: string, userId: string, target: string): Promise<void> {
	// Conditional in SQL, because a capture is POLLED: an unconditional patch would rewrite the
	// instance row every 4 seconds for as long as the console's Tmux tab is open.
	await env.DB.prepare(
		`UPDATE agent_instances
		    SET config = json_set(CASE WHEN config IS NULL OR config = '' OR NOT json_valid(config) THEN '{}' ELSE config END, ?1, ?2)
		  WHERE id = ?3 AND user_id = ?4
		    AND (config IS NULL OR config = '' OR NOT json_valid(config) OR json_extract(config, ?1) IS NOT ?2)`,
	)
		.bind(jsonPath("lastTerminalTarget"), target, instanceId, userId)
		.run();
}

async function appendRow(env: Env, row: { instanceId: string; userId: string; target: string; type: TerminalHistoryType; content: string }): Promise<void> {
	await env.DB.prepare("INSERT INTO terminal_history (instance_id, user_id, target, type, content) VALUES (?1, ?2, ?3, ?4, ?5)")
		.bind(row.instanceId, row.userId, row.target, row.type, row.content)
		.run();
	// Keep the newest TERMINAL_HISTORY_KEEP. `OFFSET` finds the first row past the cap; when there
	// is none the subquery is NULL and `seq <= NULL` deletes nothing.
	await env.DB.prepare(
		`DELETE FROM terminal_history WHERE instance_id = ?1 AND user_id = ?2 AND seq <= (
		   SELECT seq FROM terminal_history WHERE instance_id = ?1 AND user_id = ?2 ORDER BY seq DESC LIMIT 1 OFFSET ?3
		 )`,
	)
		.bind(row.instanceId, row.userId, TERMINAL_HISTORY_KEEP)
		.run();
}

/** Store a pane for `target` if it differs from the last one stored for it (and is not throttled). */
export async function recordTerminalSnapshot(
	env: Env,
	args: { instanceId: string; userId: string; target: string; pane: string; settled: boolean; now?: number },
): Promise<boolean> {
	const stored = terminalSnapshotContent(args.pane);
	if (!stored) return false;
	const last = await env.DB.prepare(
		"SELECT content, created_at FROM terminal_history WHERE instance_id = ?1 AND user_id = ?2 AND target = ?3 AND type = 'terminal' ORDER BY seq DESC LIMIT 1",
	)
		.bind(args.instanceId, args.userId, args.target)
		.first<{ content: string; created_at: string }>();
	// `settled` is the pane a write tool returned AFTER the runner waited for it to quiesce — the
	// terminal equivalent of an idle engine, so it is stored at once. A polled capture of a busy
	// pane is throttled instead, exactly as a working engine's snapshots are.
	const persist = shouldPersistSnapshot({
		pane: args.pane,
		lastContent: last?.content ?? null,
		lastAt: last?.created_at ?? null,
		runState: args.settled ? "idle" : "",
		now: args.now ?? Date.now(),
	});
	if (!persist) return false;
	await appendRow(env, { instanceId: args.instanceId, userId: args.userId, target: args.target, type: "terminal", content: stored });
	return true;
}

/**
 * Record one terminal connector call. Called by `runRegistryTool` after the handler returned, with
 * the handler's RAW content (the pane, before it is fenced for a model).
 *
 * Best-effort by contract: the caller swallows a throw, because failing to keep a record must
 * never turn a command that ran into one reported as failed.
 */
export async function recordTerminalToolUse(
	env: Env,
	args: { instanceId?: string; userId?: string; name: string; input: Record<string, unknown>; success: boolean; content: string },
): Promise<void> {
	const { instanceId, userId, name, input } = args;
	if (!instanceId || !userId || !args.success) return;
	const target = terminalTargetOf(name, input, args.content);
	if (!target) return;
	const owner = { instanceId, userId, target };
	if (PANE_READS.has(name)) {
		await rememberTerminalTarget(env, instanceId, userId, target);
		await recordTerminalSnapshot(env, { ...owner, pane: args.content, settled: false });
		return;
	}
	const typed = typedText(name, input);
	if (typed !== null) {
		await rememberTerminalTarget(env, instanceId, userId, target);
		if (typed) await appendRow(env, { ...owner, type: "command", content: typed.slice(0, COMMAND_CHARS) });
		await recordTerminalSnapshot(env, { ...owner, pane: args.content, settled: true });
		return;
	}
	if (CREATES.has(name)) {
		await rememberTerminalTarget(env, instanceId, userId, target);
		await appendRow(env, { ...owner, type: "system", content: `Terminal ${target} opened.` });
		return;
	}
	// A kill is recorded but does NOT move `lastTerminalTarget` off the killed target: what the
	// owner comes back asking about is the work that ran there, which is the whole point of #878.
	if (KILLS.has(name)) await appendRow(env, { ...owner, type: "system", content: `Terminal ${target} was closed.` });
}

interface HistoryRow {
	seq: number;
	target: string;
	type: string;
	content: string;
	created_at: string;
}

const toEntry = (r: HistoryRow): TerminalHistoryEntry => ({ seq: r.seq, type: r.type as TimelineType, content: r.content, createdAt: r.created_at, target: r.target });

/**
 * A page of an instance's terminal history.
 *
 * The cursor semantics are `coding_timeline`'s so one MCP tool can read either record: no cursor is
 * the NEWEST page, `before` walks back, `since` polls forward. Rows within a page are oldest→newest.
 */
export async function loadTerminalHistory(
	env: Env,
	args: { instanceId: string; userId: string; terminalOnly?: boolean; since?: number; before?: number; limit?: number; maxLimit?: number },
): Promise<{ entries: TerminalHistoryEntry[]; hasMore: boolean; oldestSeq: number | null; newestSeq: number | null; nextSeq: number }> {
	const limit = Math.max(1, Math.min(args.maxLimit ?? 200, args.limit ?? 40));
	const typeClause = args.terminalOnly ? "AND type = 'terminal'" : "";
	const since = Number.isFinite(args.since) && (args.since as number) >= 0 ? (args.since as number) : null;
	if (since !== null && args.before !== undefined) throw new Error("Pass `since` or `before`, not both.");
	if (since !== null) {
		const { results } = await env.DB.prepare(
			`SELECT seq, target, type, content, created_at FROM terminal_history WHERE instance_id = ?1 AND user_id = ?2 ${typeClause} AND seq > ?3 ORDER BY seq ASC LIMIT ?4`,
		)
			.bind(args.instanceId, args.userId, since, limit + 1)
			.all<HistoryRow>();
		const rows = results ?? [];
		const entries = rows.slice(0, limit).map(toEntry);
		const newestSeq = entries.length ? entries[entries.length - 1].seq : null;
		return { entries, hasMore: rows.length > limit, oldestSeq: entries[0]?.seq ?? null, newestSeq, nextSeq: newestSeq ?? since };
	}
	const before = Number.isFinite(args.before) && (args.before as number) > 0 ? (args.before as number) : Number.MAX_SAFE_INTEGER;
	const { results } = await env.DB.prepare(
		`SELECT seq, target, type, content, created_at FROM terminal_history WHERE instance_id = ?1 AND user_id = ?2 ${typeClause} AND seq < ?3 ORDER BY seq DESC LIMIT ?4`,
	)
		.bind(args.instanceId, args.userId, before, limit + 1)
		.all<HistoryRow>();
	const rows = results ?? [];
	const entries = rows.slice(0, limit).map(toEntry).reverse();
	const newestSeq = entries.length ? entries[entries.length - 1].seq : null;
	return { entries, hasMore: rows.length > limit, oldestSeq: entries[0]?.seq ?? null, newestSeq, nextSeq: newestSeq ?? 0 };
}

/** The explicit clear: every stored row for the instance, and the remembered target with them. */
export async function clearTerminalHistory(env: Env, instanceId: string, userId: string): Promise<number> {
	const res = await env.DB.prepare("DELETE FROM terminal_history WHERE instance_id = ?1 AND user_id = ?2").bind(instanceId, userId).run();
	await removeInstanceConfigKey(env, instanceId, userId, "lastTerminalTarget");
	return res.meta?.changes ?? 0;
}

/** `config.lastTerminalTarget`, read from an already-parsed config. */
export function lastTerminalTargetOf(config: Record<string, unknown>): string | null {
	const t = config.lastTerminalTarget;
	return typeof t === "string" && t ? t : null;
}
