import { describe, expect, it } from "vitest";
import { PERMISSIONS_CONTROL_ID, permissionRequestFocus } from "./permissionRequestFocus";

describe("permission request console focus (#1009)", () => {
	it("targets the Permissions & Connections control only for an exact verified link", () => {
		expect(permissionRequestFocus("?focus=permissions&permission_request=pr_1")).toEqual({ controlId: PERMISSIONS_CONTROL_ID, requestId: "pr_1" });
	});

	it("does not focus or fetch for a missing, blank, or unrelated query", () => {
		for (const query of ["", "?focus=permissions", "?focus=other&permission_request=pr_1", "?focus=permissions&permission_request=   "]) expect(permissionRequestFocus(query)).toBeNull();
	});
});
