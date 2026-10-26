import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DISABLE_REASON_MAX, DISABLED_INSTANCES_PATH, describeDisabled, isPaused, MY_INSTANCES_WITH_PAUSED, pausePanel } from "./instancePause";

/**
 * The Pause control's words and its one comparison (#825).
 *
 * `agent_instances.status = 'paused'` sat in the schema's declared domain with no writer for a
 * year, and `lib/status-domain.ts` recorded WHY it stayed that way: shipping the writer without
 * the console control is what makes a half-working feature. So the assertions here are as much
 * about the control existing and saying the right thing as about the function.
 */
describe("pausePanel", () => {
	it("offers DISABLE for an active instance", () => {
		const p = pausePanel("active");
		expect(p.action).toBe("disable");
		expect(p.button).toMatch(/Disable/);
	});

	it("offers ENABLE for a disabled (paused) one", () => {
		const p = pausePanel("paused");
		expect(p.action).toBe("enable");
		expect(p.button).toMatch(/Enable/);
		expect(p.title).toBe("Disabled");
	});

	it("shows the pause half for a status this build has not been taught", () => {
		// The safe direction to be wrong in: offering the reversible control on an unfamiliar
		// state, where the server refuses what it cannot do. Defaulting to RESUME would show an
		// agent as paused because the console did not recognise a word.
		for (const status of ["suspended", "", null, undefined]) {
			expect(pausePanel(status).action, String(status)).toBe("disable");
		}
	});

	it("says what pause KEEPS — the whole difference from the control beside it", () => {
		// Cancel is one card below. If this panel does not say the subscription survives, the two
		// read as the same button with different wording.
		const p = pausePanel("active");
		expect(p.statement).toMatch(/without unsubscribing/i);
		expect(p.statement).toMatch(/kept/i);
		// And that chat still works, which is the reason an owner pauses after a failed run.
		expect(p.statement).toMatch(/chat/i);
	});

	it("says enable does NOT restart what the disable stopped", () => {
		expect(pausePanel("paused").statement).toMatch(/does not restart/i);
	});

	it("names no confirmation, because the control is reversible", () => {
		// `unsubscribeScope` next door builds a `confirm` string; this deliberately does not, and
		// ceremony on the safe control is what teaches people to click through the dangerous one.
		expect(Object.keys(pausePanel("active"))).toEqual(["title", "statement", "button", "action"]);
	});
});

describe("isPaused", () => {
	it("matches the server's word and nothing near it", () => {
		expect(isPaused("paused")).toBe(true);
		for (const near of ["Paused", "PAUSED", "active", "canceled", "", null, undefined]) {
			expect(isPaused(near), String(near)).toBe(false);
		}
	});
});

describe("the control is wired in", () => {
	const card = readFileSync(join(import.meta.dirname, "..", "components", "PauseCard.tsx"), "utf8");
	const tab = readFileSync(join(import.meta.dirname, "..", "tabs", "SettingsTab.tsx"), "utf8");
	// The card and the Danger zone both moved into settings/MiscellaneousSection.tsx at #911.
	const misc = readFileSync(join(import.meta.dirname, "..", "tabs", "settings", "MiscellaneousSection.tsx"), "utf8");

	it("renders the panel rather than composing its own sentence", () => {
		expect(card).toContain("pausePanel(status)");
		expect(card).toContain("{panel.statement}");
		expect(card).toContain("{panel.button}");
	});

	it("writes BOTH paths out in full, so the parity check can see them", () => {
		// A template segment the extractor cannot resolve reports as one unmeasurable capability
		// `POST /v1/instances/{}/{}`, which made `check-mcp-parity.mjs` fail on a gap that does not
		// exist — `disable_instance` and `enable_instance` cover these. Two literals keep the
		// measurement true.
		expect(card).toContain("/disable`");
		expect(card).toContain("/enable`");
		// Written without the interpolation braces: spelling them here trips
		// `noTemplateCurlyInString`, which is the lint doing its job on a test that forbids the
		// very pattern it has to name.
		expect(card).not.toContain("panel.action}");
	});

	it("takes the new status from the RESPONSE, not from which button was pressed", () => {
		// The routes are idempotent and answer `changed:false` when the state already held, so
		// trusting the press would show "Resume" after a pause that was already in effect.
		expect(card).toContain("setStatus(d.status ?? null)");
	});

	it("reports runs as ASKED to stop, never as stopped", () => {
		expect(card).toMatch(/asked to stop/);
		expect(card).not.toMatch(/runs? stopped\b/);
	});

	it("is mounted on the Settings tab, ABOVE the Danger zone", () => {
		// Anchored on the HEADING, not the words "Danger zone" — two doc comments upstream mention
		// it, and indexOf would have measured a comment rather than the card.
		const heading = 'text-danger">Danger zone';
		expect(tab).toContain('import MiscellaneousSection from "./settings/MiscellaneousSection"');
		expect(tab).toContain("<MiscellaneousSection");
		expect(misc).toContain("<PauseCard instanceId={instanceId}");
		expect(misc).toContain(heading);
		expect(misc.indexOf("<PauseCard")).toBeLessThan(misc.indexOf(heading));
	});

	it("keeps paused instances available to detail and Settings views (#826)", () => {
		const hook = readFileSync(join(import.meta.dirname, "..", "hooks", "useInstanceRecord.ts"), "utf8");
		expect(MY_INSTANCES_WITH_PAUSED).toBe("/v1/instances/my/instances?includePaused=1");
		expect(hook).toContain("MY_INSTANCES_WITH_PAUSED");
		expect(tab).toContain("MY_INSTANCES_WITH_PAUSED");
	});
});

describe("the record of a disable (#1383)", () => {
	it("says when, by whom and why — only the parts that are known", () => {
		expect(describeDisabled({ at: "2026-10-27 01:02:03", by: "u1", reason: "duplicate" }, "u1")).toBe("Disabled 2026-10-27 by you — duplicate");
		expect(describeDisabled({ at: "2026-10-27 01:02:03", by: "u9", reason: null }, "u1")).toBe("Disabled 2026-10-27 by another session");
		expect(describeDisabled({ at: null, by: null, reason: "idle" })).toBe("Disabled — idle");
	});

	it("an instance paused without a record says so, rather than inventing one", () => {
		for (const none of [null, undefined, { at: null, by: null, reason: null }]) {
			expect(describeDisabled(none)).toMatch(/no record of when, by whom or why/);
		}
	});

	it("bounds the reason input to what the server accepts", () => {
		expect(DISABLE_REASON_MAX).toBe(500);
	});
});

describe("the Disabled page is wired in (#1383)", () => {
	const src = (...parts: string[]) => readFileSync(join(import.meta.dirname, "..", ...parts), "utf8");
	const page = src("pages", "Disabled.tsx");

	it("reads the dedicated list and enables with the literal route, so the parity check can see it", () => {
		expect(DISABLED_INSTANCES_PATH).toBe("/v1/instances/my/disabled-instances");
		expect(page).toContain("DISABLED_INSTANCES_PATH");
		expect(page).toContain("/enable`");
		expect(page).not.toContain("panel.action}");
	});

	it("is routed and reachable from the nav, and the card links to it", () => {
		expect(src("App.tsx")).toContain('<Route path="disabled" element={<Disabled />} />');
		expect(src("components", "Layout.tsx")).toContain('to: "/disabled"');
		expect(src("components", "PauseCard.tsx")).toContain('to="/disabled"');
	});

	it("refreshes from the server after an enable rather than dropping the row locally", () => {
		expect(page).toMatch(/await load\(\)/);
	});

	it("never offers a delete: the page enables and nothing else", () => {
		expect(page).not.toMatch(/method: "DELETE"|cancel_instance|\/cancel/);
	});
});
