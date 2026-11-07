/**
 * One-off, idempotent repair of a Scout's stored leads to today's identity rules (#1606): re-key them
 * (tracking parameters, https, per-source ids), link duplicates and reposts to the first lead, archive
 * search-result pages, and fill the employer of careers-site leads. `dryRun` writes nothing and returns
 * the same counts the real run would produce. A second run changes nothing.
 */
import type { Env } from "../../types.js";
import { JOB_LEAD_TRANSITIONS, jobLeadStatus, jobLeadVersion, jobPostingIdentity, workKeyForLead } from "../job-lead-triage.js";
import { employerByHost, findRepostOf, inferCompany, isSearchResultsUrl } from "./lead-hygiene.js";
import { readGmailScoutLeadRecords } from "./scan.js";

export interface JobLeadRepairCounts {
	dryRun: boolean;
	scanned: number;
	/** Leads whose `work_key` / `url` changed to the current identity. */
	rekeyed: number;
	/** The same job held twice (same identity): later ones linked and archived. */
	duplicatesLinked: number;
	/** Same company + title within 60 days: later ones linked and archived. */
	repostsLinked: number;
	searchPagesArchived: number;
	companiesFilled: number;
	/** Leads that should be archived but are applied for or past archiving, so were left alone. */
	protectedKept: number;
	/** More leads than one read returns: run it again after this one. */
	truncated: boolean;
}

const READ_LIMIT = 500;
type Rec = { id?: string; data?: Record<string, unknown> };
const when = (d: Record<string, unknown>) => Date.parse(String(d.gmail_date ?? d.posted_date ?? "")) || 0;
const applied = (d: Record<string, unknown>) => typeof d.apply_request_id === "string";

export async function repairJobLeads(env: Env, instanceId: string, opts: { dryRun: boolean }): Promise<JobLeadRepairCounts> {
	const records = ((await readGmailScoutLeadRecords(env, instanceId, new URLSearchParams({ limit: String(READ_LIMIT) }))) as Rec[]).filter((r): r is Required<Rec> => !!r.id && !!r.data);
	const counts: JobLeadRepairCounts = { dryRun: opts.dryRun, scanned: records.length, rekeyed: 0, duplicatesLinked: 0, repostsLinked: 0, searchPagesArchived: 0, companiesFilled: 0, protectedKept: 0, truncated: records.length >= READ_LIMIT };
	const patches = new Map<string, Record<string, unknown>>();
	const view = new Map<string, Record<string, unknown>>(records.map((r) => [r.id, { ...r.data }]));
	const patch = (id: string, p: Record<string, unknown>) => {
		patches.set(id, { ...patches.get(id), ...p });
		Object.assign(view.get(id) as Record<string, unknown>, p);
	};
	const archive = (id: string, reason: string, extra: Record<string, unknown>): boolean => {
		const d = view.get(id) as Record<string, unknown>;
		const status = jobLeadStatus(d);
		if (applied(d) || !JOB_LEAD_TRANSITIONS[status].includes("archived")) return false;
		const version = jobLeadVersion(d) + 1;
		const lifecycle = Array.isArray(d.lifecycle) ? d.lifecycle : [];
		patch(id, { ...extra, status: "archived", archived_reason: reason, lifecycle_version: version, lifecycle: [...lifecycle, { from: status, to: "archived", action: "archive", version, at: new Date().toISOString(), note: reason }] });
		return true;
	};

	// Employers by host come from the leads as stored, before anything is filled in.
	const byHost = employerByHost(records);
	const ordered = [...records].sort((a, b) => when(a.data) - when(b.data));
	const keepers = new Map<string, string>();
	// Progressed or live leads win a key over archived ones, then the earliest.
	const rank = (d: Record<string, unknown>) => (applied(d) ? 0 : jobLeadStatus(d) === "archived" ? 2 : 1);
	for (const r of [...ordered].sort((a, b) => rank(a.data) - rank(b.data))) {
		const key = workKeyForLead(r.data);
		if (key && !keepers.has(key)) keepers.set(key, r.id);
	}

	for (const r of ordered) {
		const d = view.get(r.id) as Record<string, unknown>;
		const key = workKeyForLead(d);
		const url = typeof d.url === "string" ? jobPostingIdentity(d.url)?.url : undefined;
		const isLoser = !!key && keepers.get(key) !== r.id;

		if (!isLoser && key && url && (d.work_key !== key || d.url !== url)) {
			patch(r.id, { work_key: key, url });
			counts.rekeyed++;
		}
		const named = inferCompany(d, byHost);
		if (named) {
			patch(r.id, { company: named.company, company_source: named.source });
			counts.companiesFilled++;
		}
		if (d.duplicate_of) continue;
		if (typeof d.url === "string" && isSearchResultsUrl(d.url)) {
			if (archive(r.id, "search_results_page", {})) counts.searchPagesArchived++;
			else if (jobLeadStatus(d) !== "archived") counts.protectedKept++;
			continue;
		}
		const first = isLoser ? keepers.get(key as string) : findRepostOf(d, ordered.filter((o) => o.id !== r.id && when(o.data) <= when(d)).map((o) => ({ id: o.id, data: view.get(o.id) })))?.id;
		if (!first || first === r.id) continue;
		if (archive(r.id, isLoser ? "duplicate_job" : "repost", { duplicate_of: first })) isLoser ? counts.duplicatesLinked++ : counts.repostsLinked++;
		else counts.protectedKept++;
	}

	if (!opts.dryRun) {
		const agent = env.AGENT.get(env.AGENT.idFromName(instanceId));
		for (const [id, data] of patches) {
			const res = await agent.fetch(new Request(`https://agent/collections/job_leads/records/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) }));
			if (!res.ok) throw new Error(`Could not repair lead ${id}: ${res.status}`);
		}
	}
	return counts;
}
