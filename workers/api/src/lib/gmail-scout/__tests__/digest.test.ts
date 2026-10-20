/**
 * #1248 — a digest is a container, not a verdict. Every posting it names is checked on its own job-board
 * page and added, deduplicated or rejected with its own logged reason; the digest is rejected outright
 * only when nothing in it names a posting.
 *
 * The fixtures model the shapes the major boards send (live Scout 2 mail, #1247: SEEK digests carry 5–23
 * canonical `/job/<id>` links plus 20–29 opaque tracking redirects; EthicalJobs carries no recognisable
 * posting link). Every personal parameter is marked SECRET; the real messages are not read here. Only the
 * job boards are faked, and every request they receive is logged.
 */
import { describe, expect, it } from "vitest";
import type { GmailMessage } from "../../gmail.js";
import { gmailLeadIntakeRejection, ingestGmailCandidates } from "../scan.js";
import { DIGEST_POSTINGS_MAX } from "../provider-redirect.js";

const msg = (over: Partial<GmailMessage>): GmailMessage =>
	({ id: "m-digest", threadId: "t-digest", from: "", to: "me@example.com", cc: "", subject: "", date: new Date().toUTCString(), messageId: "", references: "", snippet: "", text: "", attachments: [], ...over }) as unknown as GmailMessage;

const page = (title: string, company: string, validThrough = new Date(Date.now() + 86_400_000).toISOString()) =>
	`<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", title, hiringOrganization: { "@type": "Organization", name: company }, validThrough })}</script></head><body>…</body></html>`;

/** A job board answering by URL; anything unrouted is gone (404). */
function boards(routes: Record<string, () => Response>) {
	const requested: string[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		requested.push(url);
		expect(init?.redirect).toBe("manual");
		return routes[url]?.() ?? new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetchImpl, requested };
}

async function ingest(message: GmailMessage, fetchImpl: typeof fetch, existing: Array<{ id?: string; data?: Record<string, unknown> }> = []) {
	const stored: Record<string, unknown>[] = [];
	const result = await ingestGmailCandidates({
		hits: [{ id: message.id }],
		readMessage: async () => message,
		existing,
		insertLead: async (data) => {
			stored.push(data);
			return { created: true, id: `lead-${stored.length}` };
		},
		fetchImpl,
	});
	const [row, ...subs] = result.log;
	return { result, stored, row, subs };
}

const SECRET_RE = /SECRET|tracking=|trackingId|midToken|tk=/;

// ── SEEK "N new jobs for …" ─────────────────────────────────────────────────────────────────────────
const seek = (id: number) => `https://www.seek.com.au/job/${id}`;
const seekLink = (id: number) => `${seek(id)}?type=standard&amp;ref=jobalert&amp;tracking=SEEKSECRET-${id}`;
const seekRedirect = (n: number) => `https://click.s.seek.com.au/f/a/SEEKSECRET${n}~~/AAAAAQA~/RgRq`;
const SEEK_DIGEST = msg({
	from: "SEEK <noreply@s.seek.com.au>",
	subject: "4 new jobs for Platform Engineer",
	text: `<style>.company-info { color: #333 }</style>
<a href="${seekLink(90000001)}">Platform Engineer</a> Acme Pty Ltd · Sydney NSW <a href="${seekRedirect(1)}">Apply</a>
<a href="${seekLink(90000002)}">Cloud Engineer</a> Globex Corporation · Parramatta NSW <a href="${seekRedirect(2)}">Apply</a>
<a href="${seekLink(90000003)}">Site Reliability Engineer</a> Initech · Sydney NSW <a href="${seekRedirect(3)}">Apply</a>
<a href="${seekLink(90000004)}">DevOps Engineer</a> Umbrella · Remote <a href="${seekRedirect(4)}">Apply</a>
<a href="${seekRedirect(5)}">See all jobs</a> <a href="https://www.seek.com.au/my-activity/saved-searches?unsubscribe=SEEKSECRETUNSUB">Unsubscribe</a>`,
});

describe("SEEK: \"4 new jobs for …\" (#1248)", () => {
	const seekBoard = () =>
		boards({
			[seek(90000001)]: () => new Response(page("Platform Engineer", "Acme Pty Ltd")),
			[seek(90000003)]: () => new Response("blocked", { status: 403 }),
		});

	it("checks each posting on its own: one added from the board's own posting, one closed, one awaiting a browser, one already a lead", async () => {
		const b = seekBoard();
		const existing = [{ id: "lead-old", data: { url: seek(90000004), status: "unverified", gmail_message_id: "older" } }];
		const { result, stored, row, subs } = await ingest(SEEK_DIGEST, b.fetchImpl, existing);

		expect(result).toMatchObject({ added: 2, deduped: 1, rejected: { posting_not_live: 1 } });
		expect(stored).toEqual([
			expect.objectContaining({ url: seek(90000001), title: "Platform Engineer", company: "Acme Pty Ltd", status: "unverified", from_digest: true, gmail_message_id: "m-digest" }),
			expect.objectContaining({ url: seek(90000003), title: "Site Reliability Engineer", status: "awaiting_browser_verification", from_digest: true }),
		]);
		// The CSS on the page never becomes an employer (#1022's original failure).
		expect(JSON.stringify(stored)).not.toMatch(/info \{/);
		expect(result.awaiting).toEqual([expect.objectContaining({ canonicalUrl: seek(90000003), reason: "server_fetch_refused" })]);

		expect(row).toMatchObject({ classification: "digest", decision: "added", rejection: null });
		expect(row.evidence).toMatch(/subject contains "4 new jobs".*4 jobs named in it.*tracking link\(s\) not followed/);
		expect(row.reason).toMatch(/1 added, 1 awaiting browser verification, 1 already leads, 1 not taken/);
		expect(subs.map((s) => [s.classification, s.subIndex, s.job?.url, s.decision, s.rejection])).toEqual([
			["digest_item", 1, seek(90000001), "added", null],
			["digest_item", 2, seek(90000002), "rejected", "posting_not_live"],
			["digest_item", 3, seek(90000003), "awaiting_browser_verification", null],
			["digest_item", 4, seek(90000004), "deduped", null],
		]);
		expect(subs[0].evidence).toMatch(/job board's own posting: "Platform Engineer" at Acme Pty Ltd/);
		expect(subs[3]).toMatchObject({ leadId: "lead-old" });
	});

	it("requests canonical postings only — never a tracking redirect, and never a posting that is already a lead", async () => {
		const b = seekBoard();
		const { result, stored } = await ingest(SEEK_DIGEST, b.fetchImpl, [{ id: "lead-old", data: { url: seek(90000004) } }]);
		expect(b.requested.sort()).toEqual([seek(90000001), seek(90000002), seek(90000003)]);
		expect(JSON.stringify({ result, stored, requested: b.requested })).not.toMatch(SECRET_RE);
	});

	it("is idempotent: the same digest again adds nothing, and never re-fetches a posting that became a lead", async () => {
		const existing: Array<{ id?: string; data?: Record<string, unknown> }> = [];
		const first = await ingest(SEEK_DIGEST, seekBoard().fetchImpl, existing);
		existing.push(...first.stored.map((data, i) => ({ id: `lead-${i + 1}`, data })));
		const b = seekBoard();
		const again = await ingest(SEEK_DIGEST, b.fetchImpl, existing);
		expect(again.result).toMatchObject({ added: 0, deduped: 2 });
		expect(again.stored).toEqual([]);
		expect(b.requested.sort()).toEqual([seek(90000002), seek(90000004)]); // only the two not taken are re-checked
	});

	it("leads taken from a digest are not flagged as digest junk by the stored-lead rules", async () => {
		const { stored } = await ingest(SEEK_DIGEST, seekBoard().fetchImpl);
		for (const lead of stored) expect(gmailLeadIntakeRejection({ ...lead, subject: SEEK_DIGEST.subject, from: SEEK_DIGEST.from })).toBeNull();
	});
});

// ── SEEK Recommendations ────────────────────────────────────────────────────────────────────────────
describe("SEEK Recommendations (#1248)", () => {
	const RECS = msg({
		from: "SEEK Recommendations <noreply@s.seek.com.au>",
		subject: "[Very strong applicant] Platform Engineer + 11 new jobs",
		text: `<a href="${seekLink(91000001)}">Platform Engineer</a> Acme Pty Ltd
<a href="${seekLink(91000002)}">Data Engineer</a> Hooli
Plain-text copy: [ ${seek(91000003)}?tracking=SEEKSECRET9 ]`,
	});

	it("a posting the board names differently is a mismatch; one the board would not show, with no link text, waits for a browser untitled", async () => {
		const b = boards({
			[seek(91000001)]: () => new Response(page("Platform Engineer", "Acme Pty Ltd")),
			[seek(91000002)]: () => new Response(page("Senior Data Scientist", "Hooli")),
			[seek(91000003)]: () => new Response("blocked", { status: 403 }),
		});
		const { result, stored, row, subs } = await ingest(RECS, b.fetchImpl);
		expect(result).toMatchObject({ added: 2, rejected: { posting_mismatch: 1 } });
		// Live (#1248 reprocess): SEEK refuses the server and its canonical links carry no text — the posting
		// is still one identified job, so like a pasted URL it waits for the browser, never named after the subject.
		expect(stored[1]).toMatchObject({ url: seek(91000003), title: null, company: undefined, status: "awaiting_browser_verification", from_digest: true });
		expect(result.awaiting).toEqual([expect.objectContaining({ canonicalUrl: seek(91000003), title: null, reason: "server_fetch_refused" })]);
		expect(row).toMatchObject({ classification: "digest", decision: "added" });
		expect(subs.map((s) => [s.decision, s.rejection])).toEqual([["added", null], ["rejected", "posting_mismatch"], ["awaiting_browser_verification", null]]);
		expect(subs[2].evidence).toMatch(/www\.seek\.com\.au posting identified by its id; the job board's page could not be read here \(server fetch refused\)/);
		expect(subs[2].job).toEqual({ title: null, company: null, url: seek(91000003) });
	});
});

// ── LinkedIn ────────────────────────────────────────────────────────────────────────────────────────
describe("LinkedIn job alert digest (#1248)", () => {
	const li = (id: number) => `https://www.linkedin.com/jobs/view/${id}`;
	const liLink = (id: number) => `https://www.linkedin.com/comm/jobs/view/${id}/?trackingId=LISECRET${id}&amp;midToken=LISECRETMID`;
	const LI = msg({
		from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>",
		subject: "30 new jobs for “platform engineer”",
		text: `<a href="${liLink(4000000001)}">Platform Engineer</a> Acme Pty Ltd · Sydney
<a href="${liLink(4000000002)}">Infrastructure Engineer</a> Globex · Melbourne
<a href="https://www.linkedin.com/comm/jobs/search?keywords=platform&amp;midToken=LISECRETMID">See all jobs</a>`,
	});

	it("behind LinkedIn's sign-in wall each posting is taken by its link text and queued for a browser — never thrown away", async () => {
		const wall = () => new Response(null, { status: 302, headers: { location: "https://www.linkedin.com/authwall?trk=x" } });
		const b = boards({ [li(4000000001)]: wall, [li(4000000002)]: wall });
		const { result, stored, subs } = await ingest(LI, b.fetchImpl);
		expect(result).toMatchObject({ added: 2, rejected: {} });
		expect(stored.map((s) => [s.url, s.title, s.status])).toEqual([
			[li(4000000001), "Platform Engineer", "awaiting_browser_verification"],
			[li(4000000002), "Infrastructure Engineer", "awaiting_browser_verification"],
		]);
		expect(result.awaiting.map((a) => a.canonicalUrl)).toEqual([li(4000000001), li(4000000002)]);
		expect(subs.every((s) => s.decision === "awaiting_browser_verification")).toBe(true);
		expect(JSON.stringify({ result, stored, requested: b.requested })).not.toMatch(SECRET_RE);
	});
});

// ── Indeed ──────────────────────────────────────────────────────────────────────────────────────────
describe("Indeed digest (#1248)", () => {
	const view = (jk: string) => `https://au.indeed.com/viewjob?jk=${jk}`;
	const click = (jk: string) => `https://au.indeed.com/rc/clk/dl?jk=${jk}&amp;from=ja&amp;tk=SECRETTK&amp;alid=SECRETALID`;
	const INDEED = msg({
		from: "Indeed <alert@indeed.com>",
		subject: "Platform Engineer + 5 new jobs",
		text: `<a href="${click("0123456789abcdef")}">Platform Engineer</a> Acme Pty Ltd - Sydney NSW
<a href="${click("fedcba9876543210")}">Backend Engineer</a> Globex Corporation - Sydney NSW
<a href="https://au.indeed.com/account/unsubscribe?alid=SECRETALID&amp;tk=SECRETTK">Unsubscribe</a>`,
	});

	it("two postings from ONE email both become leads: the shared Gmail message is not a duplicate key inside a digest", async () => {
		const b = boards({
			[view("0123456789abcdef")]: () => new Response(page("Platform Engineer", "Acme Pty Ltd")),
			[view("fedcba9876543210")]: () => new Response(page("Backend Engineer", "Globex Corporation")),
		});
		const { result, stored } = await ingest(INDEED, b.fetchImpl);
		expect(result).toMatchObject({ added: 2, deduped: 0, rejected: {} });
		expect(stored.map((s) => [s.url, s.title, s.company, s.gmail_message_id])).toEqual([
			[view("0123456789abcdef"), "Platform Engineer", "Acme Pty Ltd", "m-digest"],
			[view("fedcba9876543210"), "Backend Engineer", "Globex Corporation", "m-digest"],
		]);
		expect(JSON.stringify({ result, stored, requested: b.requested })).not.toMatch(SECRET_RE);
	});

	it("a posting past its validThrough is closed, and says so on its own row", async () => {
		const b = boards({
			[view("0123456789abcdef")]: () => new Response(page("Platform Engineer", "Acme Pty Ltd", "2020-01-01T00:00:00Z")),
			[view("fedcba9876543210")]: () => new Response(page("Backend Engineer", "Globex Corporation")),
		});
		const { result, row, subs } = await ingest(INDEED, b.fetchImpl);
		expect(result).toMatchObject({ added: 1, rejected: { posting_not_live: 1 } });
		expect(row.reason).toMatch(/1 added, 0 already leads, 1 not taken/);
		expect(subs[0]).toMatchObject({ decision: "rejected", rejection: "posting_not_live", reason: expect.stringMatching(/no longer live/) });
	});
});

// ── EthicalJobs: nothing extractable ────────────────────────────────────────────────────────────────
describe("EthicalJobs: a digest with nothing to extract (#1248)", () => {
	it("is rejected outright, as `digest`, with the reason that nothing in it names a posting — and nothing is fetched", async () => {
		const EJ = msg({
			from: "EthicalJobs.com.au <alerts@ethicaljobs.com.au>",
			subject: "6 new jobs for you on EthicalJobs",
			// Modelled on the measured live case (#1247: 0 recognised postings): every link is a mail-tracker
			// redirect on a host that names no job, or a search/home page — the real message is not read here.
			text: `<a href="https://t.mailtrack.example/s3t/c/EJSECRET1">Program Coordinator</a>
<a href="https://t.mailtrack.example/s3t/c/EJSECRET2">Policy Officer</a>
<a href="https://ethicaljobs.com.au/jobs?keywords=policy">See all</a> <a href="https://ethicaljobs.com.au/">EthicalJobs</a>`,
		});
		const b = boards({});
		const { result, stored, row, subs } = await ingest(EJ, b.fetchImpl);
		expect(result).toMatchObject({ added: 0, rejected: { digest: 1 } });
		expect(stored).toEqual([]);
		expect(subs).toEqual([]);
		expect(row).toMatchObject({ classification: "digest", decision: "rejected", rejection: "digest" });
		expect(row.reason).toMatch(/^digest: nothing extractable/);
		expect(b.requested).toEqual([]);
	});
});

describe("a long digest is capped (#1248)", () => {
	it(`checks at most ${DIGEST_POSTINGS_MAX} postings and says how many it left`, async () => {
		const ids = Array.from({ length: DIGEST_POSTINGS_MAX + 5 }, (_, i) => 92000000 + i);
		const LONG = msg({ from: "SEEK <noreply@s.seek.com.au>", subject: "30 new jobs for Platform Engineer", text: ids.map((id) => `<a href="${seekLink(id)}">Role ${id}</a>`).join("\n") });
		const b = boards({});
		const { row, subs } = await ingest(LONG, b.fetchImpl);
		expect(subs).toHaveLength(DIGEST_POSTINGS_MAX);
		expect(b.requested).toHaveLength(DIGEST_POSTINGS_MAX);
		expect(row.evidence).toMatch(/5 beyond the first 25 not checked/);
	});
});
