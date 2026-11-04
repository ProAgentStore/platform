/** Durable diagnostics. The injected transport may only read native diagnostics; no launch/resume/action. */
import type { Env } from "../types.js";
import { HttpError } from "./auth.js";
import { subjectBelongsTo } from "./browser-artifacts.js";
import { type BrowserEvidenceTarget, recordOf, sanitizeBrowserCall, sanitizeBrowserState } from "./browser-evidence-contract.js";
export const BROWSER_EVIDENCE_TIMEOUT_MS = 5_000;
export type EvidenceFetch = (path: "/browser-calls" | "/browser-state", body: Record<string, unknown>) => Promise<Response>;
type DB = Pick<Env, "DB">;
type Availability = "not_collected" | "available" | "unavailable" | "unsupported" | "refused" | "invalid_response" | "partial";
interface Coverage {
 status: Availability; epoch: string | null; lastSeq: number; dropped: number; priorEpochDropped: number; invalidRecords: number;
 restartObserved: boolean; legacyEpochUnknown: boolean; pageLimitReached: boolean; firstCallId?: string;
}
interface EvidenceRow { coverage: string; state: string | null; state_status: Availability; refreshed_at: number | null }
const initial = (): Coverage => ({ status: "not_collected", epoch: null, lastSeq: 0, dropped: 0, priorEpochDropped: 0, invalidRecords: 0, restartObserved: false, legacyEpochUnknown: false, pageLimitReached: false });
const scope = (t: BrowserEvidenceTarget) => [t.userId, t.instanceId, t.subjectKind, t.subjectId];
const WHERE = "user_id = ?1 AND instance_id = ?2 AND subject_kind = ?3 AND subject_id = ?4";
const read = (env: DB, t: BrowserEvidenceTarget) => env.DB.prepare(`SELECT coverage,state,state_status,refreshed_at FROM browser_run_evidence WHERE ${WHERE}`).bind(...scope(t)).first<EvidenceRow>();
const parsedCoverage = (row: EvidenceRow | null): Coverage => { try { return { ...initial(), ...JSON.parse(row?.coverage ?? "{}") }; } catch { return initial(); } };
const parsedRecord = (value: string): unknown => { try { return JSON.parse(value); } catch { return null; } };
const statusOf = (status: number): Availability => status === 404 || status === 405 || status === 501 ? "unsupported" : status === 401 || status === 403 ? "refused" : "unavailable";
async function requireSubject(env: DB, t: BrowserEvidenceTarget) { if (!(await subjectBelongsTo(env, t.userId, t.instanceId, t.subjectKind, t.subjectId))) throw new HttpError(404, "Browser run not found"); }

/** Works for ended subjects too: collecting retained evidence never restarts their browser. */
export async function refreshBrowserEvidence(env: DB, t: BrowserEvidenceTarget, readNative: EvidenceFetch | null, now = Date.now()): Promise<void> {
 await requireSubject(env, t);
 const previous = await read(env, t); const coverage = parsedCoverage(previous);
 let state: string | null = null; let stateStatus: Availability = "unavailable";
 const expires = now + 30 * 86_400_000;
 let after = coverage.epoch ? coverage.lastSeq : 0;
 coverage.pageLimitReached = false;
 if (!readNative) coverage.status = "unavailable";
 else {
  try {
   for (let page = 0; page < 21; page++) {
    if (page === 20) { coverage.pageLimitReached = true; coverage.status = "partial"; break; }
    const response = await readNative("/browser-calls", { subjectKind: t.subjectKind, subjectId: t.subjectId, afterSeq: after, limit: 100 });
    if (!response.ok) { coverage.status = statusOf(response.status); break; }
    const body = recordOf(await response.json());
    if (!body || !Array.isArray(body.calls) || body.calls.length > 2000 || !Number.isSafeInteger(body.lastSeq) || Number(body.lastSeq) < 0 || !Number.isSafeInteger(body.dropped) || Number(body.dropped) < 0) { coverage.status = "invalid_response"; break; }
    const epoch = typeof body.epoch === "string" && body.epoch.length <= 128 && body.epoch ? body.epoch : null;
    if (epoch && epoch !== coverage.epoch) {
     coverage.restartObserved ||= coverage.epoch !== null || !!coverage.firstCallId;
     coverage.priorEpochDropped += coverage.dropped; coverage.epoch = epoch; coverage.lastSeq = 0; coverage.dropped = 0;
     if (after > 0) { after = 0; continue; }
    }
    coverage.legacyEpochUnknown ||= epoch === null;
    if (epoch === null) coverage.epoch = null;
    const calls = body.calls.map(raw => sanitizeBrowserCall(raw, t));
    coverage.invalidRecords += calls.filter(c => !c).length;
    const valid = calls.filter((c): c is NonNullable<typeof c> => !!c);
    if (epoch === null && after === 0 && valid[0] && coverage.firstCallId && coverage.firstCallId !== valid[0].callId) coverage.restartObserved = true;
    if (after === 0 && valid[0]) coverage.firstCallId = valid[0].callId;
    for (let index = 0; index < valid.length; index += 50) {
     await env.DB.batch(valid.slice(index, index + 50).map(call => env.DB.prepare("INSERT INTO browser_run_calls(user_id,instance_id,subject_kind,subject_id,call_id,epoch,seq,record,stored_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(user_id,instance_id,subject_kind,subject_id,call_id) DO NOTHING").bind(...scope(t), call.callId, epoch, call.seq, JSON.stringify(call), now, expires)));
    }
    coverage.lastSeq = Number(body.lastSeq); coverage.dropped = Math.max(coverage.dropped, Number(body.dropped)); coverage.status = coverage.invalidRecords ? "partial" : "available";
    if (body.hasMore !== true) break;
    if (coverage.lastSeq <= after) { coverage.status = "invalid_response"; break; }
    after = coverage.lastSeq;
   }
  } catch { coverage.status = "unavailable"; }
  try {
   const response = await readNative("/browser-state", { subjectKind: t.subjectKind, subjectId: t.subjectId });
   if (!response.ok) stateStatus = statusOf(response.status);
   else {
    const observed = sanitizeBrowserState(await response.json(), t);
    stateStatus = observed ? observed.availability : "invalid_response";
    if (observed?.availability === "available") state = JSON.stringify(observed);
   }
  } catch { stateStatus = "unavailable"; }
 }
 await env.DB.prepare("INSERT INTO browser_run_evidence(user_id,instance_id,subject_kind,subject_id,coverage,state,state_status,refreshed_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(user_id,instance_id,subject_kind,subject_id) DO UPDATE SET coverage=excluded.coverage,state=COALESCE(excluded.state,browser_run_evidence.state),state_status=excluded.state_status,refreshed_at=excluded.refreshed_at,expires_at=excluded.expires_at WHERE browser_run_evidence.refreshed_at IS NULL OR browser_run_evidence.refreshed_at < excluded.refreshed_at").bind(...scope(t), JSON.stringify(coverage), state, stateStatus, now, expires).run();
}

/** Durable insertion cursor, bound again to owner+instance+subject; native sequence resets cannot hide rows. */
export async function listBrowserCalls(env: DB, t: BrowserEvidenceTarget, cursor?: string, limit = 50) {
 await requireSubject(env, t);
 if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "limit must be 1–100");
 if (cursor && (!/^\d+$/.test(cursor) || !(await env.DB.prepare(`SELECT id FROM browser_run_calls WHERE ${WHERE} AND id = ?5`).bind(...scope(t), cursor).first()))) throw new HttpError(400, "Unknown browser call cursor for this run");
 const result = await env.DB.prepare(`SELECT id,epoch,record,stored_at FROM browser_run_calls WHERE ${WHERE} AND id > ?5 ORDER BY id LIMIT ?6`).bind(...scope(t), cursor ?? "0", limit + 1).all<{ id: number; epoch: string | null; record: string; stored_at: number }>();
 const rows = result.results ?? []; const hasMore = rows.length > limit; if (hasMore) rows.pop();
 const row = await read(env, t);
 return { subject: { kind: t.subjectKind, id: t.subjectId }, calls: rows.flatMap(r => { const call = sanitizeBrowserCall(parsedRecord(r.record), t); return call ? [{ ...call, epoch: r.epoch, retainedAt: new Date(r.stored_at).toISOString() }] : []; }), nextCursor: hasMore ? String(rows.at(-1)!.id) : null, hasMore, coverage: { ...parsedCoverage(row), refreshedAt: row?.refreshed_at ? new Date(row.refreshed_at).toISOString() : null, retentionDays: 30, errorTextMaxChars: 200, arguments: "redacted summaries; typed text and file contents are not stored", sequenceMeaning: "native stream order; epoch changes may reset seq", urlAfterMeaning: "navigation argument when known, not proof of final loaded URL" } };
}
export async function readBrowserState(env: DB, t: BrowserEvidenceTarget, refreshed = false) {
 await requireSubject(env, t); const row = await read(env, t); const state = row?.state ? sanitizeBrowserState(parsedRecord(row.state), t) : null;
 return { subject: { kind: t.subjectKind, id: t.subjectId }, availability: row?.state_status ?? "not_collected", freshness: refreshed && row?.state_status === "available" && state?.current === true ? "observed_this_read" : "retained", capturedAt: state?.capturedAt ?? null, snapshot: state ? { ...state, current: refreshed && row?.state_status === "available" && state.current === true } : null, refreshedAt: row?.refreshed_at ? new Date(row.refreshed_at).toISOString() : null, notice: "Reading diagnostics never selects a tab, navigates, resumes, approves, or replays an action. An unavailable live source does not erase retained evidence." };
}
export async function sweepBrowserEvidence(env: DB, now = Date.now()) {
 await env.DB.prepare("DELETE FROM browser_run_calls WHERE expires_at <= ?1").bind(now).run();
 await env.DB.prepare("DELETE FROM browser_run_evidence WHERE expires_at <= ?1").bind(now).run();
}
