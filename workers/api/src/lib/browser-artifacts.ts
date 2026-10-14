/**
 * Screenshot replay for browser-driven runs (#1063) — ONE owner-scoped artifact contract.
 *
 * Every browser run that drives a page can leave visual evidence behind: the legacy workflows
 * (JOB_APPLY, BROWSER_TASK — subject `runtime_task`), a Scout's local research (`local_browser_run`) and
 * an Application Runner's fill (`local_apply_run`). They keep their own run tables and state machines;
 * what they share is this: a screenshot is addressed by its SUBJECT and a sequence number, its bytes live
 * in R2 under the owner's prefix, and it is only ever served through an owner-checked route.
 *
 * The trace contracts are untouched. A trace may name a screenshot (its seq and capture point) and
 * nothing else; the bytes and every pixel of page content stay here, behind authentication. The metadata
 * kept beside them is closed: a capture point from a fixed vocabulary, a URL with its query and fragment
 * removed, its domain, and an action class — never page text, form values or typed values.
 *
 * Live takeover (`browser-takeovers.ts`) shares the subject identifiers and nothing else: that is an
 * interactive session, this is stored evidence after the fact.
 */
import type { BrowserArtifactView as BrowserArtifactWireView } from "../agent-types.js";
import type { Env } from "../types.js";

export const BROWSER_ARTIFACT_SUBJECTS = ["runtime_task", "local_browser_run", "local_apply_run"] as const;
export type BrowserArtifactSubject = (typeof BROWSER_ARTIFACT_SUBJECTS)[number];
export const isBrowserArtifactSubject = (v: unknown): v is BrowserArtifactSubject => typeof v === "string" && (BROWSER_ARTIFACT_SUBJECTS as readonly string[]).includes(v);

/** One viewport JPEG is tens to a few hundred KB; anything past this is refused, not truncated. */
export const MAX_BROWSER_ARTIFACT_BYTES = 768 * 1024;
/** How long a workflow task's or a Runner run's screenshots are kept. A Scout run follows its own trace retention. */
export const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Where a screenshot was taken. A closed vocabulary: the runner may only name one of these. */
export const CAPTURE_POINTS = ["action", "navigated", "clicked", "snapshot", "waited", "paused", "blocked", "filled", "uploaded", "checkpoint", "review", "submit", "completed"] as const;
export type CapturePoint = (typeof CAPTURE_POINTS)[number];

/** The metadata stored beside a screenshot — what a replay caption may say, and nothing more. */
export interface BrowserArtifactMetadata {
	point: CapturePoint;
	url: string | null;
	domain: string | null;
	action: string | null;
}

/** A screenshot as a reader sees it (the wire type in agent-types.ts). The R2 key never leaves the server. */
export type BrowserArtifactView = BrowserArtifactWireView & BrowserArtifactMetadata;

export const browserArtifactKey = (userId: string, instanceId: string, subjectKind: BrowserArtifactSubject, subjectId: string, seq: number, contentType = "image/jpeg"): string =>
	`browser-artifacts/${userId}/${instanceId}/${subjectKind}/${subjectId}/${String(seq).padStart(5, "0")}.${contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg"}`;

/** A URL a caption may carry: http(s) only, no credentials, no query, no fragment (they hold tokens and search terms). */
export function captionUrl(raw: unknown): { url: string | null; domain: string | null } {
	if (typeof raw !== "string" || !raw) return { url: null, domain: null };
	try {
		const u = new URL(raw);
		if (u.protocol !== "https:" && u.protocol !== "http:") return { url: null, domain: null };
		const url = `${u.origin}${u.pathname}`;
		// Refused, never cut: a truncated URL would read as a real one.
		return { url: url.length <= 500 ? url : null, domain: u.hostname.toLowerCase() };
	} catch {
		return { url: null, domain: null };
	}
}

/** Normalise whatever a writer reports into the closed metadata. Unknown points become `action`. */
export function artifactMetadata(input: { point?: unknown; url?: unknown; action?: unknown }): BrowserArtifactMetadata {
	const point = (CAPTURE_POINTS as readonly string[]).includes(String(input.point)) ? (input.point as CapturePoint) : "action";
	const action = typeof input.action === "string" && /^[a-z][a-z0-9_.-]{0,39}$/i.test(input.action) ? input.action.toLowerCase() : null;
	return { point, ...captionUrl(input.url), action };
}

/** Base64 (no data: prefix) → bytes, or null when it is not base64. */
export function base64Bytes(value: string): Uint8Array | null {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
	try {
		return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

interface ArtifactRow {
	id: string;
	user_id: string;
	instance_id: string;
	subject_kind: BrowserArtifactSubject;
	subject_id: string;
	seq: number;
	content_type: string;
	r2_key: string;
	bytes: number;
	point: CapturePoint;
	url: string | null;
	domain: string | null;
	action: string | null;
	created_at: number;
}

const view = (r: ArtifactRow): BrowserArtifactView => ({
	id: r.id,
	subjectKind: r.subject_kind,
	subjectId: r.subject_id,
	seq: r.seq,
	contentType: r.content_type,
	bytes: r.bytes,
	point: r.point,
	url: r.url,
	domain: r.domain,
	action: r.action,
	createdAt: new Date(r.created_at).toISOString(),
});

export interface PutBrowserArtifact {
	userId: string;
	instanceId: string;
	subjectKind: BrowserArtifactSubject;
	subjectId: string;
	seq: number;
	bytes: Uint8Array;
	contentType?: string;
	metadata: { point?: unknown; url?: unknown; action?: unknown };
	retentionDays?: number;
	now?: number;
}

export type PutBrowserArtifactResult = { stored: true; artifact: BrowserArtifactView } | { stored: false; reason: "no_storage" | "bad_seq" | "bad_type" | "empty" | "too_large" | "write_failed" | "screenshots_off" };

/** Where each subject's run recorded the owner's screenshot switch as it started (#1064). */
const SCREENSHOTS_FLAG: Record<BrowserArtifactSubject, string> = {
	runtime_task: "SELECT json_extract(payload, '$.input.screenshots') AS flag FROM instance_runtime_tasks WHERE id = ?1 AND user_id = ?2",
	local_browser_run: "SELECT json_extract(policy, '$.screenshots') AS flag FROM local_browser_runs WHERE id = ?1 AND user_id = ?2",
	local_apply_run: "SELECT json_extract(policy, '$.screenshots') AS flag FROM local_apply_runs WHERE id = ?1 AND user_id = ?2",
};

/**
 * Did this run start with the owner's screenshot switch OFF? The storage half of #1064's three
 * guards: whatever reaches the store — an older runner, a stray pull, a future caller — a frame for an
 * off run is never written. Only an explicit `false` on the run's own record counts.
 */
export async function subjectScreenshotsOff(env: Pick<Env, "DB">, userId: string, subjectKind: BrowserArtifactSubject, subjectId: string): Promise<boolean> {
	const row = await env.DB.prepare(SCREENSHOTS_FLAG[subjectKind]).bind(subjectId, userId).first<{ flag: unknown }>().catch(() => null);
	return row?.flag === 0 || row?.flag === false;
}

/**
 * Store one screenshot. Idempotent per (subject, seq): a re-sync of the same capture returns the stored
 * row rather than writing a second. Best-effort by contract — a refusal or failure is a result, never a
 * throw, because a replay frame must never fail the run it illustrates.
 */
export async function putBrowserArtifact(env: Pick<Env, "DB" | "STORAGE">, input: PutBrowserArtifact): Promise<PutBrowserArtifactResult> {
	if (!env.STORAGE) return { stored: false, reason: "no_storage" };
	if (!Number.isInteger(input.seq) || input.seq < 0) return { stored: false, reason: "bad_seq" };
	const contentType = input.contentType ?? "image/jpeg";
	if (!CONTENT_TYPES.has(contentType)) return { stored: false, reason: "bad_type" };
	if (!input.bytes.byteLength) return { stored: false, reason: "empty" };
	if (await subjectScreenshotsOff(env, input.userId, input.subjectKind, input.subjectId)) return { stored: false, reason: "screenshots_off" };
	if (input.bytes.byteLength > MAX_BROWSER_ARTIFACT_BYTES) return { stored: false, reason: "too_large" };
	const existing = await env.DB.prepare("SELECT * FROM browser_run_artifacts WHERE subject_kind = ?1 AND subject_id = ?2 AND seq = ?3 AND user_id = ?4")
		.bind(input.subjectKind, input.subjectId, input.seq, input.userId)
		.first<ArtifactRow>();
	if (existing) return { stored: true, artifact: view(existing) };
	const now = input.now ?? Date.now();
	const retention = Math.min(Math.max(Math.trunc(input.retentionDays ?? DEFAULT_ARTIFACT_RETENTION_DAYS), 1), 90);
	const key = browserArtifactKey(input.userId, input.instanceId, input.subjectKind, input.subjectId, input.seq, contentType);
	const meta = artifactMetadata(input.metadata);
	const id = crypto.randomUUID();
	try {
		await env.STORAGE.put(key, input.bytes, { httpMetadata: { contentType } });
	} catch {
		return { stored: false, reason: "write_failed" };
	}
	try {
		await env.DB.prepare(
			`INSERT INTO browser_run_artifacts (id, user_id, instance_id, subject_kind, subject_id, seq, kind, content_type, r2_key, bytes, point, url, domain, action, created_at, expires_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'screenshot', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
			 ON CONFLICT (subject_kind, subject_id, seq) DO NOTHING`,
		)
			.bind(id, input.userId, input.instanceId, input.subjectKind, input.subjectId, input.seq, contentType, key, input.bytes.byteLength, meta.point, meta.url, meta.domain, meta.action, now, now + retention * DAY_MS)
			.run();
	} catch {
		// No row means the retention sweep would never find this object: remove it rather than orphan it.
		await env.STORAGE.delete(key).catch(() => undefined);
		return { stored: false, reason: "write_failed" };
	}
	const row = await env.DB.prepare("SELECT * FROM browser_run_artifacts WHERE subject_kind = ?1 AND subject_id = ?2 AND seq = ?3 AND user_id = ?4")
		.bind(input.subjectKind, input.subjectId, input.seq, input.userId)
		.first<ArtifactRow>();
	return row ? { stored: true, artifact: view(row) } : { stored: false, reason: "write_failed" };
}

/** A subject's screenshots, in capture order. Owner-scoped in SQL. */
export async function listBrowserArtifacts(env: Pick<Env, "DB">, userId: string, instanceId: string, subjectKind: BrowserArtifactSubject, subjectId: string): Promise<BrowserArtifactView[]> {
	const { results } = await env.DB.prepare("SELECT * FROM browser_run_artifacts WHERE user_id = ?1 AND instance_id = ?2 AND subject_kind = ?3 AND subject_id = ?4 ORDER BY seq LIMIT 500")
		.bind(userId, instanceId, subjectKind, subjectId)
		.all<ArtifactRow>();
	return (results ?? []).map(view);
}

/** One screenshot's row (with its key), only for its owner and instance. */
export async function readBrowserArtifact(env: Pick<Env, "DB">, userId: string, instanceId: string, artifactId: string): Promise<(BrowserArtifactView & { r2Key: string }) | null> {
	const row = await env.DB.prepare("SELECT * FROM browser_run_artifacts WHERE id = ?1 AND user_id = ?2 AND instance_id = ?3").bind(artifactId, userId, instanceId).first<ArtifactRow>();
	return row ? { ...view(row), r2Key: row.r2_key } : null;
}

/** The highest seq stored for a subject — the cursor a pull-sync resumes from. -1 when none. */
export async function lastBrowserArtifactSeq(env: Pick<Env, "DB">, userId: string, subjectKind: BrowserArtifactSubject, subjectId: string): Promise<number> {
	const row = await env.DB.prepare("SELECT MAX(seq) AS seq FROM browser_run_artifacts WHERE user_id = ?1 AND subject_kind = ?2 AND subject_id = ?3").bind(userId, subjectKind, subjectId).first<{ seq: number | null }>();
	return row?.seq ?? -1;
}

const SUBJECT_TABLE: Record<BrowserArtifactSubject, string> = {
	runtime_task: "instance_runtime_tasks",
	local_browser_run: "local_browser_runs",
	local_apply_run: "local_apply_runs",
};

/** Does this owner's instance really have this run? The subject's OWN row, not just a matching prefix. */
export async function subjectBelongsTo(env: Pick<Env, "DB">, userId: string, instanceId: string, subjectKind: BrowserArtifactSubject, subjectId: string): Promise<boolean> {
	const row = await env.DB.prepare(`SELECT 1 AS ok FROM ${SUBJECT_TABLE[subjectKind]} WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3`).bind(subjectId, instanceId, userId).first<{ ok: number }>();
	return !!row;
}

/**
 * Delete expired screenshots — the R2 object first, then the row, so a failed delete is retried next sweep
 * rather than leaving an object no row points at. Bounded per call. Legacy `runshot/` objects are not
 * tracked here and are never touched.
 */
export async function sweepExpiredBrowserArtifacts(env: Pick<Env, "DB" | "STORAGE">, now = Date.now(), limit = 200): Promise<number> {
	const { results } = await env.DB.prepare("SELECT id, r2_key FROM browser_run_artifacts WHERE expires_at <= ?1 ORDER BY expires_at LIMIT ?2").bind(now, limit).all<{ id: string; r2_key: string }>();
	let deleted = 0;
	for (const r of results ?? []) {
		try {
			await env.STORAGE?.delete(r.r2_key);
		} catch {
			continue;
		}
		await env.DB.prepare("DELETE FROM browser_run_artifacts WHERE id = ?1").bind(r.id).run();
		deleted++;
	}
	return deleted;
}

/**
 * A workflow browser step's screenshot (JOB_APPLY, BROWSER_TASK), stored under subject `runtime_task`.
 * Returns the artifact id the step's `agent.shot` event carries, or null when nothing was stored —
 * best-effort, like every replay frame.
 */
export async function storeWorkflowShot(env: Pick<Env, "DB" | "STORAGE">, input: { userId: string; instanceId: string; taskId: string; seq: number; screenshotBase64: string; action: string; url: string }): Promise<string | null> {
	const bytes = base64Bytes(input.screenshotBase64);
	if (!bytes) return null;
	const out = await putBrowserArtifact(env, { userId: input.userId, instanceId: input.instanceId, subjectKind: "runtime_task", subjectId: input.taskId, seq: input.seq, bytes, metadata: { point: "action", url: input.url, action: input.action } }).catch(() => null);
	return out?.stored ? out.artifact.id : null;
}

/** Enough pages to drain a whole run's capped frames in one sync (a page is ~900 KB of frames). */
const MAX_SHOT_PAGES_PER_SYNC = 8;

/**
 * Pull a local run's new replay frames from its runner (#1063) — the runner cannot push — and store each
 * through the contract. `fetchPage(afterSeq)` is the caller's relay call (`POST …/shots`); an old runner
 * without the route answers nothing, which is simply "no frames". Resumes after the highest stored seq,
 * so a re-sync never stores a frame twice. Best-effort throughout: returns how many were stored.
 */
export async function ingestRunnerShots(
	env: Pick<Env, "DB" | "STORAGE">,
	target: { userId: string; instanceId: string; subjectKind: "local_browser_run" | "local_apply_run"; subjectId: string; retentionDays?: number },
	fetchPage: (afterSeq: number) => Promise<unknown>,
	now = Date.now(),
): Promise<number> {
	if (!env.STORAGE) return 0;
	let after = Math.max(await lastBrowserArtifactSeq(env, target.userId, target.subjectKind, target.subjectId), 0);
	let stored = 0;
	for (let page = 0; page < MAX_SHOT_PAGES_PER_SYNC; page++) {
		const body = (await fetchPage(after).catch(() => null)) as { shots?: unknown; lastSeq?: unknown } | null;
		const shots = Array.isArray(body?.shots) ? (body.shots as Array<Record<string, unknown>>) : [];
		if (!shots.length) break;
		let advanced = after;
		for (const shot of shots) {
			const seq = shot.seq;
			if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= after) continue;
			advanced = Math.max(advanced, seq);
			const bytes = typeof shot.data === "string" ? base64Bytes(shot.data) : null;
			if (!bytes) continue;
			const out = await putBrowserArtifact(env, {
				userId: target.userId,
				instanceId: target.instanceId,
				subjectKind: target.subjectKind,
				subjectId: target.subjectId,
				seq,
				bytes,
				contentType: typeof shot.mimeType === "string" ? shot.mimeType : "image/jpeg",
				metadata: { point: shot.point, url: shot.url, action: shot.action },
				retentionDays: target.retentionDays,
				now,
			});
			if (out.stored) stored++;
		}
		if (advanced <= after) break;
		after = advanced;
	}
	return stored;
}
