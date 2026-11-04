import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ELEMENT_PROBE_FN } from "../commit-guard.js";
import { McpRuntime } from "../mcp-runtime.js";
import { ApplyBridge, type ApplyBridgeHost } from "./bridge.js";

type FixtureWindow = Window & { clicks: number; submits: number };

const URL = "https://controls.test/application";
const CONTROLS = [
	{ name: "Save", html: '<button type="button"><span>Save</span></button>' },
	{ name: "Store entry", html: '<input type="button" value="Store entry">' },
	{ name: "Fermer le panneau", html: '<section><div tabindex="0" role="button" aria-label="Fermer le panneau"><span>×</span></div></section>' },
	{ name: "Record section", html: '<button form="application" type="button">Record section</button>' },
];
const FORM = `<h1>Application</h1><form id="application" method="post">
<label>Full name<input id="name"></label>
<div id="controls">${CONTROLS.slice(0, 3).map((c) => c.html).join("")}</div>
<button id="native">Send record</button><button type="button" id="terminal">Submit application</button>
</form>${CONTROLS[3].html}<p id="receipt"></p>
<script>
window.clicks = 0; window.submits = 0;
document.querySelector('form').onsubmit = event => { event.preventDefault(); window.submits++; };
for (const control of document.querySelectorAll('button,input[type=button],[role=button]')) {
 control.addEventListener('click', () => { window.clicks++; document.querySelector('#receipt').textContent = 'Editor changed'; });
}
</script>`;

// Invariant: AI-selected observed buttons need no label whitelist, while explicit execution
// and submission gates still apply. The fixtures make no claim about arbitrary JS handlers.
describe("generic application editor controls", () => {
	let browser: Browser;
	let context: BrowserContext;
	let page: Page;
	let runtime: McpRuntime;
	let bridge: ApplyBridge;
	let stopped: boolean;
	let allowed: boolean;
	beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
	beforeEach(async () => {
		context = await browser.newContext();
		await context.route("https://**/*", (route) => route.fulfill({ contentType: "text/html", body: FORM }));
		page = await context.newPage();
		runtime = new McpRuntime();
		await runtime.start({ context, activePage: () => page });
		stopped = false;
		allowed = true;
		const host: ApplyBridgeHost = {
			emit: () => {}, pause: async () => "stopped", supervisorCheckpoint: async () => "continue",
			isAllowed: (domain) => allowed && domain === "controls.test",
			grounding: () => "Name: Jane Citizen", artifactPath: () => { throw new Error("No fixture artifacts"); },
			overTime: () => false, isStopped: () => stopped, now: Date.now,
			limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 }, mode: "fill_and_review",
		};
		bridge = new ApplyBridge(runtime, host);
		runtime.setCallPolicy({ isCancelled: () => stopped, isDomainAllowed: host.isAllowed, requestDomainApproval: (url) => bridge.admitDomain(url) });
		await bridge.callTool("browser_navigate", { url: URL });
		await bridge.callTool("browser_snapshot");
	});
	afterEach(async () => { vi.restoreAllMocks(); await runtime.stop(); await context.close(); });
	afterAll(async () => { await browser.close(); });
	const checkpoint = () => bridge.callTool("supervisor_checkpoint", { checkpointId: "fixture", phase: "post_navigation" });
	async function ref(name: string, role = "button") {
		const result = await bridge.callTool("browser_snapshot");
		const snapshot = result.content.map((block) => block.text).join("\n");
		const target = snapshot.match(new RegExp(`${role} "${name}"[^\\n]*\\[ref=(\\w+)\\]`))?.[1];
		if (!target) throw new Error(`Missing fixture control: ${snapshot}`);
		return target;
	}
	async function untouched() {
		expect(await page.evaluate(() => ({ clicks: (window as FixtureWindow).clicks, submits: (window as FixtureWindow).submits }))).toEqual({ clicks: 0, submits: 0 });
	}
	it.each(CONTROLS)("activates $name from an observed non-submit control", async ({ name }) => {
		await checkpoint();
		const result = await bridge.callTool("browser_click", { action_intent: "edit_form", target: await ref(name) });
		expect(result.isError).not.toBe(true);
		expect(await page.locator("#receipt").textContent()).toBe("Editor changed");
		expect(await page.evaluate(() => (window as FixtureWindow).submits)).toBe(0);
		// A changed editor requires the existing checkpoint before another write.
		expect((await bridge.callTool("browser_click", { action_intent: "edit_form", target: await ref(name) })).isError).toBe(true);
		expect(await page.evaluate(() => (window as FixtureWindow).clicks)).toBe(1);
	});
	it.each(["Send record", "Submit application"])("retains final submission classification for %s", async (name) => {
		await checkpoint();
		expect((await bridge.callTool("browser_type", { target: await ref("Full name", "textbox"), text: "Jane Citizen", source_quote: "Name: Jane Citizen" })).isError).not.toBe(true);
		await bridge.callTool("browser_click", { action_intent: "edit_form", element: "Save", target: await ref(name) });
		expect(bridge.reviewReady).toBe(true);
		await untouched();
	});
	it.each([undefined, "share", "accept_terms"])("refuses a generic button without editing intent: %s", async (action_intent) => {
		await checkpoint();
		expect((await bridge.callTool("browser_click", { target: await ref("Save"), action_intent })).isError).toBe(true);
		await untouched();
	});

	it("requires the page checkpoint before editing", async () => {
		expect((await bridge.callTool("browser_click", { action_intent: "edit_form", target: await ref("Save") })).isError).toBe(true);
		await untouched();
	});
	it("never treats a failed current probe as a non-submit fact", async () => {
		await checkpoint();
		const target = await ref("Save");
		const actual = runtime.callTool.bind(runtime);
		vi.spyOn(runtime, "callTool").mockImplementation(async (name, args, options) => {
			if (name === "browser_evaluate" && args?.function === ELEMENT_PROBE_FN) return { content: [{ type: "text", text: "Target disappeared" }], isError: true };
			return actual(name, args, options);
		});
		expect((await bridge.callTool("browser_click", { action_intent: "edit_form", target })).isError).toBe(true);
		await untouched();
	});
	it.each([
		{ name: "Store entry", selector: 'input[type="button"]', attribute: "type", value: "checkbox" },
		{ name: "Fermer le panneau", selector: '[role="button"]', attribute: "role", value: "checkbox" },
		{ name: "Save", selector: '#controls button', attribute: "role", value: "checkbox" },
	])("refuses $name when its live semantics changed to an answer control", async ({ name, selector, attribute, value }) => {
		await checkpoint();
		const target = await ref(name);
		await page.locator(selector).evaluate((control, change) => control.setAttribute(change.attribute, change.value), { attribute, value });
		expect((await bridge.callTool("browser_click", { target, action_intent: "edit_form" })).isError).toBe(true);
		await untouched();
	});

	it("refuses a reference absent from the current observation", async () => {
		await checkpoint();
		expect((await bridge.callTool("browser_click", { action_intent: "edit_form", target: "notObserved" })).isError).toBe(true);
		await untouched();
	});
	it.each(["stop", "domain"])("rechecks %s after probing and before action dispatch", async (guard) => {
		await checkpoint();
		const target = await ref("Save");
		const actual = runtime.callTool.bind(runtime);
		vi.spyOn(runtime, "callTool").mockImplementation(async (name, args, options) => {
			const result = await actual(name, args, options);
			if (name === "browser_evaluate" && args?.function === ELEMENT_PROBE_FN) {
				if (guard === "stop") stopped = true;
				else allowed = false;
			}
			return result;
		});
		expect((await bridge.callTool("browser_click", { action_intent: "edit_form", target })).isError).toBe(true);
		await untouched();
	});
	it("still refuses invented field values beside generic controls", async () => {
		await checkpoint();
		expect((await bridge.callTool("browser_type", { target: await ref("Full name", "textbox"), text: "Invented Candidate", source_quote: "Name: Jane Citizen" })).isError).toBe(true);
		expect(await page.locator("#name").inputValue()).toBe("");
	});
});
