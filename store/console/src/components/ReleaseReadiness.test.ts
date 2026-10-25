/**
 * #1350 — the readiness block prints the PR-merge runner note whether or not the gate reads ready: it is advice about a
 * different delivery route, not a reason a direct push cannot publish.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Readiness } from "../lib/releaseGate";
import ReleaseReadiness from "./ReleaseReadiness";

const NOTE = "Pull request merges need CLI 0.4.180 or newer. The runner on mac is 0.4.179: direct pushes are fine, but a PR merge it makes is held until you run `pags update`.";
const render = (verdict: Readiness) => renderToStaticMarkup(createElement(ReleaseReadiness, { verdict }));

describe("the readiness block", () => {
	it("says ready and still shows the merge note", () => {
		const html = render({ ready: true, items: [], notes: [NOTE] });
		expect(html).toContain("Ready to publish");
		expect(html).toContain("release-readiness-notes");
		expect(html).toContain("Pull request merges need CLI 0.4.180 or newer");
	});
	it("shows the note beside the blockers when not ready", () => {
		const html = render({ ready: false, items: [{ id: "no_channel", text: "No channel is granted." }], notes: [NOTE] });
		expect(html).toContain("Not ready to publish");
		expect(html).toContain("No channel is granted.");
		expect(html).toContain("release-readiness-notes");
	});
	it("prints no notes list when there is nothing to add", () => {
		expect(render({ ready: true, items: [], notes: [] })).not.toContain("release-readiness-notes");
	});
});
