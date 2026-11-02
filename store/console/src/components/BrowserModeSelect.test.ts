import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import BrowserModeSelect from "./BrowserModeSelect";
import { BrowserModeSettings, type BrowserModeView } from "../tabs/settings/BrowserModeSection";

const view = (overrides: Partial<BrowserModeView> = {}) => renderToStaticMarkup(createElement(BrowserModeSettings, {
	data: { mode: null, agentDefault: null, effective: null, source: "runner", explained: "Visible mode needs a desktop session. Screenshot replay works in either mode.", ...overrides },
	saving: false, message: "", onChange: () => undefined,
}));

describe("browser mode settings show inherited and explicit choices accurately", () => {
	it("does not claim an unknown runner fallback is headless or headed", () => {
		const html = view();
		expect(html).toContain("Effective setting: Runner default (no agent or instance override)");
		expect(html).toContain('<option value="" selected="">Use agent default (Runner default)</option>');
	});
	it("shows the effective agent setting while keeping the inheritance option selected", () => {
		const html = view({ agentDefault: "headed", effective: "headed", source: "agent" });
		expect(html).toContain("Effective setting: Visible browser (from agent)");
		expect(html).toContain('<option value="" selected="">Use agent default (Visible browser)</option>');
	});
	it("shows an instance override separately from the agent default", () => {
		const html = view({ mode: "headless", agentDefault: "headed", effective: "headless", source: "instance" });
		expect(html).toContain("Effective setting: Headless browser (instance override)");
		expect(html).toContain('<option value="headless" selected="">Headless browser</option>');
		expect(html).toContain("Use agent default (Visible browser)");
		expect(html).toContain("current tasks continue unchanged");
	});
	it("disables further choices while a change is saving and offers both modes", () => {
		const html = renderToStaticMarkup(createElement(BrowserModeSelect, { value: "headed", inheritLabel: "Use runner default", disabled: true, onChange: () => undefined }));
		expect(html).toMatch(/<select[^>]*disabled=""/);
		expect(html).toContain('<option value="headed" selected="">Visible browser</option>');
		expect(html).toContain('<option value="headless">Headless browser</option>');
	});
});
