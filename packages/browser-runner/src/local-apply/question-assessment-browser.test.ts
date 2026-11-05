import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { McpRuntime } from "../mcp-runtime.js";
import { ApplyBridge, type ApplyBridgeHost, type ToolResult } from "./bridge.js";

const text = (result: ToolResult) => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
const forms = [
	{ path: "portfolio", body: '<label>Display name<input required value="Owner"></label><label>Public portfolio<input id="optional"></label>' },
	{ path: "project", body: '<fieldset><legend>Project request</legend><label>Delivery<select required><option selected>Digital</option></select></label><label>Reference detail<textarea id="optional"></textarea></label></fieldset>' },
];

describe("model-assessed omission with independent browser forms", () => {
	let browser: Browser, context: BrowserContext, page: Page, runtime: McpRuntime, bridge: ApplyBridge, root: string;
	beforeAll(async () => { browser = await chromium.launch({ headless: true }); root = await mkdtemp(join(tmpdir(), "pags-optional-form-")); });
	beforeEach(async () => {
		context = await browser.newContext(); page = await context.newPage(); runtime = new McpRuntime();
		await context.route("https://omission.test/**", (route) => {
			const form = forms.find((item) => route.request().url().endsWith(item.path)) ?? forms[0];
			return route.fulfill({ contentType: "text/html", body: `<form onsubmit="event.preventDefault();window.sent=(window.sent||0)+1;document.body.innerHTML='<h1>Application received</h1>'">${form.body}<button>Submit application</button></form>` });
		});
		await runtime.start({ context, activePage: () => page, onPageSelected: (selected) => { page = selected; } });
		await runtime.configureToolAccess("full", root); runtime.setCallPolicy({ toolAccess: "full", isDomainAllowed: (domain) => domain === "omission.test" });
		const host: ApplyBridgeHost = { emit: () => {}, pause: async () => "stopped", supervisorCheckpoint: async () => "continue", page: () => page, isAllowed: (domain) => domain === "omission.test", grounding: () => "", artifactPath: () => ({ error: "No test artifact" }), overTime: () => false, now: Date.now, limits: { maxActions: 50, maxPages: 5, maxMinutes: 5 }, mode: "auto_submit", toolAccess: "full", escalationLevel: "autonomous", gateId: "one-fixture-submission" };
		bridge = new ApplyBridge(runtime, host);
	});
	afterEach(async () => { await runtime.stop(); await context.close(); });
	afterAll(async () => { await browser.close(); await rm(root, { recursive: true, force: true }); });
	async function classify(classification: string, omissionVerified: boolean) {
		return bridge.callTool("request_answer", { question: "Which fact belongs in the unknown detail?", assessment: { classification, observationUrl: page.url(), evidence: omissionVerified ? "The current form reports valid while the optional detail remains blank; no material claim is changed." : "Current evidence leaves a required or consequential fact unresolved.", omissionVerified, decision: { risk: "minor", reason: "A blank optional detail asserts no personal fact; unresolved mandatory information remains blocking." } } });
	}
	async function submit() {
		const snapshot = text(await bridge.callTool("browser_snapshot"));
		const ref = snapshot.split("\n").find((line) => line.includes('button "Submit application"'))?.match(/\[ref=([^\]]+)\]/)?.[1];
		expect(ref).toBeTruthy();
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "verified-final", phase: "before_submit" });
		return bridge.callTool("submit_application", { ref });
	}
	it.each(forms)("accepts a verified blank and authorized submission on $path", async ({ path }) => {
		await bridge.callTool("browser_navigate", { url: `https://omission.test/${path}` });
		await bridge.callTool("browser_snapshot");
		expect(await page.locator("#optional").inputValue()).toBe("");
		expect(await page.locator("form").evaluate((form) => (form as HTMLFormElement).checkValidity())).toBe(true);
		expect((await classify("optional", true)).isError).not.toBe(true);
		const result = await submit();
		expect(result.isError, text(result)).not.toBe(true);
		expect(bridge.submitAttempted).toBe(true); expect(bridge.submitted).not.toBeNull();
		expect(await page.evaluate(() => (window as unknown as { sent: number }).sent)).toBe(1);
	});
	it.each(["required", "material", "unknown"])("blocks a %s unknown even when the native form permits submission", async (classification) => {
		await bridge.callTool("browser_navigate", { url: "https://omission.test/project" });
		await classify(classification, false);
		expect((await submit()).isError).toBe(true);
		expect(bridge.submitAttempted).toBe(false);
		expect(await page.evaluate(() => (window as unknown as { sent?: number }).sent ?? 0)).toBe(0);
	});
	it("reinstates a blocker when later form validation requires an earlier optional detail", async () => {
		await bridge.callTool("browser_navigate", { url: "https://omission.test/portfolio" }); await classify("optional", true);
		await page.locator("#optional").evaluate((input) => { (input as HTMLInputElement).required = true; });
		expect(await page.locator("form").evaluate((form) => (form as HTMLFormElement).checkValidity())).toBe(false);
		await bridge.callTool("browser_snapshot"); await classify("required", false);
		expect((await submit()).isError).toBe(true); expect(bridge.submitAttempted).toBe(false);
	});
});
