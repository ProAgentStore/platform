/**
 * Push a Scout's leads to the Jobs app (#1587, #1607), deterministically, instead of relying on the model
 * to remember to. Runs after a scan, a browser verification and a triage, through the Scout's own MCP
 * grants (see lib/jobs-app.ts):
 *
 *   - `submit_leads` once per lead (`jobs_pushed_at`), carrying `external_id` (the PAGS lead id), location,
 *     verification state and the owner's decision;
 *   - `update_my_lead` whenever those tracked values later change (`jobs_synced_key` is the last state Jobs
 *     has) — a verification outcome, a triage decision, a reason there is no original;
 *   - `get_my_lead_by_url` then `publish_lead` once the browser verification recorded the ORIGINAL posting
 *     behind a board ad (`verification.original_url`), stamped `jobs_published_at`.
 *
 * Retry is implicit: each stamp is written only after Jobs accepted that step, so anything not yet stamped
 * is simply sent again the next time this runs. Jobs also dedupes on `source_url`. Nothing here throws — a
 * Jobs problem must never fail a scan, a verification or a triage.
 */
import type { Env } from "../../types.js";
import { callJobsTool } from "../jobs-app.js";
import { jobPostingIdentity } from "../job-lead-triage.js";
import { gateLocation } from "../local-apply/submission-gate.js";
import type { JobsPushOutcome } from "./receipts.js";
import { logEvent } from "../events.js";
import { clipMarked } from "../clip-marked.js";

export const JOBS_PUSH_BATCH = 50;
/** Leads whose tracked values are brought up to date per pass: the rest wait for the next one, so a backlog is never one long request. */
export const JOBS_UPDATE_BUDGET = 25;
/** Leads in these states are the owner's or the verifier's "no": never first-sent (one Jobs already holds is still updated). Awaiting ones are sent once verified. */
const NOT_PUSHED_STATUSES = new Set(["awaiting_browser_verification", "skipped", "archived", "unverifiable", "blocked"]);

export interface JobsLead {
	source_url: string;
	source_board?: string;
	title: string;
	company_name: string;
	company_slug: string;
	country: "AU";
	location?: string;
	seen_at?: number;
	/** The PAGS lead id (#1607). */
	external_id?: string;
	verification_state?: "live" | "expired" | "unverifiable";
	verified_at?: number;
	decision?: "pending" | "apply" | "skip" | "archived";
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The lead's verification as Jobs names it: PAGS `live` / `unavailable` / `unverifiable`; anything else is not yet a verdict. */
const VERIFICATION_STATE: Record<string, JobsLead["verification_state"]> = { live: "live", unavailable: "expired", unverifiable: "unverifiable" };
/** The owner's triage as Jobs names it. A deferral is still undecided. */
const DECISION: Record<string, JobsLead["decision"]> = { apply_requested: "apply", tailoring: "apply", skipped: "skip", archived: "archived" };

/** The tracked values Jobs holds for a lead besides its identity: sent with `submit_leads`, kept current with `update_my_lead`. */
function tracking(data: Record<string, unknown>): Pick<JobsLead, "verification_state" | "verified_at" | "decision"> {
	const v = record(data.verification);
	const state = VERIFICATION_STATE[text(v.state)];
	const checked = Date.parse(text(v.checked_at));
	return {
		...(state ? { verification_state: state } : {}),
		...(state && Number.isFinite(checked) && checked > 0 ? { verified_at: checked } : {}),
		decision: DECISION[text(data.status)] ?? "pending",
	};
}

/** Why Jobs has no original for a verified-live lead (`no_original_reason`, <= 500 chars), or undefined. */
function noOriginalReason(data: Record<string, unknown>): string | undefined {
	const v = record(data.verification);
	// The Original Finder's verdict (#1608) is more specific than why the Scout found none: `not_found` / `out_of_scope`, and what was searched.
	if (typeof v.no_original_reason === "string" && v.no_original_reason) return clipMarked(`${v.no_original_reason}${typeof v.original_searched === "string" && v.original_searched ? `: ${v.original_searched}` : ""}`, 500, { within: true });
	if (v.original === "quick_apply") return "SEEK Quick Apply: no employer posting";
	if (v.original === "none") return typeof v.original_rejected === "string" ? `No usable original (${v.original_rejected})` : "No apply link leaves the job board";
	return undefined;
}

/** A stored Scout lead as `submit_leads` takes it, or null when it lacks what Jobs requires. */
export function toJobsLead(data: Record<string, unknown>, now = Date.now(), externalId?: string): JobsLead | null {
	const sourceUrl = jobPostingIdentity(text(data.url))?.url;
	// "Senior Engineer - Melbourne, VIC, AU" -> "Senior Engineer"; the place goes to `location` when the lead has none.
	const rawTitle = text(data.title);
	const suffix = rawTitle.match(/\s+-\s+([^-,]+,\s*[A-Z]{2,3},\s*AU)$/);
	const title = (suffix ? rawTitle.slice(0, suffix.index) : rawTitle).trim();
	const company = text(data.company);
	const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	// Jobs refuses over-long values per element, so a lead that cannot fit is not sent rather than cut.
	if (!sourceUrl || !title || !company || !slug || title.length > 200 || company.length > 120 || slug.length > 120) return null;
	const board = text(data.source_domain).toLowerCase().replace(/^www\./, "");
	// A lead from an alert has no location; a live-verified SEEK page title ("<role> Job in <place> - SEEK") supplies one (gateLocation, #1576).
	const v = record(data.verification);
	const loc = gateLocation({ lead: { location: text(data.location) || suffix?.[1] || "" }, verification: { state: text(v.state), title: text(v.title) } }) ?? "";
	const location = loc.length <= 120 ? loc : "";
	const seen = Date.parse(text(data.gmail_date));
	return {
		source_url: sourceUrl,
		...(board && board.length <= 40 && /^[a-z0-9.-]+$/.test(board) ? { source_board: board } : {}),
		title,
		company_name: company,
		company_slug: slug,
		country: "AU",
		...(location ? { location } : {}),
		...(Number.isFinite(seen) && seen >= 1e12 && seen <= now + 300_000 ? { seen_at: seen } : {}),
		...(externalId && externalId.length <= 200 ? { external_id: externalId } : {}),
		...tracking(data),
	};
}

type LeadRecord = { id?: string; data?: Record<string, unknown> };
const stamp = (env: Env, instanceId: string, id: string, data: Record<string, unknown>) =>
	env.AGENT.get(env.AGENT.idFromName(instanceId))
		.fetch(new Request(`https://agent/collections/job_leads/records/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) }))
		.catch(() => undefined);

/** What Jobs should hold for a lead's tracked values; a change from `jobs_synced_key` is an `update_my_lead`. */
function trackedState(lead: JobsLead, data: Record<string, unknown>, submitted = false) {
	// `submit_leads` has no no_original_reason: a lead just submitted still owes Jobs that one, via update_my_lead.
	const reason = submitted ? undefined : noOriginalReason(data);
	return { ...(lead.location ? { location: lead.location } : {}), ...(lead.verification_state ? { verification_state: lead.verification_state } : {}), ...(lead.verified_at ? { verified_at: lead.verified_at } : {}), decision: lead.decision, ...(reason ? { no_original_reason: reason } : {}) };
}

/**
 * The first row of a Jobs query tool's result. The MCP server answers a query with the rows as a JSON array text
 * (pas/platform packages/mcp tool-loader.ts: `JSON.stringify(rows)`), which `mcp_call_tool` parses to an array; no rows is the
 * text "No results found." - a string here.
 */
function firstRow(data: unknown): Record<string, unknown> | null {
	return Array.isArray(data) && record(data[0]).id ? record(data[0]) : null;
}

const failed = (env: Env, userId: string, instanceId: string, event: string, message: string) => logEvent(env, { source: "jobs-push", event, level: "warn", userId, instanceId, message }).catch(() => undefined);

/** Publish the original posting a verification found behind a board ad (#1607). Returns whether to stamp `jobs_published_at`. */
async function publishOriginal(env: Env, who: { userId: string; instanceId: string }, lead: JobsLead, data: Record<string, unknown>): Promise<boolean> {
	const v = record(data.verification);
	const url = text(v.original_url);
	const host = text(v.original_host);
	const description = text(v.original_description);
	if (v.original !== "external" || !url || !host || !description) return false;
	const found = await callJobsTool(env, who, "get_my_lead_by_url", { source_url: lead.source_url });
	if (!found.ok) {
		if (found.reason === "failed") await failed(env, who.userId, who.instanceId, "get_my_lead_by_url_failed", found.detail);
		return false;
	}
	const row = firstRow(found.data);
	if (!row) return false; // Jobs does not hold the lead (yet): the next push submits it, then this runs again.
	if (row.status !== "new") return true; // already published (or a duplicate/rejected one): nothing to publish
	// publish_lead takes a slug of at most 120 characters: the company + title when that fits, else the company's own.
	const full = `${lead.company_slug}-${lead.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	const out = await callJobsTool(env, who, "publish_lead", {
		lead_id: String(row.id),
		original_url: url,
		source_host: host,
		slug: full.length <= 120 ? full : lead.company_slug,
		description,
		...(lead.location ? { location: lead.location } : {}),
	});
	if (!out.ok) {
		if (out.reason === "failed") await failed(env, who.userId, who.instanceId, "publish_lead_failed", out.detail);
		return false;
	}
	return true;
}

/**
 * `read` is the Scout's lead reader, passed in because scan.ts imports this module. `onlyLeadId` limits the pass to one lead
 * (a triage or a verification touched just that one).
 */
export async function pushScoutLeadsToJobs(env: Env, instanceId: string, userId: string, read: () => Promise<LeadRecord[]>, onlyLeadId?: string): Promise<JobsPushOutcome> {
	try {
		const who = { userId, instanceId };
		const records = (await read()).flatMap((r) => (r.id && r.data && (!onlyLeadId || r.id === onlyLeadId) ? [{ id: r.id, data: r.data }] : []));
		const pending = records.flatMap((r) => {
			if (r.data.jobs_pushed_at || NOT_PUSHED_STATUSES.has(text(r.data.status))) return [];
			const lead = toJobsLead(r.data, Date.now(), r.id);
			return lead ? [{ id: r.id, lead, data: r.data }] : [];
		});
		let sent = 0;
		let granted = true;
		let reason: string | null = null;
		for (let i = 0; i < pending.length && granted; i += JOBS_PUSH_BATCH) {
			const batch = pending.slice(i, i + JOBS_PUSH_BATCH);
			const out = await callJobsTool(env, who, "submit_leads", { leads: JSON.stringify(batch.map((b) => b.lead)) });
			if (!out.ok) {
				// A missing grant is a state, not an incident: stay quiet, the leads wait. The receipt still says why (#1605).
				reason = out.reason;
				if (out.reason === "failed") await failed(env, userId, instanceId, "submit_leads_failed", out.detail);
				granted = false;
				break;
			}
			const at = Date.now();
			for (const b of batch) {
				const state = trackedState(b.lead, b.data, true);
				await stamp(env, instanceId, b.id, { jobs_pushed_at: at, jobs_synced_key: JSON.stringify(state) });
				b.data.jobs_pushed_at = at;
				b.data.jobs_synced_key = JSON.stringify(state);
			}
			sent += batch.length;
		}
		// Leads Jobs already holds: keep their tracked values current, then publish a found original.
		let budget = JOBS_UPDATE_BUDGET;
		for (const r of records) {
			if (!r.data.jobs_pushed_at || budget <= 0) continue;
			const lead = toJobsLead(r.data, Date.now(), r.id);
			if (!lead) continue;
			const state = trackedState(lead, r.data);
			const key = JSON.stringify(state);
			if (key !== r.data.jobs_synced_key) {
				budget--;
				const out = await callJobsTool(env, who, "update_my_lead", { source_url: lead.source_url, external_id: r.id, ...state });
				if (out.ok) await stamp(env, instanceId, r.id, { jobs_synced_key: key });
				else if (out.reason === "failed") await failed(env, userId, instanceId, "update_my_lead_failed", out.detail);
			}
			if (!r.data.jobs_published_at && record(r.data.verification).original === "external") {
				budget--;
				if (await publishOriginal(env, who, lead, r.data)) await stamp(env, instanceId, r.id, { jobs_published_at: Date.now() });
			}
		}
		return { sent, failed: reason ? pending.length - sent : 0, reason };
	} catch (e) {
		await failed(env, userId, instanceId, "submit_leads_failed", e instanceof Error ? e.message : String(e));
		return { sent: 0, failed: 0, reason: "failed" };
	}
}
