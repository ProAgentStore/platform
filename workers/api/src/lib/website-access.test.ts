import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { answerWebsiteAccessRequest, ensureWebsiteAccessRequest, getWebsiteAccessRequest, listDeniedWebsiteDomains, listRememberedWebsiteDomains, listWebsiteAccessRequests, revokeWebsiteDomain, type WebsiteAccessAnswerAdapters } from "./website-access.js";

let db: RealSchemaD1;
let env: Env;
let notify: ReturnType<typeof vi.fn>;
let adapters: WebsiteAccessAnswerAdapters;
const NOW = Date.parse("2026-11-04T01:00:00Z");
beforeEach(() => {
	db = realSchemaD1();
	seedTenant(db, { userId: "u1", instanceIds: ["i1", "i2"] });
	seedTenant(db, { userId: "u2", instanceIds: ["other"] });
	// Only D1 is exercised; verify its fixture contract before supplying the narrower test bindings.
	const bindings: Pick<Env, "DB"> = { DB: db.DB };
	env = bindings as Env;
	notify = vi.fn(async () => undefined);
	adapters = { canAnswer: vi.fn(async () => true), isCurrent: vi.fn(async () => true), resume: vi.fn(async () => ({ resumed: true })) };
});
afterEach(() => db.close());
const ask = (over = {}) => ensureWebsiteAccessRequest(env, { userId: "u1", instanceId: "i1", subjectKind: "local_apply_run", subjectId: "run-1", hostname: "jobs.example.com", pauseKey: "pause-1", ...over }, { attention: { notify }, now: NOW });
const answer = (id: string, decision: "approve" | "deny" = "approve") => answerWebsiteAccessRequest(env, "u1", "i1", id, decision, adapters, NOW + 1000);

describe("website permission questions (#1480)", () => {
	it("deduplicates the same originating pause and notifies with an owner-authenticated unique link once", async () => {
		const first = await ask();
		const again = await ask({ hostname: "JOBS.EXAMPLE.COM" });
		expect(again.id).toBe(first.id);
		expect(first.link).toBe(`/console/instances/i1/website-requests/${first.id}`);
		expect(first).toMatchObject({ status: "pending", decidedAt: null, hostname: "jobs.example.com" });
		expect(notify).toHaveBeenCalledTimes(1);
		expect((await ask({ pauseKey: "pause-2" })).id).toBe(first.id);
		expect((await ask({ subjectId: "run-2" })).id).toBe(first.id);
	});
	it("reads never decide; another owner or instance cannot inspect or answer a request", async () => {
		const r = await ask();
		expect(await getWebsiteAccessRequest(env, "u2", "i1", r.id)).toBeNull();
		expect(await getWebsiteAccessRequest(env, "u1", "i2", r.id)).toBeNull();
		expect((await listWebsiteAccessRequests(env, "u2", "other")).requests).toEqual([]);
		await expect(answerWebsiteAccessRequest(env, "u2", "i1", r.id, "approve", adapters)).rejects.toMatchObject({ status: 404 });
		expect((await getWebsiteAccessRequest(env, "u1", "i1", r.id))?.status).toBe("pending");
		expect(await listRememberedWebsiteDomains(env, "u1", "i1")).toEqual([]);
	});
	it("retries a failed notification until recorded without creating another question or changing its dedupe identity", async () => {
		notify.mockRejectedValueOnce(new Error("notification storage unavailable"));
		const first = await ask();
		expect((await ask()).id).toBe(first.id);
		await ask();
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify.mock.calls[0]).toEqual(notify.mock.calls[1]);
		expect((await listWebsiteAccessRequests(env, "u1", "i1")).requests).toHaveLength(1);
	});
	it("retries an actual swallowed notification insert failure and records one durable question notification", async () => {
		await env.DB.exec("CREATE TRIGGER fail_website_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(FAIL, 'temporary notification failure'); END;");
		const input = { userId: "u1", instanceId: "i1", subjectKind: "local_apply_run" as const, subjectId: "run-1", hostname: "jobs.example.com", pauseKey: "pause-1" };
		const first = await ensureWebsiteAccessRequest(env, input);
		expect(await env.DB.prepare("SELECT notified_at FROM website_access_requests WHERE id = ?1").bind(first.id).first()).toEqual({ notified_at: null });
		await env.DB.exec("DROP TRIGGER fail_website_notification;");
		expect((await ensureWebsiteAccessRequest(env, input)).id).toBe(first.id);
		await ensureWebsiteAccessRequest(env, input);
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id = 'u1'").first()).toEqual({ count: 1 });
		expect(await env.DB.prepare("SELECT notified_at FROM website_access_requests WHERE id = ?1").bind(first.id).first()).toMatchObject({ notified_at: expect.any(Number) });
	});
	it("persists only the exact host before resuming, once; it never grants a sibling or another agent", async () => {
		const r = await ask();
		adapters.resume = vi.fn(async (request) => {
			expect(request.subjectId).toBe("run-1");
			expect(await listRememberedWebsiteDomains(env, "u1", "i1")).toEqual(["jobs.example.com"]);
			return { resumed: true };
		});
		expect(await answer(r.id)).toMatchObject({ recorded: true, resumed: true, request: { status: "approved" } });
		expect(await answer(r.id)).toMatchObject({ repeated: true, resumed: false });
		expect((await ask({ subjectId: "run-2" })).id).toBe(r.id);
		expect(adapters.resume).toHaveBeenCalledTimes(1);
		expect(await listRememberedWebsiteDomains(env, "u1", "i2")).toEqual([]);
		expect(await listRememberedWebsiteDomains(env, "u2", "i1")).toEqual([]);
	});
	it("an ended run's question can save future permission but never resumes a newer run", async () => {
		const old = await ask();
		await ask({ subjectId: "run-2", hostname: "other.example.com" });
		adapters.isCurrent = vi.fn(async () => false);
		expect(await answer(old.id)).toMatchObject({ recorded: true, resumed: false, resumeError: expect.stringContaining("no run was started or resumed") });
		expect(adapters.resume).not.toHaveBeenCalled();
		expect(await listRememberedWebsiteDomains(env, "u1", "i1")).toEqual(["jobs.example.com"]);
	});
	it("remembers denial and lets the owner revoke it; repeated old answers never restore revoked decisions", async () => {
		const denied = await ask();
		expect(await answer(denied.id, "deny")).toMatchObject({ recorded: true, resumed: false, repeated: false });
		expect(await listDeniedWebsiteDomains(env, "u1", "i1")).toEqual(["jobs.example.com"]);
		expect(adapters.resume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "denied", subjectId: "run-1", hostname: "jobs.example.com" }));
		expect(await answer(denied.id, "deny")).toMatchObject({ resumed: false, repeated: true });
		await revokeWebsiteDomain(env, "u1", "i1", "jobs.example.com");
		await answer(denied.id, "deny");
		expect(await listDeniedWebsiteDomains(env, "u1", "i1")).toEqual([]);
		const allowed = await ask({ pauseKey: "another" });
		await answer(allowed.id);
		await revokeWebsiteDomain(env, "u2", "i1", "jobs.example.com");
		expect(await listRememberedWebsiteDomains(env, "u1", "i1")).toEqual(["jobs.example.com"]);
		await revokeWebsiteDomain(env, "u1", "i1", "jobs.example.com");
		await answer(allowed.id);
		expect(await listRememberedWebsiteDomains(env, "u1", "i1")).toEqual([]);
		await expect(answer(allowed.id, "deny")).rejects.toMatchObject({ status: 409 });
	});
	it("refuses a pending answer when ask_once was changed and truthfully keeps saved permission on resume failure", async () => {
		const r = await ask();
		adapters.canAnswer = vi.fn(async () => false);
		await expect(answer(r.id)).rejects.toMatchObject({ status: 409 });
		expect((await getWebsiteAccessRequest(env, "u1", "i1", r.id))?.status).toBe("pending");
		adapters.canAnswer = vi.fn(async () => true);
		adapters.resume = vi.fn(async () => { throw new Error("private runner detail"); });
		expect(await answer(r.id)).toMatchObject({ recorded: true, resumed: false, resumeError: "Permission saved, but the original run could not be resumed. Check its current status before continuing." });
		expect(await listRememberedWebsiteDomains(env, "u1", "i1")).toEqual(["jobs.example.com"]);
	});
	it("a denial remains saved when releasing the original wait fails", async () => {
		const r = await ask();
		adapters.resume = vi.fn(async () => { throw new Error("private runtime failure"); });
		expect(await answer(r.id, "deny")).toMatchObject({ recorded: true, resumed: false, resumeError: "Website denial saved, but the original waiting run could not be updated. Check its current status; access remains denied." });
		expect(await listRememberedWebsiteDomains(env, "u1", "i1")).toEqual([]);
		expect(await listDeniedWebsiteDomains(env, "u1", "i1")).toEqual(["jobs.example.com"]);
	});
	it.each(["approve", "deny"] as const)("fans out a saved %s decision once before original resume and reports separate counts", async (decision) => {
		const r = await ask();
		const order: string[] = [];
		adapters.afterDecision = vi.fn(async (request) => {
			expect(request.status).toBe(decision === "approve" ? "approved" : "denied");
			expect((await getWebsiteAccessRequest(env, "u1", "i1", r.id))?.status).toBe(request.status);
			order.push("fanout");
			return { continued: 2, denied: 1, failed: 0 };
		});
		adapters.isCurrent = vi.fn(async () => { order.push("original"); return false; });
		expect(await answer(r.id, decision)).toMatchObject({ recorded: true, resumed: false, additionalWaitingTasks: { continued: 2, denied: 1, failed: 0 } });
		await answer(r.id, decision);
		expect(order).toEqual(["fanout", "original"]);
		expect(adapters.afterDecision).toHaveBeenCalledTimes(1);
	});
	it("a failed fanout preserves the grant and still checks the original run", async () => {
		const r = await ask();
		adapters.afterDecision = vi.fn(async () => { throw new Error("private failure"); });
		expect(await answer(r.id)).toMatchObject({ recorded: true, resumed: true, additionalWaitingTasksError: expect.stringContaining("Website decision saved") });
		expect(await listRememberedWebsiteDomains(env, "u1", "i1")).toEqual(["jobs.example.com"]);
		expect(adapters.resume).toHaveBeenCalledTimes(1);
	});
	it("competing answers produce one durable decision and cannot both resume", async () => {
		const r = await ask();
		const results = await Promise.allSettled([answer(r.id), answer(r.id, "deny")]);
		expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
		const saved = await getWebsiteAccessRequest(env, "u1", "i1", r.id);
		expect(["approved", "denied"]).toContain(saved?.status);
		expect(await listRememberedWebsiteDomains(env, "u1", "i1")).toEqual(saved?.status === "approved" ? ["jobs.example.com"] : []);
	});
	it("rejects URLs/wildcards and cannot create a question for another owner's instance", async () => {
		for (const hostname of ["https://jobs.example.com", "*.example.com", "jobs.example.com/path", "jobs.example.com:443"]) await expect(ask({ hostname })).rejects.toMatchObject({ status: 400 });
		await expect(ask({ instanceId: "other" })).rejects.toMatchObject({ status: 404 });
	});
});
