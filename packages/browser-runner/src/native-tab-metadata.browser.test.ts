import { expect, it } from "vitest";
import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpRuntime } from "./mcp-runtime.js";
import { BrowserToolRecovery } from "./browser-tool-recovery.js";
import type { McpToolResult } from "./mcp-runtime.js";

it("native tab selection completes with unavailable background title metadata and still acts on the selected independent form", async () => {
	const browser = await chromium.launch({ headless: true });
	const root = await mkdtemp(join(tmpdir(), "pags-native-title-"));
	const mcp = new McpRuntime(undefined, new BrowserToolRecovery<McpToolResult>(4_000, 20_000));
	let release!: (value: string) => void;
	try {
		const context = await browser.newContext();
		const background = await context.newPage(), target = await context.newPage();
		await background.setContent('<title>Background</title><label>First<input></label>');
		await target.setContent('<title>Target</title><label>Second<input></label>');
		const nativeTitle = background.title;
		let stalled = false;
		background.title = () => stalled ? new Promise<string>(resolve => { release = resolve; }) : nativeTitle.call(background);
		let active = background;
		await mcp.start({ context, activePage: () => active, onPageSelected: page => { active = page; } });
		await mcp.configureToolAccess("full", root);
		mcp.setCallPolicy({ toolAccess: "full" });
		const listed = await mcp.callTool("browser_tabs", { action: "list" });
		expect(listed.isError, mcp.textOf(listed)).not.toBe(true);
		stalled = true;
		const selected = await mcp.callTool("browser_tabs", { action: "select", index: 1 });
		expect(selected.isError, mcp.textOf(selected)).not.toBe(true);
		expect(mcp.textOf(selected)).toContain("title unavailable");
		expect(active).toBe(target); expect(mcp.recoveryStatus()).toBeNull();
		const filled = await mcp.callTool("browser_run_code_unsafe", { code: 'async page => { await page.getByLabel("Second").fill("Independent answer"); return await page.getByLabel("Second").inputValue(); }' });
		expect(filled.isError, mcp.textOf(filled)).not.toBe(true);
		expect(await target.getByLabel("Second").inputValue()).toBe("Independent answer");
		expect(await background.getByLabel("First").inputValue()).toBe("");
		stalled = false; release("Background");
	} finally { release?.("Background"); await mcp.stop(); await browser.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it("identifies an unsettled foreground phase and keeps it quarantined until that same native request returns", async () => {
	const browser = await chromium.launch({ headless: true });
	const root = await mkdtemp(join(tmpdir(), "pags-native-foreground-"));
	const mcp = new McpRuntime(undefined, new BrowserToolRecovery<McpToolResult>(1_000, 10_000));
	let release!: () => void, calls = 0;
	try {
		const context = await browser.newContext();
		const first = await context.newPage(), target = await context.newPage();
		const nativeForeground = target.bringToFront.bind(target);
		const gate = new Promise<void>(resolve => { release = resolve; });
		target.bringToFront = async () => { calls++; await gate; await nativeForeground(); };
		let active = first;
		await mcp.start({ context, activePage: () => active, onPageSelected: page => { active = page; } });
		await mcp.configureToolAccess("full", root); mcp.setCallPolicy({ toolAccess: "full" });
		expect((await mcp.callTool("browser_tabs", { action: "list" })).isError).not.toBe(true);
		const selected = await mcp.callTool("browser_tabs", { action: "select", index: 1 });
		expect(selected.toolDiagnostic).toMatchObject({ execution: "pending", recoverable: false });
		expect(selected.toolDiagnostic?.message).toContain("bringToFront pending");
		expect((await mcp.recover()).isError).toBe(true);
		expect(calls).toBe(1); expect(active).toBe(first);
		release();
		for (let i = 0; i < 100 && !mcp.recoveryStatus()?.canResume; i++) await new Promise(resolve => setTimeout(resolve, 20));
		const recovered = await mcp.recover();
		expect(recovered.isError, mcp.textOf(recovered)).not.toBe(true);
		expect(active).toBe(target); expect(calls).toBe(1);
	} finally { release?.(); await mcp.stop(); await browser.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
