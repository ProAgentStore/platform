/** #1511: the acting MCP client receives fresh image blocks under the same policy as replay. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { BrowserTools } from "../local-browser/bridge.js";
import { createBridgeServer } from "../local-browser/bridge-stdio.js";
import { MASK_CSS, MAX_SHOT_BASE64, type MaskablePage, ShotRecorder } from "../local-browser/replay.js";
import { ApplyBridge, type ApplyBridgeHost } from "./bridge.js";
import type { LocalApplyEvent } from "./contract.js";

function fixture(options: { enabled?: boolean; blur?: boolean; pageAvailable?: boolean } = {}) {
	let url = "https://forms.example.test/application?private=query";
	let stopped = false;
	let pixels = Buffer.from("fresh viewport one");
	const screenshot = vi.fn(async (_options: Parameters<MaskablePage["screenshot"]>[0]) => pixels);
	const page: MaskablePage = { url: () => url, locator: () => ({}) as never, screenshot };
	const events: Array<Omit<LocalApplyEvent, "at">> = [];
	const browser: BrowserTools = {
		// The raw upstream screenshot has unsafe arguments: it must never be exposed or called.
		listTools: async () => [{ name: "browser_take_screenshot", inputSchema: { type: "object", properties: { filename: { type: "string" } } } }],
		callTool: vi.fn(async () => ({ content: [{ type: "text", text: "unused" }] })),
	};
	const host: ApplyBridgeHost = {
		emit: (e) => { events.push(e); }, pause: async () => "stopped", supervisorCheckpoint: async () => "continue",
		isAllowed: (hostname) => hostname === "forms.example.test", grounding: () => "", artifactPath: () => ({ error: "none" }),
		overTime: () => false, isStopped: () => stopped, now: () => 1000,
		limits: { maxMinutes: 10, maxActions: 20, maxPages: 5 }, mode: "fill_and_review",
		page: () => options.pageAvailable === false ? null : page,
	};
	const shots = new ShotRecorder(options.enabled === false ? 0 : 10, () => 1000, options.blur);
	const bridge = new ApplyBridge(browser, host, shots);
	return { bridge, shots, browser, events, screenshot, setUrl: (next: string) => { url = next; }, stop: () => { stopped = true; }, setPixels: (next: Buffer) => { pixels = next; } };
}

async function clientFor(bridge: ApplyBridge) {
	const server = createBridgeServer({ url: "http://127.0.0.1:1", runId: "vision-run", token: "test" }, async (_endpoint, body) => {
		const result = body.op === "list" ? { tools: await bridge.listTools() } : await bridge.callTool(String(body.name), body.args as Record<string, unknown>);
		return JSON.parse(JSON.stringify(result)); // The runner's HTTP JSON boundary.
	});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "acting-model-test", version: "1" });
	await client.connect(clientTransport);
	return { client, close: async () => { await client.close(); await server.close(); } };
}

describe("application model screenshot input", () => {
	it.each([true, false])("passes fresh image pixels through the MCP server, preserving blur=%s", async (blur) => {
		const f = fixture({ blur });
		const connection = await clientFor(f.bridge);
		try {
			const listed = (await connection.client.listTools()).tools.filter((t) => t.name === "browser_take_screenshot");
			expect(listed).toHaveLength(1);
			expect(listed[0].inputSchema).toMatchObject({ properties: {}, additionalProperties: false });
			const first = await connection.client.callTool({ name: "browser_take_screenshot", arguments: {} });
			expect(first).toMatchObject({ content: [
				{ type: "text", text: expect.stringContaining(`"formFieldsBlurred":${blur}`) },
				{ type: "image", data: Buffer.from("fresh viewport one").toString("base64"), mimeType: "image/jpeg" },
			] });
			f.setPixels(Buffer.from("fresh viewport two"));
			const second = await connection.client.callTool({ name: "browser_take_screenshot", arguments: {} });
			expect(second).toMatchObject({ content: [
				{ text: expect.stringContaining('"seq":2') },
				{ type: "image", data: Buffer.from("fresh viewport two").toString("base64") },
			] });
			expect(f.screenshot).toHaveBeenCalledTimes(2);
			const captureOptions = f.screenshot.mock.calls[0][0] as unknown as Record<string, unknown>;
			if (blur) expect(captureOptions).toMatchObject({ style: MASK_CSS, mask: [{}] });
			else { expect(captureOptions).not.toHaveProperty("style"); expect(captureOptions).not.toHaveProperty("mask"); }
			expect(f.browser.callTool).not.toHaveBeenCalled();
			expect(f.shots.shots).toHaveLength(2);
			expect(JSON.stringify(first)).not.toContain("private=query");
			expect(JSON.stringify(f.events)).not.toContain(Buffer.from("fresh viewport one").toString("base64"));
			expect(f.events.filter((e) => e.type === "screenshot.captured").map((e) => e.detail?.shot)).toEqual([1, 2]);
		} finally { await connection.close(); }
	});

	it("omits screenshot capability when the owner disables it and refuses a guessed call", async () => {
		const f = fixture({ enabled: false });
		expect((await f.bridge.listTools()).map((t) => t.name)).not.toContain("browser_take_screenshot");
		expect(await f.bridge.callTool("browser_take_screenshot")).toMatchObject({ isError: true });
		expect(f.screenshot).not.toHaveBeenCalled();
	});

	it.each(["missing page", "capture failed", "oversized image", "website denied", "stopped", "changed during capture", "stopped during capture"])("returns no image for %s", async (failure) => {
		const f = fixture({ pageAvailable: failure !== "missing page" });
		if (failure === "capture failed") f.screenshot.mockRejectedValueOnce(new Error("failed"));
		if (failure === "oversized image") f.setPixels(Buffer.alloc(MAX_SHOT_BASE64));
		if (failure === "website denied") f.setUrl("https://unapproved.example.test/application");
		if (failure === "stopped") f.stop();
		if (failure === "changed during capture") f.screenshot.mockImplementationOnce(async () => { f.setUrl("https://unapproved.example.test/new-page"); return Buffer.from("wrong page"); });
		if (failure === "stopped during capture") f.screenshot.mockImplementationOnce(async () => { f.stop(); return Buffer.from("stopped capture"); });
		const result = await f.bridge.callTool("browser_take_screenshot");
		expect(result.isError).toBe(true);
		expect(result.content.every((c) => c.type === "text")).toBe(true);
		if (["missing page", "stopped"].includes(failure)) expect(f.screenshot).not.toHaveBeenCalled();
		if (failure.endsWith("during capture")) {
			expect(f.shots.shots).toEqual([]);
			expect(f.events.filter((e) => e.type === "screenshot.captured")).toEqual([]);
			expect(f.events).toContainEqual(expect.objectContaining({ type: "policy.decision", detail: expect.objectContaining({ reason: "capture_invalidated" }) }));
		}
		expect(f.bridge.submitAttempted).toBe(false);
	});
});
