/**
 * Settings sub-tabs (#1589): every section is reachable in exactly one sub-tab. Rendered for real
 * (server-side markup, a router carrying `?subtab=`), asserted by `data-testid` — not by reading the source.
 * Clicking, typing and request counting are Playwright's (e2e/settings-subtabs.spec.ts, #282).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import SettingsTab from "./SettingsTab";
import { SETTINGS_SUBTABS, type SettingsSubtab } from "../lib/settingsSubtab";

// Everything on: a coding Gmail Scout that is also a repo agent, so every gated section can show.
function render(subtab: SettingsSubtab | null, over: { isCoding?: boolean; isRepo?: boolean } = {}) {
	return renderToStaticMarkup(
		createElement(
			MemoryRouter,
			{ initialEntries: [subtab ? `/?subtab=${subtab}` : "/"] },
			createElement(SettingsTab, {
				instanceId: "inst-1",
				instanceName: "Scout",
				isApply: false,
				isCoding: over.isCoding ?? true,
				isRepo: over.isRepo ?? true,
				isLocalBrowser: true,
				isGmailScout: true,
				takesScreenshots: true,
				caps: { runtime: "local_browser", surfaces: ["chat", "settings"] },
				onUnsubscribe: () => undefined,
			}),
		),
	);
}

const SECTIONS: Record<SettingsSubtab, string[]> = {
	agent: ["agent-settings", "settings-brain-section", "pilot-model", "settings-coding-section", "local-browser", "gmail-scout"],
	browser: ["browser-verification", "browser-screenshots", "browser-mode"],
	automation: ["runner", "actions-runner", "teamwork", "loop-presets", "loop-runs", "triggers"],
	notifications: ["notification-policy"],
	instructions: ["operator-manual", "connection-guide"],
	general: [
		"instance-info",
		"settings-board-maintenance",
		"settings-where-things-live",
		"voice-translation",
		"settings-home-screen-shortcut",
		"settings-maintenance",
		"settings-pause",
		"settings-danger-zone",
	],
};

const has = (html: string, id: string) => html.includes(`data-testid="${id}"`) || html.includes(`data-testid="settings-section-${id}"`);

describe("every Settings section is reachable in exactly one sub-tab", () => {
	for (const tab of SETTINGS_SUBTABS) {
		it(`${tab} renders its own sections and none of the others'`, () => {
			const html = render(tab);
			for (const id of SECTIONS[tab]) expect(has(html, id), `${id} on ${tab}`).toBe(true);
			for (const other of SETTINGS_SUBTABS.filter((t) => t !== tab)) {
				for (const id of SECTIONS[other]) expect(has(html, id), `${id} must not render on ${tab}`).toBe(false);
			}
		});
	}

	it("no param, and an unknown value, open Agent", () => {
		expect(has(render(null), "gmail-scout")).toBe(true);
		expect(render(null)).not.toContain("settings-danger-zone");
	});
});

describe("the default sub-tab", () => {
	it("never holds the Danger zone", () => {
		expect(render(null)).not.toContain('data-testid="settings-danger-zone"');
		expect(render("agent")).not.toContain("Danger zone");
	});
	it("General ends with it", () => {
		const html = render("general");
		expect(html.indexOf('data-testid="settings-danger-zone"')).toBeGreaterThan(html.indexOf('data-testid="settings-pause"'));
	});
});

describe("General keeps its cards in the order the issue gives", () => {
	it("Instance info, Board maintenance, Where things live, Voice, Shortcut, Maintenance, Pause, Danger zone", () => {
		const html = render("general");
		const at = SECTIONS.general.map((id) => html.indexOf(id === "instance-info" || id.startsWith("voice") ? `settings-section-${id}` : id));
		expect(at.every((n) => n >= 0)).toBe(true);
		expect(at).toEqual([...at].sort((a, b) => a - b));
	});
	it("shows the repo connection inside Instance info only for a repo agent", () => {
		expect(render("general", { isRepo: true })).toContain("Instance ID");
	});
});

describe("Instructions holds the manual and the guide, General neither", () => {
	it("OperatorManualCard and ConnectionGuide are not on General", () => {
		const general = render("general");
		expect(general).not.toContain("settings-section-operator-manual");
		expect(general).not.toContain("settings-section-connection-guide");
		expect(render("instructions")).toContain("settings-section-operator-manual");
	});
});

describe("Brain and Coding stay two sections, and the engine card is not inside the Brain's (#1043)", () => {
	it("Brain's section comes first and holds no CodingEngineCard; Pilot sits between them", () => {
		const html = render("agent");
		const brain = html.indexOf('data-testid="settings-brain-section"');
		const pilot = html.indexOf('data-testid="settings-section-pilot-model"');
		const coding = html.indexOf('data-testid="settings-coding-section"');
		expect(brain).toBeGreaterThan(-1);
		expect(pilot).toBeGreaterThan(brain);
		expect(coding).toBeGreaterThan(pilot);
		expect(html.slice(brain, pilot)).not.toContain("Coding — edits");
		expect(html.slice(coding)).toContain("Coding — edits, tests and deploys");
	});
});

/** The Agent sub-tab for one fixture's gating booleans (#1592). */
function renderAgent(gates: { isCoding?: boolean; isLocalBrowser?: boolean; isGmailScout?: boolean; withFields?: boolean }) {
	return renderToStaticMarkup(
		createElement(
			MemoryRouter,
			{ initialEntries: ["/?subtab=agent"] },
			createElement(SettingsTab, {
				instanceId: "inst-1",
				instanceName: "Agent",
				isApply: false,
				isCoding: gates.isCoding ?? false,
				isRepo: gates.isCoding ?? false,
				isLocalBrowser: gates.isLocalBrowser ?? false,
				isGmailScout: gates.isGmailScout ?? false,
				takesScreenshots: false,
				caps: gates.isCoding ? { runtime: "coding", surfaces: ["coding"] } : { runtime: "local_browser", surfaces: ["chat", "settings"] },
				onUnsubscribe: () => undefined,
			}),
		),
	);
}

/** Where each marker first appears in the markup, in the order given; fails if any is missing. */
function orderOf(html: string, ids: string[]) {
	const at = ids.map((id) => html.indexOf(`data-testid="${id}"`));
	expect(at.every((n) => n >= 0), `missing in ${ids.join(", ")}: ${at.join(",")}`).toBe(true);
	return at;
}

describe("the Agent sub-tab puts what the agent does first (#1592)", () => {
	it("Gmail Scout: Gmail source, Research, then Brain; no Pilot and no Coding", () => {
		const html = renderAgent({ isGmailScout: true, isLocalBrowser: true });
		const at = orderOf(html, ["settings-section-gmail-scout", "settings-section-local-browser", "settings-brain-section"]);
		expect(at).toEqual([...at].sort((a, b) => a - b));
		expect(html).not.toContain('data-testid="settings-coding-section"');
		expect(html).not.toContain('data-testid="settings-section-pilot-model"');
	});

	it("Coding agent: Brain, then the Pilot, then a separate Coding section; no Research or Gmail source", () => {
		const html = renderAgent({ isCoding: true });
		const at = orderOf(html, ["settings-brain-section", "settings-section-pilot-model", "settings-coding-section"]);
		expect(at).toEqual([...at].sort((a, b) => a - b));
		expect(html).toContain("Coding — edits, tests and deploys");
		expect(html).not.toContain('data-testid="settings-section-local-browser"');
		expect(html).not.toContain('data-testid="settings-section-gmail-scout"');
	});

	it("shows no Agent settings heading when the agent declares no fields", () => {
		expect(renderAgent({ isGmailScout: true, isLocalBrowser: true })).not.toContain("Agent settings");
	});

	it("keeps the repo connection in General, not Agent", () => {
		expect(renderAgent({ isCoding: true })).not.toContain("Instance ID");
	});
});

describe("the tab bar", () => {
	it("is plain buttons, marks the selected one, and is not a nav", () => {
		const html = render("browser");
		expect(html).not.toMatch(/<nav\b/);
		expect(html).toMatch(/data-testid="settings-subtab-browser"[^>]*aria-current="true"|aria-current="true"[^>]*data-testid="settings-subtab-browser"/);
		expect((html.match(/aria-current="true"/g) ?? []).length).toBe(1);
	});
});

// The card lives in settings/InstanceInfo.tsx (#911); General mounts it (asserted above by render).
const SRC = readFileSync(join(__dirname, "settings", "InstanceInfo.tsx"), "utf8");

describe("SettingsTab displays the instance ID for deep links (#909)", () => {
		it("renders an Instance ID card with the instanceId", () => {
		expect(SRC).toContain('data-testid="instance-id-value"');
		expect(SRC).toContain("{instanceId}");
		expect(SRC).toContain("Instance ID");
	});

	it("provides a copy button for the instance ID", () => {
		expect(SRC).toContain('data-testid="instance-id-copy-button"');
		expect(SRC).toContain("copyInstanceId");
		expect(SRC).toContain("Copy ID");
	});

	it("includes documentation about using the instance ID for deep links", () => {
		expect(SRC).toContain("deep links");
		expect(SRC).toContain("secure-inputs");
	});
});
