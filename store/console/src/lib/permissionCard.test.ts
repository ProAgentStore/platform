import { describe, expect, it } from "vitest";
import { permissionCardInstanceLabel } from "./permissionCard";

describe("the permission card names its instance (#1009)", () => {
	it("by name, with the id that disambiguates two instances of one agent", () => {
		expect(permissionCardInstanceLabel("PAS Tradies App Coder", "b853fc25")).toBe("PAS Tradies App Coder (b853fc25)");
	});
	it("by id when the name is not known yet — never just 'this instance'", () => {
		expect(permissionCardInstanceLabel(undefined, "i1")).toBe("i1");
		expect(permissionCardInstanceLabel("   ", "i1")).toBe("i1");
	});
});
