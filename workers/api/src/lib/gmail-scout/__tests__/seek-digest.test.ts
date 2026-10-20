/**
 * #1251 — the title and employer of each job inside a SEEK digest, from the digest's own listing.
 *
 * The fixture keeps the exact LAYOUT of a real SEEK Job Alerts digest (jobmail@s.seek.com.au, "20 new
 * jobs for … in Melbourne VIC", read 2026-10-20): the greeting, a `logo` marker and image per block (and
 * blocks without one), title then employer, badges, "Posted on" lines, location, salary, the canonical
 * `/job/<id>` link that closes each block, and the footer's search link. The names, ids and tracking values
 * are invented; no real listing or personal parameter is reproduced.
 */
import { describe, expect, it } from "vitest";
import type { GmailMessage } from "../../gmail.js";
import { digestJobs, ingestGmailCandidates } from "../scan.js";
import { seekDigestListings } from "../seek-digest.js";

const job = (id: number) => `https://au.seek.com/job/${id}`;
const link = (id: number) => `[https://au.seek.com/job/${id}?savedSearchID=00000000-0000-0000-0000-SECRET&tracking=JMC-SavedSearch-anz-1-ss-pca-a]`;

/** The plain-text part, block for block as SEEK lays it out. */
const SEEK_PLAIN = `Acme Health, Globex Labs,
Initech and other companies have new roles for you.
%%str_to_replace_open_tracking%%

seek
[https://seekcdn.com/notifications/apac-mail/shared/seek-logo-white-bg.png]https://au.seek.com/?tracking=JMC-SavedSearch-anz-1-logo-ss-pca-a

Hi Sam,
Based on your saved search for Software Developer in Melbourne VIC 3000, we’ve
found 5 new jobs that could be right for you.

logo
[https://bx-branding-gateway.cloud.seek.com.au/11111111-aaaa.1/serpLogo]

Software Developer
Acme Health

East Melbourne, Melbourne VIC
$118,000 + super + salary packaging

${link(90000001)}

logo
[https://bx-branding-gateway.cloud.seek.com.au/22222222-bbbb.1/serpLogo]

Software Engineer (6-month contract with potential to extend)
Globex Labs Pty Ltd

Strong applicant

Melbourne VIC
$200,000-$220,000 + super

${link(90000002)}

Forward Deployed Engineer
Initech Recruitment

Very strong applicant

Melbourne VIC

${link(90000003)}

logo
[https://bx-branding-gateway.cloud.seek.com.au/33333333-cccc.1/serpLogo]

Graduate Software Engineer
Hooli Limited

Posted on 29 Sep 2026

Melbourne VIC
Be paid $82,000 + super + annual performance bonus

${link(90000004)}

Data engineer
Umbrella Network

Hawthorn, Melbourne VIC
$120,000 – $160,000 per year

${link(90000005)}


View all matching jobs
[https://au.seek.com/jobs?where=Melbourne+VIC+3000&keywords=Software+Developer&savedSearchID=00000000-SECRET&tracking=JMC-SavedSearch-anz-1-ss-pca-a&daterange=999]
`;

const EXPECTED = [
	[job(90000001), { title: "Software Developer", company: "Acme Health" }],
	[job(90000002), { title: "Software Engineer (6-month contract with potential to extend)", company: "Globex Labs Pty Ltd" }],
	[job(90000003), { title: "Forward Deployed Engineer", company: "Initech Recruitment" }], // a block with no logo
	[job(90000004), { title: "Graduate Software Engineer", company: "Hooli Limited" }],
	[job(90000005), { title: "Data engineer", company: "Umbrella Network" }],
];

describe("SEEK's listing block names each job (#1251)", () => {
	it("title and employer for every job — whether or not its block has a logo", () => {
		expect([...seekDigestListings(SEEK_PLAIN)]).toEqual(EXPECTED);
	});

	it("never a location, salary, badge, 'Posted on' line or bullet — the lines the nearest-line guess took", () => {
		const names = [...seekDigestListings(SEEK_PLAIN).values()].flatMap((l) => [l.title, l.company]);
		for (const wrong of ["Melbourne VIC", "East Melbourne, Melbourne VIC", "$118,000 + super + salary packaging", "Strong applicant", "Very strong applicant", "Posted on 29 Sep 2026", "["]) {
			expect(names).not.toContain(wrong);
		}
	});

	it("the Scout's mailbox puts the link on the line after its `[` (#1247) — the same jobs are read", () => {
		const wrapped = SEEK_PLAIN.replace(/\[https:/g, "[\nhttps:");
		expect([...seekDigestListings(wrapped)]).toEqual(EXPECTED);
	});

	it("the first job is named only after a `logo` marker: the greeting before it is never a title", () => {
		const noLogo = SEEK_PLAIN.replace("logo\n[https://bx-branding-gateway.cloud.seek.com.au/11111111-aaaa.1/serpLogo]\n", "");
		const read = seekDigestListings(noLogo);
		expect(read.has(job(90000001))).toBe(false);
		expect(read.get(job(90000002))).toEqual({ title: "Software Engineer (6-month contract with potential to extend)", company: "Globex Labs Pty Ltd" });
	});

	it("a block whose second line is a badge has no employer, rather than the badge", () => {
		const text = `logo\n[https://x.example/serpLogo]\n\nPlatform Engineer\n\nStrong applicant\n\nMelbourne VIC\n\n${link(90000009)}`;
		expect(seekDigestListings(text).get(job(90000009))).toEqual({ title: "Platform Engineer", company: null });
	});

	it("keeps only the posting id: no saved-search or tracking value survives", () => {
		expect(JSON.stringify([...seekDigestListings(SEEK_PLAIN)])).not.toMatch(/SECRET|tracking|savedSearch/);
	});
});

const message = (text: string): GmailMessage =>
	({ id: "m-seek", threadId: "t", from: "SEEK Job Alerts <jobmail@s.seek.com.au>", to: "me@example.com", cc: "", subject: "5 new jobs for Software Developer in Melbourne VIC 3000", date: new Date().toUTCString(), messageId: "", references: "", snippet: "", text, attachments: [] }) as unknown as GmailMessage;

describe("in the scan log and the leads (#1251)", () => {
	it("digestJobs carries the listing's title and employer for every job", () => {
		expect(digestJobs(message(SEEK_PLAIN)).jobs).toEqual(EXPECTED.map(([url, l]) => ({ url, ...(l as object) })));
	});

	it("SEEK refuses the server, as it does live: each job is still stored and logged with its title and employer", async () => {
		const refused = (async () => new Response("blocked", { status: 403 })) as unknown as typeof fetch;
		const stored: Record<string, unknown>[] = [];
		const existing = [{ id: "lead-old", data: { url: job(90000005) } }];
		const result = await ingestGmailCandidates({
			hits: [{ id: "m-seek" }],
			readMessage: async () => message(SEEK_PLAIN),
			existing,
			insertLead: async (data) => {
				stored.push(data);
				return { created: true, id: `lead-${stored.length}` };
			},
			fetchImpl: refused,
		});
		expect(stored.map((s) => [s.url, s.title, s.company, s.status])).toEqual(
			EXPECTED.slice(0, 4).map(([url, l]) => [url, (l as { title: string }).title, (l as { company: string }).company, "awaiting_browser_verification"]),
		);
		// The browser check is told what job to expect, instead of nothing.
		expect(result.awaiting[0]).toMatchObject({ title: "Software Developer", company: "Acme Health" });
		const subs = result.log.filter((e) => e.classification === "digest_item");
		expect(subs.map((s) => s.job)).toEqual(EXPECTED.map(([url, l]) => ({ url, ...(l as object) })));
		expect(subs[0].evidence).toMatch(/^title and employer as the email lists them; the job board's page could not be read here/);
		expect(subs[4]).toMatchObject({ decision: "deduped", leadId: "lead-old" });
	});
});
