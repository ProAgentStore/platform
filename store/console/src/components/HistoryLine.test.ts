import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import HistoryLine from "./HistoryLine";
import { deliveriesLine, loopRunsLine, takeoversLine } from "../lib/historyLine";

const render = (state: Parameters<typeof HistoryLine>[0]["state"], panel: Parameters<typeof HistoryLine>[0]["panel"] = "loop-runs") =>
	renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HistoryLine, { instanceId: "i/1", panel, state, testId: "line" })));

describe("HistoryLine, static render (#1590)", () => {
	it("Checking… has no link and no verdict", () => {
		const html = render({ status: "loading" });
		expect(html).toContain("Checking…");
		expect(html).not.toContain("<a");
		expect(html).not.toContain("No runs waiting");
	});
	it("a failed fetch reads Couldn't check · View in Activity", () => {
		const html = render({ status: "failed" }, "takeovers");
		expect(html).toContain("Couldn&#x27;t check");
		expect(html).toContain("View in Activity");
		expect(html).toContain('href="/instances/i%2F1/activity?view=history&amp;panel=takeovers"');
	});
	it("waiting runs read N waiting for you in warning tone, linking to the panel", () => {
		const html = render(loopRunsLine(2));
		expect(html).toContain("2 waiting for you");
		expect(html).toContain("text-warning");
		expect(html).toContain("panel=loop-runs");
	});
	it("no waiting runs is a muted line, not a warning", () => {
		const html = render(loopRunsLine(0));
		expect(html).toContain("No runs waiting");
		expect(html).not.toContain("text-warning");
	});
	it("the cards with no line render nothing", () => {
		expect(render(takeoversLine(0), "takeovers")).toBe("");
		expect(render(deliveriesLine(0), "deliveries")).toBe("");
		expect(render(deliveriesLine(3), "deliveries")).toContain("3 undelivered");
	});
});
