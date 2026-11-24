/**
 * Owner triage for the "Needs you" inbox (#1697): New / Discussed / Deferred and a "Needs computer" marker on a
 * coder question or a parked run. Pure bookkeeping beside the item: it never answers, resumes, expires or hides
 * anything (the item stays in the inbox and in the badge count); the owner's view filters on it.
 */
import type { Env } from "../types.js";

export const TRIAGE_STATUSES = ["new", "discussed", "deferred"] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];
/** Only these kinds are a question the owner may sit on; the other sources are not triaged. */
export const TRIAGE_KINDS = ["coder_question", "run_parked"] as const;

export interface Triage {
	/** Effective status: a deferral whose `deferUntil` has passed is New again. */
	status: TriageStatus;
	needsComputer: boolean;
	deferUntil: string | null;
	updatedAt: string;
}

export const DEFAULT_TRIAGE: Triage = { status: "new", needsComputer: false, deferUntil: null, updatedAt: "" };

export const isTriageItem = (id: string): boolean => TRIAGE_KINDS.some((k) => id.startsWith(`${k}:`));

interface Row {
	item_id: string;
	status: TriageStatus;
	needs_computer: number;
	defer_until: number | null;
	updated_at: number;
}

function fromRow(r: Row, now: number): Triage {
	const lapsed = r.status === "deferred" && r.defer_until !== null && r.defer_until <= now;
	return {
		status: lapsed ? "new" : r.status,
		needsComputer: !!r.needs_computer,
		deferUntil: r.defer_until === null ? null : new Date(r.defer_until).toISOString(),
		updatedAt: new Date(r.updated_at).toISOString(),
	};
}

const CHUNK = 80;

async function readRows(env: Env, uid: string, itemIds: string[]): Promise<Row[]> {
	const out: Row[] = [];
	for (let i = 0; i < itemIds.length; i += CHUNK) {
		const part = itemIds.slice(i, i + CHUNK);
		const { results } = await env.DB.prepare(`SELECT item_id, status, needs_computer, defer_until, updated_at FROM inbox_triage WHERE user_id = ?1 AND item_id IN (${part.map((_, n) => `?${n + 2}`).join(",")})`)
			.bind(uid, ...part)
			.all<Row>();
		out.push(...(results ?? []));
	}
	return out;
}

/** Triage for the given item ids (a D1 statement binds at most ~100 values, so chunked). Absent = New. */
export async function readTriage(env: Env, uid: string, itemIds: string[], now: number): Promise<Map<string, Triage>> {
	if (!itemIds.length) return new Map();
	return new Map((await readRows(env, uid, itemIds)).map((r) => [r.item_id, fromRow(r, now)]));
}

export interface TriagePatch {
	status?: TriageStatus;
	needsComputer?: boolean;
	/** ms epoch; only meaningful with status `deferred`. */
	deferUntil?: number | null;
}

/** Upsert the owner's triage for one item. Fields not in the patch keep their stored value; leaving Deferred drops the date. */
export async function writeTriage(env: Env, uid: string, itemId: string, patch: TriagePatch, now: number): Promise<Triage> {
	const stored = (await readRows(env, uid, [itemId]))[0];
	const status = patch.status ?? stored?.status ?? "new";
	const deferUntil = status !== "deferred" ? null : patch.deferUntil !== undefined ? patch.deferUntil : (stored?.defer_until ?? null);
	const needs = patch.needsComputer ?? !!stored?.needs_computer;
	await env.DB.prepare(
		`INSERT INTO inbox_triage (user_id, item_id, status, needs_computer, defer_until, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
		 ON CONFLICT(user_id, item_id) DO UPDATE SET status = ?3, needs_computer = ?4, defer_until = ?5, updated_at = ?6`,
	)
		.bind(uid, itemId, status, needs ? 1 : 0, deferUntil, now)
		.run();
	return fromRow({ item_id: itemId, status, needs_computer: needs ? 1 : 0, defer_until: deferUntil, updated_at: now }, now);
}
