import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpRuntime } from "./mcp-runtime.js";
import { acceptsUpload, UploadVerifier } from "./upload-verification.js";

describe("approved document format matches the native upload field", () => {
	it.each([
		["resume.txt", ".pdf,application/pdf", false],
		["resume.txt", "text/plain", true],
		["resume.txt", "text/*", true],
		["RESUME.TXT", " .PDF, .TXT ", true],
		["resume.txt", "", true],
		["resume.unknown", "application/pdf", false],
	])("%s with accept=%s matches=%s", (file, accept, matches) => {
		expect(acceptsUpload(file, accept)).toBe(matches);
	});
});

describe("actual Playwright MCP upload selection and site validation (#1473)", () => {
	let browser: Browser;
	let context: BrowserContext;
	let page: Page;
	let mcp: McpRuntime;
	let dir: string;
	let path: string;
	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pags-upload-verification-"));
		path = join(dir, "resume.txt");
		writeFileSync(path, "Approved synthetic resume fixture only.");
		browser = await chromium.launch({ headless: true });
	}, 60_000);
	beforeEach(async () => {
		context = await browser.newContext();
		page = await context.newPage();
		mcp = new McpRuntime();
		await mcp.start({ context, activePage: () => page });
	});
	afterEach(async () => { await mcp.stop(); await context.close(); }, 60_000);
	afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);
	async function choose(html: string, selector = "#resume") {
		await page.setContent(html);
		await mcp.callTool("browser_snapshot");
		const chooser = page.waitForEvent("filechooser");
		await page.locator(selector).click();
		return chooser;
	}
	const upload = () => mcp.callTool("browser_file_upload", { paths: [path] });

	it("releases both listeners when successive runs reuse a persistent page", () => {
		const before = { chooser: page.listenerCount("filechooser"), close: page.listenerCount("close") };
		for (let run = 0; run < 12; run++) {
			const verifier = new UploadVerifier();
			verifier.track(page);
			verifier.track(page);
			expect(page.listenerCount("filechooser")).toBe(before.chooser + 1);
			expect(page.listenerCount("close")).toBe(before.close + 1);
			verifier.stop();
			expect(page.listenerCount("filechooser")).toBe(before.chooser);
			expect(page.listenerCount("close")).toBe(before.close);
		}
	});

	it("refuses TXT on the selected PDF-only field before any change event, even if another field accepts TXT", async () => {
		await choose('<input type="file" accept=".txt"><input id="resume" type="file" accept=".pdf,application/pdf" onchange="window.changed=true">');
		const result = await upload();
		expect(result.isError).toBe(true);
		expect(mcp.textOf(result)).toContain("does not match");
		expect(await page.locator("#resume").evaluate((el) => (el as HTMLInputElement).files?.length)).toBe(0);
		expect(await page.evaluate(() => (window as unknown as { changed?: boolean }).changed)).toBeUndefined();
	});

	it.each([0, 150])("surfaces a site's rejection and cleared input despite native MCP success (delay %d ms)", async (delay) => {
		await choose(`<input id="resume" type="file" accept=".txt" aria-describedby="error" onchange="setTimeout(()=>{this.value='';document.querySelector('#error').textContent='Unsupported document'},${delay})"><div id="error" role="alert"></div>`);
		const result = await upload();
		expect(result.isError).toBe(true);
		expect(mcp.textOf(result)).toMatch(/validation error|field was cleared/);
		expect(await page.locator("#resume").evaluate((el) => (el as HTMLInputElement).files?.length)).toBe(0);
	});

	it("surfaces explicit invalid state even when the site leaves the file selected", async () => {
		await choose('<input id="resume" type="file" accept=".txt" onchange="this.setAttribute(\'aria-invalid\',\'true\')">');
		expect((await upload()).isError).toBe(true);
		expect(await page.locator("#resume").evaluate((el) => (el as HTMLInputElement).files?.length)).toBe(1);
	});

	it("reports selection only, retains exact approved bytes, and does not treat existing guidance as rejection", async () => {
		await choose('<input id="resume" type="file" accept="text/plain" aria-describedby="hint"><div id="hint">Maximum file size 5 MB</div>');
		const result = await upload();
		expect(result.isError).not.toBe(true);
		expect(mcp.textOf(result)).toContain("Website acceptance remains unconfirmed");
		expect(await page.locator("#resume").evaluate(async (el) => (el as HTMLInputElement).files?.[0].text())).toBe("Approved synthetic resume fixture only.");
	});

	it("requires a new chooser after the selection instead of reusing the prior field", async () => {
		await choose('<input id="resume" type="file" accept=".txt">');
		expect((await upload()).isError).not.toBe(true);
		const repeated = await upload();
		expect(repeated.isError).toBe(true);
		expect(mcp.textOf(repeated)).toContain("No verified file chooser");
	});

	it.each(["this.value=''", "this.replaceWith(document.createElement('input'))"])("confirms selected bytes when a SPA consumes its file input: %s (#1496)", async (consume) => {
		await choose(`<input id="resume" type="file" accept=".txt" onchange="document.querySelector('#ack').textContent=this.files[0].name;${consume}"><span id="ack"></span>`);
		const result = await upload();
		expect(result.isError).not.toBe(true);
		expect(mcp.textOf(result)).toContain("Website acceptance remains unconfirmed");
		expect(await page.locator("#ack").innerText()).toBe("resume.txt");
	});

	it.each(["preexisting", "hidden", "transparent_parent", "wrong_name", "other_frame"])("does not accept %s filename text as new selection evidence", async (kind) => {
		const ack = kind === "preexisting" ? "resume.txt" : "";
		const value = kind === "wrong_name" ? "other.txt" : "resume.txt";
		const update = kind === "other_frame" ? `document.querySelector('iframe').contentDocument.body.textContent='resume.txt'` : `document.querySelector('#ack').textContent='${value}'`;
		await choose(`<input id="resume" type="file" onchange="this.value='';${update}"><div ${kind === "transparent_parent" ? 'style="opacity:0"' : ""}><span id="ack" ${kind === "hidden" ? 'style="display:none"' : ""}>${ack}</span></div><iframe srcdoc="<body></body>"></iframe>`);
		expect((await upload()).isError).toBe(true);
	});

	it("recognizes a consumed input's acknowledgment inside its own iframe", async () => {
		await page.setContent('<iframe srcdoc="<body></body>"></iframe>');
		const frame = page.frames()[1];
		await frame.setContent('<input id="resume" type="file" onchange="document.querySelector(\'#ack\').textContent=this.files[0].name;this.remove()"><span id="ack"></span>');
		await mcp.callTool("browser_snapshot");
		const opened = page.waitForEvent("filechooser");
		await frame.locator("#resume").click();
		await opened;
		expect((await upload()).isError).not.toBe(true);
	});

	it("a replacement input's explicit invalid state outweighs its new filename acknowledgment", async () => {
		await choose('<input id="resume" type="file" onchange="document.querySelector(\'#ack\').textContent=this.files[0].name;const next=this.cloneNode();next.setAttribute(\'aria-invalid\',\'true\');this.replaceWith(next)"><span id="ack"></span>');
		expect((await upload()).isError).toBe(true);
	});

	it("a new filename does not override explicit rejection, and the bounded error starts with its reason", async () => {
		mcp.setSubject({ kind: "local_apply_run", id: "upload-rejection" });
		await choose('<input id="resume" type="file" aria-describedby="error" onchange="document.querySelector(\'#ack\').textContent=this.files[0].name;this.value=\'\';document.querySelector(\'#error\').textContent=\'Unsupported document\'"><span id="ack"></span><div id="error" role="alert"></div>');
		const result = await upload();
		expect(result.isError).toBe(true);
		expect(mcp.textOf(result)).toMatch(/^The upload field reported a validation error/);
		expect(mcp.pullCalls({ kind: "local_apply_run", id: "upload-rejection" }, 0).calls.at(-1)?.errorHead).toMatch(/^The upload field reported a validation error/);
	});

	it("requires observed native selection as well as a new filename acknowledgment", async () => {
		const verifier = new UploadVerifier();
		verifier.track(page);
		try {
			await choose('<input id="resume" type="file"><span id="ack"></span>');
			const prepared = await verifier.prepare(page, [path]);
			await page.evaluate(() => { document.querySelector("#ack")!.textContent = "resume.txt"; document.querySelector("#resume")!.remove(); });
			expect((await prepared.verify?.())?.error).toBeTruthy();
		} finally { verifier.stop(); }
	});

	it.each(["stop", "task_binding", "chooser", "domain"] as const)("refuses an upload when %s changes during awaited validation (#1490)", async (change) => {
		await page.route("https://fixture.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Fixture</title>" }));
		await page.goto("https://fixture.test/");
		await choose('<input id="resume" type="file" accept=".txt"><input id="other" type="file" accept=".txt">');
		let stopped = false, authorized = true, allowed = true;
		mcp.setCallPolicy({ isCancelled: () => stopped, websiteAccess: () => ({ mode: allowed ? "allow_all" : "allowlist", domains: [] }) });
		const expectedUploadId = mcp.pendingUploadId()!;
		const prepare = UploadVerifier.prototype.prepare;
		const mutation = vi.spyOn(UploadVerifier.prototype, "prepare").mockImplementationOnce(async function (...args) {
			const prepared = await prepare.apply(this, args);
			if (change === "stop") stopped = true;
			if (change === "task_binding") authorized = false;
			if (change === "domain") allowed = false;
			if (change === "chooser") {
				const changed = page.waitForEvent("filechooser");
				await page.locator("#other").click();
				await changed;
			}
			return prepared;
		});
		try {
			const result = await mcp.callTool("browser_file_upload", { paths: [path] }, { expectedUploadId, isUploadAuthorized: () => authorized });
			expect(result.isError).toBe(true);
			expect(await page.locator('input[type="file"]').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).files?.length))).toEqual([0, 0]);
		} finally { mutation.mockRestore(); }
	});

	it("verification of one upload preserves a newer native chooser", async () => {
		const verifier = new UploadVerifier();
		verifier.track(page);
		try {
			const original = await choose('<input id="resume" type="file"><input id="other" type="file">');
			const prepared = await verifier.prepare(page, [path]);
			await original.setFiles(path);
			const changed = page.waitForEvent("filechooser");
			await page.locator("#other").click();
			await changed;
			const newer = verifier.pendingId(page);
			expect(newer).not.toBe(prepared.chooserId);
			await prepared.verify?.();
			expect(verifier.pendingId(page)).toBe(newer);
		} finally { verifier.stop(); }
	});
});
