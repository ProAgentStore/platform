import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpRuntime } from "../mcp-runtime.js";
import { ApplyBridge, type ApplyBridgeHost, type ToolResult } from "./bridge.js";
import type { LocalApplyEvent, LocalApplyPause } from "./contract.js";

const ALLOWED = "https://allowed.test/apply";
const REDIRECTED = "https://employer.test/apply";
const FORM = `<h1>Application</h1><button type="button">Next</button>
<label>Full name<input id="name"></label><label>Email<input id="email"></label>
<label>City<select id="city"><option value="">Choose</option><option>Sydney</option></select></label>
<label>Resume<input id="resume" type="file" accept=".txt"></label>`;

describe("application domains are admitted at actual browser dispatch", () => {
	let browser: Browser;
	let context: BrowserContext;
	let page: Page;
	let mcp: McpRuntime;
	let bridge: ApplyBridge;
	let allow: Set<string>;
	let stopped: boolean;
	let host: ApplyBridgeHost;
	let events: Array<Omit<LocalApplyEvent, "at">>;
	let pauses: LocalApplyPause[];
	let dir: string;
	let artifact: string;
	beforeAll(async () => {
		browser = await chromium.launch({ headless: true });
		dir = mkdtempSync(join(tmpdir(), "pags-domain-dispatch-"));
		artifact = join(dir, "resume.txt");
		writeFileSync(artifact, "Synthetic approved resume.");
	}, 60_000);
	beforeEach(async () => {
		context = await browser.newContext();
		await context.route("https://**/*", (route) => route.fulfill({ contentType: "text/html", body: FORM }));
		page = await context.newPage();
		mcp = new McpRuntime();
		await mcp.start({ context, activePage: () => page });
		allow = new Set(["allowed.test"]);
		stopped = false;
		events = [];
		pauses = [];
		host = {
			emit: (event) => events.push(event),
			pause: async (pause) => { pauses.push(pause); return "stopped"; },
			supervisorCheckpoint: vi.fn(async () => "continue" as const),
			isAllowed: (domain) => allow.has(domain),
			grounding: () => "Name: Jane Citizen\nEmail: jane@example.test\nCity: Sydney",
			artifactPath: () => ({ path: artifact, sha256: "a".repeat(64) }),
			overTime: () => false,
			isStopped: () => stopped,
			now: Date.now,
			limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 },
			mode: "fill_and_review",
		};
		bridge = new ApplyBridge(mcp, host);
		mcp.setCallPolicy({ isCancelled: () => stopped, isDomainAllowed: host.isAllowed, requestDomainApproval: (url) => bridge.admitDomain(url) });
		await bridge.callTool("browser_navigate", { url: ALLOWED });
		await bridge.callTool("browser_snapshot");
		await checkpoint();
	});
	afterEach(async () => { await mcp.stop(); await context.close(); }, 60_000);
	afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);
	const checkpoint = () => bridge.callTool("supervisor_checkpoint", { checkpointId: "fixture-checkpoint", phase: "post_navigation" });
	async function snapshotRef(role: string, name: string): Promise<string> {
		const result = await bridge.callTool("browser_snapshot");
		const snapshot = result.content.map((block) => block.text).join("\n");
		const ref = snapshot.match(new RegExp(`${role} "${name}"[^\\n]*\\[ref=(\\w+)\\]`))?.[1];
		if (!ref) throw new Error(`Missing fixture control ${name}`);
		return ref;
	}
	async function redirectAfterCheckpoint() {
		await bridge.callTool("browser_click", { target: await snapshotRef("button", "Next") });
		await checkpoint();
		await page.evaluate((url) => { setTimeout(() => { location.href = url; }, 0); }, REDIRECTED);
		await page.waitForURL(REDIRECTED);
		await bridge.callTool("browser_snapshot");
		// Reproduce the live case: even a continue directive that observes the employer's domain
		// does not admit that domain. Only the owner's per-run allowlist can do so.
		expect((await checkpoint()).isError).not.toBe(true);
	}
	async function untouched() {
		expect(await page.locator("#name").inputValue()).toBe("");
		expect(await page.locator("#city").inputValue()).toBe("");
		expect(await page.locator("#resume").evaluate((input) => (input as HTMLInputElement).files?.length)).toBe(0);
		expect(bridge.filled).toBe(0);
		expect(bridge.uploaded.size).toBe(0);
		expect(events.some((event) => event.type === "field.filled" || event.type === "artifact.uploaded")).toBe(false);
	}

	it.each(["type", "select", "upload"])("a delayed external redirect prevents %s until owner admission", async (action) => {
		await redirectAfterCheckpoint();
		let result: ToolResult;
		if (action === "type") result = await bridge.callTool("browser_type", { target: await snapshotRef("textbox", "Full name"), text: "Jane Citizen", source_quote: "Name: Jane Citizen" });
		else if (action === "select") result = await bridge.callTool("browser_select_option", { target: await snapshotRef("combobox", "City"), values: ["Sydney"], source_quote: "City: Sydney" });
		else {
			// A human can open the chooser; that does not admit the destination for agent uploads.
			const chooser = page.waitForEvent("filechooser");
			await page.locator("#resume").click();
			await chooser;
			result = await bridge.callTool("upload_artifact", { kind: "resume" });
		}
		expect(result.isError).toBe(true);
		expect(pauses).toEqual([expect.objectContaining({ reason: "external_redirect", domain: "employer.test", url: REDIRECTED })]);
		await untouched();
	});

	it("owner approval survives within the run, but the paused action needs a fresh checkpoint before retry", async () => {
		await redirectAfterCheckpoint();
		host.pause = async (pause) => { pauses.push(pause); allow.add("employer.test"); return "resumed"; };
		const args = { target: await snapshotRef("textbox", "Full name"), text: "Jane Citizen", source_quote: "Name: Jane Citizen" };
		expect((await bridge.callTool("browser_type", args)).isError).toBe(true);
		await untouched();
		expect((await bridge.callTool("browser_type", args)).content[0].text).toContain("supervisor_checkpoint");
		await checkpoint();
		expect((await bridge.callTool("browser_type", args)).isError).not.toBe(true);
		expect(await page.locator("#name").inputValue()).toBe("Jane Citizen");
		expect((await bridge.callTool("browser_type", { target: await snapshotRef("textbox", "Email"), text: "jane@example.test", source_quote: "Email: jane@example.test" })).isError).not.toBe(true);
		expect(pauses).toHaveLength(1);
	});

	it("rechecks the fresh destination if the page redirects again while domain approval is pending", async () => {
		await redirectAfterCheckpoint();
		host.pause = async (pause) => { pauses.push(pause); allow.add("employer.test"); await page.goto("https://another.test/apply"); return "resumed"; };
		const result = await bridge.callTool("browser_type", { target: await snapshotRef("textbox", "Full name"), text: "Jane Citizen", source_quote: "Name: Jane Citizen" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("has not been approved");
		await untouched();
	});
});
