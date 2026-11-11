/** #1624 phase 2: the Tailor's two sources built from the owner's CV app instead of the uploaded PDF. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../agent-storage-utils.js";
import type { Env } from "../../types.js";

const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
let granted = true;
let responses: Record<string, unknown> = {};
vi.mock("../jobs-app.js", () => ({
	CV_MCP_URL: "https://mcp.proappstore.online/mcp/apps/cv",
	callAppTool: async (_env: unknown, _who: unknown, _url: string, tool: string, args: Record<string, unknown>) => {
		calls.push({ tool, args });
		const r = responses[`${tool}:${String(args.kind ?? "")}`] ?? responses[tool];
		return r instanceof Error ? { ok: false, reason: "not_connected", detail: r.message } : { ok: true, data: r ?? [] };
	},
}));
vi.mock("../mcp-consent.js", () => ({ hasMcpConsent: async () => granted, normalizeMcpEndpoint: (u: string) => u }));
const uploaded = vi.fn(async () => [{ role: "resume", fileId: "pdf" }]);
vi.mock("./uploaded-sources.js", () => ({ listUploadedTailorSourceSelections: async () => [{ role: "resume" }], materializeUploadedTailorSources: (...a: unknown[]) => uploaded(...(a as [])) }));
const { CV_SOURCE_IDS, cvProvenance, materializeCvTailorSources, playbookKindFor, regionFor, renderBook, resolveTailorSources } = await import("./cv-sources.js");

const book = {
	revision: 42,
	facts: [
		{ key: "first_name", value: "Owner", allowed_use: "resume" },
		{ key: "application_email", value: "owner@example.com", allowed_use: "resume" },
		{ key: "salary_rule", value: "from AUD 200,000", allowed_use: "forms" },
		{ key: "residential_address", value: "⚠ Not recorded", allowed_use: "resume" },
	],
	roles: [
		{ id: "r1", title: "Head of Engineering", organization: "Rocket Lab Pty Ltd", employment_type: "permanent", start_month: "2026-03", end_month: null, location: "Melbourne", summary: "Runs engineering.\n\n⚠ To confirm:\n- Employment type unknown.", title_variants: [] },
		{ id: "r2", title: "Senior Project Manager", organization: "Asta Solutions Pty Ltd", employment_type: "contract", start_month: "2024-03", end_month: "2024-09", location: null, summary: "⚠ To confirm:\n- Title differs.", title_variants: [{ title: "Software Development Manager", allowed_for: ["head_of_eng"] }] },
	],
	projects: [],
	stories: [
		{ role_id: "r1", headline: "Built the agentic engineering pipeline", situation: null, task: null, action: "Issues to coding agents to PRs.", result: null, metrics: "1,200+ commits", confidence: "recalled", visibility: "resume", skills: [{ name: "MCP" }] },
		{ role_id: "r1", headline: "Private story", situation: null, task: null, action: null, result: null, metrics: null, confidence: "recalled", visibility: "private", skills: [] },
		{ role_id: "r1", headline: "Interview only", situation: null, task: null, action: null, result: null, metrics: null, confidence: "recalled", visibility: "interview", skills: [] },
		{ role_id: "r1", headline: "Unchecked draft", situation: null, task: null, action: null, result: null, metrics: null, confidence: "draft", visibility: "resume", skills: [] },
	],
	skills: [{ name: "TypeScript", category: "language", years: 10 }],
	credentials: [
		{ kind: "certification", name: "PMP", issuer: "PMI", issued: "2010", expires: null, status: "expired", notes: "Never claim it is held." },
		{ kind: "education", name: "Master of Computer Science", issuer: "SPbU", issued: "2005", expires: null, status: "active", notes: "⚠ To confirm: Diploma?" },
	],
};
const playbook = (kind: string, region = "", instructions = `Write a ${kind} résumé.`) => ({ kind, region, name: `${kind} playbook`, instructions, section_order: '["summary","experience"]', max_pages: 2, emphasis_themes: '["delivery"]', exclude: "[]" });
const env = {} as Env;
const who = { userId: "owner", instanceId: "tailor" };
const lead = (title: string, location?: string) => ({ lead: { title, company: "Acme", ...(location ? { location } : {}) } }) as never;

beforeEach(() => {
	calls.length = 0;
	granted = true;
	uploaded.mockClear();
	responses = { get_career_book: [{ book: JSON.stringify(book) }], "get_playbook:pm": [playbook("pm")], "get_playbook:head_of_eng": [playbook("head_of_eng"), playbook("head_of_eng", "AU-VIC", "Mention Melbourne.")] };
});

describe("choosing the playbook", () => {
	it("maps job titles to the seeded kinds", () => {
		expect(playbookKindFor("Senior Project Manager")).toBe("pm");
		expect(playbookKindFor("Program Manager, Enterprise Compliance")).toBe("pm");
		expect(playbookKindFor("Service Delivery Manager")).toBe("delivery");
		expect(playbookKindFor("Head of Engineering")).toBe("head_of_eng");
		expect(playbookKindFor("Engineering Manager - Hawthorn East")).toBe("head_of_eng");
		expect(playbookKindFor("Principal Software Engineer")).toBe("principal_eng");
		expect(playbookKindFor("CTO")).toBe("cto");
	});
	it("maps locations to region keys", () => {
		expect(regionFor("Melbourne VIC")).toBe("AU-VIC");
		expect(regionFor("Surry Hills, Sydney NSW")).toBe("AU-NSW-Sydney");
		expect(regionFor("Brisbane QLD")).toBe("AU");
		expect(regionFor(undefined)).toBeNull();
	});
});

describe("rendering the book", () => {
	it("keeps true titles and allowed variants, drops review notes, private/interview/draft stories, and marks expired credentials", () => {
		const text = renderBook(book as never);
		expect(text).toContain("## Head of Engineering — Rocket Lab Pty Ltd (2026-03 – present)");
		expect(text).toContain("Runs engineering.");
		expect(text).toContain("This role may also be titled: Software Development Manager (for head_of_eng résumés only)");
		expect(text).toContain("- Built the agentic engineering pipeline. Issues to coding agents to PRs. Metrics: 1,200+ commits. Skills: MCP.");
		for (const absent of ["To confirm", "Private story", "Interview only", "Unchecked draft", "Diploma?"]) expect(text).not.toContain(absent);
		expect(text).toContain("PMP, PMI, 2010 (certification; status: EXPIRED) — Never claim it is held.");
	});
});

describe("materializeCvTailorSources", () => {
	it("builds a hashed resume/profile pair with only resume-usable facts and the merged regional playbook", async () => {
		const sources = await materializeCvTailorSources(env, who, lead("Head of Engineering", "Melbourne VIC"), Date.parse("2026-11-10T00:00:00Z"));
		expect(calls.map((c) => c.tool)).toEqual(["get_career_book", "get_playbook"]);
		expect(calls[1].args).toEqual({ kind: "head_of_eng", region: "AU-VIC" });
		expect(sources.map((s) => [s.role, s.fileId, s.version])).toEqual([["resume", CV_SOURCE_IDS.resume, "book-r42.head_of_eng.AU-VIC"], ["profile", CV_SOURCE_IDS.profile, "book-r42.head_of_eng.AU-VIC"]]);
		for (const s of sources) expect(s.extractedTextSha256).toBe(await sha256Hex(new TextEncoder().encode(s.text)));
		const profile = sources[1].text;
		expect(profile).toContain("- first name: Owner");
		expect(profile).toContain("- application email: owner@example.com");
		expect(profile).not.toContain("200,000");
		expect(profile).not.toContain("Not recorded");
		expect(profile).toContain("They are not facts about the owner");
		expect(profile).toContain("Write a head_of_eng résumé.\n\nMention Melbourne.");
		expect(cvProvenance(sources)).toEqual({ bookRevision: 42, playbookKind: "head_of_eng", region: "AU-VIC" });
	});

	it("falls back to the pm playbook when the chosen kind has none", async () => {
		const sources = await materializeCvTailorSources(env, who, lead("Principal Software Engineer"));
		expect(calls.filter((c) => c.tool === "get_playbook").map((c) => c.args.kind)).toEqual(["principal_eng", "pm"]);
		expect(sources[0].version).toBe("book-r42.pm");
	});

	it("refuses an empty book or an unreachable CV app instead of tailoring from anything else", async () => {
		responses.get_career_book = [{ book: JSON.stringify({ ...book, roles: [] }) }];
		await expect(materializeCvTailorSources(env, who, lead("PM"))).rejects.toThrow(/no roles/);
		responses.get_career_book = new Error("connect cv");
		await expect(materializeCvTailorSources(env, who, lead("PM"))).rejects.toThrow(/get_career_book is unavailable \(not_connected: connect cv\)/);
	});
});

describe("resolveTailorSources", () => {
	it("prefers the CV app when the instance holds the grant, and never touches the uploaded PDF then", async () => {
		const sources = await resolveTailorSources(env, who, lead("Senior Project Manager"));
		expect(sources?.[0].fileId).toBe(CV_SOURCE_IDS.resume);
		expect(uploaded).not.toHaveBeenCalled();
	});
	it("without the grant it keeps the uploaded-file selection, and refuses to re-dispatch a CV-built run", async () => {
		granted = false;
		expect(await resolveTailorSources(env, who, lead("PM"))).toEqual([{ role: "resume", fileId: "pdf" }]);
		await expect(resolveTailorSources(env, who, lead("PM"), [{ role: "resume", fileId: CV_SOURCE_IDS.resume, version: "book-r1.pm", originalSha256: "a", extractedTextSha256: "a", extractedAt: "x" }])).rejects.toThrow(/grant has since been removed/);
	});
});
