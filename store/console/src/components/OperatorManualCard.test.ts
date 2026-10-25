/**
 * #1238 — what an instance's Settings shows of the layers it inherits: the account's manual first, the template's next, then the
 * instance's own marked as the addendum that wins. Nothing at all when nothing is inherited.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InheritedLayers } from "./OperatorManualCard";

const render = (account: string, inherited: string) => renderToStaticMarkup(createElement(InheritedLayers, { account, inherited }));

describe("InheritedLayers", () => {
	it("renders nothing when nothing is inherited", () => {
		expect(render("", "")).toBe("");
	});

	it("account only: the account section, then the instance addendum marker", () => {
		const html = render("Main only, no PRs.", "");
		expect(html).toContain("Inherited from your account");
		expect(html).toContain("Main only, no PRs.");
		expect(html).not.toContain("Inherited from template");
		expect(html).toContain("an addendum that wins where they conflict");
	});

	it("template only: unchanged from #1237", () => {
		const html = render("", "Checkouts are home-relative.");
		expect(html).toContain("Inherited from template");
		expect(html).not.toContain("Inherited from your account");
	});

	it("both: the account first, the template next, the instance marker last", () => {
		const html = render("A", "T");
		const a = html.indexOf("Inherited from your account");
		const t = html.indexOf("Inherited from template");
		const i = html.indexOf("This instance");
		expect(a).toBeGreaterThanOrEqual(0);
		expect(t).toBeGreaterThan(a);
		expect(i).toBeGreaterThan(t);
		expect(html).toContain('data-testid="operator-manual-account"');
		expect(html).toContain('data-testid="operator-manual-inherited"');
	});

	it("shows the text as text, not markup", () => {
		expect(render("<b>x</b>", "")).toContain("&lt;b&gt;x&lt;/b&gt;");
	});
});
