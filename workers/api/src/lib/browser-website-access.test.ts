import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import type { Env } from "../types.js";
import { runApplyLoop } from "./apply-loop.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { answerWebsiteAccessRequest, getWebsiteAccessRequest, type WebsiteAccessRequest } from "./website-access.js";
import { BrowserWebsiteAccessRequired, browserWebsiteBlock, isCurrentGenericWebsiteRequest, requireBrowserWebsiteAccess, resolveOpeningWebsiteAccess, resumeGenericWebsiteRequest, waitForBrowserWebsiteAccess, waitForWebsiteDecision, type BrowserWebsiteBlock, type BrowserWebsiteWaitDeps } from "./browser-website-access.js";

const access: BrowserWebsiteBlock = { decision: "ask", mode: "ask_once", hostname: "jobs.example.com", url: "https://jobs.example.com/next", actionDispatched: false };
const request: WebsiteAccessRequest = { id: "question", instanceId: "instance", instanceName: "Agent", subjectKind: "runtime_task", subjectId: "task", hostname: access.hostname, pauseKey: "pause", status: "pending", createdAt: new Date().toISOString(), decidedAt: null, link: "/question", questionUrl: "/question", subjectLink: null };
const deps = (): BrowserWebsiteWaitDeps => ({ create: vi.fn(async () => request), read: vi.fn(async () => request), isCurrent: vi.fn(async () => true), granted: vi.fn(async () => true), park: vi.fn(async () => false), sleep: vi.fn(async () => undefined) });

describe("website permission never masquerades as action success", () => {
	it("accepts only typed authenticated receipts and rejects malformed destinations", () => {
		expect(browserWebsiteBlock({ websiteAccess: access })).toEqual(access);
		expect(browserWebsiteBlock({ snapshot: JSON.stringify({ websiteAccess: access }) })).toBeNull();
		expect(() => browserWebsiteBlock({ websiteAccess: { ...access, hostname: "other.example.com" } })).toThrow(/Invalid/);
		expect(() => browserWebsiteBlock({ websiteAccess: { ...access, mode: "allowlist" } })).toThrow(/Invalid/);
	});
	it("halts the real decision loop on the first denied navigation without another model call", async () => {
		const decide = vi.fn(async () => ({ action: { action: "navigate" as const, url: access.url } }));
		const act = vi.fn(async () => requireBrowserWebsiteAccess({ url: "about:blank", challenge: null, websiteAccess: access }));
		await expect(runApplyLoop({ snapshot: async () => ({ url: "about:blank", title: "", snapshot: "", challenge: null }), decide, act }, {})).rejects.toBeInstanceOf(BrowserWebsiteAccessRequired);
		expect(decide).toHaveBeenCalledTimes(1);
		expect(act).toHaveBeenCalledTimes(1);
	});
	it("strict deny creates no question or wait", async () => {
		const d = deps();
		expect(await waitForWebsiteDecision({ ...access, decision: "deny", mode: "allowlist" }, d)).toMatchObject({ approved: false, result: { outcome: "blocked" } });
		expect(d.create).not.toHaveBeenCalled();
		expect(d.sleep).not.toHaveBeenCalled();
	});
	it("waits for owner approval and the current exact-host grant", async () => {
		const d = deps();
		d.read = vi.fn().mockResolvedValueOnce(request).mockResolvedValueOnce({ ...request, status: "approved" });
		expect(await waitForWebsiteDecision(access, d)).toMatchObject({ approved: true, questionUrl: "/question" });
		expect(d.sleep).toHaveBeenCalledTimes(1);
		expect(d.granted).toHaveBeenCalledWith(access.hostname);
	});
	it.each(["cancelled", "stale", "revoked", "denied", "timeout"])("does not continue on %s", async (condition) => {
		const d = deps();
		if (condition === "cancelled") d.park = vi.fn(async () => true);
		if (condition === "stale") d.isCurrent = vi.fn(async () => false);
		if (condition === "revoked") { d.read = vi.fn<BrowserWebsiteWaitDeps["read"]>(async () => ({ ...request, status: "approved" })); d.granted = vi.fn(async () => false); }
		if (condition === "denied") d.read = vi.fn<BrowserWebsiteWaitDeps["read"]>(async () => ({ ...request, status: "denied" }));
		expect(await waitForWebsiteDecision(access, d, 2)).toMatchObject({ approved: false });
	});
	it("after opening approval only takes a fresh snapshot, including post-dispatch redirects", async () => {
		const initial: { url: string; websiteAccess?: BrowserWebsiteBlock } = { url: "https://start.example.com/", websiteAccess: { ...access, actionDispatched: true } };
		const snapshot = vi.fn(async () => ({ url: "about:blank", websiteAccess: undefined }));
		const wait = vi.fn(async () => ({ approved: true as const, questionUrl: "/question" }));
		expect(await resolveOpeningWebsiteAccess(initial, wait, snapshot)).toMatchObject({ receipt: { url: "about:blank" } });
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(wait).toHaveBeenCalledWith(initial.websiteAccess, 0);
	});
	it("normal allow_all/allowlist-success receipt goes straight through without a question", async () => {
		const wait = vi.fn(), snapshot = vi.fn();
		expect(await resolveOpeningWebsiteAccess({ url: access.url }, wait, snapshot)).toEqual({ receipt: { url: access.url } });
		expect(wait).not.toHaveBeenCalled();
		expect(snapshot).not.toHaveBeenCalled();
	});
});

let db: RealSchemaD1 | undefined;
afterEach(() => { db?.close(); db = undefined; });
describe("durable generic browser website pause", () => {
	function fixture() {
		db = realSchemaD1();
		seedTenant(db, { userId: "owner", instanceIds: ["instance"] });
		db.exec("INSERT INTO instance_runtime_tasks(id,instance_id,user_id,type,status,payload,created_at,updated_at) VALUES ('task','instance','owner','browser.task','running','{}',datetime('now'),datetime('now'))");
		const bindings: Pick<Env, "DB"> = { DB: db.DB };
		return bindings as Env;
	}
	it("records the exact waiting task, survives runner mirroring, and clears before fresh continuation", async () => {
		const env = fixture();
		let asked: WebsiteAccessRequest | null = null;
		const step = {
			do: async (_name: string, body: () => Promise<unknown>) => body(),
			sleep: async () => {
				const row = await env.DB.prepare("SELECT id FROM website_access_requests").first<{ id: string }>();
				asked = await getWebsiteAccessRequest(env, "owner", "instance", row!.id);
				expect(await isCurrentGenericWebsiteRequest(env, "owner", asked!)).toBe(true);
				expect(await isCurrentGenericWebsiteRequest(env, "other", asked!)).toBe(false);
				expect(await isCurrentGenericWebsiteRequest(env, "owner", { ...asked!, pauseKey: "stale" })).toBe(false);
				// Runner task mirrors replace their payload: API-owned permission marker is separate.
				db!.exec("UPDATE instance_runtime_tasks SET payload='{\"status\":\"running\"}' WHERE id='task'");
				await answerWebsiteAccessRequest(env, "owner", "instance", asked!.id, "approve", { canAnswer: async () => true, isCurrent: (r) => isCurrentGenericWebsiteRequest(env, "owner", r), resume: (r) => resumeGenericWebsiteRequest(env, "owner", r) });
			},
		} as unknown as WorkflowStep;
		const answer = await waitForBrowserWebsiteAccess(env, step, { instanceId: "instance", userId: "owner", taskId: "task", loopRunId: null, pauseKey: "website-round-0" }, access);
		expect(answer).toMatchObject({ approved: true });
		expect(await isCurrentGenericWebsiteRequest(env, "owner", asked!)).toBe(false);
		expect(await resumeGenericWebsiteRequest(env, "owner", asked!)).toMatchObject({ resumed: false });
	});
	it("an owner cancellation while waiting cannot resume that task", async () => {
		const env = fixture();
		const step = { do: async (_name: string, body: () => Promise<unknown>) => body(), sleep: async () => { db!.exec("UPDATE instance_runtime_tasks SET status='cancelled' WHERE id='task'"); } } as unknown as WorkflowStep;
		expect(await waitForBrowserWebsiteAccess(env, step, { instanceId: "instance", userId: "owner", taskId: "task", loopRunId: null, pauseKey: "website-round-0" }, access)).toMatchObject({ approved: false, result: { outcome: "cancelled" } });
	});
});
