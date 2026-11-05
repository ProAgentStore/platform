import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserCallRecorder } from "./browser-call-recorder.js";
import { BrowserToolRecovery } from "./browser-tool-recovery.js";
import { McpRuntime, type McpToolResult } from "./mcp-runtime.js";

describe("runtime recovery retains native upload evidence and ownership (#1537, #1473)", () => {
	let browser: Browser, context: BrowserContext, page: Page, mcp: McpRuntime, dir: string, path: string;
	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pags-recovery-")); path = join(dir, "document.txt"); writeFileSync(path, "synthetic approved document");
		browser = await chromium.launch({ headless: true });
	});
	beforeEach(async () => {
		context = await browser.newContext(); page = await context.newPage();
		mcp = new McpRuntime(new BrowserCallRecorder(), new BrowserToolRecovery<McpToolResult>(1500, 10_000));
		await mcp.start({ context, activePage: () => page });
		mcp.setSubject({ kind: "local_apply_run", id: "original" });
		await page.setContent('<input type="file" onchange="window.selections=(window.selections||0)+1;this.value=\'\';this.setCustomValidity(\'Document rejected\')">');
		expect((await mcp.callTool("browser_snapshot")).isError).not.toBe(true);
		const chooser = page.waitForEvent("filechooser"); await page.locator("input").click(); await chooser;
	});
	afterEach(async () => { vi.restoreAllMocks(); await mcp.stop(); await context.close(); });
	afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); });

	async function delayedUpload() {
		const native = Client.prototype.callTool;
		let release!: () => void;
		const delayed = new Promise<void>(resolve => { release = resolve; });
		const spy = vi.spyOn(Client.prototype, "callTool").mockImplementation(async function (...args) {
			const response = await native.apply(this, args);
			if (args[0].name === "browser_file_upload") await delayed;
			return response;
		});
		const result = await mcp.callTool("browser_file_upload", { paths: [path] });
		expect(result.toolDiagnostic).toMatchObject({ kind: "request_deadline", execution: "pending" });
		expect(spy.mock.calls.find(call => call[0].name === "browser_file_upload")?.[2]).toMatchObject({ timeout: 10_000 });
		return { release, spy };
	}
	it("recovers selection after the input was cleared, retains site validity, and never uploads twice", async () => {
		const { release, spy } = await delayedUpload();
		expect(mcp.pendingUploadId()).toBeNull();
		expect((await page.screenshot()).length).toBeGreaterThan(100);
		const callsBefore = spy.mock.calls.length;
		expect((await mcp.callTool("browser_evaluate", { function: "() => 1" })).toolDiagnostic?.kind).toBe("quarantined");
		expect(spy.mock.calls.length).toBe(callsBefore);
		expect((await mcp.recover()).isError).toBe(true);
		release(); await vi.waitFor(() => expect(mcp.recoveryStatus()?.canResume).toBe(true));
		const recovered = await mcp.recover();
		expect(recovered.uploadSelection).toMatchObject({ evidence: "input_event", inputRetainsSelection: false, customError: true, validationMessage: "Document rejected", websiteAcceptance: "unconfirmed" });
		expect(mcp.recoveryStatus()).toBeNull();
		expect((await mcp.callTool("browser_file_upload", { paths: [path] })).isError).toBe(true);
		expect(await page.evaluate(() => (window as unknown as { selections: number }).selections)).toBe(1);
		expect(mcp.pullCalls({ kind: "local_apply_run", id: "original" }, 0).calls.some(call => call.toolDiagnostic?.kind === "request_deadline")).toBe(true);
	});
	it.each(["subject", "page", "stop"])("does not release an old operation after %s changes", async change => {
		const { release } = await delayedUpload();
		if (change === "subject") mcp.setSubject({ kind: "local_apply_run", id: "new" });
		if (change === "page") page = await context.newPage();
		if (change === "stop") mcp.setCallPolicy({ isCancelled: () => true });
		release(); await vi.waitFor(() => expect(mcp.recoveryStatus()?.canResume).toBe(true));
		expect((await mcp.recover()).isError).toBe(true);
		expect((await mcp.callTool("browser_snapshot")).toolDiagnostic?.kind).toBe("quarantined");
		await expect(mcp.configureToolAccess("guarded", dir)).rejects.toThrow("uncertain");
	});
	it("does not assign a timely old response to a newly claimed subject", async () => {
		const native = Client.prototype.callTool;
		vi.spyOn(Client.prototype, "callTool").mockImplementation(async function (...args) {
			const response = await native.apply(this, args);
			if (args[0].name === "browser_file_upload") mcp.setSubject({ kind: "local_apply_run", id: "replacement" });
			return response;
		});
		const result = await mcp.callTool("browser_file_upload", { paths: [path] });
		expect(result.toolDiagnostic, JSON.stringify(result)).toMatchObject({ execution: "settled", recoverable: false });
		expect(result.uploadSelection).toBeUndefined();
		expect(mcp.pullCalls({ kind: "local_apply_run", id: "replacement" }, 0).calls).toHaveLength(0);
		expect(mcp.pullCalls({ kind: "local_apply_run", id: "original" }, 0).calls.at(-1)?.browserState).toBeUndefined();
	});
	it("withholds delayed content when the current URL no longer passes admission", async () => {
		const { release } = await delayedUpload();
		await page.route("https://denied.test/**", route => route.fulfill({ body: "private denied page" }));
		await page.goto("https://denied.test/");
		mcp.setCallPolicy({ websiteAccess: () => ({ mode: "allowlist", domains: ["allowed.test"] }) });
		release(); await vi.waitFor(() => expect(mcp.recoveryStatus()?.canResume).toBe(true));
		const result = await mcp.recover();
		expect(result.isError).toBe(true);
		expect(result.websiteAccess).toBeDefined();
		expect(mcp.textOf(result)).toContain("content is withheld");
		expect(mcp.textOf(result)).not.toContain("### Snapshot");
	});
});
