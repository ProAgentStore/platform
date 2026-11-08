/**
 * #1238, #1596 — what an instance's Settings shows of the layers it inherits: one collapsed line above the instance's own
 * editor (the editor marked as the addendum that wins); the account's layer first and the template's next once expanded.
 * Nothing at all when nothing is inherited.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InheritedLayers, InheritedLayersBody } from "./OperatorManualCard";

const render = (account: string, inherited: string) => renderToStaticMarkup(createElement(InheritedLayers, { account, inherited }));
const text = (html: string) => html.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'");
const body = (account: string, inherited: string) => renderToStaticMarkup(createElement(InheritedLayersBody, { account, inherited }));

describe("InheritedLayers", () => {
	it("renders nothing when nothing is inherited", () => {
		expect(render("", "")).toBe("");
	});

	it("is collapsed by default: one line naming both layers, no layer text, the addendum marker after it", () => {
		const html = render("Main only, no PRs.", "Checkouts are home-relative.");
		expect(text(html)).toContain("Also follows your account manual and this agent's template manual · Show");
		expect(html).toContain('aria-expanded="false"');
		expect(html).not.toContain("<pre");
		expect(html).not.toContain("Main only, no PRs.");
		expect(html.indexOf("Also follows")).toBeLessThan(html.indexOf("This instance"));
		expect(html).toContain("an addendum that wins where they conflict");
	});

	it("names only the layer that exists", () => {
		expect(text(render("A", ""))).toContain("Also follows your account manual · Show");
		expect(render("A", "")).not.toContain("template manual");
		expect(text(render("", "T"))).toContain("Also follows this agent's template manual · Show");
		expect(render("", "T")).not.toContain("account manual");
	});
});

describe("InheritedLayersBody (what Show reveals)", () => {
	it("account only: the account section, no template section", () => {
		const html = body("Main only, no PRs.", "");
		expect(html).toContain("Inherited from your account");
		expect(html).toContain("Main only, no PRs.");
		expect(html).not.toContain("Inherited from template");
	});

	it("template only", () => {
		const html = body("", "Checkouts are home-relative.");
		expect(html).toContain("Inherited from template");
		expect(html).not.toContain("Inherited from your account");
	});

	it("both: the account first, the template next", () => {
		const html = body("A", "T");
		expect(html.indexOf("Inherited from your account")).toBeGreaterThanOrEqual(0);
		expect(html.indexOf("Inherited from template")).toBeGreaterThan(html.indexOf("Inherited from your account"));
		expect(html).toContain('data-testid="operator-manual-account"');
		expect(html).toContain('data-testid="operator-manual-inherited"');
	});

	it("shows the text as text, not markup", () => {
		expect(body("<b>x</b>", "")).toContain("&lt;b&gt;x&lt;/b&gt;");
	});
});
