import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPaused, MY_INSTANCES_WITH_PAUSED, pausePanel } from "./instancePause";

/**
 * The Pause control's words and its one comparison (#825).
 *
 * `agent_instances.status = 'paused'` sat in the schema's declared domain with no writer for a
 * year, and `lib/status-domain.ts` recorded WHY it stayed that way: shipping the writer without
 * the console control is what makes a half-working feature. So the assertions here are as much
 * about the control existing and saying the right thing as about the function.
 */
describe("pausePanel", () => {
	it("offers PAUSE for an active instance", () => {
		const p = pausePanel("active");
		expect(p.action).toBe("pause");
		expect(p.button).toMatch(/Pause/);
	});

	it("offers RESUME for a paused one", () => {
		const p = pausePanel("paused");
		expect(p.action).toBe("resume");
		expect(p.button).toMatch(/Resume/);
	});

	it("shows the pause half for a status this build has not been taught", () => {
		// The safe direction to be wrong in: offering the reversible control on an unfamiliar
		// state, where the server refuses what it cannot do. Defaulting to RESUME would show an
		// agent as paused because the console did not recognise a word.
		for (const status of ["suspended", "", null, undefined]) {
			expect(pausePanel(status).action, String(status)).toBe("pause");
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

	it("says resume does NOT restart what the pause stopped", () => {
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

	it("renders the panel rather than composing its own sentence", () => {
		expect(card).toContain("pausePanel(status)");
		expect(card).toContain("{panel.statement}");
		expect(card).toContain("{panel.button}");
	});

	it("writes BOTH paths out in full, so the parity check can see them", () => {
		// A template segment the extractor cannot resolve reports as one unmeasurable capability
		// `POST /v1/instances/{}/{}`, which made `check-mcp-parity.mjs` fail on a gap that does not
		// exist — `pause_instance` and `resume_instance` cover these. Two literals keep the
		// measurement true.
		expect(card).toContain("/pause`");
		expect(card).toContain("/resume`");
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
		expect(tab).toContain("<PauseCard instanceId={instanceId}");
		expect(tab.indexOf("<PauseCard")).toBeLessThan(tab.indexOf(heading));
	});

	it("keeps paused instances available to detail and Settings views (#826)", () => {
		const hook = readFileSync(join(import.meta.dirname, "..", "hooks", "useInstanceRecord.ts"), "utf8");
		expect(MY_INSTANCES_WITH_PAUSED).toBe("/v1/instances/my/instances?includePaused=1");
		expect(hook).toContain("MY_INSTANCES_WITH_PAUSED");
		expect(tab).toContain("MY_INSTANCES_WITH_PAUSED");
	});
});
