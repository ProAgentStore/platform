/**
 * Scout research replay (#1063): the bridge takes a frame at its own capture points, the trace records
 * ONLY that a frame exists (`screenshot.captured` — seq and point), and the screenshot tool stays refused
 * to the CLI. The browser is faked; the bridge and recorder are real.
 */
import { describe, expect, it } from "vitest";
import type { LocalBrowserEvent, LocalBrowserLimits } from "./contract.js";
import { type BridgeHost, BrowserBridge, type BrowserTools } from "./bridge.js";
import { MASK_FORM_CONTROLS, ShotRecorder } from "./replay.js";

const IMAGE = "/9j/4AAQSkZJRgABAQ==";
const LIMITS: LocalBrowserLimits = { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 };

function setup() {
	let url = "about:blank";
	const tools: BrowserTools = {
		listTools: async () => ["browser_navigate", "browser_snapshot", "browser_take_screenshot"].map((name) => ({ name, inputSchema: {} })),
		callTool: async (name, args = {}) => {
			if (name === "browser_navigate") url = String(args.url);
			if (name === "browser_evaluate") {
				if (args.function === MASK_FORM_CONTROLS) return { content: [{ type: "text", text: '### Result\n"masked"' }] };
				if (String(args.function).includes("unmasked")) return { content: [{ type: "text", text: '### Result\n"unmasked"' }] };
				return { content: [{ type: "text", text: `### Result\n${JSON.stringify({ url, title: "Jobs", captcha: false, login: false, paywall: false, accessBlocked: false, writeForm: false })}` }] };
			}
			if (name === "browser_take_screenshot") return { content: [{ type: "image", data: IMAGE, mimeType: "image/jpeg" }] };
			if (name === "browser_snapshot") return { content: [{ type: "text", text: '- heading "Senior Engineer at Acme — salary $200k" [ref=e1]' }] };
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	const events: Array<Omit<LocalBrowserEvent, "at">> = [];
	const host: BridgeHost = {
		emit: (e) => events.push(e),
		pause: async () => "stopped",
		isDenied: () => false,
		isPermitted: () => true,
		consentIdFor: () => undefined,
		allowListOnly: () => false,
		overTime: () => false,
		limits: LIMITS,
	};
	const shots = new ShotRecorder(60);
	return { bridge: new BrowserBridge(tools, host, shots), events, shots };
}

describe("Scout replay frames (#1063)", () => {
	it("takes a frame after navigating, reading the page and finishing — each named on the trace by seq and point only", async () => {
		const { bridge, events, shots } = setup();
		await bridge.callTool("browser_navigate", { url: "https://au.seek.com/jobs?keywords=ai" });
		await bridge.callTool("browser_snapshot");
		await bridge.callTool("finish_research", { summary: "done" });
		expect(shots.shots.map((s) => [s.seq, s.point])).toEqual([[1, "navigated"], [2, "snapshot"], [3, "completed"]]);
		const captured = events.filter((e) => e.type === "screenshot.captured");
		expect(captured.map((e) => e.detail)).toEqual([{ shot: 1, point: "navigated" }, { shot: 2, point: "snapshot" }, { shot: 3, point: "completed" }]);
	});

	it("privacy: no trace event carries the image, the page's text or a URL's query", async () => {
		const { bridge, events } = setup();
		await bridge.callTool("browser_navigate", { url: "https://au.seek.com/jobs?keywords=ai" });
		await bridge.callTool("browser_snapshot");
		const trace = JSON.stringify(events);
		expect(trace).not.toContain(IMAGE);
		expect(trace).not.toContain("salary $200k");
		for (const e of events.filter((x) => x.type === "screenshot.captured")) expect(Object.keys(e.detail ?? {}).sort()).toEqual(["point", "shot"]);
	});

	it("the screenshot tool is still never offered to, or callable by, the CLI", async () => {
		const { bridge, shots } = setup();
		expect((await bridge.listTools()).map((t) => t.name)).not.toContain("browser_take_screenshot");
		expect((await bridge.callTool("browser_take_screenshot", {})).isError).toBe(true);
		expect(shots.shots).toEqual([]);
	});

	it("without a recorder the bridge behaves exactly as before — no frames, no events", async () => {
		const events: Array<Omit<LocalBrowserEvent, "at">> = [];
		const { bridge } = setup();
		const plain = new BrowserBridge((bridge as unknown as { browser: BrowserTools }).browser, { ...(bridge as unknown as { host: BridgeHost }).host, emit: (e) => events.push(e) });
		await plain.callTool("browser_navigate", { url: "https://au.seek.com/jobs" });
		expect(events.some((e) => e.type === "screenshot.captured")).toBe(false);
	});
});
