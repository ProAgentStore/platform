/**
 * Standing auto-submit, made unmistakable (#1039): the warning and confirmation, the policy summary,
 * the danger banner, and the exact requests — rendered for real with react-dom/server, so what is
 * asserted is the markup an owner sees.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AutoSubmitConfirmDialog, AutoSubmitDangerBanner, ManualReviewBadge, PolicySummary } from "../components/AutoSubmitPolicy";
import { AUTO_SUBMIT_ACKNOWLEDGEMENT, AUTO_SUBMIT_DANGER, AUTO_SUBMIT_WARNING, type AutoSubmitRules, buildPolicySummary, disablePayload, enablePayload, rulesPayload } from "./autoSubmitPolicy";

const RULES: AutoSubmitRules = { allowDomains: ["boards.greenhouse.io"], roles: ["engineer"], locations: ["sydney", "remote"], exclude: ["contract"], minSalary: 120000, dailyCap: 3 };
const ALLOWANCE = { dailyCap: 3, usedToday: 1, remaining: 2 };
const noop = () => {};
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/&amp;/g, "&");

describe("the policy summary (#1039)", () => {
	it("states every rule the gate checks, and the allowance left today", () => {
		expect(buildPolicySummary(RULES, ALLOWANCE)).toEqual([
			{ label: "Allowed sites", value: "boards.greenhouse.io" },
			{ label: "Approved roles", value: "engineer" },
			{ label: "Locations", value: "sydney, remote" },
			{ label: "Excluded when the job mentions", value: "contract" },
			{ label: "Minimum salary", value: "120,000" },
			{ label: "Daily cap", value: "3 per 24 hours" },
			{ label: "Remaining today", value: "2 of 3" },
		]);
	});

	it("says what an empty rule means instead of hiding it", () => {
		const rows = Object.fromEntries(buildPolicySummary({ allowDomains: [], roles: [], locations: [], exclude: [], minSalary: null, dailyCap: 0 }).map((r) => [r.label, r.value]));
		expect(rows).toMatchObject({ "Allowed sites": "none — no application qualifies", Locations: "any location", "Excluded when the job mentions": "nothing excluded", "Minimum salary": "no minimum", "Remaining today": "not known yet" });
	});

	it("renders as a list of the exact rules", () => {
		const out = html(createElement(PolicySummary, { rules: RULES, allowance: ALLOWANCE }));
		for (const v of ["boards.greenhouse.io", "engineer", "sydney, remote", "contract", "120,000", "3 per 24 hours", "2 of 3"]) expect(out).toContain(v);
	});
});

describe("the confirmation before enabling (#1039)", () => {
	const dialog = (acknowledged: boolean) => html(createElement(AutoSubmitConfirmDialog, { rules: RULES, allowance: ALLOWANCE, acknowledged, onAcknowledge: noop, onConfirm: noop, onCancel: noop }));

	it("warns that submissions are real and irreversible, and shows the rules that will apply", () => {
		const out = dialog(false);
		expect(out).toContain(AUTO_SUBMIT_WARNING);
		expect(out).toContain(AUTO_SUBMIT_ACKNOWLEDGEMENT);
		expect(out).toContain('data-testid="auto-submit-policy-summary"');
		expect(out).toContain("boards.greenhouse.io");
		expect(out).toMatch(/role="dialog"/);
	});

	it("Confirm & Enable stays disabled until the acknowledgement is ticked", () => {
		const button = (out: string) => out.match(/<button[^>]*data-testid="auto-submit-confirm-enable"[^>]*>/)?.[0] ?? "";
		expect(button(dialog(false))).toMatch(/ disabled=""/);
		expect(button(dialog(true))).not.toMatch(/ disabled=""/);
		expect(dialog(true)).toContain("Confirm & Enable");
	});
});

describe("the danger state and the default (#1039)", () => {
	it("a persistent banner with the active rules and a one-click disable while it is on", () => {
		const out = html(createElement(AutoSubmitDangerBanner, { rules: RULES, allowance: ALLOWANCE, onDisable: noop }));
		expect(out).toContain(AUTO_SUBMIT_DANGER);
		expect(out).toMatch(/role="alert"/);
		expect(out).toMatch(/data-testid="auto-submit-disable"[^>]*>Disable now/);
		expect(out).toContain("2 of 3");
	});

	it("a Manual review badge by default", () => {
		expect(html(createElement(ManualReviewBadge))).toContain("Manual review (default)");
	});
});

describe("the requests (#1039)", () => {
	it("disable is one request that needs nothing else", () => {
		expect(disablePayload()).toEqual({ autoSubmit: { enabled: false } });
	});

	it("enable carries the rules shown and the acknowledgement the server requires", () => {
		expect(enablePayload(RULES)).toEqual({
			allowDomains: ["boards.greenhouse.io"],
			autoSubmit: { enabled: true, roles: ["engineer"], locations: ["sydney", "remote"], exclude: ["contract"], minSalary: 120000, dailyCap: 3 },
			acknowledgeRealSubmissions: true,
		});
	});

	it("saving the rules can never switch auto-submit on", () => {
		const body = rulesPayload(RULES, { profile: "profile.md", answers: null });
		expect((body.autoSubmit as Record<string, unknown>).enabled).toBeUndefined();
		expect(body).not.toHaveProperty("acknowledgeRealSubmissions");
	});

	it("the card no longer offers a plain checkbox that enables auto-submit", () => {
		const tab = readFileSync(join(__dirname, "../tabs/ApplicationsTab.tsx"), "utf8");
		expect(tab).not.toMatch(/Enable auto-submit for applications that match this policy/);
		expect(tab).not.toMatch(/enabled: e\.target\.checked/);
		expect(tab).toContain("<AutoSubmitConfirmDialog");
		expect(tab).toContain("<AutoSubmitDangerBanner");
	});
});
