/** #1606: one job identity, search pages out, reposts linked, employers inferred, and an idempotent repair. */
import { describe, expect, it } from "vitest";
import { canonicalJobUrl, jobPostingIdentity, workKeyForLead } from "../../job-lead-triage.js";
import { companyFromSender, employerByHost, findRepostOf, inferCompany, isSearchResultsUrl } from "../lead-hygiene.js";
import { repairJobLeads } from "../repair.js";
import { ingestGmailCandidates } from "../scan.js";
import type { GmailMessage } from "../../gmail.js";
import type { Env } from "../../../types.js";

const PAGEUP = "http://careers.deeca.vic.gov.au/job/Project-Officer/1369685766?eid=abc&from=email&locale=en_GB&refid=xyz";

describe("job identity", () => {
	it("strips PageUp tracking parameters, forces https, and keys on host + numeric id", () => {
		expect(canonicalJobUrl(PAGEUP)).toBe("https://careers.deeca.vic.gov.au/job/Project-Officer/1369685766");
		expect(workKeyForLead({ url: PAGEUP })).toBe("pageup:careers.deeca.vic.gov.au:1369685766");
		expect(workKeyForLead({ url: "https://careers.deeca.vic.gov.au/job/Other-Slug/1369685766" })).toBe(workKeyForLead({ url: PAGEUP }));
	});
	it("SEEK is the job id, Indeed is jk", () => {
		expect(workKeyForLead({ url: "http://www.seek.com.au/job/94872937?tracking=x&type=standard" })).toBe("seek:94872937");
		expect(jobPostingIdentity("https://au.seek.com/job/94872937?ref=x")).toEqual({ key: "seek:94872937", url: "https://au.seek.com/job/94872937" });
		expect(jobPostingIdentity("https://au.indeed.com/rc/clk?jk=0123456789abcdef&tk=zz&from=ja")).toEqual({ key: "indeed:0123456789abcdef", url: "https://au.indeed.com/viewjob?jk=0123456789abcdef" });
	});
	it("anything else is its canonical URL", () => {
		expect(workKeyForLead({ url: "http://jobs.example.com/a/?locale=en&utm_x=1#f" })).toBe("url:https://jobs.example.com/a");
	});
});

describe("search pages", () => {
	it.each(["https://au.indeed.com/jobs?q=engineer&l=melbourne", "https://www.indeed.com/jobs?q=x", "https://au.seek.com/jobs?keywords=x", "https://au.seek.com/software-engineer-jobs-in-melbourne-vic/remote"])("%s is not a posting", (u) => expect(isSearchResultsUrl(u)).toBe(true));
	it("a posting is", () => {
		expect(isSearchResultsUrl("https://www.seek.com.au/job/94872937")).toBe(false);
		expect(isSearchResultsUrl("https://au.indeed.com/viewjob?jk=0123456789abcdef")).toBe(false);
	});
});

describe("company inference", () => {
	it("reads the employer from the sender, and from a unanimous host", () => {
		expect(companyFromSender('"RACV Careers" <jobs@racv.com.au>')).toBe("RACV");
		const byHost = employerByHost([{ data: { source_domain: "careers.racv.com.au", company: "RACV" } }, { data: { source_domain: "multi.example", company: "A" } }, { data: { source_domain: "multi.example", company: "B" } }]);
		expect(inferCompany({ source_domain: "careers.racv.com.au", gmail_from: "x <a@b.c>" }, byHost)).toEqual({ company: "RACV", source: "host" });
		expect(inferCompany({ source_domain: "multi.example", gmail_from: "Acme Talent <a@b.c>" }, byHost)).toEqual({ company: "Acme", source: "sender" });
		expect(inferCompany({ source_domain: "www.seek.com.au", gmail_from: "SEEK <a@b.c>" }, byHost)).toBeNull();
	});
});

describe("reposts", () => {
	const lead = (id: string, over: Record<string, unknown>) => ({ id, data: { company: "Triple Zero Victoria", title: "Project Manager", gmail_date: "2026-10-01T00:00:00Z", ...over } });
	it("links a same company/title/country lead within 60 days to the first, not beyond", () => {
		const first = lead("a", {});
		expect(findRepostOf(lead("b", { company: "Triple Zero Victoria Pty Ltd", gmail_date: "2026-10-20T00:00:00Z" }).data, [first])?.id).toBe("a");
		expect(findRepostOf(lead("c", { gmail_date: "2027-01-20T00:00:00Z" }).data, [first])).toBeNull();
		expect(findRepostOf(lead("d", { title: "Other" }).data, [first])).toBeNull();
	});
});

const msg = (id: string, from: string, url: string, subject = "Project Manager at Triple Zero Victoria"): GmailMessage =>
	({ id, threadId: `t${id}`, from, to: "me@x", cc: "", subject, date: new Date().toUTCString(), messageId: "", references: "", snippet: "", text: `Company: Triple Zero Victoria\n${url}`, attachments: [] }) as unknown as GmailMessage;

describe("intake", () => {
	const run = async (messages: GmailMessage[], existing: Array<{ id?: string; data?: Record<string, unknown> }> = []) => {
		const stored: Array<Record<string, unknown>> = [];
		const out = await ingestGmailCandidates({ hits: messages.map((m) => ({ id: m.id })), readMessage: async (id) => messages.find((m) => m.id === id) as GmailMessage, existing, insertLead: async (d) => {
				stored.push(d);
				return { created: true, id: `L${stored.length}` };
			} });
		return { out, stored };
	};
	it("a second SEEK id for the same company+title is stored as a linked, archived repost with no verification queued", async () => {
		const { out, stored } = await run([msg("m1", "SEEK <a@seek.com.au>", "https://jobs.example.com/job/Pm/1111111"), msg("m2", "SEEK <a@seek.com.au>", "https://jobs.example.com/job/Pm/2222222")]);
		expect(stored).toHaveLength(2);
		expect(stored[1]).toMatchObject({ duplicate_of: "L1", status: "archived", archived_reason: "repost" });
		expect(stored[0].duplicate_of).toBeUndefined();
		expect(out).toMatchObject({ added: 1, deduped: 1 });
	});
	it("a careers-site lead with no employer gets one from the sender", async () => {
		const m = { ...msg("m3", '"Acme Careers" <jobs@acme.example>', "https://careers.acme.example/job/Dev/3333333", "A new role"), text: "https://careers.acme.example/job/Dev/3333333" } as GmailMessage;
		const { stored } = await run([m]);
		expect(stored[0]).toMatchObject({ company: "Acme", company_source: "sender" });
	});
	it("a search-results link is never stored", async () => {
		const m = { ...msg("m4", "x <a@b.c>", "https://au.seek.com/software-jobs-in-melbourne/remote"), text: "https://au.seek.com/software-jobs-in-melbourne/remote" } as GmailMessage;
		const { stored, out } = await run([m]);
		expect(stored).toHaveLength(0);
		expect(out.rejected.search_results_page ?? out.rejected.no_specific_job_url).toBe(1);
	});
});

describe("repair", () => {
	const recs = [
		{ id: "1", data: { url: PAGEUP, work_key: `url:${PAGEUP}`, status: "unverified", title: "Project Officer", company: "DEECA", gmail_date: "2026-10-01T00:00:00Z", source_domain: "careers.deeca.vic.gov.au" } },
		{ id: "2", data: { url: "https://careers.deeca.vic.gov.au/job/Project-Officer/1369685766", work_key: "url:https://careers.deeca.vic.gov.au/job/Project-Officer/1369685766", status: "unverified", title: "Project Officer", company: "DEECA", gmail_date: "2026-10-02T00:00:00Z", source_domain: "careers.deeca.vic.gov.au" } },
		{ id: "3", data: { url: "https://au.indeed.com/jobs?q=x", work_key: "url:https://au.indeed.com/jobs?q=x", status: "unverified", title: "x", gmail_date: "2026-10-02T00:00:00Z", source_domain: "au.indeed.com" } },
		{ id: "4", data: { url: "https://careers.deeca.vic.gov.au/job/Analyst/555555", work_key: "x", status: "unverified", title: "Analyst", gmail_date: "2026-10-03T00:00:00Z", source_domain: "careers.deeca.vic.gov.au", gmail_from: "DEECA Jobs <a@b.c>" } },
	];
	const env = (store: typeof recs) =>
		({
			AGENT: {
				idFromName: (n: string) => n,
				get: () => ({
					fetch: async (req: Request) => {
						const u = new URL(req.url);
						if (u.pathname === "/collections/job_leads") return Response.json({});
						if (req.method === "GET") return Response.json({ records: store });
						const id = decodeURIComponent(u.pathname.split("/").pop() as string);
						Object.assign(store.find((r) => r.id === id)?.data as object, ((await req.json()) as { data: object }).data);
						return Response.json({});
					},
				}),
			},
		}) as unknown as Env;

	it("dry run counts without writing; the real run applies them; a second run changes nothing", async () => {
		const store = structuredClone(recs);
		const dry = await repairJobLeads(env(store), "s", { dryRun: true });
		expect(dry).toMatchObject({ dryRun: true, scanned: 4, rekeyed: 2, duplicatesLinked: 1, searchPagesArchived: 1, companiesFilled: 1 });
		expect(store).toEqual(recs);
		const real = await repairJobLeads(env(store), "s", { dryRun: false });
		expect(real).toMatchObject({ rekeyed: 2, duplicatesLinked: 1, searchPagesArchived: 1, companiesFilled: 1 });
		expect(store[0].data).toMatchObject({ work_key: "pageup:careers.deeca.vic.gov.au:1369685766", url: "https://careers.deeca.vic.gov.au/job/Project-Officer/1369685766" });
		expect(store[1].data).toMatchObject({ status: "archived", duplicate_of: "1" });
		expect(store[2].data).toMatchObject({ status: "archived", archived_reason: "search_results_page" });
		expect(store[3].data).toMatchObject({ company: "DEECA" });
		const again = await repairJobLeads(env(store), "s", { dryRun: false });
		expect(again).toMatchObject({ rekeyed: 0, duplicatesLinked: 0, repostsLinked: 0, searchPagesArchived: 0, companiesFilled: 0 });
	});
});
