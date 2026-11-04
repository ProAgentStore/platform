import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LocalBrowserWebsiteFields from "./LocalBrowserWebsiteFields";
import type { WebsiteAccessMode } from "../../lib/websiteAccess";

const props = {
	allowDomains: ["legacy.example.com"],
	form: { allowDomains: "legacy.example.com", denyDomains: "blocked.example.com" },
	sites: [{ id: "decision-1", scope: "navigate" as const, domain: "legacy.example.com", decision: "allow" as const, decidedAt: 1, expiresAt: null }],
	set: () => {},
	decide: () => {},
};

describe("research website settings", () => {
	it.each<WebsiteAccessMode>(["allow_all", "allowlist", "ask_once"])("hides inactive legacy navigation controls with explicit %s access", (mode) => {
		const html = renderToStaticMarkup(createElement(LocalBrowserWebsiteFields, { ...props, websiteAccess: { mode, domains: [] } }));
		expect(html).toContain("Website access is managed in Browser settings.");
		for (const inactive of ["Allowed sites", "Never visit", "Your decisions", "legacy.example.com", "textarea", "button"]) expect(html).not.toContain(inactive);
	});
	it("keeps legacy controls and their remembered choices when no explicit mode is effective", () => {
		const html = renderToStaticMarkup(createElement(LocalBrowserWebsiteFields, props));
		for (const active of ["Allowed sites", "Never visit", "Your decisions", "legacy.example.com", "Forget legacy.example.com"]) expect(html).toContain(active);
		expect(html).not.toContain("Website access is managed in Browser settings.");
	});
});
