import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { McpRuntime } from "./mcp-runtime.js";
import { startTestJobServer, type TestJobServer } from "./test-job-server.js";
import { navigationRefusal } from "./mcp-call-policy.js";

describe("MCP action policy — no guarded action reaches the page through an alternate helper", () => {
	let browser: Browser;
	let page: Page;
	let mcp: McpRuntime;
	let server: TestJobServer;
	beforeAll(async () => {
		server = await startTestJobServer();
		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext();
		page = await context.newPage();
		mcp = new McpRuntime();
		await mcp.start({ context });
		await mcp.selectPage(page);
	}, 60_000);
	afterAll(async () => { await mcp?.stop(); await browser?.close(); await server?.close(); }, 60_000);
	beforeEach(async () => { mcp.setCallPolicy({}); await page.goto(server.quickApplyUrl); });
	async function buttonRef() {
		const snapshot = mcp.textOf(await mcp.callTool("browser_snapshot"));
		const ref = snapshot.match(/button "Envoyer ma candidature"[^\n]*\[ref=(\w+)\]/)?.[1];
		if (!ref) throw new Error("Fixture submit control is absent");
		return ref;
	}
	it("guards the standard click even when check/upload calls it with a harmless label", async () => {
		const target = await buttonRef();
		mcp.setCallPolicy({ guard: { mode: "dry_run" } });
		const before = server.submissions.length;
		const result = await mcp.callTool("browser_click", { target, element: "checkbox" });
		expect(result.isError).toBe(true);
		expect(mcp.textOf(result)).toContain("REHEARSAL");
		expect(server.submissions).toHaveLength(before);
		mcp.setCallPolicy({});
		expect((await mcp.callTool("browser_click", { target, element: "checkbox" })).isError).not.toBe(true);
		await expect.poll(() => server.submissions.length, { timeout: 5_000 }).toBe(before + 1);
		await page.waitForURL(/\/success\//);
	});
	it.each(["click", "Space", "Enter"])("read-only sees a POST formmethod override through %s, including an external default submitter", async (action) => {
		await page.setContent('<button form="application" formmethod="post" type="submit">Go</button><form id="application" method="get" action="/apply" enctype="multipart/form-data"><label>Search<input name="coverNote"></label></form>');
		const target = mcp.textOf(await mcp.callTool("browser_snapshot")).match(/button "Go"[^\n]*\[ref=(\w+)\]/)?.[1];
		expect(target).toBeTruthy();
		if (action === "Space") await page.getByRole("button", { name: "Go" }).focus();
		if (action === "Enter") await page.getByRole("textbox", { name: "Search" }).focus();
		const invoke = () => action === "click" ? mcp.callTool("browser_click", { target, element: "Go" }) : mcp.callTool("browser_press_key", { key: action });
		mcp.setCallPolicy({ guard: { mode: "read_only" } });
		const before = server.submissions.length;
		const refused = await invoke();
		expect(refused.isError).toBe(true);
		expect(mcp.textOf(refused)).toContain("READ-ONLY");
		expect(server.submissions).toHaveLength(before);
		mcp.setCallPolicy({});
		expect((await invoke()).isError).not.toBe(true);
		await expect.poll(() => server.submissions.length, { timeout: 5_000 }).toBe(before + 1);
		await page.waitForURL(/\/success\//);
	});
	it("a failed DOM probe cannot turn a rehearsal's invented Continue label into permission", async () => {
		mcp.setCallPolicy({ guard: { mode: "dry_run" } });
		const before = server.submissions.length;
		const result = await mcp.callTool("browser_click", { target: "missing-ref", element: "Continue" });
		expect(result.isError).toBe(true);
		expect(mcp.textOf(result)).toContain("could not be read");
		expect(server.submissions).toHaveLength(before);
	});
	it.each(["Space", " ", "Control+Enter"])("refuses activation %s during a rehearsal", async (key) => {
		await page.locator('button[type="submit"]').focus();
		mcp.setCallPolicy({ guard: { mode: "dry_run" } });
		const before = server.submissions.length;
		expect((await mcp.callTool("browser_press_key", { key })).isError).toBe(true);
		expect(server.submissions).toHaveLength(before);
	});
	it("does not accept page confirmation dialogs in a guarded run, including internal calls", async () => {
		await page.evaluate(() => { setTimeout(() => { if (confirm("Send application?")) document.body.dataset.sent = "yes"; }, 0); });
		await page.waitForTimeout(50);
		mcp.setCallPolicy({ guard: { mode: "dry_run" } });
		expect((await mcp.callTool("browser_handle_dialog", { accept: true }, { internal: true })).isError).toBe(true);
		expect((await mcp.callTool("browser_handle_dialog", { accept: false }, { internal: true })).isError).toBe(true);
		mcp.setCallPolicy({});
		expect((await mcp.callTool("browser_handle_dialog", { accept: false }, { internal: true })).isError).not.toBe(true);
		expect(await page.locator("body").getAttribute("data-sent")).toBeNull();
	});
	it("blocks all uploads in read-only mode before Playwright receives the host path", async () => {
		mcp.setCallPolicy({ guard: { mode: "read_only" } });
		const result = await mcp.callTool("browser_file_upload", { paths: ["/a/private/file"] });
		expect(result.isError).toBe(true);
		expect(mcp.textOf(result)).toContain("READ-ONLY");
	});
	it("read-only refuses a checkbox even when its onchange handler submits", async () => {
		await page.setContent('<label>Ready<input type="checkbox" onchange="document.body.dataset.sent=\'yes\'"></label>');
		const target = mcp.textOf(await mcp.callTool("browser_snapshot")).match(/checkbox "Ready"[^\n]*\[ref=(\w+)\]/)?.[1];
		expect(target).toBeTruthy();
		mcp.setCallPolicy({ guard: { mode: "read_only" } });
		expect((await mcp.callTool("browser_click", { target, element: "Ready" })).isError).toBe(true);
		expect(await page.locator("body").getAttribute("data-sent")).toBeNull();
		mcp.setCallPolicy({});
		expect((await mcp.callTool("browser_click", { target, element: "Ready" })).isError).not.toBe(true);
		expect(await page.locator("body").getAttribute("data-sent")).toBe("yes");
	});
	it("read-only rejects bulk fill, dropdown selection and typing into a POST form", async () => {
		mcp.setCallPolicy({ guard: { mode: "read_only" } });
		const target = mcp.textOf(await mcp.callTool("browser_snapshot")).match(/textbox "Recherche"[^\n]*\[ref=(\w+)\]/)?.[1];
		expect((await mcp.callTool("browser_type", { target, text: "value" })).isError).toBe(true);
		for (const name of ["browser_fill_form", "browser_select_option"]) expect((await mcp.callTool(name, {})).isError).toBe(true);
	});
	it("requires an internal origin binding for every secret placeholder", async () => {
		mcp.provideSecrets({ TEST_SECRET: "synthetic-secret-only" });
		const target = mcp.textOf(await mcp.callTool("browser_snapshot")).match(/textbox "Recherche"[^\n]*\[ref=(\w+)\]/)?.[1];
		expect((await mcp.callTool("browser_type", { target, text: "TEST_SECRET" })).isError).toBe(true);
		expect((await mcp.callTool("browser_fill_form", { fields: [{ ref: target, value: "TEST_SECRET" }] })).isError).toBe(true);
		expect((await mcp.callTool("browser_type", { target, text: "TEST_SECRET" }, { expectedOrigin: new URL(server.url).origin })).isError).not.toBe(true);
		expect(await page.getByRole("textbox", { name: "Recherche" }).inputValue()).toBe("synthetic-secret-only");
		mcp.clearSecrets();
	});
	it("agent page code is refused even without a rehearsal policy; fixed runner probes still work", async () => {
		const args = { function: "() => document.body.dataset.sent = 'yes'" };
		expect((await mcp.callTool("browser_evaluate", args)).isError).toBe(true);
		expect((await mcp.callTool("browser_run_code", { code: "1" })).isError).toBe(true);
		expect(mcp.textOf(await mcp.callTool("browser_run_code_unsafe", { code: "1" }))).toContain("BLOCKED by the runner");
		expect(await page.locator("body").getAttribute("data-sent")).toBeNull();
		expect((await mcp.callTool("browser_evaluate", { function: "() => document.title" }, { internal: true })).isError).not.toBe(true);
	});
	it("refuses after Stop and records refusal rather than performing the next action", async () => {
		const target = await buttonRef();
		mcp.setSubject({ kind: "runtime_task", id: "stopped-run" });
		mcp.setCallPolicy({ isCancelled: () => true });
		const before = server.submissions.length;
		expect((await mcp.callTool("browser_click", { target, element: "Submit" })).isError).toBe(true);
		expect(server.submissions).toHaveLength(before);
		expect(mcp.pullCalls({ kind: "runtime_task", id: "stopped-run" }, 0).calls.at(-1)?.outcome).toBe("refused");
	});
	it("checks Stop again when it arrives while the guard is reading the DOM", async () => {
		await page.goto(server.searchUrl);
		const target = mcp.textOf(await mcp.callTool("browser_snapshot")).match(/button "Search"[^\n]*\[ref=(\w+)\]/)?.[1];
		expect(target).toBeTruthy();
		let checks = 0;
		mcp.setCallPolicy({ guard: { mode: "read_only", labels: "impossible-label" }, isCancelled: () => ++checks >= 4 });
		const result = await mcp.callTool("browser_click", { target, element: "Continue" });
		expect(result.isError).toBe(true);
		expect(mcp.textOf(result)).toContain("stopped");
	});
	it.each(["file:///etc/passwd", "data:text/html,private", "javascript:alert(1)", "chrome://settings", "about:config"])("refuses non-web navigation %s without changing page", async (url) => {
		const before = page.url();
		const result = await mcp.callTool("browser_navigate", { url });
		expect(result.isError).toBe(true);
		expect(mcp.textOf(result)).toContain("http(s)");
		expect(page.url()).toBe(before);
	});
	it("never returns non-web page contents from a restored tab or browser history", async () => {
		await page.goto("data:text/html,<h1>PRIVATE-FIXTURE-CONTENTS</h1>");
		const restored = await mcp.callTool("browser_snapshot");
		expect(restored.isError).toBe(true);
		expect(mcp.textOf(restored)).not.toContain("PRIVATE-FIXTURE-CONTENTS");
		await page.goto(server.quickApplyUrl);
		const back = await mcp.callTool("browser_navigate_back");
		expect(back.isError).toBe(true);
		expect(mcp.textOf(back)).not.toContain("PRIVATE-FIXTURE-CONTENTS");
	});
	it("refuses a credential entry after the page redirected to a different origin", async () => {
		const result = await mcp.callTool("browser_type", { target: "anything", text: "secret-name" }, { expectedOrigin: "https://expected.invalid" });
		expect(result.isError).toBe(true);
		expect(mcp.textOf(result)).toContain("changed origin");
	});
});

it("permits web navigation and the explicitly blank initialization page", () => {
	for (const url of ["https://example.org", "http://127.0.0.1:1234", "about:blank"]) expect(navigationRefusal(url)).toBeNull();
});
