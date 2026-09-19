import { describe, expect, it } from "vitest";
import { MAX_ITERATIONS_CAP, sanitizeMaxIterations } from "./agent-loop.js";
import {
	clampIterations,
	hasLoopLimits,
	MAX_CONFIGURABLE_ITERATIONS,
	PILOT_DEFAULT_MAX_STEPS,
	sanitizeLoopLimitsConfig,
} from "./loop-limits.js";

/** What the start paths actually compute: the account clamp, then the instance clamp. */
function effective(requested: unknown, limits: Parameters<typeof clampIterations>[1], ceiling = MAX_ITERATIONS_CAP) {
	return clampIterations(sanitizeMaxIterations(requested, ceiling), limits, ceiling);
}

describe("nothing configured — the behaviour that shipped, unchanged (#820 AC6 case 1)", () => {
	it("leaves every sanitizeMaxIterations answer exactly where it was", () => {
		for (const raw of [undefined, "lots", Number.NaN, 0, -3, 1, 10, 25, 50, 9999]) {
			expect(effective(raw, {})).toBe(sanitizeMaxIterations(raw));
		}
	});

	it("still lands an unnamed request on 10 — the default this feature exists to override", () => {
		expect(effective(undefined, {})).toBe(10);
	});
});

describe("a floor alone", () => {
	it("clamps a request below it UP, which is the whole point (AC2)", () => {
		// The issue's own example: a caller passing 10 against a minimum of 30 gets 30.
		expect(effective(10, { minIterations: 30 })).toBe(30);
	});

	it("catches the caller who named nothing, not just the one who named too little", () => {
		expect(effective(undefined, { minIterations: 30 })).toBe(30);
	});

	it("leaves a request already above it alone", () => {
		expect(effective(40, { minIterations: 30 })).toBe(40);
	});

	it("is a floor and not a target — it never pulls a larger request down", () => {
		expect(effective(50, { minIterations: 30 })).toBe(50);
	});
});

describe("a ceiling alone", () => {
	it("clamps a request above it down (AC3)", () => {
		expect(effective(40, { maxIterations: 20 })).toBe(20);
	});

	it("leaves a request below it alone", () => {
		expect(effective(5, { maxIterations: 20 })).toBe(5);
	});
});

describe("both bounds", () => {
	const both = { minIterations: 15, maxIterations: 30 };

	it("raises to the floor", () => {
		expect(effective(3, both)).toBe(15);
	});

	it("lowers to the ceiling", () => {
		expect(effective(45, both)).toBe(30);
	});

	it("leaves a request already inside the range untouched (AC6 case 5)", () => {
		expect(effective(20, both)).toBe(20);
		expect(effective(15, both)).toBe(15);
		expect(effective(30, both)).toBe(30);
	});
});

describe("the account ceiling always wins — an instance bound may narrow it, never widen it", () => {
	it("caps an instance maxIterations set above the account ceiling", () => {
		expect(clampIterations(45, { maxIterations: 45 }, 20)).toBe(20);
	});

	it("caps a FLOOR set above the account ceiling, rather than letting it walk through", () => {
		// The one case that would turn a per-instance setting into a way around an account-wide
		// spend bound (#477). 30 is what the owner wrote; 20 is what the account allows.
		expect(clampIterations(20, { minIterations: 30 }, 20)).toBe(20);
		expect(clampIterations(1, { minIterations: 30 }, 20)).toBe(20);
	});

	it("never exceeds the account ceiling for any request or any configuration", () => {
		for (const requested of [1, 10, 50, 1000]) {
			for (const limits of [{}, { minIterations: 999 }, { maxIterations: 999 }, { minIterations: 40, maxIterations: 999 }]) {
				expect(clampIterations(requested, limits, 25)).toBeLessThanOrEqual(25);
			}
		}
	});
});

describe("a misconfigured floor above the effective ceiling", () => {
	it("is pulled down to the ceiling rather than inverting the range (AC6 case 6)", () => {
		expect(clampIterations(5, { minIterations: 40, maxIterations: 20 }, MAX_ITERATIONS_CAP)).toBe(20);
	});

	it("never returns a value above the ceiling, whichever bound is larger", () => {
		const out = clampIterations(1, { minIterations: 40, maxIterations: 20 }, MAX_ITERATIONS_CAP);
		expect(out).toBeLessThanOrEqual(20);
		expect(out).toBeGreaterThanOrEqual(1);
	});
});

describe("clampIterations edge inputs", () => {
	it("lands an unreadable request on the floor, not on 1", () => {
		// "Unreadable" and "unspecified" mean the same thing to an owner who set a minimum.
		expect(clampIterations(Number.NaN, { minIterations: 12 }, MAX_ITERATIONS_CAP)).toBe(12);
		expect(clampIterations(Number.NaN, {}, MAX_ITERATIONS_CAP)).toBe(1);
	});

	it("survives a nonsense account ceiling instead of returning one", () => {
		expect(clampIterations(10, {}, Number.NaN)).toBe(10);
		expect(clampIterations(10, {}, 0)).toBe(1);
		expect(clampIterations(10, {}, -5)).toBe(1);
	});

	it("floors a fractional request", () => {
		expect(clampIterations(10.9, {}, MAX_ITERATIONS_CAP)).toBe(10);
	});
});

describe("sanitizeLoopLimitsConfig — total, because it runs on READ as well as on write", () => {
	it("keeps whole numbers in range", () => {
		expect(sanitizeLoopLimitsConfig({ minIterations: 30, maxIterations: 45 })).toEqual({
			minIterations: 30,
			maxIterations: 45,
		});
	});

	it("keeps one bound without the other", () => {
		expect(sanitizeLoopLimitsConfig({ minIterations: 30 })).toEqual({ minIterations: 30 });
		expect(sanitizeLoopLimitsConfig({ maxIterations: 30 })).toEqual({ maxIterations: 30 });
	});

	it("drops values that cannot be a bound instead of throwing on a start path", () => {
		expect(sanitizeLoopLimitsConfig({ minIterations: 0, maxIterations: -1 })).toEqual({});
		expect(sanitizeLoopLimitsConfig({ minIterations: "many" })).toEqual({});
		expect(sanitizeLoopLimitsConfig({ minIterations: Number.NaN })).toEqual({});
		expect(sanitizeLoopLimitsConfig(null)).toEqual({});
		expect(sanitizeLoopLimitsConfig("nope")).toEqual({});
		expect(sanitizeLoopLimitsConfig(undefined)).toEqual({});
	});

	it("reads a numeric string, which is what a form field sends", () => {
		expect(sanitizeLoopLimitsConfig({ minIterations: "30" })).toEqual({ minIterations: 30 });
	});

	it("floors a fraction and caps at the widest configurable bound", () => {
		expect(sanitizeLoopLimitsConfig({ minIterations: 3.9 })).toEqual({ minIterations: 3 });
		expect(sanitizeLoopLimitsConfig({ maxIterations: 99_999 })).toEqual({ maxIterations: MAX_CONFIGURABLE_ITERATIONS });
	});

	it("repairs an inverted pair by lowering the floor, never by raising the ceiling", () => {
		// Raising the ceiling would grant spend the owner never wrote down.
		expect(sanitizeLoopLimitsConfig({ minIterations: 40, maxIterations: 20 })).toEqual({
			minIterations: 20,
			maxIterations: 20,
		});
	});

	it("ignores unrelated keys, so the config blob's other tenants cannot leak in", () => {
		expect(sanitizeLoopLimitsConfig({ minIterations: 5, behaviour: { tone: 9 } })).toEqual({ minIterations: 5 });
	});
});

describe("hasLoopLimits — what decides whether the Pilot's own default yields", () => {
	it("is false only when neither bound is configured", () => {
		expect(hasLoopLimits({})).toBe(false);
		expect(hasLoopLimits({ minIterations: 1 })).toBe(true);
		expect(hasLoopLimits({ maxIterations: 1 })).toBe(true);
	});
});

describe("the unnamed-caller path the coding driver takes (delegate_goal names no number)", () => {
	// Mirrors `boundedMaxSteps` in loop-drivers.ts: with bounds configured the number that gets
	// clamped is the PILOT's default, not sanitizeMaxIterations' fallback of 10.
	const pilotSteps = (limits: Parameters<typeof clampIterations>[1]) =>
		hasLoopLimits(limits) ? clampIterations(PILOT_DEFAULT_MAX_STEPS, limits, MAX_ITERATIONS_CAP) : undefined;

	it("leaves the Pilot's default in place when nothing is configured", () => {
		expect(pilotSteps({})).toBeUndefined();
	});

	it("does NOT cut an unnamed run down to a floor below the Pilot's default", () => {
		// The trap: clamping 10 here would turn a minimum of 30 into a 30-step cap on a run that
		// used to get 40 — a floor behaving as a ceiling.
		expect(pilotSteps({ minIterations: 30 })).toBe(PILOT_DEFAULT_MAX_STEPS);
	});

	it("raises an unnamed run when the floor is above the Pilot's default", () => {
		expect(pilotSteps({ minIterations: 45 })).toBe(45);
	});

	it("applies a configured ceiling on the one path that never names a number", () => {
		expect(pilotSteps({ maxIterations: 20 })).toBe(20);
	});
});
