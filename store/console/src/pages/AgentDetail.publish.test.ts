/**
 * The console half of #793 — the settings form must not assert a state the server refused.
 *
 * ── What was reported, and what it actually was
 *
 * "Library says no published agents yet, but the agent's settings say published." The obvious
 * reading is a schema mismatch, and it is wrong: both ends read `agents.visibility`
 * (`agent-publish-library.test.ts` pins that end to end). What the reporter saw was the FORM
 * showing a value the server had rejected — `sVis` holds the user's selection, the save threw, and
 * the old `catch` alerted without re-reading, so the control went on saying `published` about a row
 * that never changed.
 *
 * ── What is asserted HERE, and what cannot be
 *
 * `saveSettings` is a closure over a dozen React state setters; testing it directly would mean
 * mounting the page, and this console has no component test harness (its UI is Playwright's job —
 * see `vitest.config.ts`'s note on why `.tsx` under pages/ stays excluded from coverage).
 *
 * So this file pins the two things that are checkable as VALUES rather than as rendering:
 * `isTestFixtureRefusal`, the predicate deciding whether the override is offered at all, and the
 * source-level ordering that the reload happens on every exit path. The second is a source guard
 * for the same reason `claim-retires-displaced.test.ts` has one: the defect is an ABSENCE — a
 * missing reload — and an absence in a closure is invisible to any unit test of it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isTestFixtureRefusal } from "./AgentDetail.js";

describe("isTestFixtureRefusal — is this the publish guard, or some other 400?", () => {
	/** The refusal `lib/test-agent-guard.ts` actually composes, copied verbatim. */
	const REAL = new Error(
		'This looks like a test fixture (matched "sandbox" in its slug, name or description) and would appear in the public catalog. Publish it with allowTestAgent: true if that is intended.',
	);

	it("recognises the real refusal", () => {
		expect(isTestFixtureRefusal(REAL)).toBe(true);
	});

	it("keys on the FLAG NAME, not the prose around it", () => {
		// The wording is a sentence someone will improve. The flag is the API contract. A predicate
		// matched on "This looks like a test fixture" would stop offering the override the day the
		// copy is edited — silently, and presenting as "publishing is broken" all over again.
		expect(isTestFixtureRefusal(new Error("Refused: pass allowTestAgent: true to publish it."))).toBe(true);
		expect(isTestFixtureRefusal(new Error("This looks like a test fixture and cannot be published."))).toBe(false);
	});

	it("does NOT claim an unrelated failure", () => {
		// Offering "publish it anyway?" for a 403 or a network drop would invite a retry that
		// cannot work, and would bury the real reason behind a dialog about fixtures.
		for (const m of ["Not your agent", "Agent not found", "Failed to fetch", "Nothing to update", "API 500"]) {
			expect(isTestFixtureRefusal(new Error(m)), m).toBe(false);
		}
	});

	it("is safe on things that are not Errors at all", () => {
		// `catch (e)` catches anything a throw can carry.
		for (const v of [null, undefined, "allowTestAgent", { message: "allowTestAgent" }, 42]) {
			expect(isTestFixtureRefusal(v)).toBe(false);
		}
	});
});

describe("saveSettings re-reads the server on EVERY exit path (#793)", () => {
	const src = readFileSync(new URL("./AgentDetail.tsx", import.meta.url).pathname, "utf8");
	const body = src.slice(src.indexOf("const saveSettings ="), src.indexOf("const deleteAgent ="));

	it("read a plausible function — G1, so a moved handler fails loudly", () => {
		expect(body.length, "saveSettings was not found in AgentDetail.tsx — this file is measuring nothing").toBeGreaterThan(400);
		// Spelled by concatenation so the literal is not itself a template placeholder — biome reads
		// `${…}` inside a plain string as a mistake, and here it is the exact text being asserted.
		expect(body).toContain("/v1/agents/$\{id}");
	});

	it("reloads in the CATCH — the defect this ticket is about", () => {
		// Without this the form keeps the user's rejected selection on screen. Everything else in
		// #793 followed from that one missing call.
		const catchBlock = body.slice(body.lastIndexOf("} catch (e) {"));
		expect(catchBlock, "a failed save must re-read the server before reporting").toContain("loadAgent()");
	});

	it("reloads BEFORE the success alert, not after", () => {
		// `alert()` blocks, so the old order left the just-saved values unrendered until the dialog
		// was dismissed — the one moment a user looks hardest at this form.
		const reload = body.indexOf("await loadAgent();");
		const ok = body.indexOf('alert("Saved!")');
		expect(reload).toBeGreaterThan(-1);
		expect(ok).toBeGreaterThan(-1);
		expect(reload, "loadAgent() must precede the success alert").toBeLessThan(ok);
	});

	it("reloads when the user DECLINES the override, too", () => {
		// Declining leaves `published` selected with the server still on draft — the same stale
		// assertion, reached by a different door.
		expect(body).toContain("confirm(");
		const declined = body.slice(body.indexOf("confirm("), body.indexOf("allowTestAgent: true"));
		expect(declined, "declining the override must also re-read the server").toContain("loadAgent()");
	});

	it("retries with allowTestAgent only after the user confirms", () => {
		// The override is a question, never an automatic escalation: silently republishing past a
		// guard the platform raised would defeat #65 from the client side.
		const confirmAt = body.indexOf("confirm(");
		const retryAt = body.indexOf("allowTestAgent: true");
		expect(confirmAt).toBeGreaterThan(-1);
		expect(retryAt).toBeGreaterThan(confirmAt);
	});
});
