/**
 * #986 — the Applications card shows how far the fill GOT, in the server's own words.
 *
 * The sentence is not written here, and that is the property this pins: the Board card, this card
 * and an MCP reader all carry the shared execution projection's `progress.label`
 * (`workers/api/src/lib/applications/fill-progress.ts`), which is what stopped a card from saying
 * "Filled — waiting for your review before anything is sent" about a run whose own checkpoint
 * reported `filled: 0, uploaded: 0`. Checked on the source, as the console's other wiring tests
 * are; the projection's behaviour is the API's and is tested there.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { maskComments } from "../lib/jsx-tags.js";

const src = maskComments(readFileSync(new URL("./ApplicationsTab.tsx", import.meta.url), "utf8"));

const face = maskComments(readFileSync(new URL("../components/ApplicationRunFace.tsx", import.meta.url), "utf8"));

describe("ApplicationsTab — the fill's progress (#986)", () => {
	it("renders the server's sentence rather than composing one from the status", () => {
		expect(src).toContain('data-testid="run-progress"');
		expect(src).toContain("{progress.label}");
	});

	it("shows the counts the sentence rests on, so a claim of filled work is falsifiable", () => {
		expect(src).toMatch(/progress\.filled/);
		expect(src).toMatch(/progress\.uploaded/);
		expect(src).toMatch(/progress\.checkpointPhase/);
	});

	it("never states filled work in its own words", () => {
		// The literal the issue was filed about, and any sibling of it, must not exist in this file:
		// whether a form is filled is the runner's measurement, never a string the console chooses.
		expect(src).not.toMatch(/Filled\b/);
		expect(src).not.toMatch(/waiting for your review/);
	});
});

describe("ApplicationRunFace — the board card says the same thing (#986)", () => {
	it("names the KIND of run in its prefix, and never asserts filling over the stage", () => {
		// "Filling:" was printed in front of EVERY fill stage, so "Paused before form filling —
		// nothing has been entered yet" rendered under a bold claim that it was filling.
		expect(face).toContain('{app.kind === "tailor" ? "Tailoring" : "Fill"}');
		expect(face).not.toContain('"Filling"');
	});

	it("carries the counts the stage sentence rests on", () => {
		expect(face).toMatch(/app\.progress\.filled/);
		expect(face).toMatch(/app\.progress\.uploaded/);
		expect(face).toMatch(/progress\?: \{ stage: string; label: string; filled: number; uploaded: number/);
	});
});
