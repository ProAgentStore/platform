import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
import type { ApplyRun } from "./local-apply/store.js";
import type { LocalBrowserRun } from "./local-browser/store.js";
import type { WebsiteAccessRequest } from "./website-access.js";

const mocks = vi.hoisted(() => ({
	apply: vi.fn(), research: vi.fn(), application: vi.fn(), settings: vi.fn(), runtime: vi.fn(), call: vi.fn(),
	resumeApply: vi.fn(), resumeResearch: vi.fn(), ensure: vi.fn(), decisions: vi.fn(), genericCurrent: vi.fn(), genericResume: vi.fn(), nativeWaiters: vi.fn(),
}));
vi.mock("./local-apply/store.js", () => ({ getApplyRun: mocks.apply }));
vi.mock("./local-browser/store.js", () => ({ getLocalBrowserRun: mocks.research }));
vi.mock("./local-artifact/store.js", () => ({ getOwnedApplication: mocks.application }));
vi.mock("./local-apply/apply.js", () => ({ resumeApplyRun: mocks.resumeApply }));
vi.mock("./local-browser/sync.js", () => ({ resumeLocalBrowserRun: mocks.resumeResearch }));
vi.mock("./browser-settings.js", () => ({ readBrowserSettings: mocks.settings }));
vi.mock("./website-access.js", () => ({ ensureWebsiteAccessRequest: mocks.ensure, listWebsiteDomainDecisions: mocks.decisions }));
vi.mock("./browser-website-access.js", () => ({ isCurrentGenericWebsiteRequest: mocks.genericCurrent, resumeGenericWebsiteRequest: mocks.genericResume }));
vi.mock("./browser-website-native.js", () => ({ resumeNativeWebsiteWaiters: mocks.nativeWaiters }));
vi.mock("../routes/instances-runtime.js", () => ({ getLiveRuntime: mocks.runtime, callRuntime: mocks.call, runtimeJson: (response: Response) => response.json() }));

import { applyWebsitePause, parseWebsitePause, syncApplyWebsiteQuestion as syncApply, syncResearchWebsiteQuestion as syncResearch } from "./website-access-local.js";
import { websiteAccessResumeAdapters } from "./website-access-resume.js";

const env = {} as Env;
const syncApplyWebsiteQuestion = (env: Env, uid: string, run: ApplyRun) => syncApply(env, uid, run, (run, pause, decision) => mocks.resumeApply(env, uid, run, { expectedWebsitePauseKey: pause.pauseKey, websiteDecision: decision }));
const syncResearchWebsiteQuestion = (env: Env, uid: string, run: LocalBrowserRun, rawPause: unknown, resumeKnown = true) => syncResearch(env, uid, run, rawPause, (run, pause, decision) => mocks.resumeResearch(env, run.instanceId, uid, run, Date.now(), { expectedWebsitePauseKey: pause.pauseKey, websiteDecision: decision }), resumeKnown);
const pause = { hostname: "jobs.example.com", pauseKey: "pause-1" };
const access = { mode: "ask_once" as const, domains: [] as string[] };
const apply = () => ({ id: "fill-1", instanceId: "agent-1", applicationId: "application-1", status: "paused", policy: { browserWebsiteAccess: access }, pause: { reason: "external_redirect", domain: pause.hostname, handoffRequestId: pause.pauseKey } }) as unknown as ApplyRun;
const research = () => ({ id: "research-1", instanceId: "agent-1", status: "paused", pauseReason: "consent_required", runnerSeq: 4, policy: { browserWebsiteAccess: access } }) as unknown as LocalBrowserRun;
const request = (subjectKind: WebsiteAccessRequest["subjectKind"] = "local_apply_run") => ({ id: "question-1", instanceId: "agent-1", subjectKind, subjectId: subjectKind === "local_apply_run" ? "fill-1" : "research-1", ...pause }) as WebsiteAccessRequest;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.apply.mockResolvedValue(apply()); mocks.research.mockResolvedValue(research());
	mocks.application.mockResolvedValue({ fillRunId: "fill-1" });
	mocks.settings.mockResolvedValue({ effective: { websiteAccess: access } });
	mocks.runtime.mockResolvedValue({ instance_id: "agent-1", user_id: "owner-1" });
	mocks.call.mockImplementation(async () => Response.json({ state: "paused", websitePause: pause }));
	mocks.decisions.mockResolvedValue([]); mocks.ensure.mockResolvedValue(request());
	mocks.resumeApply.mockResolvedValue({ ...apply(), status: "running" });
	mocks.resumeResearch.mockResolvedValue({ ...research(), status: "running" });
	mocks.genericCurrent.mockResolvedValue(true); mocks.genericResume.mockResolvedValue({ resumed: true });
	mocks.nativeWaiters.mockResolvedValue({ continued: 0, denied: 0, failed: 0 });
});

describe("local website questions", () => {
	it("does not create website questions for allow-all, strict lists, legacy or ended runs", async () => {
		for (const mode of ["allow_all", "allowlist", undefined]) {
			const run = apply();
			run.policy.browserWebsiteAccess = mode ? { mode: mode as "allow_all" | "allowlist", domains: [] } : undefined;
			await syncApplyWebsiteQuestion(env, "owner-1", run);
		}
		await syncApplyWebsiteQuestion(env, "owner-1", { ...apply(), status: "blocked" });
		expect(mocks.ensure).not.toHaveBeenCalled(); expect(mocks.resumeApply).not.toHaveBeenCalled();
	});
	it("binds an application question to its exact run, host and pause", async () => {
		await syncApplyWebsiteQuestion(env, "owner-1", apply());
		expect(mocks.ensure).toHaveBeenCalledWith(env, expect.objectContaining({ userId: "owner-1", instanceId: "agent-1", subjectKind: "local_apply_run", subjectId: "fill-1", ...pause }));
		expect(mocks.resumeApply).not.toHaveBeenCalled();
	});
	it.each(["allow", "deny"] as const)("a remembered %s releases only the current exact pause, without another question", async (decision) => {
		mocks.decisions.mockResolvedValue([{ hostname: pause.hostname, decision }]);
		await syncApplyWebsiteQuestion(env, "owner-1", apply());
		expect(mocks.resumeApply).toHaveBeenCalledWith(env, "owner-1", expect.objectContaining({ id: "fill-1" }), { expectedWebsitePauseKey: "pause-1", websiteDecision: decision });
		expect(mocks.ensure).not.toHaveBeenCalled();
	});
	it("does not treat another hostname's decision as permission", async () => {
		mocks.decisions.mockResolvedValue([{ hostname: "example.com", decision: "allow" }]);
		await syncApplyWebsiteQuestion(env, "owner-1", apply());
		expect(mocks.ensure).toHaveBeenCalled(); expect(mocks.resumeApply).not.toHaveBeenCalled();
	});
	it("creates a research question from native pause metadata and preserves legacy profile consent", async () => {
		await syncResearchWebsiteQuestion(env, "owner-1", research(), pause);
		expect(mocks.ensure).toHaveBeenCalledWith(env, expect.objectContaining({ subjectKind: "local_browser_run", subjectId: "research-1", ...pause }));
		mocks.ensure.mockClear();
		await syncResearchWebsiteQuestion(env, "owner-1", research(), undefined);
		expect(mocks.ensure).not.toHaveBeenCalled();
	});
	it("defers a remembered research permission until the outer status has been reconciled", async () => {
		mocks.decisions.mockResolvedValue([{ hostname: pause.hostname, decision: "allow" }]);
		await syncResearchWebsiteQuestion(env, "owner-1", research(), pause, false);
		expect(mocks.resumeResearch).not.toHaveBeenCalled();
		await syncResearchWebsiteQuestion(env, "owner-1", research(), pause);
		expect(mocks.resumeResearch).toHaveBeenCalledTimes(1);
	});
	it("rejects malformed pause identities instead of manufacturing an approval target", () => {
		for (const value of [null, { ...pause, hostname: "https://jobs.example.com" }, { ...pause, pauseKey: "" }, { ...pause, pauseKey: "x".repeat(129) }]) expect(parseWebsitePause(value)).toBeNull();
		expect(applyWebsitePause({ ...apply(), pause: { reason: "captcha" } })).toBeNull();
	});
});

describe("website answer resume binding", () => {
	it("refuses answers after the owner changes away from ask-once or for another instance", async () => {
		const adapter = websiteAccessResumeAdapters(env, "owner-1", "agent-1");
		expect(await adapter.canAnswer({ ...request(), instanceId: "other" })).toBe(false);
		mocks.settings.mockResolvedValue({ effective: { websiteAccess: { mode: "allow_all", domains: [] } } });
		expect(await adapter.canAnswer(request())).toBe(false);
	});
	it("does not resume an ended run, another pause, or an application's replacement attempt", async () => {
		const adapter = websiteAccessResumeAdapters(env, "owner-1", "agent-1");
		expect(await adapter.isCurrent({ ...request(), pauseKey: "old-pause" })).toBe(false);
		expect(await adapter.isCurrent({ ...request(), hostname: "other.example.com" })).toBe(false);
		mocks.application.mockResolvedValue({ fillRunId: "replacement" });
		expect(await adapter.isCurrent(request())).toBe(false);
		mocks.apply.mockResolvedValue({ ...apply(), status: "blocked" });
		expect((await adapter.resume!(request())).resumed).toBe(false);
		expect(mocks.resumeApply).not.toHaveBeenCalled();
	});
	it("a current application answer resumes the same attempt with its pause nonce and no submission grant", async () => {
		const adapter = websiteAccessResumeAdapters(env, "owner-1", "agent-1");
		expect(await adapter.isCurrent(request())).toBe(true);
		expect(await adapter.resume!(request())).toEqual({ resumed: true });
		expect(mocks.resumeApply).toHaveBeenCalledWith(env, "owner-1", expect.objectContaining({ id: "fill-1" }), { expectedWebsitePauseKey: "pause-1", websiteDecision: "allow" });
	});
	it("a denial releases the same application pause without reporting permission to continue", async () => {
		const adapter = websiteAccessResumeAdapters(env, "owner-1", "agent-1");
		expect((await adapter.resume!({ ...request(), status: "denied" })).resumed).toBe(false);
		expect(mocks.resumeApply).toHaveBeenCalledWith(env, "owner-1", expect.objectContaining({ id: "fill-1" }), { expectedWebsitePauseKey: "pause-1", websiteDecision: "deny" });
	});
	it("checks the live research pause instead of trusting its old cloud status", async () => {
		const adapter = websiteAccessResumeAdapters(env, "owner-1", "agent-1");
		const r = request("local_browser_run");
		expect(await adapter.isCurrent(r)).toBe(true);
		mocks.call.mockImplementation(async () => Response.json({ state: "paused", websitePause: { ...pause, pauseKey: "new-pause" } }));
		expect((await adapter.resume!(r)).resumed).toBe(false);
		expect(mocks.resumeResearch).not.toHaveBeenCalled();
	});
	it("does not claim a disappeared runner resumed an application or research run", async () => {
		mocks.resumeApply.mockResolvedValue({ ...apply(), status: "failed" });
		mocks.resumeResearch.mockResolvedValue({ ...research(), status: "failed" });
		const adapter = websiteAccessResumeAdapters(env, "owner-1", "agent-1");
		expect(await adapter.resume!(request())).toMatchObject({ resumed: false, reason: expect.stringContaining("failed") });
		expect(await adapter.resume!(request("local_browser_run"))).toMatchObject({ resumed: false, reason: expect.stringContaining("failed") });
	});
	it("does not automatically restart a connector action", async () => {
		const adapter = websiteAccessResumeAdapters(env, "owner-1", "agent-1");
		expect(await adapter.isCurrent(request("connector"))).toBe(false);
		expect((await adapter.resume!(request("connector"))).resumed).toBe(false);
	});
	it("answers other already-waiting native tasks without dispatching the original task twice", async () => {
		const adapter = websiteAccessResumeAdapters(env, "owner-1", "agent-1");
		const r = request("runtime_task");
		await adapter.afterDecision!(r);
		expect(mocks.nativeWaiters).toHaveBeenCalledWith(env, "owner-1", r, { excludeTaskId: r.subjectId });
		expect(mocks.genericResume).not.toHaveBeenCalled();
	});
});
