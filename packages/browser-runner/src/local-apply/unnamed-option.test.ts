import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ELEMENT_PROBE_FN } from "../commit-guard.js";
import { McpRuntime } from "../mcp-runtime.js";
import { ApplyBridge, type ApplyBridgeHost } from "./bridge.js";

const SOURCE = "Preferred city: Melbourne\nOffice: Melbourne Victoria, Australia";
const CONTENTS = [
	{ label: "nested paragraph", html: '<div role="option" tabindex="0"><section><p>Melbourne</p></section></div>', value: "Melbourne" },
	{ label: "rich list item", html: '<li role="option" tabindex="0"><p>Melbourne</p><p>Victoria, Australia</p></li>', value: "Melbourne Victoria, Australia" },
	{ label: "labelledby paragraph", html: '<div role="option" aria-labelledby="choice" tabindex="0"><p id="choice">Melbourne</p></div>', value: "Melbourne" },
	{ label: "empty aria label", html: '<div role="option" aria-label="" tabindex="0"><p>Melbourne</p></div>', value: "Melbourne" },
];
function form(options: string) {
	return `<h1>Application</h1><label>City<input id="city"></label><ul role="listbox">${options}</ul><script>
window.selections = 0;
for(const option of document.querySelectorAll('[role=option]'))option.onclick=()=>{window.selections++;document.querySelector('#city').value='chosen';};
</script>`;
}

describe("grounded answers to unnamed snapshot options", () => {
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
		page = await context.newPage();
		runtime = new McpRuntime();
		await runtime.start({ context, activePage: () => page });
		stopped = false;
		allowed = true;
		const host: ApplyBridgeHost = {
			emit: () => {}, pause: async () => "stopped", supervisorCheckpoint: async () => "continue",
			isAllowed: (domain) => allowed && ["options.test", "frame.test"].includes(domain), grounding: () => SOURCE,
			artifactPath: () => ({ error: "No fixture artifacts" }), overTime: () => false, isStopped: () => stopped, now: Date.now,
			limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 }, mode: "fill_and_review",
		};
		bridge = new ApplyBridge(runtime, host);
		runtime.setCallPolicy({ isCancelled: () => stopped, isDomainAllowed: host.isAllowed });
	});
	afterEach(async () => { vi.restoreAllMocks(); await runtime.stop(); await context.close(); });
	afterAll(async () => { await browser.close(); });
	async function open(html = CONTENTS[0].html, iframe = false, checkpoint = true) {
		await context.route("https://**/*", (route) => route.fulfill({ contentType: "text/html", body: iframe && route.request().url().includes("options.test") ? '<h1>Application</h1><iframe src="https://frame.test/form"></iframe>' : form(html) }));
		await bridge.callTool("browser_navigate", { url: "https://options.test/form" });
		const snapshot = await bridge.callTool("browser_snapshot");
		const text = snapshot.content.map((block) => block.text ?? "").join("\n");
		const target = text.match(/option[^\n]*\[ref=(\w+)\]/)?.[1];
		if (!target) throw new Error(text);
		if (checkpoint) await bridge.callTool("supervisor_checkpoint", { checkpointId: "fixture", phase: "initial" });
		return { target, text, frame: iframe ? page.frames()[1] : page.mainFrame() };
	}
	const click = (target: string, answer_value: unknown = "Melbourne", source_quote = "Preferred city: Melbourne") => bridge.callTool("browser_click", { target, answer_value, source_quote });
	async function untouched() {
		for (const frame of page.frames()) if (await frame.locator("#city").count()) expect(await frame.locator("#city").inputValue()).toBe("");
		expect(bridge.filled).toBe(0);
	}
	it.each(CONTENTS)("selects $label using model text verified against native accessible name", async ({ html, value }) => {
		const { target, text, frame } = await open(html);
		expect(text).toContain(`option [ref=${target}]`);
		const calls = vi.spyOn(runtime, "callTool");
		const result = await click(target, value, value === "Melbourne" ? "Preferred city: Melbourne" : "Office: Melbourne Victoria, Australia");
		expect(result.isError, JSON.stringify(result)).not.toBe(true);
		expect(await frame.locator("#city").inputValue()).toBe("chosen");
		const forwarded = calls.mock.calls.find(([name]) => name === "browser_click");
		expect(forwarded?.[1]).not.toHaveProperty("answer_value");
		expect(forwarded?.[2]).toMatchObject({ expectedAccessibility: { role: "option", name: value } });
	});
	it("resolves an iframe option in its actual owner frame", async () => {
		const { target, frame } = await open(CONTENTS[0].html, true);
		expect(target).toMatch(/^f\d+e\d+$/);
		expect((await click(target)).isError).not.toBe(true);
		expect(await frame.locator("#city").inputValue()).toBe("chosen");
	});
	it.each([undefined, "", "Sydney"])("refuses missing or incorrect candidate %s", async (value) => {
		const { target } = await open();
		expect((await bridge.callTool("browser_click", { target, answer_value: value, source_quote: "Preferred city: Melbourne" })).isError).toBe(true);
		await untouched();
	});
	it("requires the exact owner source even for a correct native name", async () => {
		const { target } = await open();
		expect((await click(target, "Melbourne", "Invented source: Melbourne")).isError).toBe(true);
		await untouched();
	});
	it("does not substitute text content for a conflicting aria-labelledby name", async () => {
		const { target } = await open('<span id="label">Sydney</span><div role="option" aria-labelledby="label" tabindex="0"><p>Melbourne</p></div>');
		expect((await click(target)).isError).toBe(true);
		await untouched();
	});
	it("cannot select a different same-name option to satisfy the observed ref", async () => {
		const { target } = await open('<div role="option" tabindex="0"><p>Sydney</p></div><div role="option" tabindex="0"><p>Melbourne</p></div>');
		expect((await click(target)).isError).toBe(true);
		await untouched();
	});
	it("rejects a stale role even with caller-supplied fake accessibility properties", async () => {
		const { target, frame } = await open();
		await frame.locator('[role="option"]').evaluate((el) => el.setAttribute("role", "button"));
		expect((await bridge.callTool("browser_click", { target, answer_value: "Melbourne", source_quote: "Preferred city: Melbourne", expectedAccessibility: { role: "button", name: "Melbourne" } })).isError).toBe(true);
		await untouched();
	});
	it("refuses native submit buttons posing as options", async () => {
		const { target } = await open('<form method="post" onsubmit="event.preventDefault()"><button role="option"><p>Melbourne</p></button></form>');
		expect((await click(target)).isError).toBe(true);
		await untouched();
	});
	it.each(["role", "label", "native_submit", "detached"])("rechecks %s changes after the bridge probe", async (change) => {
		const html = change === "native_submit" ? '<form method="post"><button role="option" type="button"><p>Melbourne</p></button></form>' : CONTENTS[0].html;
		const { target, frame } = await open(html);
		const actual = runtime.callTool.bind(runtime);
		vi.spyOn(runtime, "callTool").mockImplementation(async (name, args, opts) => {
			const result = await actual(name, args, opts);
			if (name === "browser_evaluate" && args?.function === ELEMENT_PROBE_FN) await frame.locator('[role="option"]').evaluate((el, mutation) => {
				if (mutation === "role") el.setAttribute("role", "button");
				else if (mutation === "label") el.setAttribute("aria-label", "Sydney");
				else if (mutation === "native_submit") el.setAttribute("type", "submit");
				else el.replaceWith(el.cloneNode(true));
			}, change);
			return result;
		});
		expect((await click(target)).isError).toBe(true);
		await untouched();
	});
	it("cannot use a same-name option in another frame to satisfy this ref", async () => {
		const { target } = await open('<div role="option" tabindex="0"><p>Sydney</p></div><iframe srcdoc="<div role=option tabindex=0><p>Melbourne</p></div>"></iframe>');
		expect(page.frames()).toHaveLength(2);
		expect((await click(target)).isError).toBe(true);
		await untouched();
	});

	it("requires the supervisor checkpoint", async () => {
		const { target } = await open(CONTENTS[0].html, false, false);
		expect((await click(target)).isError).toBe(true);
		await untouched();
	});
	it.each(["stop", "domain"])("rechecks %s after the native probe", async (guard) => {
		const { target } = await open();
		const actual = runtime.callTool.bind(runtime);
		vi.spyOn(runtime, "callTool").mockImplementation(async (name, args, opts) => {
			const result = await actual(name, args, opts);
			if (name === "browser_evaluate" && args?.function === ELEMENT_PROBE_FN) {
				if (guard === "stop") stopped = true;
				else allowed = false;
			}
			return result;
		});
		expect((await click(target)).isError).toBe(true);
		await untouched();
	});
	it("does not broaden paragraph clicks into answers", async () => {
		const { text } = await open();
		const target = text.match(/paragraph[^\n]*\[ref=(\w+)\]/)?.[1];
		expect((await click(target!)).isError).toBe(true);
		await untouched();
	});
});
