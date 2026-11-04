import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
const mocks = vi.hoisted(() => ({ policy: vi.fn(), ensure: vi.fn() }));
vi.mock("./browser-settings-dispatch.js", () => ({ websiteAccessForInstance: mocks.policy }));
vi.mock("./website-access.js", () => ({ ensureWebsiteAccessRequest: mocks.ensure }));
import { auxiliaryWebsiteAccess } from "./website-access-auxiliary.js";
const env = {} as Env;
const access = { decision: "ask", mode: "ask_once", hostname: "jobs.example.com", url: "https://jobs.example.com/apply", actionDispatched: false };
beforeEach(() => { vi.clearAllMocks(); mocks.policy.mockResolvedValue({ mode: "ask_once", domains: [], rememberedDomains: [], deniedDomains: [] }); mocks.ensure.mockResolvedValue({ id: "request", questionUrl: "https://console.test/question/request" }); });
describe("auxiliary website permission", () => {
	it("creates an agent-bound opaque question without claiming a retained application pause", async () => {
		const out = await auxiliaryWebsiteAccess(env, "owner", "agent", "preflight", "https://jobs.example.com/?secret=query", { websiteAccess: access });
		expect(out).toMatchObject({ state: "blocked", questionUrl: "https://console.test/question/request" });
		expect(mocks.ensure).toHaveBeenCalledWith(env, expect.objectContaining({ userId: "owner", instanceId: "agent", subjectKind: "connector", hostname: "jobs.example.com" }));
		expect(JSON.stringify(mocks.ensure.mock.calls)).not.toContain("secret=query");
	});
	it("never asks for a strict denial", async () => {
		expect(await auxiliaryWebsiteAccess(env, "owner", "agent", "sign_in", "id", { websiteAccess: { ...access, decision: "deny", mode: "allowlist" } })).toMatchObject({ state: "blocked", error: expect.stringMatching(/denied/) });
		expect(mocks.ensure).not.toHaveBeenCalled();
	});
	it.each([{ rememberedDomains: ["jobs.example.com"] }, { deniedDomains: ["jobs.example.com"] }, { mode: "allow_all" }])("does not reopen an owner question for a cached old refusal after a decision: %j", async (patch) => {
		mocks.policy.mockResolvedValue({ mode: "ask_once", domains: [], ...patch });
		expect(await auxiliaryWebsiteAccess(env, "owner", "agent", "reconciliation", "id", { websiteAccess: access })).toMatchObject({ state: "blocked" });
		expect(mocks.ensure).not.toHaveBeenCalled();
	});
	it("does nothing for an ordinary successful auxiliary receipt", async () => {
		expect(await auxiliaryWebsiteAccess(env, "owner", "agent", "preflight", "id", { state: "live" })).toBeNull();
		expect(mocks.ensure).not.toHaveBeenCalled();
	});
});
