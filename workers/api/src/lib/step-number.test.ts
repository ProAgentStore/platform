import { describe, expect, it } from "vitest";
import { parseStepNumber, stepNumberError } from "./step-number.js";

describe("parseStepNumber — absent, zero and unreadable are three different things", () => {
	it("treats only undefined/null as absent, so the handler's default applies", () => {
		expect(parseStepNumber(undefined)).toEqual({ kind: "absent" });
		expect(parseStepNumber(null)).toEqual({ kind: "absent" });
	});

	it("accepts finite numbers, including an explicit 0 (a real request)", () => {
		expect(parseStepNumber(0)).toEqual({ kind: "value", value: 0 });
		expect(parseStepNumber(50)).toEqual({ kind: "value", value: 50 });
		expect(parseStepNumber(-3)).toEqual({ kind: "value", value: -3 });
		expect(parseStepNumber(2.7)).toEqual({ kind: "value", value: 2.7 });
	});

	it("accepts numeric strings — a $param off a settings field arrives as text", () => {
		expect(parseStepNumber("50")).toEqual({ kind: "value", value: 50 });
		expect(parseStepNumber("  4 ")).toEqual({ kind: "value", value: 4 });
		expect(parseStepNumber("0")).toEqual({ kind: "value", value: 0 });
	});

	it("rejects what `Number(x) || 0` silently mapped to zero", () => {
		// This is the whole bug (#243): every one of these used to become 0, and 0 means
		// "keep nothing" to slice, while an ABSENT value means "keep everything".
		for (const bad of ["", "   ", "fifty", "abc", false, true, [], {}, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(parseStepNumber(bad).kind, `expected ${JSON.stringify(bad)} to be invalid`).toBe("invalid");
		}
	});

	it("says WHY, in words a pipeline author can act on", () => {
		expect(parseStepNumber("")).toEqual({ kind: "invalid", reason: "is blank" });
		expect(parseStepNumber("fifty")).toEqual({ kind: "invalid", reason: '"fifty" is not a number' });
		expect(parseStepNumber(false)).toEqual({ kind: "invalid", reason: "false is not a number" });
		expect(parseStepNumber([1])).toEqual({ kind: "invalid", reason: "a list is not a number" });
	});
});

describe("stepNumberError", () => {
	it("names the tool, the field, the reason and where to look", () => {
		const msg = stepNumberError("slice", "limit", "is blank", "leave it unset to keep all");
		expect(msg).toContain("slice");
		expect(msg).toContain('"limit"');
		expect(msg).toContain("is blank");
		expect(msg).toContain("$param");
	});
});
