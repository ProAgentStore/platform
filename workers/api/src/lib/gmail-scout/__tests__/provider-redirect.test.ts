/**
 * #1024: a one-item provider alert carries only a redirect. Live receipt b3a24be1 rejected such an
 * Indeed alert as `no_specific_job_url` (hits 2, added 0). The fixture below models that alert —
 * one role, one employer, one location, only Indeed click links carrying the owner's personal
 * alert tokens — since the real message is not read here.
 */
import { describe, expect, it } from "vitest";
import type { GmailMessage } from "../../gmail.js";
import { classifyGmailMessage, ingestGmailCandidates } from "../scan.js";
import { providerPostingUrl, resolveProviderJobAlert } from "../provider-redirect.js";

const JK = "0123456789abcdef";
const CANONICAL = `https://au.indeed.com/viewjob?jk=${JK}`;
/** The owner's personal alert parameters. None may reach a stored lead, a receipt, or any request but the provider's own redirect. */
const PERSONAL = ["SECRETTK", "SECRETALID", "SECRETQD", "SECRETRD", "SECRETAD"];
const CLICK = `https://au.indeed.com/rc/clk/dl?jk=${JK}&amp;from=ja&amp;qd=SECRETQD&amp;rd=SECRETRD&amp;tk=SECRETTK&amp;alid=SECRETALID`;

const alert = (over: Partial<GmailMessage> = {}): GmailMessage =>
	({
		id: "m-indeed",
		threadId: "t",
		from: "Indeed <alert@indeed.com>",
		to: "me@example.com",
		cc: "",
		subject: "Platform Engineer at Acme",
		date: new Date().toUTCString(),
		messageId: "",
		references: "",
		snippet: "Platform Engineer Acme Pty Ltd Sydney NSW",
		text: `<table><tr><td><a href="${CLICK}">Platform Engineer</a></td></tr><tr><td>Acme Pty Ltd - Sydney NSW</td></tr>
<tr><td><a href="${CLICK}"><img src="https://au.indeed.com/images/logo.png"></a></td></tr>
<tr><td><a href="https://au.indeed.com/account/unsubscribe?alid=SECRETALID&amp;tk=SECRETTK">Unsubscribe</a></td></tr></table>`,
		attachments: [],
		...over,
	}) as unknown as GmailMessage;

const postingPage = (postings: object[]) =>
	`<html><head>${postings.map((p) => `<script type="application/ld+json">${JSON.stringify(p)}</script>`).join("")}</head><body>…</body></html>`;
const POSTING = { "@context": "https://schema.org", "@type": "JobPosting", title: "Platform Engineer", hiringOrganization: { "@type": "Organization", name: "Acme Pty Ltd" }, validThrough: new Date(Date.now() + 86_400_000).toISOString() };

/** A provider that answers by URL; every request it receives is logged. */
function provider(routes: Record<string, () => Response>) {
	const requested: string[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		requested.push(url);
		expect(init?.redirect).toBe("manual"); // every hop is re-checked by us, never followed blindly
		const route = routes[url];
		return route ? route() : new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetchImpl, requested };
}
const live = () => provider({ [CANONICAL]: () => new Response(postingPage([POSTING]), { status: 200 }) });

async function ingest(message: GmailMessage, fetchImpl: typeof fetch) {
	const stored: Record<string, unknown>[] = [];
	const result = await ingestGmailCandidates({ hits: [{ id: message.id }], readMessage: async () => message, existing: [], insertLead: async (data) => {
		stored.push(data);
		return { created: true, id: `lead-${stored.length}` };
	}, fetchImpl });
	return { result, stored };
}

describe("#1024: the live no_specific_job_url case", () => {
	it("is still no_specific_job_url to the synchronous classifier: only the resolver can accept it", () => {
		expect(classifyGmailMessage(alert())).toEqual({ rejected: "no_specific_job_url" });
	});

	it("becomes ONE unverified lead at the canonical posting, with no personal parameter anywhere", async () => {
		const p = live();
		const { result, stored } = await ingest(alert(), p.fetchImpl);
		expect(result).toEqual({ candidates: 1, added: 1, deduped: 0, rejected: {}, awaiting: [] });
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ url: CANONICAL, work_key: `url:${CANONICAL}`, title: "Platform Engineer at Acme", source_domain: "au.indeed.com", status: "unverified", verification: { state: "unverified", canonical_job_url: CANONICAL } });
		expect(stored[0]).not.toHaveProperty("apply_handoff");
		// The posting id was visible in the link, so the personalized redirect was never requested at all.
		expect(p.requested).toEqual([CANONICAL]);
		const everything = JSON.stringify({ result, stored, requested: p.requested });
		for (const secret of PERSONAL) expect(everything).not.toContain(secret);
	});

	it("takes the employer from the posting when the mail has no labelled company", async () => {
		const { stored } = await ingest(alert({ subject: "Platform Engineer", snippet: "Acme Pty Ltd, Sydney NSW" }), live().fetchImpl);
		expect(stored[0]).toMatchObject({ company: "Acme Pty Ltd" });
	});

	it("follows an opaque tracking link only within the provider, and stops at the hop that names the posting", async () => {
		const opaque = "https://au.indeed.com/pagead/clk/dl?mo=r&ad=SECRETAD";
		const hop = `https://au.indeed.com/rc/clk?jk=${JK}&tk=SECRETTK&from=ja`;
		const p = provider({
			[opaque]: () => new Response(null, { status: 302, headers: { location: hop } }),
			[CANONICAL]: () => new Response(postingPage([POSTING]), { status: 200 }),
		});
		const { result, stored } = await ingest(alert({ text: `<a href="${opaque}">Platform Engineer</a> Acme Pty Ltd` }), p.fetchImpl);
		expect(result.added).toBe(1);
		expect(stored[0].url).toBe(CANONICAL);
		// The personal hop is read from the Location header, never requested; the posting is fetched clean.
		expect(p.requested).toEqual([opaque, CANONICAL]);
		expect(JSON.stringify(stored)).not.toMatch(/SECRET/);
	});
});

describe("#1024: anything short of exactly one live matching posting is refused, by name", () => {
	const reason = async (message: GmailMessage, p: { fetchImpl: typeof fetch }) => (await ingest(message, p.fetchImpl)).result.rejected;

	it("a redirect leaving the provider is not followed: redirect_unresolved", async () => {
		const opaque = "https://au.indeed.com/pagead/clk/dl?ad=SECRETAD";
		const p = provider({ [opaque]: () => new Response(null, { status: 302, headers: { location: "https://tracker.example/x?jk=0123456789abcdef&tk=SECRETTK" } }) });
		expect(await reason(alert({ text: `<a href="${opaque}">Platform Engineer</a>` }), p)).toEqual({ redirect_unresolved: 1 });
		expect(p.requested).toEqual([opaque]); // the off-provider host never received the owner's token
	});

	it("a link that resolves to nothing is unresolved, and a provider error never leaks into the reason", async () => {
		const opaque = "https://au.indeed.com/rc/clk/dl?ad=SECRETAD";
		const broken = (async (url: RequestInfo | URL) => { throw new Error(`fetch failed for ${String(url)}`); }) as typeof fetch;
		const { result } = await ingest(alert({ text: `<a href="${opaque}">Platform Engineer</a>` }), broken);
		expect(result.rejected).toEqual({ redirect_unresolved: 1 });
		expect(JSON.stringify(result)).not.toMatch(/SECRET|fetch failed/);
	});

	it("two different postings in one alert: multiple_listings, and nothing is fetched", async () => {
		const p = live();
		const second = `https://au.indeed.com/rc/clk/dl?jk=fedcba9876543210&amp;tk=SECRETTK`;
		expect(await reason(alert({ text: `<a href="${CLICK}">Platform Engineer</a><a href="${second}">Data Engineer</a>` }), p)).toEqual({ multiple_listings: 1 });
		expect(p.requested).toEqual([]);
	});

	it("a gone posting (404/410), one redirected away, or one past validThrough: posting_not_live", async () => {
		for (const res of [() => new Response("", { status: 404 }), () => new Response("", { status: 410 }), () => new Response(null, { status: 302, headers: { location: "https://au.indeed.com/jobs?q=platform" } })]) {
			expect(await reason(alert(), provider({ [CANONICAL]: res }))).toEqual({ posting_not_live: 1 });
		}
		const expired = { ...POSTING, validThrough: "2020-01-01T00:00:00Z" };
		expect(await reason(alert(), provider({ [CANONICAL]: () => new Response(postingPage([expired])) }))).toEqual({ posting_not_live: 1 });
	});

	// #1030: the posting resolved safely, only the SERVER could not check its page — so a browser does.
	it("a blocked page, a page with no posting data, or several postings: awaiting browser verification, never thrown away", async () => {
		const cases: Array<[() => Response, string]> = [
			[() => new Response("blocked", { status: 403 }), "server_fetch_refused"],
			[() => new Response("<html>no data</html>"), "no_structured_posting"],
			[() => new Response(postingPage([POSTING, { ...POSTING, title: "Data Engineer" }])), "no_structured_posting"],
		];
		for (const [res, why] of cases) {
			expect(await resolveProviderJobAlert(alert(), provider({ [CANONICAL]: res }).fetchImpl)).toEqual({ awaitingBrowser: { url: CANONICAL, reason: why } });
			const { result, stored } = await ingest(alert(), provider({ [CANONICAL]: res }).fetchImpl);
			expect(result.rejected).toEqual({});
			expect(stored[0]).toMatchObject({ url: CANONICAL, status: "awaiting_browser_verification", verification: { state: "awaiting_browser_verification", reason: why, canonical_job_url: CANONICAL } });
			expect(result.awaiting).toEqual([expect.objectContaining({ leadId: "lead-1", canonicalUrl: CANONICAL, reason: why })]);
			// The personalised alert link never reaches the lead or the queue — only the canonical posting.
			expect(JSON.stringify({ stored, awaiting: result.awaiting })).not.toMatch(/SECRET|tk=/);
		}
	});

	it("a network failure on the canonical posting is a browser's job too", async () => {
		const p = provider({ [CANONICAL]: () => { throw new Error(`fetch failed for ${CANONICAL}`); } });
		expect(await resolveProviderJobAlert(alert(), p.fetchImpl)).toEqual({ awaitingBrowser: { url: CANONICAL, reason: "server_fetch_failed" } });
	});

	it("a posting whose title or company the email does not name: posting_mismatch", async () => {
		for (const posting of [{ ...POSTING, title: "Senior Data Scientist" }, { ...POSTING, hiringOrganization: { name: "Globex Corporation" } }]) {
			expect(await reason(alert(), provider({ [CANONICAL]: () => new Response(postingPage([posting])) }))).toEqual({ posting_mismatch: 1 });
		}
	});

	it("a digest or a security mail is rejected first, and the resolver is never reached", async () => {
		const p = live();
		expect(await reason(alert({ subject: "Platform Engineer + 5 new jobs" }), p)).toEqual({ digest: 1 });
		expect(await reason(alert({ subject: "Verify your Indeed account" }), p)).toEqual({ security_alert: 1 });
		expect(p.requested).toEqual([]);
	});

	it("mail with no provider job link stays no_specific_job_url, without a request", async () => {
		const p = live();
		expect(await resolveProviderJobAlert(alert({ text: "https://au.indeed.com/account/unsubscribe?tk=SECRETTK" }), p.fetchImpl)).toBeNull();
		expect(await reason(alert({ text: "no links" }), p)).toEqual({ no_specific_job_url: 1 });
		expect(p.requested).toEqual([]);
	});
});

// ── #1050: SEEK and LinkedIn ────────────────────────────────────────────────────────────────────────
//
// Both put the posting id in the link and wrap it in the owner's personal tracking parameters. The
// fixtures model the alert shapes those providers send for ONE job (title, logo and apply links, plus
// footer links), with every personal parameter marked SECRET; the real messages are not read here.

const SEEK_ID = "81234567";
const SEEK_CANONICAL = `https://www.seek.com.au/job/${SEEK_ID}`;
const seekLink = (n: number) => `https://www.seek.com.au/job/${SEEK_ID}?type=standard&amp;ref=jobalert&amp;tracking=SEEKSECRETTRACK-${n}&amp;sol=SEEKSECRETSOL`;
const seekAlert = (over: Partial<GmailMessage> = {}) =>
	alert({
		id: "m-seek",
		from: "SEEK <noreply@s.seek.com.au>",
		snippet: "Platform Engineer Acme Pty Ltd Sydney NSW",
		text: `<a href="${seekLink(1)}">Platform Engineer</a> Acme Pty Ltd - Sydney NSW
<a href="${seekLink(2)}"><img src="https://image-service-cdn.seek.com.au/logo.png"></a> <a href="${seekLink(3)}">Apply now</a>
<a href="https://www.seek.com.au/my-activity/saved-searches?unsubscribe=SEEKSECRETUNSUB">Unsubscribe</a>`,
		...over,
	});

const LI_ID = "4012345678";
const LI_CANONICAL = `https://www.linkedin.com/jobs/view/${LI_ID}`;
const liLink = (n: number) =>
	`https://www.linkedin.com/comm/jobs/view/${LI_ID}/?trackingId=LISECRETTRACK${n}%3D%3D&amp;refId=LISECRETREF&amp;lipi=urn%3Ali%3Apage%3Aemail&amp;midToken=LISECRETMID&amp;midSig=LISECRETSIG&amp;trk=eml-job&amp;eid=LISECRETEID&amp;otpToken=LISECRETOTP`;
const liAlert = (over: Partial<GmailMessage> = {}) =>
	alert({
		id: "m-linkedin",
		from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>",
		snippet: "Platform Engineer Acme Pty Ltd Sydney NSW",
		text: `<a href="${liLink(1)}">Platform Engineer</a> Acme Pty Ltd · Sydney NSW <a href="${liLink(2)}">View job</a>
<a href="https://www.linkedin.com/comm/jobs/search?keywords=platform&amp;midToken=LISECRETMID">See all jobs</a>
<a href="https://www.linkedin.com/comm/psettings/email-unsubscribe?lipi=x&amp;midToken=LISECRETMID">Unsubscribe</a>`,
		...over,
	});
const SECRET_RE = /SECRET|tracking=|trackingId|refId|midToken|otpToken/;
const rejectedBy = async (message: GmailMessage, p: { fetchImpl: typeof fetch }) => (await ingest(message, p.fetchImpl)).result.rejected;

describe("#1050: SEEK alerts", () => {
	it("the classifier keeps the posting id only — the alert's tracking never reaches a lead", () => {
		const out = classifyGmailMessage(seekAlert());
		expect(out).toMatchObject({ candidate: { url: SEEK_CANONICAL, source_domain: "www.seek.com.au" } });
		expect(JSON.stringify(out)).not.toMatch(SECRET_RE);
	});

	it("a live posting matching the mail becomes ONE unverified lead, checked at its canonical URL only", async () => {
		const p = provider({ [SEEK_CANONICAL]: () => new Response(postingPage([POSTING])) });
		const { result, stored } = await ingest(seekAlert(), p.fetchImpl);
		expect(result).toMatchObject({ added: 1, rejected: {}, awaiting: [] });
		expect(stored[0]).toMatchObject({ url: SEEK_CANONICAL, status: "unverified", verification: { canonical_job_url: SEEK_CANONICAL } });
		expect(p.requested).toEqual([SEEK_CANONICAL]); // the three tracking links were never requested
		expect(JSON.stringify({ result, stored, requested: p.requested })).not.toMatch(SECRET_RE);
	});

	it("canonicalises SEEK's hosts: its web hosts are kept, a mail/click subdomain goes to the country site", () => {
		expect(providerPostingUrl(`https://au.seek.com/job/${SEEK_ID}?tracking=SEEKSECRET`)).toBe(`https://au.seek.com/job/${SEEK_ID}`);
		expect(providerPostingUrl(`https://click.s.seek.com.au/job/${SEEK_ID}?tracking=SEEKSECRET`)).toBe(SEEK_CANONICAL);
		expect(providerPostingUrl(`https://www.seek.co.nz/job/${SEEK_ID}?tracking=SEEKSECRET`)).toBe(`https://www.seek.co.nz/job/${SEEK_ID}`);
		expect(providerPostingUrl(`https://www.seek.com.au/jobs?jobId=${SEEK_ID}&tracking=SEEKSECRET`)).toBe(SEEK_CANONICAL);
	});

	it("a look-alike host is never SEEK, and a SEEK link that names no posting is not a posting", () => {
		for (const url of [`https://www.seek.com.au.evil.example/job/${SEEK_ID}`, `https://seek.com.au-jobs.example/job/${SEEK_ID}`, `https://notseek.com.au/job/${SEEK_ID}`]) expect(providerPostingUrl(url)).toBeNull();
		for (const url of ["https://www.seek.com.au/my-activity/saved-searches", "https://www.seek.com.au/jobs?keywords=platform", "https://www.seek.com.au/job/abc"]) expect(providerPostingUrl(url)).toBeNull();
	});

	it("two different postings in one alert: multiple_listings, and nothing is fetched", async () => {
		const p = provider({});
		const text = `<a href="${seekLink(1)}">Platform Engineer</a><a href="https://www.seek.com.au/job/87654321?tracking=SEEKSECRET">Data Engineer</a>`;
		expect(await rejectedBy(seekAlert({ text }), p)).toEqual({ multiple_listings: 1 });
		expect(p.requested).toEqual([]);
	});

	it("the posting redirected off SEEK (or anywhere) is refused as not live, and the redirect is not followed", async () => {
		const p = provider({ [SEEK_CANONICAL]: () => new Response(null, { status: 301, headers: { location: "https://jobs.evil.example/job?id=81234567" } }) });
		expect(await rejectedBy(seekAlert(), p)).toEqual({ posting_not_live: 1 });
		expect(p.requested).toEqual([SEEK_CANONICAL]);
	});

	it("an expired or mismatched posting is refused by name", async () => {
		expect(await rejectedBy(seekAlert(), provider({ [SEEK_CANONICAL]: () => new Response(postingPage([{ ...POSTING, validThrough: "2020-01-01T00:00:00Z" }])) }))).toEqual({ posting_not_live: 1 });
		expect(await rejectedBy(seekAlert(), provider({ [SEEK_CANONICAL]: () => new Response(postingPage([{ ...POSTING, title: "Senior Data Scientist" }])) }))).toEqual({ posting_mismatch: 1 });
	});

	it("a page the server cannot check waits for browser verification at the canonical URL", async () => {
		for (const [res, why] of [[() => new Response("blocked", { status: 403 }), "server_fetch_refused"], [() => new Response("<html>no data</html>"), "no_structured_posting"]] as const) {
			const { result, stored } = await ingest(seekAlert(), provider({ [SEEK_CANONICAL]: res }).fetchImpl);
			expect(stored[0]).toMatchObject({ url: SEEK_CANONICAL, status: "awaiting_browser_verification", verification: { reason: why, canonical_job_url: SEEK_CANONICAL } });
			expect(result.awaiting).toEqual([expect.objectContaining({ canonicalUrl: SEEK_CANONICAL, reason: why })]);
			expect(JSON.stringify({ result, stored })).not.toMatch(SECRET_RE);
		}
	});
});

describe("#1050: LinkedIn alerts", () => {
	it("the classifier keeps the posting id only — no trackingId, refId, midToken or otpToken", () => {
		const out = classifyGmailMessage(liAlert());
		expect(out).toMatchObject({ candidate: { url: LI_CANONICAL, source_domain: "www.linkedin.com" } });
		expect(JSON.stringify(out)).not.toMatch(SECRET_RE);
	});

	it("LinkedIn's sign-in wall is not a gone posting: it waits for browser verification, and the wall is not followed", async () => {
		const p = provider({ [LI_CANONICAL]: () => new Response(null, { status: 302, headers: { location: "https://www.linkedin.com/authwall?trk=gf&sessionRedirect=x" } }) });
		const { result, stored } = await ingest(liAlert(), p.fetchImpl);
		expect(stored[0]).toMatchObject({ url: LI_CANONICAL, status: "awaiting_browser_verification", verification: { reason: "server_fetch_refused", canonical_job_url: LI_CANONICAL } });
		expect(result.awaiting).toEqual([expect.objectContaining({ canonicalUrl: LI_CANONICAL, reason: "server_fetch_refused" })]);
		expect(p.requested).toEqual([LI_CANONICAL]);
		expect(JSON.stringify({ result, stored, requested: p.requested })).not.toMatch(SECRET_RE);
	});

	// `Response` cannot be built with LinkedIn's non-standard 999, so the answer is modelled by its shape.
	it("LinkedIn's bot answer (999) waits for the browser too", async () => {
		expect(await resolveProviderJobAlert(liAlert(), provider({ [LI_CANONICAL]: () => ({ status: 999, headers: new Headers(), text: async () => "" }) as unknown as Response }).fetchImpl)).toEqual({ awaitingBrowser: { url: LI_CANONICAL, reason: "server_fetch_refused" } });
	});

	it("a guest page with a live posting matching the mail is accepted, from a direct or slugged link", async () => {
		const live = () => provider({ [LI_CANONICAL]: () => new Response(postingPage([POSTING])) });
		expect(await resolveProviderJobAlert(liAlert(), live().fetchImpl)).toEqual({ url: LI_CANONICAL, company: "Acme Pty Ltd" });
		const slug = `<a href="https://www.linkedin.com/jobs/view/platform-engineer-at-acme-${LI_ID}?refId=LISECRETREF">Platform Engineer</a> Acme Pty Ltd`;
		expect(await resolveProviderJobAlert(liAlert({ text: slug }), live().fetchImpl)).toEqual({ url: LI_CANONICAL, company: "Acme Pty Ltd" });
	});

	it("two different postings — including one named by currentJobId — are multiple_listings, and nothing is fetched", async () => {
		const p = provider({});
		const text = `<a href="${liLink(1)}">Platform Engineer</a><a href="https://www.linkedin.com/jobs/search/?currentJobId=4099999999&amp;refId=LISECRETREF">Data Engineer</a>`;
		expect(await resolveProviderJobAlert(liAlert({ text }), p.fetchImpl)).toEqual({ rejected: "multiple_listings" });
		expect(p.requested).toEqual([]);
	});

	it("a redirect that is not LinkedIn's own sign-in wall is refused as not live", async () => {
		for (const location of ["https://www.linkedin.com/jobs/search?keywords=platform", "https://evil.example/authwall"]) {
			expect(await resolveProviderJobAlert(liAlert(), provider({ [LI_CANONICAL]: () => new Response(null, { status: 302, headers: { location } }) }).fetchImpl)).toEqual({ rejected: "posting_not_live" });
		}
	});

	it("an unsupported LinkedIn link (an opaque wrapper, a look-alike host) is not a posting, and nothing is requested", async () => {
		const p = provider({});
		const wrapper = "https://www.linkedin.com/e/v2?e=LISECRETE&amp;a=jobs&amp;midToken=LISECRETMID";
		expect(await rejectedBy(liAlert({ text: `<a href="${wrapper}">Platform Engineer</a>` }), p)).toEqual({ no_specific_job_url: 1 });
		expect(providerPostingUrl(`https://www.linkedin.com.evil.example/jobs/view/${LI_ID}`)).toBeNull();
		expect(p.requested).toEqual([]);
	});
});
