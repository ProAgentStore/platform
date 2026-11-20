/**
 * "Needs you" (#1640): everything on the account that is waiting on the OWNER, in one read.
 *
 * This is an aggregation, not new state. Each source below reads the table its own surface already
 * owns, with the same "still pending" predicate that surface uses, so an item leaves the inbox when it is
 * RESOLVED at its source (answered, decided, expired, run finished) and never because someone looked at it.
 *
 * Cost: every source is one bounded query over a PARTIAL index that holds only the pending rows
 * (migration 0344), joined to the owner's instances. A count (the nav badge) is the same predicate under
 * COUNT(*), so the badge and the list cannot disagree about what is waiting.
 *
 * Privacy: items carry a title and a short summary written from the request's own metadata — never a
 * secure-input value, a credential, a URL a browser is on, or page text.
 */
import { applicationCardLabel } from "./applications/application-board.js";
import { ANSWER_PENDING_SQL } from "./coder-question-store.js";
import { accountApprovalLink, applicationLink, browserTakeoverLink, codingSessionLink, instanceLink, instancePermissionsLink, instanceRunLink, websiteAccessRequestLink } from "./console-links.js";
import { instanceListName } from "./instance-config.js";
import type { Env } from "../types.js";

export const INBOX_KINDS = ["secure_input", "website_access", "permission", "takeover", "mcp_input", "coder_question", "approval", "task", "application", "run_parked"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const INBOX_URGENCIES = ["blocking", "normal", "low"] as const;
export type InboxUrgency = (typeof INBOX_URGENCIES)[number];

export const INBOX_SORTS = ["newest", "oldest", "urgency", "expiring"] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

export interface InboxItem {
	/** `<kind>:<sourceId>` — stable for as long as the item waits. */
	id: string;
	kind: InboxKind;
	instanceId: string | null;
	instanceName: string | null;
	agentSlug: string | null;
	title: string;
	summary: string;
	createdAt: string;
	/** When the item gives up or expires, if it does. */
	expiresAt: string | null;
	/** `blocking`: something live is held (a browser, a parked run). */
	urgency: InboxUrgency;
	/** The console route (no basename) where it is answered. */
	route: string;
}

/** Per-source outcome, so a source that could not be read is never reported as "nothing waiting". */
export interface InboxSourceStatus {
	kind: InboxKind;
	ok: boolean;
	/** True when the per-source cap was hit: more are waiting than are listed. */
	truncated?: boolean;
	error?: string;
}

const PER_SOURCE_LIMIT = 100;

type Row = Record<string, unknown>;
interface Ctx {
	now: number;
}

interface Source {
	kind: InboxKind;
	table: string;
	/** The column on the table naming its instance; null for an account-level source. */
	instanceCol: string | null;
	/** Predicate over alias `r` (and `i` for the instance). Binds start at ?2 (?1 is the owner). */
	where: string;
	binds: (ctx: Ctx) => unknown[];
	/** Extra selected columns (alias `r`). */
	select: string;
	order: string;
	map: (row: Row, ctx: Ctx) => Pick<InboxItem, "title" | "summary" | "createdAt" | "expiresAt" | "urgency" | "route">;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const iso = (ms: number): string => new Date(ms).toISOString();

/** A stored time as ISO: epoch ms, ISO text, or SQLite's `YYYY-MM-DD HH:MM:SS` (UTC). */
export function toIso(v: unknown): string {
	if (typeof v === "number" && Number.isFinite(v)) return iso(v);
	if (typeof v === "string" && v) {
		const ms = Date.parse(/^\d{4}-\d\d-\d\d \d/.test(v) ? `${v.replace(" ", "T")}Z` : v);
		if (Number.isFinite(ms)) return iso(ms);
	}
	return iso(0);
}
const toIsoOrNull = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : toIso(v));
const unslash = (link: string): string => link.replace(/^\/console/, "");

const TAKEOVER_REASONS: Record<string, string> = {
	login_required: "needs you to sign in",
	captcha: "hit a CAPTCHA",
	consent_required: "needs your consent on a site",
	access_blocked: "was blocked by a site",
	paywall: "hit a paywall",
	write_affordance: "needs you to confirm a change",
	manual: "asked for you to take over",
};

/** ISO text expiries compare through datetime() so an ISO and a SQL-format value order the same way. */
const textNotExpired = (col: string) => `datetime(${col}) > datetime(?2)`;

const SOURCES: Source[] = [
	{
		kind: "secure_input",
		table: "secure_input_requests",
		instanceCol: "instance_id",
		where: `r.status = 'pending' AND ${textNotExpired("r.expires_at")}`,
		binds: ({ now }) => [iso(now)],
		select: "r.id, r.label, r.created_at, r.expires_at",
		order: "r.created_at ASC",
		map: (r) => ({ title: `Enter a value: ${clip(str(r.label), 120)}`, summary: "The agent never sees it; enter it in the console.", createdAt: toIso(r.created_at), expiresAt: toIsoOrNull(r.expires_at), urgency: "normal", route: "" }),
	},
	{
		kind: "website_access",
		table: "website_access_requests",
		instanceCol: "instance_id",
		where: "r.status = 'pending'",
		binds: () => [],
		select: "r.id, r.hostname, r.created_at",
		order: "r.created_at ASC",
		map: (r) => ({ title: `Allow ${clip(str(r.hostname), 120)}?`, summary: "An agent asked to open this website.", createdAt: toIso(r.created_at), expiresAt: null, urgency: "normal", route: "" }),
	},
	{
		kind: "permission",
		table: "instance_permission_requests",
		instanceCol: "instance_id",
		where: `r.status = 'pending' AND ${textNotExpired("r.expires_at")}`,
		binds: ({ now }) => [iso(now)],
		select: "r.id, r.control, r.connector, r.requested_scope, r.reason, r.created_at, r.expires_at",
		order: "r.created_at ASC",
		map: (r) => ({
			title: `Permission: ${clip([str(r.connector), str(r.control)].filter(Boolean).join(" · "), 100)} (${clip(str(r.requested_scope), 40)})`,
			summary: clip(str(r.reason), 200),
			createdAt: toIso(r.created_at),
			expiresAt: toIsoOrNull(r.expires_at),
			urgency: "normal",
			route: "",
		}),
	},
	{
		kind: "takeover",
		table: "browser_takeovers",
		instanceCol: "instance_id",
		where: "r.state IN ('requested', 'active') AND r.expires_at > ?2",
		binds: ({ now }) => [now],
		select: "r.id, r.subject_kind, r.subject_id, r.reason, r.created_at, r.expires_at",
		order: "r.created_at ASC",
		map: (r) => ({ title: `Browser ${TAKEOVER_REASONS[str(r.reason)] ?? "needs you"}`, summary: "A browser is held open until you take over or hand it back.", createdAt: toIso(r.created_at), expiresAt: toIsoOrNull(r.expires_at), urgency: "blocking", route: "" }),
	},
	{
		kind: "mcp_input",
		table: "mcp_input_requests",
		instanceCol: "instance_id",
		where: `r.status = 'pending' AND ${textNotExpired("r.expires_at")}`,
		binds: ({ now }) => [iso(now)],
		select: "r.id, r.tool, r.message, r.created_at, r.expires_at",
		order: "r.created_at ASC",
		map: (r) => ({ title: `A connected tool needs input: ${clip(str(r.tool), 80)}`, summary: clip(str(r.message), 200), createdAt: toIso(r.created_at), expiresAt: toIsoOrNull(r.expires_at), urgency: "normal", route: "" }),
	},
	{
		// `brain_deciding` is the platform working, not the owner waiting, so it is not here.
		kind: "coder_question",
		table: "coder_questions",
		instanceCol: "instance_id",
		where: "r.state IN ('waiting_human', 'escalated')",
		binds: () => [],
		select: "r.id, r.session_id, r.task_id, r.question, r.why, r.asked_at, r.expires_at",
		order: "r.asked_at ASC",
		map: (r) => ({ title: clip(str(r.question), 160), summary: clip(str(r.why), 200), createdAt: toIso(r.asked_at), expiresAt: toIsoOrNull(r.expires_at), urgency: "blocking", route: "" }),
	},
	{
		kind: "approval",
		table: "account_change_requests",
		instanceCol: null,
		where: "r.status = 'pending' AND r.expires_at > ?2",
		binds: ({ now }) => [now],
		select: "r.id, r.target_description, r.action, r.created_at, r.expires_at",
		order: "r.created_at ASC",
		map: (r) => ({ title: `Approve a change: ${clip(str(r.target_description) || str(r.action), 140)}`, summary: "An account change is held until you approve it.", createdAt: toIso(r.created_at), expiresAt: toIsoOrNull(r.expires_at), urgency: "normal", route: unslash(accountApprovalLink(str(r.id))) }),
	},
	{
		// The board's own words for "a person must act": needs_human, and needs_approval for an actionable ticket.
		kind: "task",
		table: "instance_runtime_tasks",
		instanceCol: "instance_id",
		where: "r.status IN ('needs_human', 'needs_approval')",
		binds: () => [],
		select: "r.id, r.type, r.status, json_extract(r.payload, '$.title') AS ptitle, r.created_at",
		order: "r.updated_at ASC",
		map: (r) => ({
			title: str(r.ptitle) ? clip(str(r.ptitle), 160) : `Task ${str(r.type)} ${r.status === "needs_approval" ? "needs approval" : "needs you"}`,
			summary: r.status === "needs_approval" ? "Waiting for your approval." : "Waiting for you to take over or answer.",
			createdAt: toIso(r.created_at),
			expiresAt: null,
			urgency: r.status === "needs_approval" ? "low" : "normal",
			route: "",
		}),
	},
	{
		kind: "application",
		table: "job_applications",
		instanceCol: "instance_id",
		where: "r.status = 'awaiting_review'",
		binds: () => [],
		select: "r.id, r.lead, r.created_at, r.updated_at",
		order: "r.updated_at ASC",
		map: (r) => {
			let lead: unknown = null;
			try {
				lead = JSON.parse(str(r.lead));
			} catch {
				/* a lead that cannot be read still gets a row, titled by its id */
			}
			const label = applicationCardLabel({ lead } as never);
			return { title: `Review application: ${label.title}`, summary: "Filled in and waiting for your review before it is submitted.", createdAt: toIso(r.updated_at ?? r.created_at), expiresAt: null, urgency: "normal", route: "" };
		},
	},
	{
		// A run parked on a person. A `decision` park that has an open coder question is that question's row, not a
		// second one; one whose answer is already recorded is waiting on the RUN, not the owner (#1678).
		kind: "run_parked",
		table: "agent_loop_runs",
		instanceCol: "instance_id",
		where: `r.status = 'running' AND (r.waiting_reason IN ('human', 'engine_auth') OR (r.waiting_reason = 'decision' AND NOT EXISTS (SELECT 1 FROM coder_questions q WHERE q.run_id = r.run_id AND (q.state IN ('waiting_human', 'escalated') OR (${ANSWER_PENDING_SQL})))))`,
		binds: () => [],
		select: "r.run_id AS id, r.session_id, r.objective, r.waiting_reason, r.waiting_until, r.parked_since, r.started_at, json_extract(r.waiting_ask, '$.taskId') AS task_id, json_extract(r.waiting_ask, '$.question') AS question",
		order: "r.started_at ASC",
		map: (r) => ({
			title: r.waiting_reason === "engine_auth" ? "A coding CLI needs you to sign in" : r.waiting_reason === "decision" ? (str(r.question) ? clip(str(r.question), 160) : "A run is waiting for your decision") : "A run is waiting for you",
			summary: clip(str(r.objective), 200),
			createdAt: toIso(r.parked_since ?? r.started_at),
			expiresAt: toIsoOrNull(r.waiting_until),
			urgency: "blocking",
			route: "",
		}),
	},
];

/**
 * A coding question is answered on its run's task page (`RunDetail`), not the session view, which for a
 * suspended session has nothing to answer (#1678). Same order as the handoff notification's own link
 * (`coding-pause.ts` `handoffLink`): the task when there is one, else the session.
 */
function codingQuestionRoute(instanceId: string, row: Row): string {
	const taskId = str(row.task_id);
	return unslash(taskId ? instanceRunLink(instanceId, taskId) : codingSessionLink(instanceId, str(row.session_id) || undefined));
}

/** The console route where an item is answered. Reuses the link builders every notification already uses. */
function routeFor(kind: InboxKind, instanceId: string, row: Row): string {
	const id = str(row.id);
	switch (kind) {
		case "secure_input":
			return `/instances/${encodeURIComponent(instanceId)}/secure-inputs/${encodeURIComponent(id)}`;
		case "website_access":
			return unslash(websiteAccessRequestLink(instanceId, id));
		case "permission":
			return unslash(instancePermissionsLink(instanceId, id));
		case "takeover":
			return unslash(browserTakeoverLink(instanceId, { id, subjectKind: str(row.subject_kind), subjectId: str(row.subject_id) }));
		case "mcp_input":
			return unslash(`${instanceLink(instanceId)}/settings?subtab=agent`);
		case "coder_question":
			return codingQuestionRoute(instanceId, row);
		case "task":
			return unslash(instanceRunLink(instanceId, id));
		case "application":
			return unslash(applicationLink(instanceId, id));
		case "run_parked":
			return codingQuestionRoute(instanceId, row);
		case "approval":
			return "/preferences";
	}
}

function sql(src: Source, count: boolean): string {
	const inst = src.instanceCol ? ` JOIN agent_instances i ON i.id = r.${src.instanceCol} AND i.user_id = r.user_id AND i.status != 'canceled'` : "";
	const agent = src.instanceCol && !count ? " JOIN agents a ON a.id = i.agent_id" : "";
	const from = `${src.table} r${inst}${agent}`;
	if (count) return `SELECT COUNT(*) AS n FROM ${from} WHERE r.user_id = ?1 AND ${src.where}`;
	const cols = src.instanceCol ? `${src.select}, r.${src.instanceCol} AS instance_id, i.config AS icfg, a.name AS aname, a.slug AS aslug` : src.select;
	return `SELECT ${cols} FROM ${from} WHERE r.user_id = ?1 AND ${src.where} ORDER BY ${src.order} LIMIT ${PER_SOURCE_LIMIT}`;
}

async function readSource(env: Env, uid: string, src: Source, ctx: Ctx): Promise<{ items: InboxItem[]; truncated: boolean }> {
	const { results } = await env.DB.prepare(sql(src, false))
		.bind(uid, ...src.binds(ctx))
		.all<Row>();
	const rows = results ?? [];
	const items = rows.map((row): InboxItem => {
		const base = src.map(row, ctx);
		const instanceId = src.instanceCol ? str(row.instance_id) : null;
		return {
			id: `${src.kind}:${str(row.id)}`,
			kind: src.kind,
			instanceId,
			instanceName: instanceId ? instanceListName(str(row.icfg) || null, str(row.aname) || null) : null,
			agentSlug: instanceId ? str(row.aslug) || null : null,
			...base,
			route: base.route || (instanceId ? routeFor(src.kind, instanceId, row) : routeFor(src.kind, "", row)),
		};
	});
	return { items, truncated: rows.length >= PER_SOURCE_LIMIT };
}

/** Every source, each read independently: one failing is reported in `sources`, never dropped. */
export async function readInbox(env: Env, uid: string, now = Date.now()): Promise<{ items: InboxItem[]; sources: InboxSourceStatus[] }> {
	const ctx: Ctx = { now };
	const settled = await Promise.allSettled(SOURCES.map((s) => readSource(env, uid, s, ctx)));
	const items: InboxItem[] = [];
	const sources: InboxSourceStatus[] = settled.map((res, i) => {
		const kind = SOURCES[i].kind;
		if (res.status === "rejected") return { kind, ok: false, error: clip(res.reason instanceof Error ? res.reason.message : String(res.reason), 200) };
		items.push(...res.value.items);
		return res.value.truncated ? { kind, ok: true, truncated: true } : { kind, ok: true };
	});
	return { items, sources };
}

/** The nav badge: the same predicates under COUNT(*), no names, no rows. A failed source marks the count partial. */
export async function countInbox(env: Env, uid: string, now = Date.now()): Promise<{ count: number; partial: boolean }> {
	const ctx: Ctx = { now };
	const settled = await Promise.allSettled(
		SOURCES.map((s) =>
			env.DB.prepare(sql(s, true))
				.bind(uid, ...s.binds(ctx))
				.first<{ n: number }>(),
		),
	);
	let count = 0;
	let partial = false;
	for (const r of settled) {
		if (r.status === "rejected") partial = true;
		else count += Number(r.value?.n) || 0;
	}
	return { count, partial };
}

export interface InboxQuery {
	kinds: InboxKind[];
	instances: string[];
	agent: string | null;
	urgency: InboxUrgency | null;
	sort: InboxSort;
}

const URGENCY_RANK: Record<InboxUrgency, number> = { blocking: 0, normal: 1, low: 2 };

/** Filter + sort. Pure. Ties always break by newest, then id, so the order is stable between polls. */
export function applyInboxQuery(items: InboxItem[], q: InboxQuery): InboxItem[] {
	const out = items.filter(
		(it) =>
			(!q.kinds.length || q.kinds.includes(it.kind)) &&
			(!q.instances.length || (it.instanceId !== null && q.instances.includes(it.instanceId))) &&
			(!q.agent || it.agentSlug === q.agent) &&
			(!q.urgency || it.urgency === q.urgency),
	);
	const newest = (a: InboxItem, b: InboxItem) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id);
	const cmp: Record<InboxSort, (a: InboxItem, b: InboxItem) => number> = {
		newest,
		oldest: (a, b) => -newest(a, b) || a.id.localeCompare(b.id),
		urgency: (a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || newest(a, b),
		// Soonest to give up first; items that never expire go last.
		expiring: (a, b) => (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity) || newest(a, b),
	};
	return out.sort(cmp[q.sort]);
}

export interface InboxCounts {
	total: number;
	byKind: Partial<Record<InboxKind, number>>;
	byInstance: Array<{ instanceId: string; name: string | null; count: number }>;
	byAgent: Array<{ slug: string; count: number }>;
	byUrgency: Partial<Record<InboxUrgency, number>>;
}

/** Counts over the whole waiting set (not the filtered view), so every chip shows what it would add. */
export function inboxCounts(items: InboxItem[]): InboxCounts {
	const byKind: InboxCounts["byKind"] = {};
	const byUrgency: InboxCounts["byUrgency"] = {};
	const inst = new Map<string, { instanceId: string; name: string | null; count: number }>();
	const agents = new Map<string, number>();
	for (const it of items) {
		byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
		byUrgency[it.urgency] = (byUrgency[it.urgency] ?? 0) + 1;
		if (it.instanceId) {
			const e = inst.get(it.instanceId) ?? { instanceId: it.instanceId, name: it.instanceName, count: 0 };
			e.count++;
			inst.set(it.instanceId, e);
		}
		if (it.agentSlug) agents.set(it.agentSlug, (agents.get(it.agentSlug) ?? 0) + 1);
	}
	return {
		total: items.length,
		byKind,
		byInstance: [...inst.values()].sort((a, b) => b.count - a.count || a.instanceId.localeCompare(b.instanceId)),
		byAgent: [...agents].map(([slug, count]) => ({ slug, count })).sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug)),
		byUrgency,
	};
}
