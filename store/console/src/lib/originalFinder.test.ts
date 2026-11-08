import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScopeNote } from "../tabs/settings/OriginalFinderSection";
import { historyLineView } from "./historyLine";
import { type FinderLead, type OriginalFinderOverview, countRows, finderLine, orderLeads, patchFromForm, formFromSettings, safeHref, termsFromText } from "./originalFinder";

const settings = { dailyCap: 10, roles: [], locations: ["remote"], exclude: [] };
const overview = (o: Partial<OriginalFinderOverview> = {}): OriginalFinderOverview => ({
	settings, scope: { roles: [], locations: [], exclude: [], source: "none" }, budget: { dailyCap: 10, usedToday: 4, remaining: 6 }, counts: { queued: 3 }, leads: [], ...o,
});
const lead = (id: string, state: string): FinderLead => ({ lead_id: id, state, attempts: 1, next_attempt_at: null, detail: null, original_url: null, updated_at: 0 });

describe("the status line's three states (#1616)", () => {
	it("Checking… while loading, with nothing to open", () => {
		expect(historyLineView({ status: "loading" })).toEqual({ text: "Checking…", tone: "muted", link: false });
	});
	it("remaining of cap and the queue once loaded, with the Activity link", () => {
		expect(historyLineView(finderLine(overview()))).toEqual({ text: "6 of 10 research runs left today · 3 waiting", tone: "muted", link: true });
		expect(historyLineView(finderLine(overview({ counts: {} })))?.text).toBe("6 of 10 research runs left today · 0 waiting");
	});
	it("Couldn't check with the link on failure", () => {
		expect(historyLineView({ status: "failed" })).toEqual({ text: "Couldn't check", tone: "muted", link: true });
	});
});

describe("the panel's ordering", () => {
	it("failed rows first, the rest keep the server's order", () => {
		expect(orderLeads([lead("a", "found"), lead("b", "failed"), lead("c", "queued"), lead("d", "failed")]).map((l) => l.lead_id)).toEqual(["b", "d", "a", "c"]);
	});
	it("counts: failed first, empty states dropped", () => {
		expect(countRows({ found: 4, failed: 1, queued: 0, queued2: 2 })).toEqual([{ state: "failed", n: 1 }, { state: "found", n: 4 }, { state: "queued2", n: 2 }]);
	});
});

describe("the form sends only what changed", () => {
	const saved = settings;
	it("budget only", () => {
		expect(patchFromForm({ ...formFromSettings(saved), dailyCap: "20" }, saved)).toEqual({ dailyCap: 20 });
	});
	it("nothing changed sends nothing; a list edit sends that list", () => {
		expect(patchFromForm(formFromSettings(saved), saved)).toEqual({});
		expect(patchFromForm({ ...formFromSettings(saved), roles: "Engineer\n\n  Designer " }, saved)).toEqual({ roles: ["Engineer", "Designer"] });
	});
	it("a blank budget is sent for the server to refuse", () => {
		expect(patchFromForm({ ...formFromSettings(saved), dailyCap: "" }, saved)).toEqual({ dailyCap: "" });
	});
	it("terms: one per line", () => expect(termsFromText("a\n b \n")).toEqual(["a", "b"]));
});

describe("original_url", () => {
	it("links only http(s)", () => {
		expect(safeHref("https://x.test/j")).toBe("https://x.test/j");
		expect(safeHref("javascript:alert(1)")).toBeNull();
		expect(safeHref(null)).toBeNull();
	});
});

describe("empty Roles shows the scope in force (static render)", () => {
	it("names the Runner line and the roles in force; says so when there are none", () => {
		const html = (roles: string[]) => renderToStaticMarkup(createElement(ScopeNote, { scope: { roles, locations: [], exclude: [], source: roles.length ? "runner" : "none" } }));
		expect(html(["platform engineer", "sre"])).toContain("Follows your Application Runner&#x27;s auto-submit roles: platform engineer, sre");
		expect(html([])).toContain("(none set yet)");
	});
});
