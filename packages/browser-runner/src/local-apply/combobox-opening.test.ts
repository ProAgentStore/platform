import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { observeControlOpening } from "../control-opening.js";
import { ELEMENT_PROBE_FN } from "../commit-guard.js";
import { McpRuntime } from "../mcp-runtime.js";
import { ApplyBridge, type ApplyBridgeHost } from "./bridge.js";

const CONTROLS = [
	{ label: "implicit native datalist input", html: '<input id="chooser" list="native-choices" aria-label="Destination"><datalist id="native-choices"><option value="Cedar"><option value="Birch"></datalist>' },
	{ label: "readonly input", html: '<input id="chooser" type="text" readonly role="combobox" aria-label="Destination" aria-expanded="false">' },
	{ label: "custom div", html: '<div id="chooser" role="combobox" tabindex="0" aria-label="Destination" aria-expanded="false">Choose</div>' },
	{ label: "editable input", html: '<input id="chooser" type="search" role="combobox" aria-label="Destination" aria-expanded="false">' },
	{ label: "native BUTTON pushbutton", html: '<button id="chooser" type="button" role="combobox" aria-label="Destination" aria-expanded="false">Choose</button>' },
	{ label: "native INPUT pushbutton", html: '<input id="chooser" type="button" role="combobox" aria-label="Destination" aria-expanded="false" value="Choose">' },
];
function form(control: string, mode: string) {
	return `<h1>Application</h1><form method="post">${control}<label>Notes<input id="notes"></label>
<div id="choices" role="listbox" hidden><div role="option" tabindex="-1">Cedar</div><div role="option" tabindex="-1">Birch</div></div><output id="result"></output></form>
${mode === "iframe_nav" ? '<iframe id="child" src="https://combo.test/child"></iframe>' : ''}<script>
window.opens=0;window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++};
const chooser=document.querySelector('#chooser'), choices=document.querySelector('#choices');
chooser.onclick=()=>{window.opens++;if('${mode}'==='reload'){location.reload();return;}if('${mode}'==='iframe_nav'){document.querySelector('#child').src='https://combo.test/child-next';return;}if('${mode}'==='popup'){window.open('https://combo.test/child');return;}choices.hidden=false;chooser.setAttribute('aria-expanded','true');};
for(const option of document.querySelectorAll('[role=option]'))option.onclick=()=>{document.querySelector('#result').textContent=option.textContent;choices.hidden=true;chooser.setAttribute('aria-expanded','false');};
</script>`;
}

describe("observed combobox opening without answering", () => {
	let browser: Browser;
	let context: BrowserContext;
	let page: Page;
	let runtime: McpRuntime;
	let bridge: ApplyBridge;
	let stopped: boolean;
	let allowed: boolean;
	let checkpoint: ReturnType<typeof vi.fn>;
	beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
	beforeEach(async () => {
		context = await browser.newContext();page = await context.newPage();runtime = new McpRuntime();
		await runtime.start({ context, activePage: () => page });stopped = false;allowed = true;
		checkpoint = vi.fn(async () => "continue" as const);
		const host: ApplyBridgeHost = { emit: () => {}, pause: async () => "stopped", supervisorCheckpoint: checkpoint,
			isAllowed: (domain) => allowed && domain === "combo.test", grounding: () => "Destination: Cedar", artifactPath: () => ({ error: "No fixture artifacts" }),
			overTime: () => false, isStopped: () => stopped, now: Date.now, limits: { maxMinutes: 10, maxPages: 20, maxActions: 100 }, mode: "fill_and_review" };
		bridge = new ApplyBridge(runtime, host);runtime.setCallPolicy({ isCancelled: () => stopped, isDomainAllowed: host.isAllowed });
	});
	afterEach(async () => { vi.restoreAllMocks();await runtime.stop();await context.close(); });
	afterAll(async () => { await browser.close(); });
	const textOf = (result: { content: Array<{ text?: string }> }) => result.content.map((block) => block.text ?? "").join("\n");
	async function snapshotRef(role: string, name: string) {
		const snapshot = textOf(await bridge.callTool("browser_snapshot"));
		const target = snapshot.match(new RegExp(`${role} "${name}"[^\\n]*\\[ref=(\\w+)\\]`))?.[1];
		if (!target) throw new Error(snapshot);return target;
	}
	async function open(control = CONTROLS[1].html, mode = "open", approve = true, iframe = false) {
		await context.route("https://**/*", (route) => route.fulfill({ contentType: "text/html", body: route.request().url().includes("/child") ? '<p>Auxiliary frame</p>' : iframe && route.request().url().endsWith("/main") ? '<iframe src="https://combo.test/form"></iframe>' : form(control, mode) }));
		await bridge.callTool("browser_navigate", { url: iframe ? "https://combo.test/main" : "https://combo.test/form" });
		const target = await snapshotRef("combobox", "Destination");
		if (approve) await bridge.callTool("supervisor_checkpoint", { checkpointId: "initial", phase: "initial" });
		return target;
	}
	const click = (target: string, action_intent: unknown = "edit_form") => bridge.callTool("browser_click", { target, action_intent });
	async function unchanged() { expect(bridge.filled).toBe(0);expect(await page.locator("#result").textContent()).toBe("");expect(await page.evaluate(() => (window as Window & { opens: number }).opens)).toBe(0); }
	it.each(CONTROLS)("opens $label, refreshes, chooses a grounded answer and verifies it without another checkpoint", async ({ html }) => {
		const target = await open(html);
		const opened = await click(target);expect(opened.isError, textOf(opened)).not.toBe(true);expect(bridge.filled).toBe(0);
		expect(await page.locator("#choices").isVisible()).toBe(true);
		// Even the old opener ref needs an explicit fresh observation after opening.
		expect((await click(target)).isError).toBe(true);
		const option = await snapshotRef("option", "Cedar");
		expect((await bridge.callTool("browser_click", { target: option })).isError).toBe(true);
		expect((await bridge.callTool("browser_click", { target: option, source_quote: "Destination: Cedar" })).isError).not.toBe(true);
		expect(await page.locator("#result").textContent()).toBe("Cedar");expect(bridge.filled).toBe(1);expect(checkpoint).toHaveBeenCalledTimes(1);
		expect(await page.evaluate(() => (window as Window & { submits: number }).submits)).toBe(0);
	});
	it("opens a combobox in its observed iframe", async () => {
		const target = await open(CONTROLS[1].html, "open", true, true);expect(target).toMatch(/^f\d+e\d+$/);
		expect((await click(target)).isError).not.toBe(true);
		const option = await snapshotRef("option", "Cedar");
		expect((await bridge.callTool("browser_click", { target: option, source_quote: "Destination: Cedar" })).isError).not.toBe(true);
		expect(await page.frames()[1].locator("#result").textContent()).toBe("Cedar");expect(checkpoint).toHaveBeenCalledTimes(1);
	});
	it.each([undefined, "choose_answer"])("requires editing intent: %s", async (action_intent) => {
		const target = await open();expect((await bridge.callTool("browser_click", { target, action_intent })).isError).toBe(true);await unchanged();
	});
	it("requires initial checkpoint", async () => { const target = await open(CONTROLS[1].html, "open", false);expect((await click(target)).isError).toBe(true);await unchanged(); });
	it.each(["checkbox", "radio", "file", "submit", "reset", "image"])("does not click a native %s masquerading as a combobox", async (type) => {
		const target = await open(`<input id="chooser" type="${type}" role="combobox" aria-label="Destination">`);
		const result = await bridge.callTool("browser_click", { target, element: "Apply", action_intent: "edit_form" });expect(result.isError).toBe(true);await unchanged();
	});
	it.each([
		'<select id="chooser" aria-label="Destination"><option>Cedar</option><option>Birch</option></select>',
	])("does not reinterpret another native control as a combobox opener", async (html) => {
		const target = await open(html);expect((await click(target)).isError).toBe(true);await unchanged();
	});

	it.each([undefined, "submit", "reset", "not-a-type"])("refuses a native BUTTON with committing/reset/default type %s", async (type) => {
		const attribute = type === undefined ? "" : `type="${type}"`;
		const target = await open(`<button id="chooser" ${attribute} role="combobox" aria-label="Destination">Choose</button>`);
		expect((await click(target)).isError).toBe(true);await unchanged();
		expect(await page.evaluate(() => (window as Window & { submits: number }).submits)).toBe(0);
	});
	it.each(["button", "input"].flatMap((tag) => (tag === "button" ? ["submit", "reset", "remove-type", "not-a-type"] : ["submit", "reset", "image", "checkbox", "radio", "file"]).map((type) => ({ tag, type }))))("refuses $tag type mutation to $type after probing", async ({ tag, type }) => {
		const control = tag === "button" ? '<button id="chooser" type="button" role="combobox" aria-label="Destination">Choose</button>' : '<input id="chooser" type="button" role="combobox" aria-label="Destination" value="Choose">';
		const target = await open(control);await page.locator("#notes").fill("Cedar");
		const actual = runtime.callTool.bind(runtime);
		vi.spyOn(runtime, "callTool").mockImplementation(async (name, args, opts) => {
			const result = await actual(name, args, opts);
			if (name === "browser_evaluate" && args?.function === ELEMENT_PROBE_FN) await page.locator("#chooser").evaluate((node, changedType) => {
				if (changedType === "remove-type") node.removeAttribute("type");else node.setAttribute("type", changedType);
			}, type);
			return result;
		});
		expect((await click(target)).isError).toBe(true);await unchanged();expect(await page.locator("#notes").inputValue()).toBe("Cedar");
		expect(await page.evaluate(() => (window as Window & { submits: number }).submits)).toBe(0);
	});

	it.each(["checkbox", "role", "role_removed", "hidden", "stop", "domain"])("refuses %s mutation after probing", async (mutation) => {
		const target = await open();const actual = runtime.callTool.bind(runtime);
		vi.spyOn(runtime, "callTool").mockImplementation(async (name, args, opts) => {
			const result = await actual(name, args, opts);
			if (name === "browser_evaluate" && args?.function === ELEMENT_PROBE_FN) {
				if (mutation === "stop") stopped = true;else if (mutation === "domain") allowed = false;
				else await page.locator("#chooser").evaluate((node, change) => { if (change === "checkbox") node.setAttribute("type", "checkbox");else if (change === "role") node.setAttribute("role", "button");else if (change === "role_removed") node.removeAttribute("role");else (node as HTMLElement).hidden = true; }, mutation);
			}return result;
		});
		expect((await click(target)).isError).toBe(true);await unchanged();
	});
	it.each([
		'<label id="chooser" role="combobox" tabindex="0" aria-label="Destination" for="native-answer">Choose</label><input id="native-answer" type="checkbox">',
		'<label for="native-answer"><div id="chooser" role="combobox" tabindex="0" aria-label="Destination">Choose</div></label><input id="native-answer" type="checkbox">',
	])("refuses native label delegation to an answer control", async (html) => {
		const target = await open(html);expect((await click(target)).isError).toBe(true);await unchanged();
		expect(await page.locator("#native-answer").isChecked()).toBe(false);
	});
	it("allows a combobox input wrapped in its own native label", async () => {
		const target = await open(`<label>Destination ${CONTROLS[1].html}</label>`);
		expect((await click(target)).isError).not.toBe(true);expect(await page.locator("#choices").isVisible()).toBe(true);
	});
	it("retains terminal submission refusal before opening", async () => {
		await open(CONTROLS[2].html);
		await page.locator("#chooser").evaluate((el) => el.setAttribute("aria-label", "Submit application"));
		const target = await snapshotRef("combobox", "Submit application");
		await click(target);await unchanged();
	});
	it("removes native opening listeners when dispatch throws", async () => {
		const before = [page.listenerCount("framenavigated"), page.listenerCount("close"), context.listenerCount("page")];
		await expect(observeControlOpening(page, () => page, async () => { throw new Error("Synthetic dispatch failed"); })).rejects.toThrow("Synthetic dispatch failed");
		expect([page.listenerCount("framenavigated"), page.listenerCount("close"), context.listenerCount("page")]).toEqual(before);
	});

	it.each(["reload", "iframe_nav", "popup"])("invalidates approval after %s during the click", async (mode) => {
		const target = await open(CONTROLS[1].html, mode);expect((await click(target)).isError).not.toBe(true);
		const notes = await snapshotRef("textbox", "Notes");
		const result = await bridge.callTool("browser_type", { target: notes, text: "Cedar", source_quote: "Destination: Cedar" });
		expect(result.isError).toBe(true);expect(textOf(result)).toContain("supervisor_checkpoint");expect(bridge.filled).toBe(0);
	});
});
