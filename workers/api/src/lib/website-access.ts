/** Durable website decisions: navigation permission only, never application submission permission. */
import type { Env } from "../types.js";
import { HttpError } from "./auth.js";
import { normalizeDomain } from "./local-browser/policy.js";
import { consoleHomeLink, websiteAccessRequestLink } from "./console-links.js";
import { attentionDeps } from "./applications/attention-deps.js";
import { requestOwnerAttention, type AttentionDeps } from "./owner-attention.js";
import { notificationDedupeKey } from "./notifications.js";

// The shared sender is best-effort and can swallow a failed in-app insert. Verify durable evidence here.
const websiteAttentionDeps: AttentionDeps<Env> = {
	...attentionDeps,
	notify: async (...args) => {
		const [env, uid, type, title, body, , opts] = args;
		const key = notificationDedupeKey(type, opts.key, title, body);
		const recorded = () => env.DB.prepare("SELECT 1 FROM notifications WHERE user_id = ?1 AND dedupe_key = ?2 LIMIT 1").bind(uid, key).first();
		if (await recorded()) return;
		await attentionDeps.notify(...args);
		if (!(await recorded())) throw new Error("Website question notification was not recorded");
	},
};

export const WEBSITE_SUBJECT_KINDS = ["local_apply_run", "local_browser_run", "runtime_task", "connector"] as const;
export type WebsiteAccessSubjectKind = (typeof WEBSITE_SUBJECT_KINDS)[number];
export interface WebsiteAccessRequest {
	id: string;
	instanceId: string;
	instanceName: string;
	subjectKind: WebsiteAccessSubjectKind;
	subjectId: string;
	hostname: string;
	pauseKey: string;
	status: "pending" | "approved" | "denied";
	createdAt: string;
	decidedAt: string | null;
	link: string;
	questionUrl: string;
	subjectLink: string | null;
}
interface RequestRow {
	id: string; instance_id: string; instance_name?: string; subject_kind: WebsiteAccessSubjectKind; subject_id: string;
	hostname: string; pause_key: string; status: WebsiteAccessRequest["status"]; created_at: number; notified_at: number | null; decided_at: number | null; subject_link: string | null;
}
const view = (r: RequestRow): WebsiteAccessRequest => ({
	id: r.id, instanceId: r.instance_id, instanceName: r.instance_name ?? "Your agent", subjectKind: r.subject_kind, subjectId: r.subject_id,
	hostname: r.hostname, pauseKey: r.pause_key, status: r.status, createdAt: new Date(r.created_at).toISOString(), decidedAt: r.decided_at === null ? null : new Date(r.decided_at).toISOString(),
	link: websiteAccessRequestLink(r.instance_id, r.id), questionUrl: websiteAccessRequestLink(r.instance_id, r.id), subjectLink: r.subject_link,
});
const SELECT_REQUEST = "SELECT r.*, a.name AS instance_name FROM website_access_requests r JOIN agent_instances i ON i.id = r.instance_id AND i.user_id = r.user_id JOIN agents a ON a.id = i.agent_id";
type DB = Pick<Env, "DB">;

export async function getWebsiteAccessRequest(env: DB, uid: string, instanceId: string, id: string): Promise<WebsiteAccessRequest | null> {
	const row = await env.DB.prepare(`${SELECT_REQUEST} WHERE r.id = ?1 AND r.user_id = ?2 AND r.instance_id = ?3`).bind(id, uid, instanceId).first<RequestRow>();
	return row ? view(row) : null;
}

/** Cursor is an opaque request id scoped again by owner+instance; reads never create or decide questions. */
export async function listWebsiteAccessRequests(env: DB, uid: string, instanceId: string, cursor?: string) {
	const boundary = cursor ? await getWebsiteAccessRequest(env, uid, instanceId, cursor) : null;
	if (cursor && !boundary) throw new HttpError(400, "Unknown website request cursor");
	const { results } = await env.DB.prepare(`${SELECT_REQUEST} WHERE r.user_id = ?1 AND r.instance_id = ?2 AND (?3 IS NULL OR r.created_at < ?3 OR (r.created_at = ?3 AND r.id < ?4)) ORDER BY r.created_at DESC, r.id DESC LIMIT 51`)
		.bind(uid, instanceId, boundary ? Date.parse(boundary.createdAt) : null, boundary?.id ?? null).all<RequestRow>();
	const rows = results ?? [];
	const hasMore = rows.length > 50;
	if (hasMore) rows.pop();
	return { requests: rows.map(view), nextCursor: hasMore ? rows.at(-1)?.id ?? null : null };
}

export interface WebsiteDomainDecision { hostname: string; decision: "allow" | "deny" }
export async function listWebsiteDomainDecisions(env: DB, uid: string, instanceId: string): Promise<WebsiteDomainDecision[]> {
	const { results } = await env.DB.prepare("SELECT hostname, decision FROM website_access_grants WHERE user_id = ?1 AND instance_id = ?2 ORDER BY hostname LIMIT 1001").bind(uid, instanceId).all<WebsiteDomainDecision>();
	if ((results?.length ?? 0) > 1000) throw new HttpError(409, "This agent has more than 1000 remembered website decisions. Forget unused decisions before starting another browser run.");
	return results ?? [];
}
export async function listRememberedWebsiteDomains(env: DB, uid: string, instanceId: string): Promise<string[]> {
	return (await listWebsiteDomainDecisions(env, uid, instanceId)).filter((d) => d.decision === "allow").map((d) => d.hostname);
}
export async function listDeniedWebsiteDomains(env: DB, uid: string, instanceId: string): Promise<string[]> {
	return (await listWebsiteDomainDecisions(env, uid, instanceId)).filter((d) => d.decision === "deny").map((d) => d.hostname);
}
export async function revokeWebsiteDomain(env: DB, uid: string, instanceId: string, hostname: string): Promise<void> {
	const domain = normalizeDomain(hostname);
	if (!domain) throw new HttpError(400, "hostname must be an exact hostname, without a URL, path, port or wildcard");
	await env.DB.prepare("DELETE FROM website_access_grants WHERE user_id = ?1 AND instance_id = ?2 AND hostname = ?3").bind(uid, instanceId, domain).run();
}

export async function ensureWebsiteAccessRequest(env: Env, input: {
	userId: string; instanceId: string; subjectKind: WebsiteAccessSubjectKind; subjectId: string; hostname: string; pauseKey: string; subjectLink?: string;
}, deps: { attention?: AttentionDeps<Env>; now?: number } = {}): Promise<WebsiteAccessRequest> {
	const hostname = normalizeDomain(input.hostname);
	if (!hostname || !WEBSITE_SUBJECT_KINDS.includes(input.subjectKind) || !input.subjectId || input.subjectId.length > 200 || !input.pauseKey || input.pauseKey.length > 200) throw new HttpError(400, "A website request needs an exact hostname and bounded subject/pause identifiers");
	const owned = await env.DB.prepare("SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(input.instanceId, input.userId).first();
	if (!owned) throw new HttpError(404, "Instance not found");
	const id = crypto.randomUUID();
	const now = deps.now ?? Date.now();
	// Originating links are navigation conveniences, never approval authority. Only local console paths survive.
	const subjectLink = input.subjectLink?.startsWith(consoleHomeLink()) && !input.subjectLink.includes("\\") && !/[\r\n]/.test(input.subjectLink) ? input.subjectLink : null;
	await env.DB.prepare("INSERT INTO website_access_requests (id,user_id,instance_id,subject_kind,subject_id,hostname,pause_key,subject_link,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE NOT EXISTS (SELECT 1 FROM website_access_grants WHERE user_id = ?2 AND instance_id = ?3 AND hostname = ?6) ON CONFLICT DO NOTHING")
		.bind(id, input.userId, input.instanceId, input.subjectKind, input.subjectId, hostname, input.pauseKey, subjectLink, now).run();
	const row = await env.DB.prepare(`${SELECT_REQUEST} WHERE r.user_id = ?1 AND r.instance_id = ?2 AND r.hostname = ?3 AND (r.status = 'pending' OR r.id IN (SELECT request_id FROM website_access_grants WHERE user_id = ?1 AND instance_id = ?2 AND hostname = ?3)) ORDER BY (r.status = 'pending') ASC LIMIT 1`)
		.bind(input.userId, input.instanceId, hostname).first<RequestRow>();
	if (!row) throw new HttpError(409, "The website question could not be recorded");
	const request = view(row);
	if (row.status === "pending" && row.notified_at === null) {
		// Retry a failed notification on the next observation. Concurrent sends use the same attention key.
		const attention = await requestOwnerAttention(env, {
			event: "approval_required", userId: input.userId, instanceId: input.instanceId,
			subject: { kind: "website-request", instanceId: input.instanceId, requestId: request.id },
			about: { kind: "website-request", id: request.id }, notificationType: "local-browser",
			title: "Allow this agent to visit a new website?",
			body: `Choose whether this agent may visit ${hostname}. Your choice is remembered for this agent and this exact hostname. This does not approve any submission.`,
		}, deps.attention ?? websiteAttentionDeps).catch(() => undefined);
		if (attention?.recorded) await env.DB.prepare("UPDATE website_access_requests SET notified_at = ?1 WHERE id = ?2 AND user_id = ?3 AND instance_id = ?4 AND notified_at IS NULL").bind(now, request.id, input.userId, input.instanceId).run();
	}
	return request;
}

export interface WebsiteAccessAnswerAdapters {
	/** False if the owner changed this agent away from ask_once. Does not depend on the original run being live. */
	canAnswer(request: WebsiteAccessRequest): Promise<boolean>;
	isCurrent(request: WebsiteAccessRequest): Promise<boolean>;
	/** Called once after persistence for other native waiters; counts never imply the original run resumed. */
	afterDecision?(request: WebsiteAccessRequest): Promise<{ continued: number; denied: number; failed: number }>;
	resume?(request: WebsiteAccessRequest): Promise<{ resumed: boolean; reason?: string }>;
}

export async function answerWebsiteAccessRequest(env: DB, uid: string, instanceId: string, id: string, decision: "approve" | "deny", adapters: WebsiteAccessAnswerAdapters, now = Date.now()) {
	let request = await getWebsiteAccessRequest(env, uid, instanceId, id);
	if (!request) throw new HttpError(404, "Website request not found");
	if (decision !== "approve" && decision !== "deny") throw new HttpError(400, "decision must be approve or deny");
	const status = decision === "approve" ? "approved" : "denied";
	if (request.status !== "pending") {
		if (request.status !== status) throw new HttpError(409, "This website question already has a different answer. Change the remembered decision in browser settings.");
		return { request, recorded: true as const, resumed: false, repeated: true, resumeError: "This answer was already recorded. No run was resumed and no revoked permission was restored." };
	}
	if (!(await adapters.canAnswer(request))) throw new HttpError(409, "This agent is no longer configured to ask once for websites. Review its current browser settings.");
	const nonce = crypto.randomUUID();
	// D1 batch is a transaction. Only this call's successful pending→decided CAS can write the decision.
	// Replaying an old approved link after revoke cannot insert another grant.
	const results = await env.DB.batch([
		env.DB.prepare("UPDATE website_access_requests SET status = ?1, decided_at = ?2, answer_nonce = ?3 WHERE id = ?4 AND user_id = ?5 AND instance_id = ?6 AND status = 'pending' AND ((SELECT COUNT(*) FROM website_access_grants WHERE user_id = ?5 AND instance_id = ?6) < 1000 OR EXISTS (SELECT 1 FROM website_access_grants g WHERE g.user_id = ?5 AND g.instance_id = ?6 AND g.hostname = website_access_requests.hostname)) RETURNING id").bind(status, now, nonce, id, uid, instanceId),
		env.DB.prepare("INSERT INTO website_access_grants (user_id,instance_id,hostname,decision,request_id,decided_at) SELECT user_id,instance_id,hostname,?1,id,?2 FROM website_access_requests WHERE id = ?3 AND user_id = ?4 AND instance_id = ?5 AND answer_nonce = ?6 ON CONFLICT(user_id,instance_id,hostname) DO UPDATE SET decision = excluded.decision, request_id = excluded.request_id, decided_at = excluded.decided_at")
			.bind(decision === "approve" ? "allow" : "deny", now, id, uid, instanceId, nonce),
	]);
	request = (await getWebsiteAccessRequest(env, uid, instanceId, id))!;
	if (!results[0].results.length) {
		if (request.status === "pending") throw new HttpError(409, "This agent already remembers 1000 website decisions. Forget an unused decision before answering another website question.");
		if (request.status !== status) throw new HttpError(409, "This website question was answered differently by another request");
		return { request, recorded: true as const, resumed: false, repeated: true };
	}
	let additional: { additionalWaitingTasks?: { continued: number; denied: number; failed: number }; additionalWaitingTasksError?: string } = {};
	if (adapters.afterDecision) {
		try { additional = { additionalWaitingTasks: await adapters.afterDecision(request) }; }
		catch { additional = { additionalWaitingTasksError: "Website decision saved, but other waiting tasks could not all be updated. Check their current statuses." }; }
	}
	try {
		if (!(await adapters.isCurrent(request))) return { ...additional, request, recorded: true as const, resumed: false, repeated: false, resumeError: "Website decision saved for future runs. The original run is no longer waiting on this website question; no run was started or resumed." };
		const outcome = adapters.resume ? await adapters.resume(request) : { resumed: false };
		if (decision === "deny") return { ...additional, request, recorded: true as const, resumed: false, repeated: false, ...(outcome.reason ? { resumeError: outcome.reason } : {}) };
		return { ...additional, request, recorded: true as const, resumed: outcome.resumed, repeated: false, ...(!outcome.resumed ? { resumeError: outcome.reason ?? "Permission saved. Resume the original run when it is available." } : {}) };
	} catch {
		return { ...additional, request, recorded: true as const, resumed: false, repeated: false, resumeError: decision === "deny" ? "Website denial saved, but the original waiting run could not be updated. Check its current status; access remains denied." : "Permission saved, but the original run could not be resumed. Check its current status before continuing." };
	}
}
