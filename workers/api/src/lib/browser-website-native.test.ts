import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { mirrorRuntimeTask } from "../routes/instances-runtime.js";
import { getWebsiteAccessRequest, type WebsiteAccessRequest } from "./website-access.js";
import { isCurrentGenericWebsiteRequest } from "./browser-website-access.js";
import { hasCurrentNativeWebsiteWaiters, mirrorNativeWebsitePause, resumeNativeWebsiteRequest, resumeNativeWebsiteWaiters } from "./browser-website-native.js";
import type { RunnerConn } from "./runner-client.js";

let db: RealSchemaD1;
afterEach(() => db?.close());
const task = { id: "task", type: "browser.open", status: "needs_human", approval: { approvedAt: "2026-11-04T00:00:00Z" }, output: { websiteAccess: { decision: "ask", hostname: "jobs.example.com", url: "https://jobs.example.com/apply", mode: "ask_once", actionDispatched: false, pauseKey: "opaque-pause" } } };
async function fixture() {
	db = realSchemaD1();
	seedTenant(db, { userId: "owner", instanceIds: ["instance"] });
	const bindings: Pick<Env, "DB"> = { DB: db.DB };
	const env = bindings as Env;
	await mirrorRuntimeTask(env, "instance", "owner", task);
	const id = (await env.DB.prepare("SELECT id FROM website_access_requests").first<{ id: string }>())!.id;
	const request = (await getWebsiteAccessRequest(env, "owner", "instance", id))!;
	const deps = { connect: vi.fn(async () => ({ instanceId: "instance", userId: "owner" }) as RunnerConn), dispatch: vi.fn(async (_conn: RunnerConn, _path: string, _body: unknown) => ({ ...task, status: "completed" })), mirror: vi.fn(mirrorRuntimeTask) };
	return { env, request, deps };
}
async function recordDecision(request: WebsiteAccessRequest, decision: "allow" | "deny" = "allow") {
	await db.DB.prepare("UPDATE website_access_requests SET status=? WHERE id=?").bind(decision === "allow" ? "approved" : "denied", request.id).run();
	await db.DB.prepare("INSERT INTO website_access_grants(user_id,instance_id,hostname,decision,request_id,decided_at) VALUES ('owner','instance',?,?,?,1)").bind(request.hostname, decision, request.id).run();
}

describe("native browser.open website questions", () => {
	it("mirrors a durable unique question and exact pause without executing or approving anything", async () => {
		const { env, request, deps } = await fixture();
		expect(request).toMatchObject({ subjectKind: "runtime_task", subjectId: "task", pauseKey: "opaque-pause", status: "pending" });
		expect(request.questionUrl).toContain(request.id);
		expect(await isCurrentGenericWebsiteRequest(env, "owner", request)).toBe(true);
		await mirrorRuntimeTask(env, "instance", "owner", task);
		expect(await env.DB.prepare("SELECT count(*) AS n FROM website_access_requests").first()).toEqual({ n: 1 });
		expect(await resumeNativeWebsiteRequest(env, "owner", request, deps)).toMatchObject({ resumed: false });
		expect(deps.dispatch).not.toHaveBeenCalled();
	});
	it("resumes only the retained approved task, sends no stored action, and cannot resume twice", async () => {
		const { env, request, deps } = await fixture();
		await recordDecision(request);
		expect(await resumeNativeWebsiteRequest(env, "owner", request, deps)).toMatchObject({ resumed: true });
		expect(deps.dispatch).toHaveBeenCalledWith(expect.anything(), "/tasks/task/website-access-resume", { pauseKey: "opaque-pause", websiteDecision: "allow" });
		expect(await resumeNativeWebsiteRequest(env, "owner", request, deps)).toMatchObject({ resumed: false });
		expect(deps.dispatch).toHaveBeenCalledTimes(1);
	});
	it.each(["wrong-owner", "stale-pause", "cancelled", "revoked", "cancel-during-connect"])("never dispatches for %s", async (condition) => {
		const { env, request, deps } = await fixture();
		await recordDecision(request);
		if (condition === "cancelled") db.exec("UPDATE instance_runtime_tasks SET status='cancelled'");
		if (condition === "revoked") db.exec("DELETE FROM website_access_grants");
		if (condition === "stale-pause") request.pauseKey = "old";
		if (condition === "cancel-during-connect") deps.connect.mockImplementation(async () => { db.exec("UPDATE instance_runtime_tasks SET status='cancelled'"); return {} as RunnerConn; });
		expect(await resumeNativeWebsiteRequest(env, condition === "wrong-owner" ? "other" : "owner", request, deps)).toMatchObject({ resumed: false });
		expect(deps.dispatch).not.toHaveBeenCalled();
	});
	it("a persisted denial stops the exact native pause without claiming a successful continuation", async () => {
		const { env, request, deps } = await fixture();
		await recordDecision(request, "deny");
		deps.dispatch.mockResolvedValue({ ...task, status: "failed" });
		expect(await resumeNativeWebsiteRequest(env, "owner", request, deps)).toMatchObject({ resumed: false });
		expect(deps.dispatch).toHaveBeenCalledWith(expect.anything(), "/tasks/task/website-access-resume", { pauseKey: "opaque-pause", websiteDecision: "deny" });
	});
	it("cannot create a question from another owner's colliding task id", async () => {
		const { env } = await fixture();
		await mirrorNativeWebsitePause(env, "instance", "other", { ...task, output: { websiteAccess: { ...task.output.websiteAccess, hostname: "other.example.com", url: "https://other.example.com/" } } });
		expect(await env.DB.prepare("SELECT count(*) AS n FROM website_access_requests").first()).toEqual({ n: 1 });
	});
});


describe("shared native host question fanout", () => {
	it("leaves the original active subject for its separate truthful resume result", async () => {
		const { env, request, deps } = await fixture();
		await recordDecision(request);
		expect(await resumeNativeWebsiteWaiters(env, "owner", request, { excludeTaskId: request.subjectId }, deps)).toEqual({ continued: 0, denied: 0, failed: 0 });
		expect(deps.dispatch).not.toHaveBeenCalled();
		expect(await isCurrentGenericWebsiteRequest(env, "owner", request)).toBe(true);
	});
	it.each(["allow", "deny"] as const)("settles both exact native waiters for %s even when the first subject ended", async (decision) => {
		const { env, request, deps } = await fixture();
		await mirrorRuntimeTask(env, "instance", "owner", { ...task, status: "cancelled" });
		const second = { ...task, id: "second", output: { websiteAccess: { ...task.output.websiteAccess, pauseKey: "second-key" } } };
		const third = { ...task, id: "third", output: { websiteAccess: { ...task.output.websiteAccess, pauseKey: "third-key" } } };
		const stopped = { ...task, id: "stopped", output: { websiteAccess: { ...task.output.websiteAccess, pauseKey: "stopped-key" } } };
		for (const waiting of [second, third, stopped]) await mirrorRuntimeTask(env, "instance", "owner", waiting);
		await mirrorRuntimeTask(env, "instance", "owner", { ...stopped, status: "cancelled" });
		// A different host gets a different question and must never consume this answer.
		await mirrorRuntimeTask(env, "instance", "owner", { ...task, id: "other-host", output: { websiteAccess: { ...task.output.websiteAccess, hostname: "other.example.com", url: "https://other.example.com/", pauseKey: "other-key" } } });
		seedTenant(db, { userId: "other-owner", instanceIds: ["other-instance"] });
		await mirrorRuntimeTask(env, "other-instance", "other-owner", { ...task, id: "other-owner-task" });
		expect(await hasCurrentNativeWebsiteWaiters(env, "owner", request)).toBe(true);
		expect(await hasCurrentNativeWebsiteWaiters(env, "other-owner", request)).toBe(false);
		await recordDecision(request, decision);
		deps.dispatch.mockImplementation(async (_conn, path) => ({ ...(path.includes("second") ? second : third), status: decision === "allow" ? "completed" : "failed" }));
		expect(await resumeNativeWebsiteWaiters(env, "owner", request, { excludeTaskId: request.subjectId }, deps)).toEqual({ continued: decision === "allow" ? 2 : 0, denied: decision === "deny" ? 2 : 0, failed: 0 });
		expect(deps.dispatch.mock.calls.map((call) => [call[1], call[2]])).toEqual([
			["/tasks/second/website-access-resume", { pauseKey: "second-key", websiteDecision: decision }],
			["/tasks/third/website-access-resume", { pauseKey: "third-key", websiteDecision: decision }],
		]);
		expect(await isCurrentGenericWebsiteRequest(env, "owner", request)).toBe(false);
		expect(await hasCurrentNativeWebsiteWaiters(env, "owner", request)).toBe(false);
		expect(await resumeNativeWebsiteWaiters(env, "owner", request, { excludeTaskId: request.subjectId }, deps)).toEqual({ continued: 0, denied: 0, failed: 0 });
		expect(deps.dispatch).toHaveBeenCalledTimes(2);
	});
});
