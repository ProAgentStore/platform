import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryToolCtx } from "./types.js";

const calls = vi.hoisted(() => ({ callRunner: vi.fn(), ensureWebsite: vi.fn() }));
vi.mock("../website-access.js", () => ({ ensureWebsiteAccessRequest: calls.ensureWebsite, getWebsiteAccessRequest: vi.fn(), listRememberedWebsiteDomains: vi.fn() }));
vi.mock("../runner-client.js", () => ({
	callRunner: calls.callRunner,
	getBoundRunnerConn: async () => ({ kind: "relay", instanceId: "instance" }),
	READ_TIMEOUT_MS: 5000,
}));
import { BROWSER_TOOLS } from "./browser.js";

function context(readOnly: boolean): RegistryToolCtx {
	return {
		userId: "owner", instanceId: "instance",
		env: { BROWSER_TOOLS_ENABLED: "1", DB: { prepare: () => ({ bind: (...ids: unknown[]) => {
			expect(ids).toEqual(["instance", "owner"]);
			return { first: async () => ({ config: JSON.stringify({ browserTask: { readOnly } }) }) };
		} }) } },
	} as unknown as RegistryToolCtx;
}
beforeEach(() => {
	calls.callRunner.mockReset();
	calls.ensureWebsite.mockReset().mockResolvedValue({ questionUrl: "/console/instances/instance/website-requests/opaque-question" });
	calls.callRunner.mockImplementation(async (_conn, path) => path === "/browser/snapshot"
		? { commitGuard: { dispatchSafe: true } }
		: { ok: true, url: "https://example.test/", title: "Test", challenge: null });
});

describe("chat browser website permission", () => {
	const block = { decision: "ask", mode: "ask_once", hostname: "new.example.com", url: "https://new.example.com/", actionDispatched: false };
	it.each(["browser_navigate", "browser_act", "browser_snapshot"])("%s returns a durable question and never claims success", async (name) => {
		calls.callRunner.mockImplementation(async (_conn, path) => path === "/browser/snapshot" && name !== "browser_snapshot"
			? { commitGuard: { dispatchSafe: true } }
			: { ok: false, url: "about:blank", websiteAccess: block });
		const result = await BROWSER_TOOLS.find((tool) => tool.name === name)!.handler(context(false), { action: "navigate", url: block.url, browserWebsiteAccess: { mode: "allow_all" } });
		expect(result).toMatchObject({ success: false, content: expect.stringContaining("/website-requests/opaque-question") });
		expect(calls.ensureWebsite).toHaveBeenCalledOnce();
		expect(calls.ensureWebsite.mock.calls[0][1]).toMatchObject({ userId: "owner", instanceId: "instance", hostname: "new.example.com", subjectKind: "connector" });
		expect(calls.callRunner.mock.calls.at(-1)?.[2]).not.toHaveProperty("browserWebsiteAccess");
	});
	it("strict allowlist denial never creates an approval request", async () => {
		calls.callRunner.mockImplementation(async (_conn, path) => path === "/browser/snapshot"
			? { commitGuard: { dispatchSafe: true } }
			: { ok: false, websiteAccess: { ...block, decision: "deny", mode: "allowlist" } });
		const result = await BROWSER_TOOLS.find((tool) => tool.name === "browser_navigate")!.handler(context(false), { url: block.url });
		expect(result).toMatchObject({ success: false, content: expect.stringContaining("denied") });
		expect(calls.ensureWebsite).not.toHaveBeenCalled();
	});
	it("an unsuccessful navigation without a permission receipt never says Navigated to", async () => {
		calls.callRunner.mockImplementation(async (_conn, path) => path === "/browser/snapshot" ? { commitGuard: { dispatchSafe: true } } : { ok: false });
		const result = await BROWSER_TOOLS.find((tool) => tool.name === "browser_navigate")!.handler(context(false), { url: block.url });
		expect(result).toMatchObject({ success: false });
		expect(result).not.toHaveProperty("head");
	});
});

describe("chat browser dispatch keeps the agent's declared policy", () => {
	it.each(["browser_navigate", "browser_act"])("%s forwards read-only policy even if model input asks to clear it", async (name) => {
		const tool = BROWSER_TOOLS.find((entry) => entry.name === name)!;
		await tool.handler(context(true), { action: "click", ref: "e1", url: "https://example.test/", guard: null, readOnly: false });
		expect(calls.callRunner.mock.calls.map((call) => call[1])).toEqual(["/browser/snapshot", "/browser/act"]);
		expect(calls.callRunner.mock.calls[1][2]).toMatchObject({ guard: { mode: "read_only" } });
	});
	it("does not dispatch an action to a runner without the new enforcement receipt", async () => {
		calls.callRunner.mockResolvedValue({ commitGuard: { supported: true } });
		await expect(BROWSER_TOOLS.find((tool) => tool.name === "browser_act")!.handler(context(false), { action: "click", ref: "e1" })).rejects.toThrow(/0.4.200/);
		expect(calls.callRunner).toHaveBeenCalledTimes(1);
	});
	it("does not act when the workflow browser refuses the read because it is leased", async () => {
		calls.callRunner.mockRejectedValue(new Error("browser is held by another task"));
		await expect(BROWSER_TOOLS.find((tool) => tool.name === "browser_act")!.handler(context(false), { action: "click", ref: "e1" })).rejects.toThrow(/held/);
		expect(calls.callRunner).toHaveBeenCalledTimes(1);
	});
});
