import { describe, expect, it } from "vitest";
import { gateLocation } from "./submission-gate.js";

describe("gateLocation (#1576)", () => {
	const seek = "Senior Project Manager - Gaming Technology Job in Richmond, Melbourne VIC - SEEK";

	it("uses the live-verified SEEK posting title when the alert lead has no location", () => {
		expect(gateLocation({ lead: { title: "Senior Project Manager" }, verification: { state: "live", title: seek } })).toBe("Richmond, Melbourne VIC");
	});

	it("prefers the lead's own location", () => {
		expect(gateLocation({ lead: { location: "Sydney NSW" }, verification: { state: "live", title: seek } })).toBe("Sydney NSW");
	});

	it.each([
		["an unverified posting", { verification: { state: "unavailable", title: seek } }],
		["no verification", {}],
		["a title that is not SEEK's", { verification: { state: "live", title: "Senior Project Manager | Careers" } }],
	])("stays empty, so the location check fails closed, for %s", (_label, lead) => {
		expect(gateLocation(lead)).toBeUndefined();
	});
});
