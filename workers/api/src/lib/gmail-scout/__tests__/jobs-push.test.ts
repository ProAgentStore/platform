/** #1587: Scout leads reach the Jobs app from the platform (submit_leads), once each, and never at the scan's expense. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../../d1-sqlite.js";
import { GMAIL_SCOUT_PINNED_EMAIL } from "../config.js";
import { type GmailScoutMailboxFactory, scanGmailScout } from "../scan.js";
import { toJobsLead } from "../jobs-push.js";
import type { GmailMessage } from "../../gmail.js";
import type { Env } from "../../../types.js";

const calls: Array<{ tool: string; args: Record<string, unknown>; instanceId: string }> = [];
let outcome: { ok: true } | { ok: false; reason: "failed" | "no_grant" | "not_connected"; detail: string } = { ok: true };
vi.mock("../../jobs-app.js", () => ({
	callJobsTool: async (_env: unknown, who: { instanceId: string }, tool: string, args: Record<string, unknown>) => {
		calls.push({ tool, args, instanceId: who.instanceId });
		return outcome;
	},
}));

let d1: RealSchemaD1;
let env: Env;
let leads: Array<{ id: string; data: Record<string, unknown> }>;
const msg = (id: string, subject: string, text: string): GmailMessage =>
	({ id, threadId: `t-${id}`, from: "Acme Careers <careers@acme.example>", to: GMAIL_SCOUT_PINNED_EMAIL, cc: "", subject, date: new Date().toUTCString(), messageId: "", references: "", snippet: "", text, attachments: [] }) as unknown as GmailMessage;
const mailbox = (messages: GmailMessage[]): GmailScoutMailboxFactory => async () => ({ list: async () => messages.map((m) => ({ id: m.id })), read: async (id) => messages.find((m) => m.id === id) as GmailMessage });
const scan = (messages: GmailMessage[]) => scanGmailScout(env, "scout", "u1", { trigger: "on_demand", triggeredBy: "u1", mailbox: mailbox(messages) });
const JOB = msg("m-job", "Platform Engineer at Acme", "Company: Acme Pty Ltd\nhttps://jobs.example.com/job/42");

beforeEach(() => {
	calls.length = 0;
	outcome = { ok: true };
	leads = [];
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["scout"] });
	d1.exec(`UPDATE agent_instances SET config = '{"source_mode":"gmail"}' WHERE id = 'scout'`);
	d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, account_label) VALUES ('u1', 'gmail', '${GMAIL_SCOUT_PINNED_EMAIL}', X'00', X'00', X'00', '${GMAIL_SCOUT_PINNED_EMAIL}')`);
	d1.exec(`INSERT INTO gmail_scout_configs (id, instance_id, pinned_email, enabled) VALUES ('cfg', 'scout', '${GMAIL_SCOUT_PINNED_EMAIL}', 1)`);
	const agent = {
		idFromName: (n: string) => n,
		get: () => ({
			fetch: async (req: Request) => {
				const url = new URL(req.url);
				if (url.pathname === "/state") return Response.json({ permissions: { email: true } });
				if (url.pathname === "/collections/job_leads") return leads.length ? Response.json({ name: "job_leads" }) : new Response("{}", { status: 404 });
				if (url.pathname === "/collections/job_leads/records" && req.method === "GET") return Response.json({ records: leads });
				if (url.pathname === "/collections/job_leads/records" && req.method === "POST") {
					const { data } = (await req.json()) as { data: Record<string, unknown> };
					const id = `lead-${leads.length}`;
					leads.push({ id, data });
					return Response.json({ id, created: true });
				}
				const put = url.pathname.match(/^\/collections\/job_leads\/records\/(.+)$/);
				if (put && req.method === "PUT") {
					const { data } = (await req.json()) as { data: Record<string, unknown> };
					const rec = leads.find((l) => l.id === decodeURIComponent(put[1]));
					if (rec) Object.assign(rec.data, data);
					return Response.json({});
				}
				return Response.json({});
			},
		}),
	};
	env = { DB: d1.DB, AGENT: agent, SESSION_SIGNING_KEY: "k" } as unknown as Env;
});
afterEach(() => d1.close());

describe("Scout leads pushed to Jobs", () => {
	it("a scan with a new lead sends one submit_leads batch with the mapped fields", async () => {
		await scan([JOB]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ tool: "submit_leads", instanceId: "scout" });
		const sent = JSON.parse(calls[0].args.leads as string);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ source_url: "https://jobs.example.com/job/42", source_board: "jobs.example.com", title: "Platform Engineer at Acme", company_name: "Acme Pty Ltd", company_slug: "acme-pty-ltd", country: "AU" });
		expect(sent[0].seen_at).toBeGreaterThan(1e12);
		expect(leads[0].data.jobs_pushed_at).toBeTypeOf("number");
	});

	it("an already-pushed lead is not sent again", async () => {
		await scan([JOB]);
		await scan([]);
		expect(calls).toHaveLength(1);
	});

	it("a Jobs error does not fail the scan, and the lead is retried on the next one", async () => {
		outcome = { ok: false, reason: "failed", detail: "boom" };
		const result = await scan([JOB]);
		expect(result).toMatchObject({ added: 1 });
		expect(leads[0].data.jobs_pushed_at).toBeUndefined();
		outcome = { ok: true };
		await scan([]);
		expect(calls).toHaveLength(2);
		expect(leads[0].data.jobs_pushed_at).toBeTypeOf("number");
	});

	it("the receipt carries the push outcome, including an unconnected Jobs account (#1605)", async () => {
		outcome = { ok: false, reason: "not_connected", detail: "No credential" };
		const failed = await scan([JOB]);
		expect(failed.receipt.jobsPush).toEqual({ sent: 0, failed: 1, reason: "not_connected" });
		outcome = { ok: true };
		const ok = await scan([]);
		expect(ok.receipt.jobsPush).toEqual({ sent: 1, failed: 0, reason: null });
	});

	it("strips the city suffix from the title and keeps it as the location", () => {
		expect(toJobsLead({ url: "https://seek.com.au/job/1?utm_source=x", title: "Data Analyst - Melbourne, VIC, AU", company: "Foo", source_domain: "www.seek.com.au" })).toMatchObject({ title: "Data Analyst", location: "Melbourne, VIC, AU", source_board: "seek.com.au", source_url: "https://seek.com.au/job/1" });
		expect(toJobsLead({ url: "https://x.example/j/1", title: "T", company: "" })).toBeNull();
	});
});
