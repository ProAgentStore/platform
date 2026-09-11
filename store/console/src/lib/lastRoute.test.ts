/**
 * Where the console opens (#161, #794).
 *
 * ── What #794 actually was, measured rather than assumed
 *
 * The ticket reads as "the default tab is Library". The static default never was: `DEFAULT_ROUTE`
 * has been `instances` since #161 introduced this module (6c73fcc7) and nothing has changed it.
 * What put a returning user on the Library was the RESTORE — `rememberRoute` persists every
 * top-level section including `browse`, so one visit to the catalogue made it the landing route
 * for every subsequent cold open, permanently and silently.
 *
 * So the fix is two things and this file pins both: `browse` is no longer restored to, and the
 * fallback stops being a constant and starts being a question about what the user has.
 *
 * ── The half that will rot first
 *
 * `landingRoute` takes counts that are `number | null`, and the null arm is the one an editor
 * will "simplify" into `?? 0`. It is load-bearing: a failed instance count read as zero routes a
 * user with fifty instances to the public catalogue — the exact behaviour this ticket removes,
 * reintroduced through the error path where nobody would look for it. Same null-is-not-zero line
 * `instance-run-liveness.ts` draws for #791.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOP_LEVEL_ROUTES, landingRoute, landingRouteFromMemory, rememberRoute, rememberedRoute, topLevelSegment } from "./lastRoute.js";
import type { LandingCounts } from "./lastRoute.js";

/** A Map-backed localStorage. These tests run in vitest's node environment, which has none. */
function fakeStorage(over: Partial<Storage> = {}) {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		clear: () => m.clear(),
		key: () => null,
		get length() {
			return m.size;
		},
		...over,
	} as Storage;
}

const original = Reflect.get(globalThis, "localStorage");
beforeEach(() => {
	Object.defineProperty(globalThis, "localStorage", { value: fakeStorage(), configurable: true, writable: true });
});
afterEach(() => {
	Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true, writable: true });
});

const counts = (over: Partial<LandingCounts> = {}): LandingCounts => ({ instances: 0, agents: 0, ...over });

describe("topLevelSegment", () => {
	it("takes the section, not the detail route", () => {
		expect(topLevelSegment("/instances/abc/settings")).toBe("instances");
		expect(topLevelSegment("/agents")).toBe("agents");
		expect(topLevelSegment("//browse")).toBe("browse");
		expect(topLevelSegment("/")).toBe("");
		expect(topLevelSegment("")).toBe("");
	});
});

describe("rememberRoute / rememberedRoute", () => {
	it("stores a known section and reads it back", () => {
		rememberRoute("/instances/abc/settings");
		expect(rememberedRoute()).toBe("instances");
	});

	it("ignores a path that is not a section we restore", () => {
		rememberRoute("/agents");
		rememberRoute("/feedback");
		// `feedback` is not in TOP_LEVEL_ROUTES, so the previous value must survive rather than be
		// replaced with something the router would then have to fall back from.
		expect(rememberedRoute()).toBe("agents");
	});

	it("rejects a stale stored value instead of routing nowhere", () => {
		localStorage.setItem("console:lastRoute", "dashboard-v2");
		expect(rememberedRoute()).toBeNull();
	});

	it("survives storage being unreadable", () => {
		// Private mode throws on access. A landing decision must still be made.
		Object.defineProperty(globalThis, "localStorage", {
			value: fakeStorage({
				getItem: () => {
					throw new Error("SecurityError");
				},
				setItem: () => {
					throw new Error("SecurityError");
				},
			}),
			configurable: true,
			writable: true,
		});
		expect(() => rememberRoute("/agents")).not.toThrow();
		expect(rememberedRoute()).toBeNull();
	});
});

describe("landingRouteFromMemory — what can be answered without a request", () => {
	it("answers a remembered section immediately", () => {
		rememberRoute("/usage");
		expect(landingRouteFromMemory()).toBe("usage");
	});

	it("does NOT restore browse — the defect #794 was filed about", () => {
		// One visit to the catalogue used to make it the landing route for every cold open after
		// it. Null here is what sends the caller to go and ask what the user has instead.
		rememberRoute("/browse");
		expect(rememberedRoute()).toBe("browse");
		expect(landingRouteFromMemory()).toBeNull();
	});

	it("answers null on a cold start", () => {
		expect(landingRouteFromMemory()).toBeNull();
	});
});

describe("landingRoute — #794's priority, as a value", () => {
	it("a remembered section beats the counts", () => {
		// #161 is not repealed: the user's own most recent choice outranks a static priority.
		expect(landingRoute("usage", counts({ instances: 4 }))).toBe("usage");
		expect(landingRoute("agents", counts({ instances: 4 }))).toBe("agents");
	});

	it("browse never wins as a remembered value, whatever it is passed with", () => {
		expect(landingRoute("browse", counts({ instances: 4 }))).toBe("instances");
		expect(landingRoute("browse", counts({ agents: 2 }))).toBe("agents");
	});

	it("Instances first, then My Agents, then the Library", () => {
		expect(landingRoute(null, counts({ instances: 3, agents: 9 }))).toBe("instances");
		expect(landingRoute(null, counts({ instances: 0, agents: 9 }))).toBe("agents");
		expect(landingRoute(null, counts({ instances: 0, agents: 0 }))).toBe("browse");
	});

	it("sends a brand-new user to the Library — the one case that still should", () => {
		// The ticket's own follow-on: someone with nothing has nothing to land on but discovery.
		expect(landingRoute(null, { instances: 0, agents: 0 })).toBe("browse");
	});

	describe("a count that could not be read is NOT a zero", () => {
		it("falls back to Instances when both reads failed", () => {
			// The pre-#794 default. Never `browse`: routing an established user to the public
			// catalogue because a fetch failed is the reported behaviour, back through the error path.
			expect(landingRoute(null, { instances: null, agents: null })).toBe("instances");
		});

		it("does not reach the Library on a half-read pair", () => {
			expect(landingRoute(null, { instances: null, agents: 0 })).toBe("instances");
			expect(landingRoute(null, { instances: 0, agents: null })).toBe("instances");
		});

		it("still answers on the evidence it DOES have", () => {
			// A failed agent count cannot hide instances that were counted, and vice versa.
			expect(landingRoute(null, { instances: 2, agents: null })).toBe("instances");
			expect(landingRoute(null, { instances: null, agents: 2 })).toBe("agents");
		});
	});

	it("only ever answers with a route the router serves — G1", () => {
		// Every branch, collected, and held to the declared set. A rule that returned a section
		// nothing renders would bounce back through the unknown-path route and loop.
		const answers = [
			landingRoute(null, { instances: 1, agents: 0 }),
			landingRoute(null, { instances: 0, agents: 1 }),
			landingRoute(null, { instances: 0, agents: 0 }),
			landingRoute(null, { instances: null, agents: null }),
			landingRoute("browse", { instances: null, agents: null }),
			landingRoute("notifications", { instances: 0, agents: 0 }),
		];
		expect(answers, "no branch was exercised — this assertion is measuring nothing").toHaveLength(6);
		for (const a of answers) expect(TOP_LEVEL_ROUTES, a).toContain(a);
	});
});
