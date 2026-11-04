import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpRuntime } from "./mcp-runtime.js";
import { FULL_PLAYWRIGHT_CAPABILITIES } from "./native-tool-access.js";

/** Invariants: accepted native schemas stay intact; dispatch still owns Stop, document and credential identity. */
describe("accepted native Playwright tool access", () => {
	let browser: Browser, context: BrowserContext, mcp: McpRuntime, root: string;
	let active: Page | null = null;
	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pags-full-native-"));
		browser = await chromium.launch({ headless: true });
		context = await browser.newContext();
		await context.route("https://fixture.test/**", route => route.fulfill({ contentType: "text/html", body: '<h1>Independent fixture</h1><label>Name<input></label><input type="file" aria-label="Document">' }));
		active = await context.newPage();
		mcp = new McpRuntime();
		await mcp.start({ context, activePage: () => active && !active.isClosed() ? active : null, onPageSelected: page => { active = page; } });
	}, 60_000);
	afterAll(async () => { await mcp?.stop(); await browser?.close(); await rm(root, { recursive: true, force: true }); }, 60_000);

	it("keeps guarded scripts unavailable, then exposes all installed native tool schemas verbatim", async () => {
		expect((await mcp.listTools()).map(t => t.name)).not.toContain("browser_run_code_unsafe");
		expect((await mcp.callTool("browser_run_code_unsafe", { code: "async page => 42", toolAccess: "full" })).isError).toBe(true);
		await mcp.configureToolAccess("full", root);
		mcp.setCallPolicy({ toolAccess: "full", guard: { mode: "dry_run" } });
		const server = await createConnection({ capabilities: [...FULL_PLAYWRIGHT_CAPABILITIES], webmcp: false }, async () => context);
		const client = new Client({ name: "native-parity-test", version: "1" });
		const [c, s] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(s); await client.connect(c);
			const expected = (await client.listTools()).tools;
			const actual = await mcp.listTools();
			expect(actual).toEqual(expected);
			expect(actual.length).toBeGreaterThan(60);
			mcp.setCallPolicy({});
			expect((await mcp.listTools()).map(tool => tool.name)).not.toContain("browser_run_code_unsafe");
			expect((await mcp.listTools()).map(tool => tool.name)).not.toContain("browser_mouse_click_xy");
			expect((await mcp.callTool("browser_mouse_click_xy", { x: 0, y: 0 })).isError).toBe(true);
			mcp.setCallPolicy({ toolAccess: "full", guard: { mode: "dry_run" } });
			expect(actual.map(t => t.name)).toEqual(expect.arrayContaining(["browser_run_code_unsafe", "browser_evaluate", "browser_mouse_click_xy", "browser_pdf_save", "browser_cookie_list"]));
		} finally { await client.close(); await server.close(); }
	});

	it("executes native unsafe code on the owned page and records it; Stop remains checked at dispatch", async () => {
		mcp.setSubject({ kind: "local_apply_run", id: "full-native-test" });
		await mcp.callTool("browser_navigate", { url: "https://fixture.test/form" });
		const result = await mcp.callTool("browser_run_code_unsafe", { code: 'async page => { await page.getByRole("textbox").fill("Native execution"); return await page.getByRole("textbox").inputValue(); }' });
		expect(result.isError, mcp.textOf(result)).not.toBe(true);
		expect(await active!.getByRole("textbox").inputValue()).toBe("Native execution");
		mcp.setCallPolicy({ toolAccess: "full", isCancelled: () => true });
		const stopped = await mcp.callTool("browser_run_code_unsafe", { code: 'async page => page.getByRole("textbox").fill("Stopped")' });
		expect(stopped.isError).toBe(true);
		expect(await active!.getByRole("textbox").inputValue()).toBe("Native execution");
		expect(mcp.pullCalls({ kind: "local_apply_run", id: "full-native-test" }, 0).calls.filter(c => c.tool === "browser_run_code_unsafe").map(c => c.outcome)).toEqual(["ok", "refused"]);
		mcp.setCallPolicy({ toolAccess: "full" });
	});

	it("scopes normal output files and checks credential broker origin even in full mode", async () => {
		const saved = await mcp.callTool("browser_snapshot", { filename: "snapshot.txt" });
		expect(saved.isError, mcp.textOf(saved)).not.toBe(true);
		expect(await readFile(join(root, "snapshot.txt"), "utf8")).toContain("Independent fixture");
		const denied = await mcp.callTool("browser_snapshot", { filename: "../outside.txt" });
		expect(denied.isError).toBe(true);
		expect(mcp.textOf(denied)).toContain("outside allowed roots");
		await symlink(tmpdir(), join(root, "escape"));
		expect((await mcp.callTool("browser_snapshot", { filename: "escape/outside.txt" })).isError).toBe(true);
		mcp.provideSecrets({ PASSWORD: "super-private" });
		const secret = await mcp.callTool("browser_type", { target: 'role=textbox', text: "PASSWORD", expectedOrigin: "https://fixture.test" });
		expect(secret.isError).toBe(true);
		expect(mcp.textOf(secret)).toContain("runner-bound sign-in origin");
		const moved = await mcp.callTool("browser_type", { target: 'role=textbox', text: "PASSWORD" }, { expectedOrigin: "https://wrong.test" });
		expect(moved.isError).toBe(true);
		expect(await active!.getByRole("textbox").inputValue()).toBe("Native execution");
	});

	it("allows only approved document identities in ordinary native uploads", async () => {
		await writeFile(join(root, "approved.txt"), "approved");
		await writeFile(join(root, "other.txt"), "not approved");
		mcp.setCallPolicy({ toolAccess: "full", approvedUploadPaths: () => [join(root, "approved.txt")] });
		mcp.trackUploadPage(active!);
		const chooser = active!.waitForEvent("filechooser");
		await active!.getByLabel("Document").click(); await chooser;
		const dropped = await mcp.callTool("browser_drop", { target: "role=textbox", paths: [join(root, "other.txt")] });
		expect(dropped.isError).toBe(true);
		expect(mcp.textOf(dropped)).toContain("approved");
		const refused = await mcp.callTool("browser_file_upload", { paths: [join(root, "other.txt")] });
		expect(refused.isError).toBe(true);
		expect(mcp.textOf(refused)).toContain("approved");
		const selected = await mcp.callTool("browser_file_upload", { paths: ["approved.txt"] });
		expect(selected.isError, mcp.textOf(selected)).not.toBe(true);
		expect(await active!.getByLabel("Document").evaluate((el: HTMLInputElement) => el.files?.[0].name)).toBe("approved.txt");
	});

	it("keeps native new/select/close tab ownership synchronized across isolated contexts with identical URLs", async () => {
		mcp.setCallPolicy({ toolAccess: "full" });
		const first = active!;
		for (let i = 0; i < 2; i++) expect((await mcp.callTool("browser_tabs", { action: "new" })).isError).not.toBe(true);
		const third = active!;
		await mcp.callTool("browser_tabs", { action: "select", index: 1 });
		const second = active!;
		await mcp.callTool("browser_tabs", { action: "close", index: 1 });
		expect(second.isClosed()).toBe(true);
		expect(active).toBe(third);
		await mcp.callTool("browser_tabs", { action: "select", index: 0 });
		expect(active).toBe(first);
		const isolatedResult = await mcp.callTool("browser_tabs", { action: "new", isolatedContext: "another" });
		expect(isolatedResult.isError, mcp.textOf(isolatedResult)).not.toBe(true);
		const isolated = active!;
		expect(isolated.context()).not.toBe(context);
		expect(isolated.url()).toBe(third.url()); // identical URL must not confuse identities
		await mcp.callTool("browser_tabs", { action: "select", index: 1 });
		expect(active).toBe(third);
		await mcp.callTool("browser_tabs", { action: "select", index: 2 });
		expect(active).toBe(isolated);
		const state = mcp.browserState({ kind: "local_apply_run", id: "full-native-test" });
		expect(JSON.stringify(state)).toContain('"tabCount":3');
		await mcp.callTool("browser_tabs", { action: "new", isolatedContext: "another" });
		expect(active!.context()).toBe(isolated.context());
		await mcp.callTool("browser_tabs", { action: "close" });
		expect(active).toBe(isolated);
		await mcp.callTool("browser_tabs", { action: "select", index: 0 });
		expect(active).toBe(first);
		const failedNavigation = await mcp.callTool("browser_tabs", { action: "new", isolatedContext: "failed-navigation", url: "http://127.0.0.1:1/unreachable" });
		expect(failedNavigation.isError).toBe(true);
		const failedTab = active!;
		expect(failedTab.context()).not.toBe(context);
		await mcp.callTool("browser_tabs", { action: "select", index: 0 });
		expect(active).toBe(first);
		await mcp.callTool("browser_tabs", { action: "select", index: 3 });
		expect(active).toBe(failedTab);
		await failedTab.close(); // production activePage getter hides already-closed pages
		expect(active).toBe(isolated);
		await mcp.callTool("browser_tabs", { action: "select", index: 0 });
		await mcp.callTool("browser_close");
		expect(first.isClosed()).toBe(false); // injected contexts remain caller-owned upstream
		await mcp.callTool("browser_snapshot");
		expect(active).toBe(first);
		await mcp.callTool("browser_tabs", { action: "new", isolatedContext: "release" });
		const releasedContext = active!.context();
		await mcp.configureToolAccess("guarded", root);
		expect(browser.contexts()).not.toContain(releasedContext);
		mcp.setCallPolicy({ toolAccess: "full" });
		expect((await mcp.listTools()).map(t => t.name)).not.toContain("browser_run_code_unsafe");
		expect((await mcp.callTool("browser_run_code_unsafe", { code: "async page => 42" })).isError).toBe(true);
		expect(first.isClosed()).toBe(false);
		await mcp.callTool("browser_tabs", { action: "select", index: 0 });
		await first.close();
		expect(active).toBe(first); // Guarded preserves exact-page termination, without automatic fallback.
		expect((await mcp.callTool("browser_snapshot")).isError).toBe(true);
	});
});
