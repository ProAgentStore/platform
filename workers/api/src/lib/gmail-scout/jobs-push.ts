/**
 * Push a Scout's leads to the Jobs app (#1587), deterministically, instead of relying on the model
 * to remember to. Runs after a scan and after a browser verification, through the Scout's own MCP
 * grant for `submit_leads` (see lib/jobs-app.ts).
 *
 * Retry is implicit: a lead is stamped `jobs_pushed_at` only after Jobs accepted its batch, so
 * anything not yet stamped is simply sent again the next time this runs. Jobs also dedupes on
 * `source_url`. Nothing here throws — a Jobs problem must never fail a scan or a verification.
 */
import type { Env } from "../../types.js";
import { callJobsTool } from "../jobs-app.js";
import { canonicalJobUrl } from "../job-lead-triage.js";
import { logEvent } from "../events.js";

export const JOBS_PUSH_BATCH = 50;
/** Leads in these states are the owner's or the verifier's "no": never sent. Awaiting ones are sent once verified. */
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
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** A stored Scout lead as `submit_leads` takes it, or null when it lacks what Jobs requires. */
export function toJobsLead(data: Record<string, unknown>, now = Date.now()): JobsLead | null {
	const sourceUrl = canonicalJobUrl(text(data.url));
	// "Senior Engineer - Melbourne, VIC, AU" -> "Senior Engineer"; the place goes to `location` when the lead has none.
	const rawTitle = text(data.title);
	const suffix = rawTitle.match(/\s+-\s+([^-,]+,\s*[A-Z]{2,3},\s*AU)$/);
	const title = (suffix ? rawTitle.slice(0, suffix.index) : rawTitle).trim();
	const company = text(data.company);
	const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	// Jobs refuses over-long values per element, so a lead that cannot fit is not sent rather than cut.
	if (!sourceUrl || !title || !company || !slug || title.length > 200 || company.length > 120 || slug.length > 120) return null;
	const board = text(data.source_domain).toLowerCase().replace(/^www\./, "");
	const loc = text(data.location) || suffix?.[1] || "";
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
	};
}

/** `read` is the Scout's lead reader, passed in because scan.ts imports this module. */
export async function pushScoutLeadsToJobs(env: Env, instanceId: string, userId: string, read: () => Promise<Array<{ id?: string; data?: Record<string, unknown> }>>): Promise<{ sent: number }> {
	try {
		const pending = (await read()).flatMap((r) => {
			if (!r.id || !r.data || r.data.jobs_pushed_at || NOT_PUSHED_STATUSES.has(text(r.data.status))) return [];
			const lead = toJobsLead(r.data);
			return lead ? [{ id: r.id, lead }] : [];
		});
		let sent = 0;
		for (let i = 0; i < pending.length; i += JOBS_PUSH_BATCH) {
			const batch = pending.slice(i, i + JOBS_PUSH_BATCH);
			const out = await callJobsTool(env, { userId, instanceId }, "submit_leads", { leads: JSON.stringify(batch.map((b) => b.lead)) });
			if (!out.ok) {
				// A missing grant is a state, not an incident: stay quiet, the leads wait.
				if (out.reason === "failed") await logEvent(env, { source: "jobs-push", event: "submit_leads_failed", level: "warn", userId, instanceId, message: out.detail }).catch(() => undefined);
				break;
			}
			const at = Date.now();
			for (const b of batch) {
				await env.AGENT.get(env.AGENT.idFromName(instanceId))
					.fetch(new Request(`https://agent/collections/job_leads/records/${encodeURIComponent(b.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: { jobs_pushed_at: at } }) }))
					.catch(() => undefined);
			}
			sent += batch.length;
		}
		return { sent };
	} catch (e) {
		await logEvent(env, { source: "jobs-push", event: "submit_leads_failed", level: "warn", userId, instanceId, message: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
		return { sent: 0 };
	}
}
