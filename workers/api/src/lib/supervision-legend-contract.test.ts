/**
 * A field a supervision legend names must exist in the payload beside it (#594).
 *
 * ── The failure
 *
 * `subordinate_status`'s `STATUS_LEGEND` and `check_delegation`'s `actsLegend` both told the model:
 *
 *   "An act with `ok: false` FAILED and one with `ok: null` was not observed to succeed."
 *
 * `ActItem` never declared `ok` and `toActItem` never read it, so the payload had never carried
 * the key — for months, in two places, while `engine-acts.ts` was writing the value into
 * `agent_events.context` all along. A model told to check a key that is absent reads the absence
 * as "fine", which inverts the intended default for an unobserved act: the legend existed to stop
 * a supervisor reporting an unverified merge as done, and its own gap caused exactly that.
 *
 * This is the same class as #585 (a description recommending a field the code had replaced) and
 * #589 (a comment asserting an agreement that no longer held). Prose next to data is believed.
 *
 * ── What this guard measures, and what it does NOT (ADR 0002)
 *
 * #594 AC5 asks for the general property — every field named in ANY tool description exists in
 * that tool's payload — with a denominator over all descriptions. That is not buildable today and
 * saying so is part of the measurement: most of this platform's ~100 tools `JSON.stringify` an
 * ad-hoc object with no declared payload type, so "the tool's payload type" does not exist to
 * compare against, and a fixture farm covering all of them would be a larger artefact than the
 * thing it guards.
 *
 * So the scope is the SUPERVISION family, where the payload is a pure function of its inputs and
 * can be built here in full. The denominator is stated as what it is: N backticked field paths
 * extracted from these legends, checked against a fully-populated payload. The general form is
 * left open on the issue rather than approximated.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STATUS_LEGEND } from "./subordinate-payload.js";
import { recentActsForInstances } from "./instance-work.js";
import type { Env } from "../types.js";

/** Every `field` and `a.b` path a legend names in backticks, minus the prose that also uses them. */
function fieldsNamedIn(legend: string): string[] {
	const out = new Set<string>();
	for (const m of legend.matchAll(/`([A-Za-z_][A-Za-z0-9_]*(?:\[\])?(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(?::\s*[^`]*)?`/g)) {
		const path = m[1];
		if (path) out.add(path);
	}
	return [...out];
}

/** The acts a real read produces, from a trace row shaped exactly as `engine-acts.ts` writes it. */
async function actsFromTrace(context: string) {
	const row = { instance_id: "i1", trace_id: "run-1", message: "merged a pull request #42", context, ts: 500 };
	const env = {
		DB: {
			prepare: () => ({ bind: () => ({ all: async () => ({ results: [row] }) }) }),
		},
	} as unknown as Env;
	return recentActsForInstances(env, "u1", ["i1"]);
}

describe("the supervision legends describe the payload that ships with them (#594 AC5)", () => {
	it("extracts a plausible number of field names, or it has stopped measuring", () => {
		// G1: an extractor that matches nothing passes every assertion below it. The legend is
		// thousands of characters of prose about named fields; a handful means the regex broke.
		const named = fieldsNamedIn(STATUS_LEGEND);
		expect(named.length, `${named.length} backticked field paths in STATUS_LEGEND (${STATUS_LEGEND.length} chars)`).toBeGreaterThan(10);
	});

	it("names `acts[].ok`, and the payload delivers it", async () => {
		// The specific promise, and the specific gap. Both halves asserted: a guard that only
		// checked the payload would pass on a legend that had quietly dropped the sentence, and one
		// that only checked the legend is what shipped.
		expect(STATUS_LEGEND, "the legend no longer teaches `ok` — if that is deliberate, the field's own docblock must change too").toContain("`ok: false`");
		const [act] = await actsFromTrace(JSON.stringify({ act: "pr.merge", ok: false, irreversible: true }));
		expect(act, "the legend names `ok` and the payload has no such key").toHaveProperty("ok");
		expect(act.ok).toBe(false);
	});

	it("delivers every one of the three states the sentence distinguishes", async () => {
		// "false FAILED · null not observed" is a three-way claim (true is the unstated third), and
		// a payload that can only produce two of them makes the sentence false by omission.
		const states = new Map<string, boolean | null>();
		for (const [label, ctx] of [
			["observed success", JSON.stringify({ act: "pr.merge", ok: true })],
			["observed failure", JSON.stringify({ act: "pr.merge", ok: false })],
			["not observed", JSON.stringify({ act: "pr.merge" })],
		] as const) {
			const [act] = await actsFromTrace(ctx);
			states.set(label, act.ok);
		}
		expect([...states.entries()]).toEqual([
			["observed success", true],
			["observed failure", false],
			["not observed", null],
		]);
		expect(states.size, `${states.size} outcome states the legend distinguishes, all reachable`).toBe(3);
	});

	/**
	 * The promise has to name the list it governs (#597).
	 *
	 * `ok` is obtainable for CONSEQUENTIAL acts and not for an ordinary tool call: #581 AC7's
	 * per-tool-call record has no outcome field because the runner computes `block.is_error`
	 * (`headless.ts:750`) and `toolResult()` writes the row without it (`:676`). Closing that needs
	 * a runner change, a CLI publish and users upgrading — #597.
	 *
	 * So the sentence is TRUE of `acts` and would be FALSE the moment `acts` grew to include tool
	 * calls. An unscoped promise is how a legend outlives the data it describes, which is the whole
	 * class this file guards; naming the scope is what makes the promise checkable.
	 */
	it("says WHICH acts it governs, so the promise cannot be inherited by a list that cannot keep it", async () => {
		expect(STATUS_LEGEND, "the `ok` sentence must name the acts it covers").toMatch(/CONSEQUENTIAL acts only/);
		expect(STATUS_LEGEND).toMatch(/not the agent's ordinary tool calls/);
		// …and the scope claim is TRUE of the reader: it keys on the generic consequential event
		// and nothing else, so no tool-call row can reach this list without changing that constant.
		const src = readFileSync(new URL("./instance-work.ts", import.meta.url).pathname, "utf-8");
		expect(src).toContain('const ACT_EVENT = "act.consequential"');
		expect(src.match(/ACT_EVENT/g)?.length, "one event name, used by both act reads").toBeGreaterThanOrEqual(3);
	});

	it("every act field the legend names is on the item the reader returns", async () => {
		// The general property, over the fields this family's legend actually promises about acts.
		// `acts` itself is the list; the rest are per-item keys.
		const PROMISED = ["kind", "summary", "command", "irreversible", "ok", "traceId", "at"] as const;
		const [act] = await actsFromTrace(JSON.stringify({ act: "pr.merge", ok: null, irreversible: true, command: "gh pr merge 42" }));
		const missing = PROMISED.filter((f) => !(f in act));
		expect(missing, `${PROMISED.length} act fields checked against the payload`).toEqual([]);
	});
});
