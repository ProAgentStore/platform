import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProfileChoice, ProfileInputs } from "../../lib/browserProfileChoice";
import { BrowserProfileChoices, inputsFrom } from "./BrowserProfileSection";

const CHECKBOX = "I allow research in my signed-in profile";
const base: ProfileInputs = { browserProfile: "isolated", instanceEngine: null, instanceProfile: null, agentEngine: null, agentProfile: null };
const render = (inputs: ProfileInputs, chosen: ProfileChoice | null = null, profileAllowed = false) =>
	renderToStaticMarkup(createElement(BrowserProfileChoices, { inputs, chosen, profileAllowed, onChoose: () => {}, onConsent: () => {} }));

describe("the one browser-profile control (#1601)", () => {
	it("offers exactly the four approved choices, in order", () => {
		const html = render(base);
		const labels = ["A fresh browser each time", "A browser profile kept for this agent", "Your own browser profile, with your sign-ins", "Use the agent’s default (now: A fresh browser each time)"];
		let from = 0;
		for (const l of labels) {
			const at = html.indexOf(l.replace("’", "&#x27;").replace("’", "’"), from) >= 0 ? html.indexOf(l.replace("’", "&#x27;"), from) : html.indexOf(l, from);
			expect(at, l).toBeGreaterThanOrEqual(from);
			from = at;
		}
		expect((html.match(/type="radio"/g) ?? []).length).toBe(4);
	});

	it("shows the choice that takes effect, and nothing else is selected", () => {
		expect((render({ ...base, instanceProfile: "persistent" }).match(/checked=""/g) ?? []).length).toBe(1);
		expect(render({ ...base, instanceProfile: "persistent" })).toMatch(/checked="" [^>]*\/?>(<span>)?A browser profile kept for this agent|A browser profile kept for this agent/);
	});

	it("disables your own profile with the reason while an engine is chosen, and never asks for consent then", () => {
		const html = render({ ...base, browserProfile: "default", instanceEngine: "chrome" }, "own", true);
		expect(html).toContain('data-testid="own-profile-blocked"');
		expect(html).toContain("cannot be used while a browser is chosen in Browser settings");
		const own = /<input[^>]*aria-describedby="browser-profile-own-note"[^>]*\/>/.exec(html)?.[0] ?? "";
		expect(own).toContain('disabled=""');
		expect(own).not.toContain("checked");
		// What takes effect is shown instead: a profile kept by the runner, never the owner's.
		expect(html).toMatch(/checked=""[^>]*\/><span>A browser profile kept for this agent/);
		expect(html).not.toContain(CHECKBOX);
	});

	it("uses the agent-default wording when only the agent's defaults block it", () => {
		const html = render({ ...base, agentProfile: "persistent" });
		expect(html).toContain("while this agent&#x27;s default browser or profile applies".replace("&#x27;", "’"));
		expect(html).toContain('data-testid="own-profile-blocked"');
	});

	it("always carries the real-profile caveat on choice 3 when it is usable, and asks for consent only once it is the choice", () => {
		const unchosen = render(base);
		expect(unchosen).toContain('data-testid="own-profile-caveat"');
		expect(unchosen).toContain("only on machines set up for it");
		expect(unchosen).not.toContain(CHECKBOX);
		expect(render(base, "own")).toContain(CHECKBOX);
		expect(render({ ...base, browserProfile: "default" })).toContain(CHECKBOX); // saved as own: consent shown as today
	});

	it("builds its inputs from the loaded view without recomputing the launch path", () => {
		const view = { mode: null, engine: "chrome", profile: null, websiteAccess: null, agentDefaults: { mode: null, engine: null, profile: "persistent", websiteAccess: null }, effective: { mode: null, engine: "chrome", profile: "persistent", websiteAccess: null }, launchPath: "managed", sources: { mode: "runner", engine: "instance", profile: "agent" }, requiredCli: "0.4.198", explained: "" } as const;
		expect(inputsFrom("default", view as never)).toEqual({ browserProfile: "default", instanceEngine: "chrome", instanceProfile: null, agentEngine: null, agentProfile: "persistent" });
	});
});
