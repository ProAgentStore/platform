/** #1433: the synthetic sign-in run freezes screenshot choices before navigation. */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";

const { callRunner, browserScreenshotSettings, state } = vi.hoisted(() => ({
	callRunner: vi.fn(), browserScreenshotSettings: vi.fn(),
	state: { card: null as Record<string, unknown> | null },
}));
vi.mock("../lib/runner-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/runner-client.js")>()), callRunner }));
vi.mock("../lib/browser-screenshots.js", async (orig) => ({ ...(await orig<typeof import("../lib/browser-screenshots.js")>()), browserScreenshotSettings }));
vi.mock("../lib/coding-store.js", async (orig) => ({ ...(await orig<typeof import("../lib/coding-store.js")>()), getSession: async () => ({ id: "s1" }) }));
vi.mock("./coding-shared.js", async (orig) => ({
	...(await orig<typeof import("./coding-shared.js")>()),
	requireOwned: async () => ({ uid: "owner", instanceId: "agent" }),
	getSessionRunnerConn: async () => ({}),
}));
vi.mock("./instances-runtime.js", async (orig) => ({
	...(await orig<typeof import("./instances-runtime.js")>()),
	mirroredRuntimeTask: async () => state.card,
	mirrorRuntimeTask: async (_env: unknown, _instance: string, _uid: string, card: Record<string, unknown>) => { state.card = card; },
}));
vi.mock("../lib/events.js", () => ({ logEvent: async () => undefined }));

import { registerSessionOpenRoutes } from "./coding-sessions-open.js";

const url = "https://claude.ai/oauth/authorize?code=true&client_id=fixture";
async function signin() {
	const app = new Hono<{ Bindings: Env }>();
	registerSessionOpenRoutes(app);
	return app.request("/agent/coding/sessions/s1/signin", { method: "POST" }, {} as Env);
}
function sent(path: string) { return callRunner.mock.calls.filter((c) => c[1] === path).map((c) => c[2]); }

beforeEach(() => {
	state.card = null;
	browserScreenshotSettings.mockReset().mockResolvedValue({ enabled: true, blurFormFields: false });
	callRunner.mockReset().mockImplementation(async (_conn: unknown, path: string) => path === "/coding/capture" ? { pane: `Browser didn't open? Use the url below to sign in:\n${url}\nPaste code here if prompted >` } : { ok: true });
});

describe("coding sign-in screenshot policy", () => {
	it("freezes the owner's choice once and sends it to both initial navigation and handoff", async () => {
		expect((await signin()).status).toBe(200);
		expect(browserScreenshotSettings).toHaveBeenCalledTimes(1);
		expect(sent("/browser/act")[0]).toEqual({ action: "navigate", url, screenshot: true, blurFormFields: false });
		expect(sent("/browser/handoff")[0]).toMatchObject({ taskId: "signin-s1", screenshot: true, blurFormFields: false });
		expect(state.card?.input).toEqual({ screenshots: true, blurFormFields: false });
	});

	it("keeps the frozen policy and existing input after settings change, identifying navigation as a continuation", async () => {
		state.card = { input: { screenshots: false, blurFormFields: false, marker: "keep" } };
		browserScreenshotSettings.mockResolvedValue({ enabled: true, blurFormFields: true });
		expect((await signin()).status).toBe(200);
		expect(browserScreenshotSettings).not.toHaveBeenCalled();
		for (const path of ["/browser/act", "/browser/handoff"]) expect(sent(path)[0]).toMatchObject({ taskId: "signin-s1", screenshot: false, blurFormFields: false });
		expect(state.card?.input).toEqual({ screenshots: false, blurFormFields: false, marker: "keep" });
	});

	it("retains masking for legacy sign-ins even when new runs request unblurred captures", async () => {
		state.card = { input: {} };
		expect((await signin()).status).toBe(200);
		expect(browserScreenshotSettings).not.toHaveBeenCalled();
		for (const path of ["/browser/act", "/browser/handoff"]) expect(sent(path)[0]).toMatchObject({ taskId: "signin-s1", screenshot: true, blurFormFields: true });
	});
});
