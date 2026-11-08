import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LocalBrowserWebsiteFields from "./LocalBrowserWebsiteFields";

const props = {
	allowDomains: ["legacy.example.com"],
	form: { allowDomains: "legacy.example.com", denyDomains: "blocked.example.com" },
	sites: [{ id: "decision-1", scope: "navigate" as const, domain: "legacy.example.com", decision: "allow" as const, decidedAt: 1, expiresAt: null }],
	set: () => {},
	decide: () => {},
};

describe("legacy site lists", () => {
	it("render the lists and the remembered choices", () => {
		const html = renderToStaticMarkup(createElement(LocalBrowserWebsiteFields, props));
		for (const active of ["Allowed sites", "Never visit", "Your decisions", "legacy.example.com", "Forget legacy.example.com"]) expect(html).toContain(active);
	});
});
