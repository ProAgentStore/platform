import { describe, expect, it } from "vitest";
import { gateApplies } from "./notification-applicability.js";

const caps = (surfaces: string[], runtime: string | null, tools?: string[]) => ({ surfaces, runtime, tools }) as never;

describe("gateApplies (#1595)", () => {
	it("an absent or `always` gate applies, so a new type is never hidden", () => {
		expect(gateApplies(undefined, caps([], null))).toBe(true);
		expect(gateApplies("always", caps([], null))).toBe(true);
	});
	it("`account` never applies to an instance", () => expect(gateApplies("account", caps(["coding"], "coding"))).toBe(false));
	it("surface, runtime and tool gates read the resolved capabilities", () => {
		expect(gateApplies("surface:coding", caps(["coding"], null))).toBe(true);
		expect(gateApplies("surface:coding", caps(["apply"], null))).toBe(false);
		expect(gateApplies("runtime:any", caps([], "browser"))).toBe(true);
		expect(gateApplies("runtime:any", caps([], null))).toBe(false);
		expect(gateApplies("runtime:local_browser", caps([], "coding"))).toBe(false);
		expect(gateApplies("tool:web_search", caps([], null, ["web_search"]))).toBe(true);
		expect(gateApplies("tool:web_search", caps([], null))).toBe(false);
	});
});
