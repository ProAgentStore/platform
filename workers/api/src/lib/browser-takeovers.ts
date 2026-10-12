/**
 * Durable browser takeovers (#1031) — `migrations/0223_browser_takeovers.sql`.
 *
 * A person is asked to take over a browser BEFORE any remote control is shown, and every step after
 * is a recorded state: requested → active → resumed, or ended / expired. The console and MCP read the
 * same rows, and the takeover proxy (`instances-apply.ts`) refuses a frame or input for a task with no
 * live row — so "the remote view opened" is always a fact someone can read afterwards.
 *
 * Writes are single-writer: a transition is one UPDATE guarded on the states it may leave, so two
 * racing writers cannot both move it, and repeating a transition already made is a no-op, not an
 * error. Nothing here stores a URL, frame, cookie, token, session or page content.
 */
import {
	type BrowserTakeover,
	TAKEOVER_REASONS,
	type TakeoverEndReason,
	type TakeoverReason,
	type TakeoverState,
	type TakeoverSubject,
} from "./browser-takeover-types.js";
import type { Env } from "../types.js";

/** How long a request waits for a person before the cron expires it. */
export const TAKEOVER_TTL_MS = 60 * 60_000;

/** Which states each state may be reached FROM. `expired` is the cron's alone. */
const FROM: Record<TakeoverState, readonly TakeoverState[]> = {
	requested: [],
	active: ["requested"],
	// From `requested` too: the owner may clear the blocker at the machine itself and resume.
	resumed: ["requested", "active"],
	ended: ["requested", "active"],
	expired: ["requested", "active"],
};
export const LIVE_TAKEOVER_STATES: readonly TakeoverState[] = ["requested", "active"];

export function canTransitionTakeover(from: TakeoverState, to: TakeoverState): boolean {
	return FROM[to].includes(from);
}

export const takeoverReasonOf = (raw: unknown): TakeoverReason => (TAKEOVER_REASONS.includes(raw as TakeoverReason) ? (raw as TakeoverReason) : "manual");

interface Row {
	id: string;
	instance_id: string;
	agent_id: string;
	subject_kind: string;
	subject_id: string;
	state: string;
	reason: string;
	mobile_allowed: number;
	end_reason: string | null;
	expires_at: number;
	created_at: number;
	activated_at: number | null;
	ended_at: number | null;
	updated_at: number;
}

const iso = (ms: number | null): string | null => (ms ? new Date(ms).toISOString() : null);
const present = (r: Row): BrowserTakeover => ({
	id: r.id,
	instanceId: r.instance_id,
	agentId: r.agent_id,
	subjectKind: r.subject_kind as TakeoverSubject,
	subjectId: r.subject_id,
	state: r.state as TakeoverState,
	reason: takeoverReasonOf(r.reason),
	mobileAllowed: r.mobile_allowed === 1,
	endReason: (r.end_reason as TakeoverEndReason | null) ?? null,
	expiresAt: iso(r.expires_at) ?? "",
	createdAt: iso(r.created_at) ?? "",
	activatedAt: iso(r.activated_at),
	endedAt: iso(r.ended_at),
	updatedAt: iso(r.updated_at) ?? "",
});

type DB = Pick<Env, "DB">;

export async function getTakeover(env: DB, userId: string, instanceId: string, id: string): Promise<BrowserTakeover | null> {
	const r = await env.DB.prepare("SELECT * FROM browser_takeovers WHERE id = ?1 AND user_id = ?2 AND instance_id = ?3").bind(id, userId, instanceId).first<Row>();
	return r ? present(r) : null;
}

/** The most recent takeover for one subject, live or not. */
export async function latestTakeoverFor(env: DB, userId: string, instanceId: string, kind: TakeoverSubject, subjectId: string): Promise<BrowserTakeover | null> {
	const r = await env.DB.prepare("SELECT * FROM browser_takeovers WHERE user_id = ?1 AND instance_id = ?2 AND subject_kind = ?3 AND subject_id = ?4 ORDER BY created_at DESC LIMIT 1")
		.bind(userId, instanceId, kind, subjectId)
		.first<Row>();
	return r ? present(r) : null;
}

export async function listTakeovers(env: DB, userId: string, instanceId: string, opts: { state?: TakeoverState; subjectKind?: TakeoverSubject; subjectId?: string; limit?: number } = {}): Promise<BrowserTakeover[]> {
	const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
	const where = ["user_id = ?1", "instance_id = ?2"];
	const binds: unknown[] = [userId, instanceId];
	const add = (sql: string, v: unknown) => {
		binds.push(v);
		where.push(`${sql} = ?${binds.length}`);
	};
	if (opts.state) add("state", opts.state);
	if (opts.subjectKind) add("subject_kind", opts.subjectKind);
	if (opts.subjectId) add("subject_id", opts.subjectId);
	binds.push(limit);
	const { results } = await env.DB.prepare(`SELECT * FROM browser_takeovers WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?${binds.length}`)
		.bind(...binds)
		.all<Row>();
	return (results ?? []).map(present);
}

/**
 * Ask a person to take over. Idempotent per subject: while one is live (requested/active), asking again
 * answers it with `created: false` — the partial unique index is the claim, as with runner updates.
 */
export async function requestTakeover(
	env: DB,
	input: { userId: string; instanceId: string; subjectKind: TakeoverSubject; subjectId: string; reason: TakeoverReason; mobileAllowed: boolean; now?: number; ttlMs?: number; id?: string },
): Promise<{ takeover: BrowserTakeover; created: boolean } | null> {
	const now = input.now ?? Date.now();
	const agent = await env.DB.prepare("SELECT agent_id FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(input.instanceId, input.userId).first<{ agent_id: string }>();
	if (!agent) return null;
	const id = input.id ?? crypto.randomUUID();
	const inserted = await env.DB.prepare(
		`INSERT INTO browser_takeovers (id, instance_id, agent_id, user_id, subject_kind, subject_id, state, reason, mobile_allowed, expires_at, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'requested', ?7, ?8, ?9, ?10, ?10)
		 ON CONFLICT DO NOTHING`,
	)
		.bind(id, input.instanceId, agent.agent_id, input.userId, input.subjectKind, input.subjectId, input.reason, input.mobileAllowed ? 1 : 0, now + (input.ttlMs ?? TAKEOVER_TTL_MS), now)
		.run()
		.then((r) => (r.meta?.changes ?? 0) > 0)
		.catch(() => false);
	const live = await env.DB.prepare(
		"SELECT * FROM browser_takeovers WHERE user_id = ?1 AND instance_id = ?2 AND subject_kind = ?3 AND subject_id = ?4 AND state IN ('requested', 'active')",
	)
		.bind(input.userId, input.instanceId, input.subjectKind, input.subjectId)
		.first<Row>();
	return live ? { takeover: present(live), created: inserted } : null;
}

export type TransitionOutcome = { ok: true; takeover: BrowserTakeover; changed: boolean } | { ok: false; takeover: BrowserTakeover | null; error: string };

/** Move one takeover. Repeating the move already made answers `changed: false`; a move its state cannot make is refused. */
export async function transitionTakeover(env: DB, userId: string, instanceId: string, id: string, to: TakeoverState, opts: { now?: number; endReason?: TakeoverEndReason } = {}): Promise<TransitionOutcome> {
	const now = opts.now ?? Date.now();
	const froms = FROM[to];
	if (froms.length) {
		const placeholders = froms.map((_, i) => `?${i + 7}`).join(", ");
		const res = await env.DB.prepare(
			`UPDATE browser_takeovers
			    SET state = ?1, updated_at = ?2,
			        activated_at = CASE WHEN ?1 = 'active' THEN ?2 ELSE activated_at END,
			        ended_at = CASE WHEN ?1 IN ('resumed', 'ended', 'expired') THEN ?2 ELSE ended_at END,
			        end_reason = COALESCE(?3, end_reason)
			  WHERE id = ?4 AND user_id = ?5 AND instance_id = ?6 AND state IN (${placeholders})`,
		)
			.bind(to, now, opts.endReason ?? (to === "expired" ? "expired" : null), id, userId, instanceId, ...froms)
			.run()
			.catch(() => null);
		if ((res?.meta?.changes ?? 0) > 0) {
			const moved = await getTakeover(env, userId, instanceId, id);
			if (moved) return { ok: true, takeover: moved, changed: true };
		}
	}
	const current = await getTakeover(env, userId, instanceId, id);
	if (!current) return { ok: false, takeover: null, error: "No such takeover." };
	if (current.state === to) return { ok: true, takeover: current, changed: false };
	return { ok: false, takeover: current, error: `A takeover that is ${current.state} cannot become ${to}.` };
}

/**
 * Close the live takeover for a subject, if there is one — the hook a run's resume or end calls. A
 * takeover resumed while still `requested` was never opened: the owner cleared it at the machine.
 */
export async function closeLiveTakeoverFor(env: DB, userId: string, instanceId: string, kind: TakeoverSubject, subjectId: string, to: "resumed" | "ended", now = Date.now(), endReason?: TakeoverEndReason): Promise<BrowserTakeover | null> {
	const live = await latestTakeoverFor(env, userId, instanceId, kind, subjectId);
	if (!live || !LIVE_TAKEOVER_STATES.includes(live.state)) return null;
	const reason = endReason ?? (to === "resumed" && live.state === "requested" ? "resumed_at_machine" : undefined);
	const out = await transitionTakeover(env, userId, instanceId, live.id, to, { now, ...(reason ? { endReason: reason } : {}) });
	return out.ok ? out.takeover : null;
}

/** The per-minute cron: every live takeover past its expiry becomes `expired`. */
export async function expireStaleTakeovers(env: DB, now = Date.now()): Promise<number> {
	const res = await env.DB.prepare(
		`UPDATE browser_takeovers SET state = 'expired', end_reason = 'expired', ended_at = ?1, updated_at = ?1
		  WHERE state IN ('requested', 'active') AND expires_at <= ?1`,
	)
		.bind(now)
		.run()
		.catch(() => null);
	return res?.meta?.changes ?? 0;
}
