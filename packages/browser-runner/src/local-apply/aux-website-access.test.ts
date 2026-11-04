import type { Page, Route } from "playwright";
import { describe, expect, it, vi } from "vitest";
import type { BrowserWebsiteAccess } from "../browser-website-access.js";
import type { RunBrowser } from "./runtime.js";
import { LocalApplySignInRuntime } from "./sign-in-runtime.js";
import { LocalApplyReconciliationRuntime } from "./reconciliation-runtime.js";

const URL = "https://jobs.example.com/apply";
const OTHER = "https://auth.example.com/login?secret=not-shared";
const signIn = { signInId: "sign-1", browserProfile: "isolated", url: URL };
const reconciliation = { type: "local_browser.apply.reconciliation", reconciliationId: "rec-1", runId: "r1", applicationId: "a1", instanceId: "i1", browserProfile: "isolated", applicationUrl: URL, allowDomains: ["jobs.example.com"], jobIdentity: "job1", materialFingerprint: {} };
function harness(redirect?: string) {
	let current = "about:blank";
	let intercept: ((route: Route) => Promise<void>) | undefined;
	const visits: string[] = [];
	const completeSignIn = vi.fn(async () => ({ fingerprint: 1, verifiable: true }));
	const setCallPolicy = vi.fn();
	const evaluate = vi.fn(async () => ({ url: current, login: true, captcha: false }));
	const stop = vi.fn(async () => undefined);
	const navigate = async (url: string) => {
		let aborted = false;
		const route = {
			request: () => ({ isNavigationRequest: () => true, url: () => url, frame: () => ({ page: () => page }) }),
			fallback: async () => { current = url; visits.push(url); },
			abort: async () => { aborted = true; },
		} as unknown as Route;
		if (intercept) await intercept(route); else await route.fallback();
		if (aborted) throw new Error("blockedbyclient");
	};
	const page = { isClosed: () => false, url: () => current, context: () => ({ route: async (_: string, fn: typeof intercept) => { intercept = fn; }, unroute: async () => { intercept = undefined; } }), goto: async (url: string) => { await navigate(url); if (redirect) await navigate(redirect); }, evaluate } as unknown as Page;
	const browserFor = vi.fn(async () => ({ tools: { setCallPolicy }, handoffPage: () => page, sessions: { beginSignIn: async () => undefined, completeSignIn }, stop }) as unknown as RunBrowser);
	const takeover = { open: vi.fn(async () => undefined), state: vi.fn(async () => "ready" as const), frame: vi.fn(async () => ({ frame: "pixels", width: 1, height: 1 })), input: vi.fn(async () => undefined), end: vi.fn(async () => undefined) };
	const deps = { dataDir: "/tmp", browserFor, takeover, schedule: () => () => undefined };
	return { visits, evaluate, setCallPolicy, completeSignIn, browserFor, takeover, stop, changeUrl: (url: string) => { current = url; }, sign: new LocalApplySignInRuntime({ ...deps, busy: () => false }), recon: new LocalApplyReconciliationRuntime(deps) };
}

describe("auxiliary browsers enforce owner website permissions (#1480)", () => {
	it.each<BrowserWebsiteAccess>([
		{ mode: "allow_all", domains: [] },
		{ mode: "allowlist", domains: ["jobs.example.com"] },
		{ mode: "ask_once", domains: [], rememberedDomains: ["jobs.example.com"] },
	])("permits the configured initial host in $mode while retaining read-only MCP policy", async (policy) => {
		const h = harness();
		expect(await h.sign.open(signIn, policy)).toMatchObject({ state: "ready" });
		expect(h.visits).toEqual([URL]);
		expect(h.setCallPolicy.mock.calls[0][0].guard).toEqual({ mode: "read_only" });
		expect(h.setCallPolicy.mock.calls[0][0].websiteAccess()).toEqual(policy);
		const r = harness();
		expect(await r.recon.start(reconciliation, policy)).toMatchObject({ state: "paused", pauseReason: "login_required" });
		expect(r.visits).toEqual([URL]);
		expect(r.setCallPolicy.mock.calls[0][0].guard).toEqual({ mode: "read_only" });
	});
	it.each([
		{ mode: "allowlist" as const, decision: "deny" },
		{ mode: "ask_once" as const, decision: "ask" },
	])("refuses an unknown initial host in $mode before opening any browser", async ({ mode, decision }) => {
		const h = harness();
		const policy = { mode, domains: [] };
		expect(await h.sign.open({ ...signIn, browserWebsiteAccess: { mode: "allow_all", domains: [] } }, policy)).toMatchObject({ state: "closed", websiteAccess: { decision, actionDispatched: false } });
		expect(await h.recon.start(reconciliation, policy)).toMatchObject({ state: "ended", websiteAccess: { decision, actionDispatched: false }, result: { state: "unavailable" } });
		expect(h.browserFor).not.toHaveBeenCalled();
		expect(h.completeSignIn).not.toHaveBeenCalled();
	});
	it.each(["allowlist", "ask_once"] as const)("blocks a redirect before its document is visited or read in %s", async (mode) => {
		const policy = { mode, domains: ["jobs.example.com"] };
		for (const kind of ["sign", "recon"] as const) {
			const h = harness(OTHER);
			const result = kind === "sign" ? await h.sign.open(signIn, policy) : await h.recon.start(reconciliation, policy);
			expect(result).toMatchObject({ websiteAccess: { hostname: "auth.example.com", url: "https://auth.example.com/login", actionDispatched: true } });
			expect(result).not.toHaveProperty("signedIn");
			expect(h.visits).toEqual([URL]);
			expect(h.evaluate).not.toHaveBeenCalled();
			expect(h.takeover.open).not.toHaveBeenCalled();
			expect(h.stop).toHaveBeenCalledOnce();
		}
	});
	it("refuses frame/input/sign-in completion after a page changed to an unknown host", async () => {
		for (const operation of ["frame", "input", "end"] as const) {
			const h = harness();
			await h.sign.open(signIn, { mode: "ask_once", domains: ["jobs.example.com"] });
			h.changeUrl(OTHER);
			expect(await h.sign[operation]({ ...signIn, complete: true, input: { type: "text", text: "secret" } })).toMatchObject({ state: "closed", websiteAccess: { decision: "ask" } });
			expect(h.takeover.frame).not.toHaveBeenCalled();
			expect(h.takeover.input).not.toHaveBeenCalled();
			expect(h.completeSignIn).not.toHaveBeenCalled();
		}
	});
	it("only an explicit read-only reconciliation retry uses a later saved permission", async () => {
		const h = harness(OTHER);
		const policy = { mode: "ask_once" as const, domains: ["jobs.example.com"] };
		expect(await h.recon.start(reconciliation, policy)).toHaveProperty("websiteAccess");
		expect(await h.recon.status({ reconciliationId: "rec-1" })).toHaveProperty("websiteAccess");
		expect(h.browserFor).toHaveBeenCalledTimes(1);
		// The original run/site proof restriction still holds after website navigation is permitted.
		expect(await h.recon.start(reconciliation, { ...policy, rememberedDomains: ["auth.example.com"] })).toMatchObject({ state: "ended", result: { state: "ambiguous" } });
		expect(h.browserFor).toHaveBeenCalledTimes(2);
	});
});
