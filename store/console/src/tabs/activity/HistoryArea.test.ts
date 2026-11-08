import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import HistoryArea from "./HistoryArea";
import { activityViewFromSearch } from "../../lib/activityView";

const render = (caps: { runtime?: string | null; surfaces?: string[] }, search = "") =>
	renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HistoryArea, { instanceId: "i1", caps, view: activityViewFromSearch(new URLSearchParams(search)) })));

// Static render runs no effects, so no panel has answered: the loading state. Real requests are e2e/activity-history.spec.ts's.
describe("History area, static render (#1590)", () => {
	it("holds only the panels this agent's capabilities allow", () => {
		const coding = render({ runtime: "coding", surfaces: ["coding"] });
		for (const id of ["loop-runs", "secure-inputs", "deliveries"]) expect(coding).toContain(`history-panel-${id}`);
		for (const id of ["takeovers", "browser-launch"]) expect(coding).not.toContain(`history-panel-${id}`);
		const scout = render({ runtime: "local_browser", surfaces: ["chat"] });
		for (const id of ["loop-runs", "takeovers", "browser-launch", "secure-inputs", "deliveries"]) expect(scout).toContain(`history-panel-${id}`);
	});
	it("panels with no rows render nothing, and the empty line is not asserted before the panels answered", () => {
		const html = render({ runtime: "local_browser", surfaces: [] }, "view=history");
		expect(html).not.toContain("Nothing waiting and no recent history");
		expect(html).not.toContain("<h3");
	});
});
