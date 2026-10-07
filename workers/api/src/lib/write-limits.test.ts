/** Refuse, don't slice, on write (#898). */
import { describe, expect, it } from "vitest";
import { normalizeRunnerTaskBody } from "../routes/instances-runtime.js";
import { loopPresetsRefusal } from "./loop-presets.js";
import { assertJobKey, overLimit, ticketOverLimit } from "./write-limits.js";

describe("overLimit", () => {
	it("names the field, its length and the limit, and says nothing was saved", () => {
		expect(overLimit({ description: ["d".repeat(2345), 2000] })).toBe("`description` is 2,345 characters; the limit is 2,000. Shorten it (or split it) and send it again — nothing was saved.");
	});

	it("passes values at the limit, and non-strings", () => {
		expect(overLimit({ a: ["x".repeat(10), 10], b: [undefined, 1], c: [42, 1] })).toBeNull();
	});
});

describe("every write path that used to slice now refuses", () => {
	it("a ticket's description past 2,000 — the field that held the acceptance criteria", () => {
		expect(ticketOverLimit({ title: "t", description: "d".repeat(2001) })).toMatch(/`description` is 2,001 characters/);
		expect(ticketOverLimit({ title: "t", description: "d".repeat(2000), reasoning: "r".repeat(8000) })).toBeNull();
	});

	it("a runner task's type, title or approval prompt", () => {
		expect(() => normalizeRunnerTaskBody({ type: "x".repeat(121) })).toThrow(/`type` is 121 characters; the limit is 120/);
		expect(() => normalizeRunnerTaskBody({ type: "apply", description: "d".repeat(501) })).toThrow(/`description` is 501/);
		expect(normalizeRunnerTaskBody({ type: "apply", title: "t".repeat(200) }).title).toHaveLength(200);
	});

	it("a loop preset list that is too long, or a preset past its label/objective limit", () => {
		expect(loopPresetsRefusal(Array.from({ length: 13 }, (_, i) => ({ label: `p${i}`, objective: "o" })))).toMatch(/13 presets were sent; the limit is 12/);
		expect(loopPresetsRefusal([{ label: "ok", objective: "o".repeat(1001) }])).toMatch(/`presets\[0\]\.objective` is 1,001 characters/);
		expect(loopPresetsRefusal([{ label: "ok", objective: "fine" }])).toBeNull();
	});

	it("a board job key — an id, which a cut would merge with another", () => {
		expect(() => assertJobKey("k".repeat(401))).toThrow(/`jobKey` is 401 characters; the limit is 400/);
		expect(() => assertJobKey("k".repeat(400))).not.toThrow();
	});
});
