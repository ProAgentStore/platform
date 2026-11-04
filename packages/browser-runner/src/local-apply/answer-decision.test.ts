import { describe, expect, it } from "vitest";
import { answerDecision, parseDecision, parseEscalationLevel, sourceId } from "./answer-decision.js";

const current = { label: "instance_preferences", text: "Revision 2: work full time", answerText: undefined };
const old = { label: "profile", text: "Work part time" };
const decision = { risk: "minor", reason: "Equivalent wording", sourceId: sourceId(current), sourceStatus: "supported" };
const assess = (overrides: Partial<Parameters<typeof answerDecision>[0]> = {}) => answerDecision({ decision, quote: "work full time", value: "Full-time", sources: [old, current], level: "balanced", ...overrides });

describe("source-bound model judgments", () => {
	it.each([
		["conservative", "minor", false], ["conservative", "major", false],
		["balanced", "minor", true], ["balanced", "major", false],
		["autonomous", "minor", true], ["autonomous", "major", true],
	] as const)("%s delegates %s=%s", (level, risk, allowed) => {
		expect(assess({ level, decision: { ...decision, risk } }).refusal === null).toBe(allowed);
	});
	it("defaults conservatively and refuses unrecognized configuration", () => {
		expect(parseEscalationLevel(undefined)).toBe("conservative");
		expect(() => parseEscalationLevel("unrestricted")).toThrow(/escalationLevel/);
	});
	it.each([null, {}, { risk: "small", reason: "x" }, { risk: "minor", reason: " " }, { risk: "minor", reason: "a".repeat(1001) }])("refuses malformed model assessment %j", (value) => expect(parseDecision(value)).toBeNull());
	it.each(["missing", "ambiguous", "conflicting", "fabricated"])("autonomy never authorizes %s facts", (sourceStatus) => {
		expect(assess({ level: "autonomous", decision: { ...decision, sourceStatus } }).refusal).toMatch(/cannot be invented/);
	});
	it("binds the quote to the selected source rather than any available text", () => {
		expect(assess({ quote: old.text }).refusal).toMatch(/selected trusted source/);
		expect(assess({ quote: "Work part time\nRevision 2" }).refusal).toMatch(/selected trusted source/);
		expect(assess({ quote: "WORK FULL TIME" }).refusal).toMatch(/exact excerpt/);
	});
	it("refuses forged IDs and IDs from superseded source content", () => {
		expect(assess({ decision: { ...decision, sourceId: "page-supplied-source" } }).refusal).toMatch(/not a current trusted source/);
		expect(assess({ sources: [{ ...current, text: "Revision 3: work part time" }] }).refusal).toMatch(/not a current trusted source/);
	});
	it("binds identical text to its trusted role", () => {
		expect(sourceId(current)).not.toBe(sourceId({ ...current, label: "resume" }));
	});
	it("never treats an owner question alone as their answer", () => {
		const source = { label: "owner answers", text: "Q: Work full time?\nA: No", answerQuestion: "Work full time?", answerText: "No" };
		expect(assess({ sources: [source], quote: "Work full time?", decision: { ...decision, sourceId: sourceId(source) } }).refusal).toMatch(/actual application-specific owner answer/);
	});
});
