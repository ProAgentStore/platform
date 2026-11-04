import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { McpRuntime } from "./mcp-runtime.js";

/** Native current page and standard MCP must agree across a popup authentication round trip. */
describe("MCP selected page follows the runner's native page", () => {
	let browser: Browser;
	let context: BrowserContext;
	let mcp: McpRuntime;
	let active: Page | null = null;
	beforeAll(async () => {
		browser = await chromium.launch({ headless: true });
		context = await browser.newContext();
		await context.route("https://fixture.test/**", async (route) => {
			const login = route.request().url().endsWith("/login");
			await route.fulfill({ contentType: "text/html", body: login
				? `<h1>Login</h1><label>Verification code<input oninput="if(this.value.length===6){window.opener.location.href='/application';window.close()}"></label>`
				: `<h1>${route.request().url().endsWith("/application") ? "Application form" : "Job listing"}</h1><a href="/login" target="_blank" rel="opener">Sign in</a>` });
		});
		context.on("page", (page) => {
			active = page;
			page.once("close", () => { if (active === page) active = context.pages().at(-1) ?? null; });
		});
		await context.newPage();
		mcp = new McpRuntime();
		await mcp.start({ context, activePage: () => active, onPageSelected: (page) => { active = page; } });
	}, 60_000);
	afterAll(async () => { await mcp?.stop(); await browser?.close(); }, 60_000);
	it("reads the login popup, then the opener application after automatic code submission closes the popup", async () => {
		await mcp.callTool("browser_navigate", { url: "https://fixture.test/job" });
		const job = mcp.textOf(await mcp.callTool("browser_snapshot"));
		const loginRef = job.match(/link "Sign in"[^\n]*\[ref=(\w+)\]/)?.[1];
		expect(loginRef).toBeTruthy();
		const popup = context.waitForEvent("page");
		await mcp.callTool("browser_click", { target: loginRef, element: "Sign in" });
		await popup;
		const login = mcp.textOf(await mcp.callTool("browser_snapshot"));
		expect(active?.url()).toBe("https://fixture.test/login");
		expect(login).toContain('heading "Login"');
		const codeRef = login.match(/textbox "Verification code"[^\n]*\[ref=(\w+)\]/)?.[1];
		expect(codeRef).toBeTruthy();
		// The completed input may close its page before MCP finishes its response.
		await mcp.callTool("browser_type", { target: codeRef, text: "123456" });
		await expect.poll(() => active?.url()).toBe("https://fixture.test/application");
		const application = mcp.textOf(await mcp.callTool("browser_snapshot"));
		expect(application).toContain('heading "Application form"');
		expect(application).not.toContain('textbox "Verification code"');
		const native = mcp.textOf(await mcp.callTool("browser_evaluate", { function: "() => location.href" }, { internal: true }));
		expect(native).toContain(active?.url());
	}, 60_000);
});
