/**
 * #1024: a one-item provider alert carries only a redirect. Live receipt b3a24be1 rejected such an
 * Indeed alert as `no_specific_job_url` (hits 2, added 0). The fixture below models that alert —
 * one role, one employer, one location, only Indeed click links carrying the owner's personal
 * alert tokens — since the real message is not read here.
 */
import { describe, expect, it } from "vitest";
import type { GmailMessage } from "../../gmail.js";
import { classifyGmailMessage, ingestGmailCandidates } from "../scan.js";
import { resolveProviderJobAlert } from "../provider-redirect.js";

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
		return true;
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
		expect(result).toEqual({ candidates: 1, added: 1, deduped: 0, rejected: {} });
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

	it("a blocked page, a page with no posting data, or several postings: posting_unverifiable", async () => {
		for (const res of [() => new Response("blocked", { status: 403 }), () => new Response("<html>no data</html>"), () => new Response(postingPage([POSTING, { ...POSTING, title: "Data Engineer" }]))]) {
			expect(await reason(alert(), provider({ [CANONICAL]: res }))).toEqual({ posting_unverifiable: 1 });
		}
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
