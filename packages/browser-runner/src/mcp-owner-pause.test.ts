import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserCallRecorder } from "./browser-call-recorder.js";
import { BrowserToolRecovery } from "./browser-tool-recovery.js";
import { McpRuntime, type McpToolResult } from "./mcp-runtime.js";

describe("owner pause fences native dispatch and requires actual settlement", () => {
	let browser: Browser, context: BrowserContext, page: Page, mcp: McpRuntime, recovery: BrowserToolRecovery<McpToolResult>, target: string, dir: string;
	beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), "pags-pause-")); browser = await chromium.launch({ headless: true }); });
	beforeEach(async () => {
		context = await browser.newContext(); page = await context.newPage();
		recovery = new BrowserToolRecovery<McpToolResult>(5000, 10_000);
		mcp = new McpRuntime(new BrowserCallRecorder(), recovery);
		await mcp.start({ context });
		await page.setContent('<button type="button" onclick="document.body.dataset.actions=String(Number(document.body.dataset.actions||0)+1)">Continue</button>');
		const snapshot = mcp.textOf(await mcp.callTool("browser_snapshot"));
		target = snapshot.match(/button "Continue"[^\n]*\[ref=(\w+)\]/)?.[1] ?? "";
		expect(target).not.toBe("");
	});
	afterEach(async () => { vi.restoreAllMocks(); await mcp.stop(); await context.close(); });
	afterAll(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });
	const click = () => mcp.callTool("browser_click", { target, element: "Continue" });
	function gate() {
		let release!: () => void, reached!: () => void;
		return { wait: new Promise<void>(resolve => { release = resolve; }), arrived: new Promise<void>(resolve => { reached = resolve; }), release: () => release(), reached: () => reached() };
	}
	it("checks the pause fence after an awaited guard observation before dispatching its action", async () => {
		const blocked = gate(), native = Client.prototype.callTool, names: string[] = [];
		vi.spyOn(Client.prototype, "callTool").mockImplementation(async function (...args) {
			names.push(args[0].name);
			const result = await native.apply(this, args);
			if (args[0].name === "browser_evaluate") { blocked.reached(); await blocked.wait; }
			return result;
		});
		mcp.setCallPolicy({ guard: { mode: "read_only", labels: "impossible-label" } });
		const pending = click(); await blocked.arrived;
		const suspended = mcp.suspendDispatch();
		blocked.release();
		expect((await pending).isError).toBe(true);
		expect(await suspended).toEqual({ state: "settled" });
		expect(names).toContain("browser_evaluate"); expect(names).not.toContain("browser_click");
		expect(await page.locator("body").getAttribute("data-actions")).toBeNull();
	});
	it("reports pending until an already-dispatched call returns, without replaying or cancelling it", async () => {
		const blocked = gate(), native = Client.prototype.callTool;
		const spy = vi.spyOn(Client.prototype, "callTool").mockImplementation(async function (...args) {
			if (args[0].name === "browser_click") { blocked.reached(); await blocked.wait; }
			return native.apply(this, args);
		});
		const pending = click(); await blocked.arrived;
		expect(await mcp.suspendDispatch()).toEqual({ state: "pending" });
		const before = spy.mock.calls.length;
		expect((await mcp.callTool("browser_snapshot")).isError).toBe(true);
		expect((await mcp.callTool("browser_evaluate", { function: "() => 1" }, { internal: true })).isError).toBe(true);
		expect(spy.mock.calls).toHaveLength(before);
		blocked.release(); await pending;
		expect(await mcp.suspendDispatch()).toEqual({ state: "settled" });
		expect(await page.locator("body").getAttribute("data-actions")).toBe("1");
		expect(spy.mock.calls.filter(call => call[0].name === "browser_click")).toHaveLength(1);
	});
	it("checks again in the final native-operation microtask before invoking the RPC", async () => {
		let suspended: ReturnType<McpRuntime["suspendDispatch"]> | undefined;
		const original = recovery.request.bind(recovery);
		vi.spyOn(recovery, "request").mockImplementation((...args) => {
			suspended = mcp.suspendDispatch();
			return original(...args);
		});
		const native = vi.spyOn(Client.prototype, "callTool");
		expect((await click()).isError).toBe(true);
		expect(await suspended).toEqual({ state: "settled" });
		expect(native.mock.calls.some(call => call[0].name === "browser_click")).toBe(false);
		expect(await page.locator("body").getAttribute("data-actions")).toBeNull();
	});
	it("revalidates run ownership in the final RPC operation", async () => {
		mcp.setSubject({ kind: "local_apply_run", id: "first" });
		const original = recovery.request.bind(recovery);
		vi.spyOn(recovery, "request").mockImplementation((...args) => {
			mcp.setSubject({ kind: "local_apply_run", id: "second" });
			return original(...args);
		});
		const native = vi.spyOn(Client.prototype, "callTool");
		expect((await click()).isError).toBe(true);
		expect(native.mock.calls.some(call => call[0].name === "browser_click")).toBe(false);
	});
	it("revalidates current upload authorization in the final RPC operation", async () => {
		const path = join(dir, "approved.txt"); writeFileSync(path, "synthetic approved bytes");
		await page.setContent('<input type="file">'); await mcp.callTool("browser_snapshot");
		const chooser = page.waitForEvent("filechooser"); await page.locator("input").click(); await chooser;
		const expectedUploadId = mcp.pendingUploadId() ?? ""; expect(expectedUploadId).not.toBe("");
		let authorized = true;
		const original = recovery.request.bind(recovery);
		vi.spyOn(recovery, "request").mockImplementation((...args) => { authorized = false; return original(...args); });
		const native = vi.spyOn(Client.prototype, "callTool");
		const result = await mcp.callTool("browser_file_upload", { paths: [path] }, { expectedUploadId, isUploadAuthorized: () => authorized });
		expect(result.isError).toBe(true);
		expect(native.mock.calls.some(call => call[0].name === "browser_file_upload")).toBe(false);
		expect(await page.locator("input").evaluate(el => (el as HTMLInputElement).files?.length)).toBe(0);
	});
	it("never treats deadline expiry or a delayed quarantined reply as owner-ready settlement", async () => {
		const blocked = gate(), native = Client.prototype.callTool;
		vi.spyOn(Client.prototype, "callTool").mockImplementation(async function (...args) {
			if (args[0].name === "browser_click") { blocked.reached(); await blocked.wait; }
			return native.apply(this, args);
		});
		const pending = click(); await blocked.arrived;
		expect((await pending).toolDiagnostic?.execution).toBe("pending");
		expect(await mcp.suspendDispatch()).toEqual({ state: "pending" });
		expect((await mcp.recover()).toolDiagnostic?.execution).toBe("not_dispatched");
		blocked.release(); await vi.waitFor(() => expect(mcp.recoveryStatus()?.canResume).toBe(true));
		expect(await mcp.suspendDispatch()).toEqual({ state: "unknown" });
		mcp.resumeDispatch(); expect((await mcp.recover()).isError).not.toBe(true);
		expect(await mcp.suspendDispatch()).toEqual({ state: "settled" });
	});
	it("keeps transport uncertainty fenced, including after a caller tries to resume dispatch", async () => {
		vi.spyOn(Client.prototype, "callTool").mockRejectedValueOnce(new Error("synthetic transport lost"));
		expect((await click()).toolDiagnostic?.execution).toBe("unknown");
		expect(await mcp.suspendDispatch()).toEqual({ state: "unknown" });
		mcp.resumeDispatch(); expect((await click()).toolDiagnostic?.kind).toBe("quarantined");
	});
	it("resumes only explicit dispatch and preserves Stop as the stronger boundary", async () => {
		expect(await mcp.suspendDispatch()).toEqual({ state: "settled" });
		expect((await click()).isError).toBe(true);
		mcp.resumeDispatch(); expect((await click()).isError).not.toBe(true);
		expect(await page.locator("body").getAttribute("data-actions")).toBe("1");
		await mcp.suspendDispatch(); mcp.setCallPolicy({ isCancelled: () => true }); mcp.resumeDispatch();
		expect((await click()).isError).toBe(true);
		expect(await page.locator("body").getAttribute("data-actions")).toBe("1");
	});
});
