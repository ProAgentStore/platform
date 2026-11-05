import { describe, expect, it, vi } from "vitest";
import { ApplyBridge, type ApplyBridgeHost } from "./bridge.js";
import { ShotRecorder, type MaskablePage } from "../local-browser/replay.js";
import type { BrowserTools } from "../local-browser/bridge.js";

function fixture({ enabled = true, blurred = true } = {}) {
	let stopped = false;
	const screenshot = vi.fn<MaskablePage["screenshot"]>(async () => Buffer.from("fresh current-page pixels"));
	let page: MaskablePage = { url: () => "https://forms.example.test/current", screenshot, locator: vi.fn(() => ({}) as never) };
	const native = [{ name: "browser_take_screenshot", inputSchema: { type: "object", properties: { fullPage: { type: "boolean" } } } }, { name: "browser_snapshot", inputSchema: { type: "object" } }];
	const callTool = vi.fn<BrowserTools["callTool"]>(async () => ({ isError: true, content: [{ type: "text", text: "Native transport request deadline; effects unknown" }] }));
	const recoverBrowser = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Original request pending; native channel remains quarantined." }] }));
	const host: ApplyBridgeHost = { runId: "exact-run", emit: vi.fn(), page: () => page, isStopped: () => stopped, pause: async () => "resumed", supervisorCheckpoint: async () => "continue", isAllowed: () => true, grounding: () => "", artifactPath: () => ({ error: "none" }), overTime: () => false, now: Date.now, limits: { maxActions: 20, maxPages: 3, maxMinutes: 5 }, mode: "fill_and_review", toolAccess: "full", recoverBrowser };
	const shots = enabled ? new ShotRecorder(20, Date.now, blurred) : undefined;
	const bridge = new ApplyBridge({ listTools: async () => native, callTool }, host, shots);
	return { bridge, host, native, callTool, screenshot, recoverBrowser, stop: () => { stopped = true; }, replacePage: () => { page = { ...page }; } };
}

describe("independent full-mode browser observation and reconciliation", () => {
	it.each([true, false])("returns direct fresh image content after native failure with privacy=%s and exact run/page identity", async (blurred) => {
		const f = fixture({ blurred });
		const listed = await f.bridge.listTools();
		for (const tool of f.native) expect(listed.find((entry) => entry.name === tool.name)).toEqual(tool);
		expect(listed.map((tool) => tool.name)).toContain("browser_read_screenshot");
		await f.bridge.callTool("browser_snapshot");
		const result = await f.bridge.callTool("browser_read_screenshot");
		expect(result.isError).not.toBe(true);
		expect(result.content[1]).toEqual({ type: "image", data: Buffer.from("fresh current-page pixels").toString("base64"), mimeType: "image/jpeg" });
		expect(result.content[0].text).toContain('"runId":"exact-run"');
		expect(result.content[0].text).toContain('"pageId":1');
		expect(result.content[0].text).toContain(`"formFieldsBlurred":${blurred}`);
		expect(f.screenshot.mock.calls.at(-1)?.[0]).toMatchObject(blurred ? { style: expect.any(String), mask: expect.any(Array) } : { type: "jpeg" });
		if (!blurred) expect(f.screenshot.mock.calls.at(-1)?.[0]).not.toHaveProperty("style");
		expect(f.callTool).toHaveBeenCalledTimes(1);
		expect(f.bridge.screenshotsDelivered).toBe(1); expect(f.bridge.screenshotRequests).toBe(1); expect(f.bridge.independentScreenshotAvailable).toBe(true);
		expect(f.host.emit).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ class: "vision", tool: "browser_read_screenshot", decision: "image_delivered", count: 1 }) }));
		await f.bridge.callTool("browser_recover");
		expect(f.recoverBrowser).toHaveBeenCalledOnce();
		expect(f.callTool).toHaveBeenCalledTimes(1);
	});
	it("keeps native screenshot available but disables independent screenshot when policy is off", async () => {
		const f = fixture({ enabled: false });
		expect((await f.bridge.listTools()).map((tool) => tool.name)).not.toContain("browser_read_screenshot");
		expect((await f.bridge.callTool("browser_read_screenshot")).isError).toBe(true);
		expect(f.screenshot).not.toHaveBeenCalled();
	});
	it.each(["stopped", "page_changed"])("returns no image if %s during direct capture", async (change) => {
		const f = fixture();
		f.screenshot.mockImplementation(async () => { if (change === "stopped") f.stop(); else f.replacePage(); return Buffer.from("must not be delivered"); });
		const result = await f.bridge.callTool("browser_read_screenshot");
		expect(result.isError).toBe(true); expect(result.content.some((block) => block.type === "image")).toBe(false);
		expect(f.bridge.screenshotsDelivered).toBe(0); expect(f.bridge.screenshotRequests).toBe(1); expect(f.callTool).not.toHaveBeenCalled();
	});
	it.each(["time", "actions"])("bounds screenshot resources after %s limit but permits read-only recovery status", async (limit) => {
		const f = fixture();
		if (limit === "time") f.host.overTime = () => true; else f.host.limits.maxActions = 0;
		expect((await f.bridge.callTool("browser_read_screenshot")).isError).toBe(true);
		expect(f.screenshot).not.toHaveBeenCalled();
		await f.bridge.callTool("browser_recover"); expect(f.recoverBrowser).toHaveBeenCalledOnce(); expect(f.screenshot).not.toHaveBeenCalled();
	});
	it("reports unavailable pixels without a delivery claim when direct capture fails", async () => {
		const f = fixture(); f.screenshot.mockRejectedValue(new Error("closed page"));
		const result = await f.bridge.callTool("browser_read_screenshot");
		expect(result.isError).toBe(true); expect(result.content).toHaveLength(1);
		expect(f.bridge.screenshotsDelivered).toBe(0);
	});

	it("counts delayed original image pixels returned by recovery without claiming a new screenshot request", async () => {
		const f = fixture();
		f.host.recoverBrowser = async () => ({ content: [{ type: "text", text: "Original response settled." }, { type: "image", data: "RETURNED_PIXELS", mimeType: "image/png" }] });
		const result = await f.bridge.callTool("browser_recover");
		expect(result.content[1]).toMatchObject({ type: "image", data: "RETURNED_PIXELS" });
		expect(f.bridge.screenshotsDelivered).toBe(1); expect(f.bridge.screenshotRequests).toBe(0);
		expect(f.screenshot).not.toHaveBeenCalled(); expect(f.callTool).not.toHaveBeenCalled();
	});

	it("does not capture or reconcile after Stop", async () => {
		const f = fixture(); f.stop();
		expect((await f.bridge.callTool("browser_read_screenshot")).isError).toBe(true);
		expect((await f.bridge.callTool("browser_recover")).isError).toBe(true);
		expect(f.screenshot).not.toHaveBeenCalled(); expect(f.recoverBrowser).not.toHaveBeenCalled();
	});
});
