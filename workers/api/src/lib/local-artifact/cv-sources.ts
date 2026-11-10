/**
 * The owner's CV app as the Application Tailor's source (#1624 phase 2, proappstore-online/cv#1).
 *
 * When the Tailor instance holds a grant for CV `get_career_book`, a run's two sources are built from the
 * owner's career book instead of the uploaded résumé PDF: the book rendered as the `resume` source, and
 * the owner's resume-usable facts plus the playbook chosen for this job as the `profile` source. They ride
 * the existing uploaded-source envelope (role, provenance, text, and an extracted-text hash the runner
 * re-checks), so no runner change is needed. With the grant but no reachable book the run is refused —
 * never silently tailored from the old PDF.
 */
import type { Env } from "../../types.js";
import { callAppTool, CV_MCP_URL } from "../jobs-app.js";
import { hasMcpConsent, normalizeMcpEndpoint } from "../mcp-consent.js";
import { sha256Hex } from "../../agent-storage-utils.js";
import { LOCAL_ARTIFACT_CAPS, type LocalArtifactLead, type LocalArtifactUploadedSource } from "./contract.js";
import { listUploadedTailorSourceSelections, materializeUploadedTailorSources } from "./uploaded-sources.js";

/** Stable ids for the two CV-built sources; `version` carries the book revision and the playbook used. */
export const CV_SOURCE_IDS = { resume: "cv-career-book", profile: "cv-profile-playbook" } as const;

type Who = { userId: string; instanceId: string };
type Book = {
	revision: number;
	facts: Array<{ key: string; value: string; allowed_use: string }>;
	roles: Array<{ id: string; title: string; organization: string | null; employment_type: string | null; start_month: string | null; end_month: string | null; location: string | null; summary: string | null; title_variants: Array<{ title: string; allowed_for: string[] }> }>;
	projects: Array<{ role_id: string | null; name: string; summary: string | null; tech: string[] }>;
	stories: Array<{ role_id: string | null; headline: string; situation: string | null; task: string | null; action: string | null; result: string | null; metrics: string | null; confidence: string; visibility: string; skills: Array<{ name: string }> }>;
	skills: Array<{ name: string; category: string | null; years: number | null }>;
	credentials: Array<{ kind: string; name: string; issuer: string | null; issued: string | null; expires: string | null; status: string; notes: string | null }>;
};
type Playbook = { kind: string; region: string; name: string; instructions: string; section_order: string; max_pages: number | null; emphasis_themes: string; exclude: string };

/** Does this Tailor instance take its sources from the CV app? A grant for `get_career_book` is the switch. */
export const cvSourcesEnabled = (env: Env, instanceId: string) => hasMcpConsent(env, instanceId, normalizeMcpEndpoint(CV_MCP_URL), "get_career_book");

/** The kind of résumé a job title calls for, matching the CV app's seeded playbook kinds. */
export function playbookKindFor(title: string): string {
	const t = title.toLowerCase();
	if (/\b(cto|chief (technology|technical|digital|information) officer|vp,? (of )?engineering|vice president,? engineering)\b/.test(t)) return "cto";
	if (/\b(head of (engineering|technology|software|platform|development|ai)|engineering manager|director of (engineering|technology)|software development manager|development manager)\b/.test(t)) return "head_of_eng";
	if (/\b(principal|staff|architect|engineer|developer|programmer)\b/.test(t)) return "principal_eng";
	if (/\b(service delivery|delivery (manager|lead|director))\b/.test(t)) return "delivery";
	return "pm";
}

/** A region overlay key for the job's location: the CV app's playbooks and compensation use the same keys. */
export function regionFor(location: string | undefined): string | null {
	const l = (location ?? "").toLowerCase();
	if (/sydney|\bnsw\b/.test(l)) return "AU-NSW-Sydney";
	if (/melbourne|\bvic\b|victoria/.test(l)) return "AU-VIC";
	if (/australia|\b(qld|wa|sa|act|tas|nt)\b|brisbane|perth|adelaide|canberra|hobart|darwin/.test(l)) return "AU";
	return null;
}

const json = <T>(v: string, fallback: T): T => { try { return JSON.parse(v) as T; } catch { return fallback; } };
/** Review notes the seed left for the owner ("⚠ To confirm: …") are not facts to write from. */
const withoutReviewNotes = (text: string | null) => (text ?? "").split("⚠ To confirm:")[0].trim();
const dates = (start: string | null, end: string | null) => `${start ?? "?"} – ${end ?? "present"}`;

/** The book as the `resume` source: every role newest first, its allowed titles, and its resume-visible stories. */
export function renderBook(book: Book): string {
	const out: string[] = ["# Career book (the owner's complete professional history)", ""];
	for (const role of book.roles) {
		out.push(`## ${role.title} — ${role.organization ?? "Unknown organisation"} (${dates(role.start_month, role.end_month)})`);
		if (role.employment_type) out.push(`Employment type: ${role.employment_type}`);
		if (role.location) out.push(`Location: ${role.location}`);
		if (role.title_variants.length) out.push(`This role may also be titled: ${role.title_variants.map((v) => `${v.title}${v.allowed_for.length ? ` (for ${v.allowed_for.join(", ")} résumés only)` : ""}`).join("; ")}`);
		const summary = withoutReviewNotes(role.summary);
		if (summary) out.push(summary);
		for (const p of book.projects.filter((x) => x.role_id === role.id)) out.push(`- Project: ${p.name}${p.summary ? ` — ${p.summary}` : ""}${p.tech.length ? ` (${p.tech.join(", ")})` : ""}`);
		for (const s of book.stories.filter((x) => x.role_id === role.id && x.visibility === "resume" && x.confidence !== "draft")) {
			const parts = [s.situation, s.task, s.action, s.result].filter(Boolean).join(" ");
			out.push(`- ${s.headline}${parts ? `. ${parts}` : ""}${s.metrics ? ` Metrics: ${s.metrics}.` : ""}${s.skills.length ? ` Skills: ${s.skills.map((k) => k.name).join(", ")}.` : ""}`);
		}
		out.push("");
	}
	if (book.credentials.length) {
		out.push("## Education and certifications");
		for (const c of book.credentials) {
			const note = c.notes && !c.notes.trim().startsWith("⚠") ? ` — ${c.notes}` : "";
			out.push(`- ${c.name}${c.issuer ? `, ${c.issuer}` : ""}${c.issued ? `, ${c.issued}` : ""} (${c.kind}; status: ${c.status.toUpperCase()}${c.expires ? `, expires ${c.expires}` : ""})${note}`);
		}
		out.push("");
	}
	if (book.skills.length) {
		out.push("## Skills");
		out.push(book.skills.map((k) => `${k.name}${k.years ? ` (${k.years} years)` : ""}`).join(", "));
	}
	return out.join("\n").trim();
}

/** The `profile` source: the facts the owner allows on a résumé, then the owner's writing instructions for this job. */
export function renderProfile(book: Book, playbook: Playbook | null, kind: string): string {
	const out = ["# Candidate profile (from the owner's CV app)", ""];
	for (const f of book.facts.filter((x) => x.allowed_use === "resume" && !x.value.includes("⚠"))) out.push(`- ${f.key.replace(/_/g, " ")}: ${f.value}`);
	if (playbook) {
		const list = (v: string) => json<string[]>(v, []).join(", ");
		out.push("", `# The owner's writing instructions for this application (playbook "${playbook.name}", kind ${kind}${playbook.region ? `, region ${playbook.region}` : ""})`);
		out.push("These are the owner's instructions for HOW to write the résumé and cover letter. They are not facts about the owner: follow them, and never cite them as a claim.");
		if (list(playbook.section_order)) out.push(`- Section order: ${list(playbook.section_order)}`);
		if (list(playbook.emphasis_themes)) out.push(`- Lead with these themes: ${list(playbook.emphasis_themes)}`);
		if (list(playbook.exclude)) out.push(`- Leave out: ${list(playbook.exclude)}`);
		if (playbook.max_pages) out.push(`- At most ${playbook.max_pages} pages`);
		if (playbook.instructions.trim()) out.push("", playbook.instructions.trim());
	}
	return out.join("\n").trim();
}

/** Base playbook with the region overlay's non-empty fields applied over it. */
function mergePlaybook(rows: Playbook[]): Playbook | null {
	const base = rows.find((r) => r.region === "") ?? null;
	const overlay = rows.find((r) => r.region !== "");
	if (!base || !overlay) return base ?? overlay ?? null;
	const has = (v: string) => v && v !== "[]";
	return { ...base, region: overlay.region, name: overlay.name || base.name, instructions: [base.instructions, overlay.instructions].filter((x) => x.trim()).join("\n\n"), section_order: has(overlay.section_order) ? overlay.section_order : base.section_order, max_pages: overlay.max_pages ?? base.max_pages, emphasis_themes: has(overlay.emphasis_themes) ? overlay.emphasis_themes : base.emphasis_themes, exclude: has(overlay.exclude) ? overlay.exclude : base.exclude };
}

async function query<T>(env: Env, who: Who, tool: string, args: Record<string, unknown>): Promise<T[]> {
	const r = await callAppTool(env, who, CV_MCP_URL, tool, args);
	if (!r.ok) throw new Error(`the CV app's ${tool} is unavailable (${r.reason}: ${r.detail})`);
	return Array.isArray(r.data) ? (r.data as T[]) : [];
}

async function source(role: "resume" | "profile", version: string, text: string, at: string): Promise<LocalArtifactUploadedSource> {
	const bytes = new TextEncoder().encode(text).byteLength;
	if (!bytes || bytes > LOCAL_ARTIFACT_CAPS.sourceBytes) throw new Error(`the CV ${role} source is ${bytes} bytes; the runner limit is ${LOCAL_ARTIFACT_CAPS.sourceBytes}`);
	const sha = await sha256Hex(new TextEncoder().encode(text));
	return { role, fileId: CV_SOURCE_IDS[role], version, originalSha256: sha, extractedTextSha256: sha, extractedAt: at, text };
}

/** Build this job's two sources from the CV app. Throws with a reason the owner can act on. */
export async function materializeCvTailorSources(env: Env, who: Who, lead: Pick<LocalArtifactLead, "lead">, now = Date.now()): Promise<LocalArtifactUploadedSource[]> {
	const [row] = await query<{ book: string }>(env, who, "get_career_book", {});
	const book = row ? json<Book | null>(row.book, null) : null;
	if (!book?.roles?.length) throw new Error("the CV app's career book has no roles yet");
	const region = regionFor(lead.lead.location);
	let kind = playbookKindFor(lead.lead.title);
	let rows = await query<Playbook>(env, who, "get_playbook", { kind, ...(region ? { region } : {}) });
	if (!rows.length && kind !== "pm") {
		kind = "pm";
		rows = await query<Playbook>(env, who, "get_playbook", { kind, ...(region ? { region } : {}) });
	}
	const playbook = mergePlaybook(rows);
	const version = `book-r${book.revision}.${playbook ? kind : "no-playbook"}${playbook?.region ? `.${playbook.region}` : ""}`;
	const at = new Date(now).toISOString();
	return [await source("resume", version, renderBook(book), at), await source("profile", version, renderProfile(book, playbook, kind), at)];
}

/**
 * The run's uploaded-source pair: from the CV app when the instance takes its sources from there, else the
 * owner's uploaded-file selection (verified against `expected` on a re-dispatch), else none (local files).
 */
export async function resolveTailorSources(env: Env, who: Who, lead: Pick<LocalArtifactLead, "lead">, expected?: ReadonlyArray<Omit<LocalArtifactUploadedSource, "text">>, now = Date.now()): Promise<LocalArtifactUploadedSource[] | undefined> {
	if (await cvSourcesEnabled(env, who.instanceId)) return materializeCvTailorSources(env, who, lead, now);
	if (expected?.some((s) => s.fileId === CV_SOURCE_IDS.resume)) throw new Error("this run was built from the CV app, whose grant has since been removed");
	if (expected?.length || (await listUploadedTailorSourceSelections(env, who.instanceId, who.userId)).length > 0) return materializeUploadedTailorSources(env, who.instanceId, who.userId, expected);
	return undefined;
}

/** Was this run built from the CV app? Its `version` names the book revision and playbook ("book-r12.pm.AU-VIC"). */
export function cvProvenance(uploaded: ReadonlyArray<Pick<LocalArtifactUploadedSource, "fileId" | "version">> | undefined): { bookRevision: number; playbookKind: string | null; region: string | null } | null {
	const m = uploaded?.find((s) => s.fileId === CV_SOURCE_IDS.resume)?.version.match(/^book-r(\d+)\.([a-z_]+)(?:\.(.+))?$/);
	return m ? { bookRevision: Number(m[1]), playbookKind: m[2] === "no-playbook" ? null : m[2], region: m[3] ?? null } : null;
}
