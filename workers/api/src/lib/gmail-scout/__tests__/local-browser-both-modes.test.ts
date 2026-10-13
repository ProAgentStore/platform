/**
 * #1024 (owner answer, comment 6135309925): the Gmail Job Search Scout runs in BOTH modes, neither
 * depending on the other. Its template declares `runtime: "local_browser"` (0225), but that runtime is
 * only for the optional browser verification of a lead the server could not check:
 *
 * - API only: with no runner, the direct Gmail API scan completes, adds the lead and queues it — and
 *   no browser run is ever started.
 * - Runner online: with verification on, the queued lead is dispatched to the Scout's local browser.
 *
 * Real migrated schema and the real seeded template; the ONE scan path and the real dispatcher. Faked:
 * the mailbox, Indeed's answer to the server, the Scout's Durable Object, and starting a browser run
 * (the runner boundary).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../../d1-sqlite.js";
import type { GmailMessage } from "../../gmail.js";
import type { Env } from "../../../types.js";
import { GMAIL_SCOUT_PINNED_EMAIL } from "../config.js";

/** Every browser run the platform asked a runner for. */
const started = vi.hoisted(() => [] as Array<{ objective: string; requestId: string }>);
vi.mock("../../local-browser/start.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../local-browser/start.js")>()),
	startLocalBrowserRun: async (_env: unknown, _inst: string, _uid: string, input: { objective: string; requestId: string }) => {
		started.push(input);
		return { kind: "started", run: { id: `run-${started.length}`, status: "running" } };
	},
}));
vi.mock("../../../routes/push.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../routes/push.js")>()),
	notifyUser: async () => undefined,
}));

const { scanGmailScout } = await import("../scan.js");
const { runLeadBrowserVerification, listLeadVerifications } = await import("../../job-lead-browser-verification.js");

const JK = "0123456789abcdef";
const CANONICAL = `https://au.indeed.com/viewjob?jk=${JK}`;
/** The one-item Indeed alert of receipt b3a24be1: only a personalised click redirect names the job. */
const INDEED: GmailMessage = {
	id: "m-indeed", threadId: "t-indeed", from: "Indeed <alert@indeed.com>", to: GMAIL_SCOUT_PINNED_EMAIL, cc: "", subject: "Platform Engineer at Acme",
	date: new Date().toUTCString(), messageId: "", references: "", snippet: "",
	text: `<a href="https://au.indeed.com/rc/clk/dl?jk=${JK}&amp;tk=SECRETTK">Platform Engineer</a> Acme Pty Ltd - Sydney NSW`, attachments: [],
} as unknown as GmailMessage;
const mailbox = async () => ({ list: async () => [{ id: INDEED.id }], read: async () => INDEED });

let d1: RealSchemaD1;
let env: Env;
let leads: Array<{ id: string; data: Record<string, unknown> }>;

/** A subscription of the SEEDED Gmail Job Search Scout, with its one mailbox connected and pinned. */
function seedScout(instanceConfig: Record<string, unknown>) {
	const agent = d1.sqlite.prepare("SELECT id FROM agents WHERE slug = 'gmail-job-search-scout'").get() as { id: string };
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('scout', '${agent.id}', 'u1', 'active', '${JSON.stringify({ source_mode: "gmail", ...instanceConfig })}')`);
	d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, account_label) VALUES ('u1', 'gmail', '${GMAIL_SCOUT_PINNED_EMAIL}', X'00', X'00', X'00', '${GMAIL_SCOUT_PINNED_EMAIL}')`);
	d1.exec(`INSERT INTO gmail_scout_configs (id, instance_id, pinned_email, enabled) VALUES ('cfg', 'scout', '${GMAIL_SCOUT_PINNED_EMAIL}', 1)`);
}

beforeEach(() => {
	started.length = 0;
	leads = [];
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	// Indeed refuses the server's check (#1030), so the lead needs a browser to be verified.
	vi.stubGlobal("fetch", async () => new Response("", { status: 403 }));
	const agentNamespace = {
		idFromName: (n: string) => n,
		get: () => ({
			fetch: async (req: Request) => {
				const url = new URL(req.url);
				if (url.pathname === "/state") return Response.json({ permissions: { email: true } });
				if (url.pathname === "/collections/job_leads") return leads.length ? Response.json({ name: "job_leads" }) : new Response("{}", { status: 404 });
				if (url.pathname === "/collections/job_leads/records" && req.method === "GET") return Response.json({ records: leads });
				if (url.pathname === "/collections/job_leads/records" && req.method === "POST") {
					const { data } = (await req.json()) as { data: Record<string, unknown> };
					leads.push({ id: `lead-${leads.length + 1}`, data });
					return Response.json({ id: `lead-${leads.length}`, created: true });
				}
				return Response.json({});
			},
		}),
	};
	env = { DB: d1.DB, AGENT: agentNamespace } as unknown as Env;
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

describe("the Gmail Scout's two modes — direct Gmail API, and the optional local browser (#1024)", () => {
	it("API only: with no runner, Scan now adds the lead and queues it for verification — and no browser run is ever started", async () => {
		seedScout({}); // browser verification is OFF until the owner turns it on, and no machine is connected
		const { receipt } = await scanGmailScout(env, "scout", "u1", { trigger: "on_demand", triggeredBy: "u1", mailbox });
		expect(receipt).toMatchObject({ status: "completed", hits: 1, added: 1, rejected: {}, awaitingBrowserVerification: 1, handoff: "none" });
		expect(leads).toHaveLength(1);
		expect(leads[0].data).toMatchObject({ url: CANONICAL, status: "awaiting_browser_verification" });
		expect((await listLeadVerifications(env, "scout", "u1")).leads).toMatchObject([{ state: "awaiting", canonicalUrl: CANONICAL, attempts: 0 }]);
		// The verification cron passes over it too: the lead waits, and still nothing asks a runner.
		expect(await runLeadBrowserVerification(env, Date.now() + 1_000)).toEqual({ settled: 0, dispatched: 0 });
		expect(started).toEqual([]);
		expect(JSON.stringify(leads)).not.toContain("SECRETTK");
	});

	it("runner online: with verification on, the queued lead is dispatched to the Scout's local browser — the canonical posting only", async () => {
		seedScout({ browserVerification: { enabled: true } });
		// The owner's standing decision for Indeed (#1049), so the dispatcher opens it without asking again.
		d1.exec(`INSERT INTO local_browser_domain_consent (instance_id, user_id, domain, scope, decision, decided_at) VALUES ('scout', 'u1', 'indeed.com', 'navigate', 'allow', 1)`);
		const { receipt } = await scanGmailScout(env, "scout", "u1", { trigger: "on_demand", triggeredBy: "u1", mailbox });
		expect(receipt).toMatchObject({ status: "completed", added: 1, awaitingBrowserVerification: 1 });
		expect(started).toEqual([]); // the scan itself never waits on a runner
		expect(await runLeadBrowserVerification(env, Date.now() + 1_000)).toEqual({ settled: 0, dispatched: 1 });
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({ requestId: "bv-lead-1-1" });
		expect(started[0].objective).toContain(CANONICAL);
		expect(started[0].objective).not.toContain("SECRETTK");
		expect((await listLeadVerifications(env, "scout", "u1")).leads).toMatchObject([{ state: "dispatched", attempts: 1 }]);
	});
});
