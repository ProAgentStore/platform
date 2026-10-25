/**
 * Owner-visible delivery state and safe recovery for release notes (#1348).
 *
 * The queue (lib/release-note-queue.ts) claims `sending` BEFORE the provider write, so a crash or an
 * unreadable reply leaves a row there on purpose: the platform never guesses whether it was posted.
 * This module is the owner's side of that rule:
 *
 *   list       the instance's rows, newest first, with the derived `state`, the evidence, the permalink
 *              and the attempt history. Keyset-paged on the immutable `created_at`, so a note queued mid-walk
 *              never shifts a page. Rows older than {@link RETENTION_DAYS} are not listed (not deleted).
 *   retry      `failed` ONLY. The provider said no; once the cause is fixed the owner may try again. Every
 *              precondition is rechecked, the status moves by compare-and-swap, and the queue still
 *              rechecks everything again before it posts.
 *   reconcile  `sending` ONLY, and only once it is {@link UNCERTAIN_AFTER_MS} old (a live send is not
 *              "uncertain"). The owner attaches the message's permalink (delivered), gives up (abandoned),
 *              or attests the channel holds no post and accepts the duplicate risk (one retry).
 *
 * `sent`, `cancelled`, `expired` and `abandoned` rows are never reopened here. Every state change leaves a
 * row in the append-only `release_note_attempts`.
 */
import { HttpError } from "./auth.js";
import { deepLinkFor } from "./console-links.js";
import { logEvent } from "./events.js";
import { keysetBefore, keysetPage, type CursorQuery } from "./history-page.js";
import { recordAttempt, type AttemptKind } from "./release-note-attempts.js";
import { collectWorkflowRuns, liveFetcher } from "./github-evidence.js";
import { completedReleaseEvidence, liveJobsPage, verifyDeployProof, type ReleaseQueueDeps, type Row } from "./release-note-queue.js";
import { deliveryBotConnected } from "./release-notes.js";
import { gateIsComplete, grantedReleaseChannels, loadReleaseNotes } from "./release-notes-settings.js";
import type { InstanceReleaseNotes, ReleaseChannel, ReleaseDeliveriesResponse, ReleaseDelivery, ReleaseDeliveryActionResponse, ReleaseDeliveryAttempt, ReleaseDeliveryState, ReleaseNoteProvider } from "../agent-types.js";
import type { Env } from "../types.js";

export const RETENTION_DAYS = 90;
export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 50;
/** A claimed send younger than this may still be in flight; older, its outcome is uncertain. */
export const UNCERTAIN_AFTER_MS = 10 * 60_000;
/** The queue's evidence window (unchanged by #1348): a note older than this is expired by the next tick. */
const EVIDENCE_WINDOW_MS = 48 * 60 * 60_000;
const ATTEMPTS_SHOWN = 20;

/** What the owner types to release an uncertain row for ONE more send. */
export const RECONCILE_RETRY_CONFIRM = "no post exists in the channel; send it again";
export const DUPLICATE_WARNING = "Duplicate risk: the first send may have reached the channel. Check the channel for this release note first. If it is there, mark it delivered with its permalink instead. Sending again can post the same announcement twice.";

type QueueRow = Row & { instance_id: string; status: string; hold_code: string | null; reason: string | null; permalink: string | null; updated_at: number; evidence_json: string | null };
type AttemptRow = { id: string; queue_id: string; kind: ReleaseDeliveryAttempt["kind"]; outcome: string; reason: string | null; permalink: string | null; evidence_json: string | null; created_at: number };
type AttemptEvidence = { channel?: { provider?: ReleaseNoteProvider; name?: string; channelId?: string }; workflowRuns?: string[]; deployJob?: string | null };

export interface DeliveryDeps extends Pick<ReleaseQueueDeps, "readRuns" | "readJobsPage" | "fetchPage"> {
	now?: () => number;
	botConnected?: (env: Env, userId: string, provider: ReleaseNoteProvider) => Promise<boolean>;
}

const parseEvidence = (json: string | null): AttemptEvidence => {
	try { return JSON.parse(json ?? "{}") as AttemptEvidence; } catch { return {}; }
};

/** A gated note whose commit range the queue has not read yet (#1349). */
const awaitingRange = (contextJson: string | undefined): boolean => {
	try { return !!(JSON.parse(contextJson ?? "{}") as { pendingRange?: unknown }).pendingRange; } catch { return false; }
};

export function deriveState(row: Pick<QueueRow, "status" | "updated_at"> & { context_json?: string }, now: number): ReleaseDeliveryState {
	switch (row.status) {
		case "pending": return awaitingRange(row.context_json) ? "awaiting_commit_range" : "waiting_for_checks";
		case "held": return "evidence_held";
		case "configuration_required": return "configuration_required";
		case "cancelled": return "configuration_changed";
		case "sending": return now - row.updated_at >= UNCERTAIN_AFTER_MS ? "outcome_uncertain" : "sending";
		case "failed": return "delivery_failed";
		case "sent": return "sent";
		case "expired": return "expired";
		case "abandoned": return "abandoned";
		default: return "waiting_for_checks";
	}
}

const actionsFor = (row: QueueRow, now: number) => ({
	retry: row.status === "failed" && now - row.created_at <= EVIDENCE_WINDOW_MS,
	reconcile: deriveState(row, now) === "outcome_uncertain",
});

function toDelivery(row: QueueRow, attempts: AttemptRow[], grants: ReleaseChannel[], now: number): ReleaseDelivery {
	const own = attempts.filter((a) => a.queue_id === row.id).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
	// The claim records where the note was going and which runs proved it; that is true even if the grant is gone since.
	const evidence = [...own].reverse().map((a) => parseEvidence(a.evidence_json)).find((e) => e.channel || e.workflowRuns) ?? {};
	const grant = grants.find((g) => g.grantId === row.grant_id);
	const provider = grant?.provider ?? evidence.channel?.provider;
	const name = grant?.name ?? evidence.channel?.name;
	const workflowRuns = evidence.workflowRuns ?? [];
	const deployJob = evidence.deployJob ?? (parseEvidence(row.evidence_json) as { jobUrl?: string }).jobUrl ?? null;
	return {
		id: row.id,
		repo: row.github_repo,
		sha: row.sha,
		runId: row.run_id,
		sessionId: row.session_id,
		destination: provider && name ? { provider, name } : null,
		status: row.status,
		state: deriveState(row, now),
		reason: row.reason,
		holdCode: row.hold_code ?? null,
		permalink: row.permalink,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		actions: actionsFor(row, now),
		evidence: { workflowRuns, deployJob },
		links: { codingRun: deepLinkFor({ kind: "coding-session", instanceId: row.instance_id, sessionId: row.session_id }), permalink: row.permalink, workflowRuns, deployJob },
		attempts: own.slice(-ATTEMPTS_SHOWN).map((a) => ({ id: a.id, kind: a.kind, outcome: a.outcome, reason: a.reason, permalink: a.permalink, at: a.created_at })),
	};
}

async function attemptsFor(env: Env, userId: string, ids: string[]): Promise<AttemptRow[]> {
	if (!ids.length) return [];
	const marks = ids.map((_id, i) => `?${i + 2}`).join(",");
	return (await env.DB.prepare(`SELECT id, queue_id, kind, outcome, reason, permalink, evidence_json, created_at FROM release_note_attempts WHERE user_id = ?1 AND queue_id IN (${marks}) ORDER BY created_at, id`).bind(userId, ...ids).all<AttemptRow>()).results ?? [];
}

/** Newest first, owner- and instance-scoped in SQL, one page past `limit` read to know whether there is more. */
export async function listDeliveries(env: Env, userId: string, instanceId: string, cursor: CursorQuery, limitRaw: number | undefined, now = Date.now()): Promise<ReleaseDeliveriesResponse> {
	const limit = Math.min(Math.max(Math.trunc(limitRaw ?? PAGE_DEFAULT) || PAGE_DEFAULT, 1), PAGE_MAX);
	const horizon = now - RETENTION_DAYS * 86_400_000;
	const binds: unknown[] = [userId, instanceId, horizon];
	const where = ["user_id = ?1", "instance_id = ?2", "created_at >= ?3"];
	keysetBefore(cursor, "created_at", where, binds);
	binds.push(limit + 1);
	const rows = (await env.DB.prepare(`SELECT * FROM release_note_queue WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?${binds.length}`).bind(...binds).all<QueueRow>()).results ?? [];
	const page = keysetPage(rows, limit, (r) => r.created_at);
	const grants = await grantedReleaseChannels(env, instanceId, userId).catch(() => []);
	const attempts = await attemptsFor(env, userId, page.rows.map((r) => r.id));
	return { deliveries: page.rows.map((r) => toDelivery(r, attempts, grants, now)), hasMore: page.hasMore, nextCursor: page.nextCursor, retention: { days: RETENTION_DAYS, horizon: new Date(horizon).toISOString() } };
}

async function loadRow(env: Env, userId: string, instanceId: string, id: string): Promise<QueueRow> {
	const row = await env.DB.prepare("SELECT * FROM release_note_queue WHERE id = ?1 AND user_id = ?2 AND instance_id = ?3").bind(id, userId, instanceId).first<QueueRow>();
	if (!row) throw new HttpError(404, "No such release note delivery for this agent.");
	return row;
}

async function viewOf(env: Env, userId: string, instanceId: string, id: string, now: number): Promise<ReleaseDelivery> {
	const row = await loadRow(env, userId, instanceId, id);
	return toDelivery(row, await attemptsFor(env, userId, [id]), await grantedReleaseChannels(env, instanceId, userId).catch(() => []), now);
}

const keyOk = (key: unknown): key is string => typeof key === "string" && /^[A-Za-z0-9._:-]{8,120}$/.test(key);

/** Every precondition of sending again; the queue repeats them at post time. Throws HttpError with the specific reason. */
async function recheckBeforeResend(env: Env, userId: string, row: QueueRow, deps: DeliveryDeps, now: number): Promise<void> {
	if (now - row.created_at > EVIDENCE_WINDOW_MS) throw new HttpError(409, "This note is older than the 48-hour evidence window, so the queue would expire it. It cannot be sent again; the window is not changed by retry.");
	const settings = await loadReleaseNotes(env, row.instance_id, userId);
	if (!settings) throw new HttpError(404, "Instance not found");
	if (!settings.effective.enabled) throw new HttpError(409, "Release notes are turned off for this agent, so nothing can be sent.");
	const channel = settings.effective.channels.find((c) => c.grantId === row.grant_id && c.selected);
	if (!channel) throw new HttpError(409, "The destination channel's grant was revoked or is no longer selected for release notes.");
	const current: InstanceReleaseNotes["requiredWorkflows"] = settings.instance.requiredWorkflows;
	if (!gateIsComplete(current)) throw new HttpError(409, "The release gate is missing or incomplete (the production_deploy workflow needs jobName and stepName), so no production note can be sent.");
	if (JSON.stringify(current) !== row.workflows_json) throw new HttpError(409, "The release gate changed since this note was queued; it was queued under a different gate and is not re-evaluated here.");
	const connected = await (deps.botConnected ?? deliveryBotConnected)(env, userId, channel.provider);
	if (!connected) throw new HttpError(409, `The ${channel.provider} bot is not connected for this account; connect it first.`);
	const required = JSON.parse(row.workflows_json) as NonNullable<InstanceReleaseNotes["requiredWorkflows"]>;
	let runs: NonNullable<Awaited<ReturnType<NonNullable<ReleaseQueueDeps["readRuns"]>>>>;
	if (deps.readRuns) {
		try { runs = await deps.readRuns(row); } catch (e) { throw new HttpError(503, `GitHub workflow evidence could not be read just now (${e instanceof Error ? e.message : String(e)}). Try again shortly.`); }
	} else {
		const collected = await collectWorkflowRuns(deps.fetchPage ?? liveFetcher(env, userId, row.github_repo.split("/")[0]), row.github_repo, row.sha);
		if (!collected.ok && collected.kind === "transient") throw new HttpError(503, `GitHub workflow evidence could not be read just now (${collected.message}). Try again shortly.`);
		if (!collected.ok) throw new HttpError(409, `The workflow evidence for this commit is incomplete: ${collected.message}`);
		runs = collected.value;
	}
	const evidence = completedReleaseEvidence(runs, row.sha, row.default_branch, required);
	if (!evidence) throw new HttpError(409, `The required workflows have not all succeeded on ${row.sha} and ${row.default_branch}, so the note cannot be sent.`);
	const index = required.findIndex((w) => w.role === "production_deploy");
	const proof = await verifyDeployProof(row, evidence[index], required[index], (page) => deps.readJobsPage ? deps.readJobsPage(row, evidence[index], page) : liveJobsPage(env, row, evidence[index], page));
	if (!proof.ok) throw new HttpError(409, `Production deploy not proven: ${proof.reason}`);
}

const notRetryable = (row: QueueRow, now: number): HttpError => {
	switch (deriveState(row, now)) {
		case "outcome_uncertain": return new HttpError(409, "This send's outcome is uncertain, so Retry refuses it. Reconcile it instead: attach the message permalink, abandon it, or confirm the channel holds no post.");
		case "sending": return new HttpError(409, "This send is still in flight. Wait for it to finish.");
		case "sent": return new HttpError(409, "Already delivered: a sent note is never retried.");
		case "configuration_changed": return new HttpError(409, "This note was cancelled because the setting or channel grant changed. Retry only applies to a failed delivery.");
		case "expired": return new HttpError(409, "This note expired after the 48-hour evidence window. Retry only applies to a failed delivery.");
		case "abandoned": return new HttpError(409, "The owner abandoned this note. Retry only applies to a failed delivery.");
		case "evidence_held": return new HttpError(409, "This note is held because its GitHub evidence is permanently incomplete or inconsistent (see the reason). Retry only applies to a failed delivery.");
		case "awaiting_commit_range": return new HttpError(409, "The queue is still reading this note's commit range from GitHub; it continues by itself. Retry only applies to a failed delivery.");
		case "configuration_required": return new HttpError(409, "This note is held until the release gate has its deploy job and step; it resumes by itself once the gate is saved.");
		default: return new HttpError(409, "This note is still waiting for its checks; the queue will send it. Retry only applies to a failed delivery.");
	}
};

/** `failed` → `pending`, once. */
export async function retryDelivery(env: Env, userId: string, instanceId: string, id: string, input: { idempotencyKey?: unknown }, deps: DeliveryDeps = {}): Promise<ReleaseDeliveryActionResponse> {
	const now = (deps.now ?? Date.now)();
	if (input.idempotencyKey !== undefined && !keyOk(input.idempotencyKey)) throw new HttpError(400, "idempotencyKey must be 8–120 characters of letters, digits and . _ : -");
	const key = input.idempotencyKey ? `retry:${id}:${input.idempotencyKey}` : null;
	const replay = async () => key && await env.DB.prepare("SELECT id FROM release_note_attempts WHERE idempotency_key = ?1 AND user_id = ?2").bind(key, userId).first();
	const row = await loadRow(env, userId, instanceId, id);
	if (await replay()) return { delivery: await viewOf(env, userId, instanceId, id, now), replayed: true };
	if (row.status !== "failed") throw notRetryable(row, now);
	await recheckBeforeResend(env, userId, row, deps, now);
	const swap = await env.DB.prepare("UPDATE release_note_queue SET status='pending', reason=NULL, updated_at=?1 WHERE id=?2 AND user_id=?3 AND status='failed'").bind(now, id, userId).run();
	if (!swap.meta.changes) {
		if (await replay()) return { delivery: await viewOf(env, userId, instanceId, id, now), replayed: true };
		throw new HttpError(409, "Another request already changed this delivery. Reload it.");
	}
	await recordAttempt(env, { queueId: id, userId, instanceId, kind: "retry", outcome: "requeued", reason: `Previous failure: ${row.reason ?? "unknown"}`, key: key ?? `retry:${id}:${crypto.randomUUID()}`, now });
	await logEvent(env, { source: "coding", userId, instanceId, traceId: row.run_id, event: "release_note_retry_requested", message: `Owner requested a retry of the release note for ${row.sha} after: ${row.reason ?? "a failed send"}`, context: { queueId: id, sha: row.sha } }).catch(() => undefined);
	return { delivery: await viewOf(env, userId, instanceId, id, now), replayed: false };
}

export type ReconcileInput = { action?: unknown; permalink?: unknown; confirm?: unknown; channelChecked?: unknown; idempotencyKey?: unknown };

/** Slack and Discord message links for exactly the row's channel. */
function permalinkMatches(provider: ReleaseNoteProvider, channelId: string, link: string): boolean {
	const id = channelId.replace(/[^A-Za-z0-9]/g, "");
	if (!id || id !== channelId) return false;
	return provider === "slack"
		? new RegExp(`^https://[a-z0-9-]+\\.slack\\.com/archives/${id}/p\\d{10,}(?:\\?[^\\s#]*)?$`).test(link)
		: new RegExp(`^https://(?:ptb\\.|canary\\.)?discord(?:app)?\\.com/channels/\\d+/${id}/\\d+$`).test(link);
}

/** What to do with a send whose outcome the platform cannot know. Never automatic. */
export async function reconcileDelivery(env: Env, userId: string, instanceId: string, id: string, input: ReconcileInput, deps: DeliveryDeps = {}): Promise<ReleaseDeliveryActionResponse> {
	const now = (deps.now ?? Date.now)();
	const action = input.action;
	if (action !== "mark_delivered" && action !== "abandon" && action !== "retry_after_channel_check") throw new HttpError(400, "action must be mark_delivered, abandon or retry_after_channel_check.");
	if (input.idempotencyKey !== undefined && !keyOk(input.idempotencyKey)) throw new HttpError(400, "idempotencyKey must be 8–120 characters of letters, digits and . _ : -");
	const key = input.idempotencyKey ? `reconcile:${id}:${action}:${input.idempotencyKey}` : null;
	const replay = async () => key && await env.DB.prepare("SELECT id FROM release_note_attempts WHERE idempotency_key = ?1 AND user_id = ?2").bind(key, userId).first();
	const row = await loadRow(env, userId, instanceId, id);
	if (await replay()) return { delivery: await viewOf(env, userId, instanceId, id, now), replayed: true, ...(action === "retry_after_channel_check" ? { warning: DUPLICATE_WARNING } : {}) };
	const state = deriveState(row, now);
	if (row.status !== "sending") throw new HttpError(409, row.status === "failed" ? "A known failure is not reconciled: use Retry." : row.status === "sent" ? "Already delivered: nothing to reconcile." : `A ${row.status} note has no uncertain send to reconcile.`);
	if (state !== "outcome_uncertain") throw new HttpError(409, `This send was claimed less than ${UNCERTAIN_AFTER_MS / 60_000} minutes ago and may still be in flight. Reconcile it once it has been quiet that long.`);
	const kind: AttemptKind = action === "mark_delivered" ? "reconcile_delivered" : action === "abandon" ? "reconcile_abandoned" : "reconcile_retry";
	const attemptKey = key ?? `reconcile:${id}:${action}:${crypto.randomUUID()}`;
	let swap: { meta: { changes: number } };
	let permalink: string | null = null;
	let outcome: string;
	if (action === "mark_delivered") {
		permalink = typeof input.permalink === "string" ? input.permalink.trim() : "";
		if (!permalink) throw new HttpError(400, "mark_delivered needs the permalink of the message you saw in the channel.");
		const claim = (await attemptsFor(env, userId, [id])).map((a) => parseEvidence(a.evidence_json).channel).find((c) => c?.channelId && c.provider);
		const grant = (await grantedReleaseChannels(env, instanceId, userId).catch(() => [])).find((g) => g.grantId === row.grant_id);
		const provider = claim?.provider ?? grant?.provider;
		const channelId = claim?.channelId ?? grant?.channelId;
		if (!provider || !channelId) throw new HttpError(409, "The destination channel can no longer be determined, so the permalink cannot be checked against it. Abandon the note instead.");
		if (!permalinkMatches(provider, channelId, permalink)) throw new HttpError(400, `That is not a ${provider} message link for this note's channel.`);
		swap = await env.DB.prepare("UPDATE release_note_queue SET status='sent', reason=NULL, permalink=?1, updated_at=?2 WHERE id=?3 AND user_id=?4 AND status='sending'").bind(permalink, now, id, userId).run();
		outcome = "sent";
	} else if (action === "abandon") {
		swap = await env.DB.prepare("UPDATE release_note_queue SET status='abandoned', reason='Abandoned by the owner: the outcome of the send was never confirmed', updated_at=?1 WHERE id=?2 AND user_id=?3 AND status='sending'").bind(now, id, userId).run();
		outcome = "abandoned";
	} else {
		if (input.confirm !== RECONCILE_RETRY_CONFIRM || input.channelChecked !== true) throw new HttpError(409, `${DUPLICATE_WARNING} To send again, pass channelChecked: true and confirm: "${RECONCILE_RETRY_CONFIRM}".`);
		await recheckBeforeResend(env, userId, row, deps, now);
		swap = await env.DB.prepare("UPDATE release_note_queue SET status='pending', reason=NULL, updated_at=?1 WHERE id=?2 AND user_id=?3 AND status='sending'").bind(now, id, userId).run();
		outcome = "requeued";
	}
	if (!swap.meta.changes) {
		if (await replay()) return { delivery: await viewOf(env, userId, instanceId, id, now), replayed: true };
		throw new HttpError(409, "Another request already changed this delivery. Reload it.");
	}
	await recordAttempt(env, { queueId: id, userId, instanceId, kind, outcome, reason: action === "retry_after_channel_check" ? "Owner attested the channel holds no post and accepted the duplicate risk" : action === "abandon" ? "Owner abandoned an uncertain send" : "Owner attached the observed message", permalink, key: attemptKey, now });
	await logEvent(env, { source: "coding", userId, instanceId, traceId: row.run_id, event: "release_note_reconciled", level: action === "retry_after_channel_check" ? "warn" : "info", message: `Owner reconciled the uncertain release note for ${row.sha}: ${action}`, context: { queueId: id, sha: row.sha, action, ...(permalink ? { permalink } : {}) } }).catch(() => undefined);
	return { delivery: await viewOf(env, userId, instanceId, id, now), replayed: false, ...(action === "retry_after_channel_check" ? { warning: DUPLICATE_WARNING } : {}) };
}
