/** Browser screenshots (#1064): where the switch shows, and the replay's empty state for a run started with it off. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RunReplay from "../components/RunReplay";
import { takesBrowserScreenshots } from "./browserScreenshots";
import { SCREENSHOTS_OFF_TEXT } from "./runReplay";

const SRC = join(__dirname, "..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("the Settings card shows for every agent whose runs take frames — and only those", () => {
	it.each(["browser", "local_browser", "local_apply"])("runtime %s", (runtime) => {
		expect(takesBrowserScreenshots({ runtime, surfaces: [] })).toBe(true);
	});

	it("the legacy apply agent (apply surface, workflow-driven)", () => {
		expect(takesBrowserScreenshots({ runtime: null, surfaces: ["apply"] })).toBe(true);
	});

	it.each([["coding"], ["local_artifact"], [null]])("not runtime %s with no apply surface", (runtime) => {
		expect(takesBrowserScreenshots({ runtime, surfaces: ["coding"] })).toBe(false);
	});

	it("the Settings tab renders the card from that predicate", () => {
		expect(read("lib/surfaces.tsx")).toContain("takesScreenshots={takesBrowserScreenshots(caps)}");
		expect(read("tabs/SettingsTab.tsx")).toContain("{takesScreenshots && <BrowserScreenshotsSection instanceId={instanceId} />}");
	});
});

describe("the replay's empty state for a run started with screenshots OFF", () => {
	it("is a statement of what happened and how to change it — not a missing frame", () => {
		const html = renderToStaticMarkup(createElement(RunReplay, { frames: [], emptyText: SCREENSHOTS_OFF_TEXT }));
		expect(html).toContain('data-testid="replay-empty"');
		expect(html).toContain("Screenshots were off for this run");
		expect(html).toContain("Turn it on in Settings");
	});

	it.each([
		["pages/RunDetail.tsx", "screenshotsOff ? SCREENSHOTS_OFF_TEXT :"],
		["tabs/research/ResearchRunView.tsx", "(frames.length > 0 || screenshotsOff) && <RunReplay frames={frames} emptyText={SCREENSHOTS_OFF_TEXT} />"],
		["tabs/ApplicationsTab.tsx", "(frames.length > 0 || screenshotsOff) && ("],
	])("%s shows it from the run's own record", (file, wiring) => {
		const src = read(file);
		expect(src).toContain("const { artifacts, screenshotsOff } = useBrowserArtifacts(");
		expect(src).toContain(wiring);
	});

	it("the flag comes from the server's list response, never inferred from an empty list", () => {
		expect(read("components/RunReplay.tsx")).toContain("screenshotsOff: r.screenshotsOff === true");
	});
});
