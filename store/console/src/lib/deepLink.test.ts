import { describe, expect, it } from "vitest";
import { deepLinkedBuildsRepo, notificationRoute } from "./deepLink";

describe("deepLinkedBuildsRepo", () => {
	it("reads the repo id the deploy notification links to", () => {
		expect(deepLinkedBuildsRepo("?builds=repo_123")).toBe("repo_123");
		expect(deepLinkedBuildsRepo("builds=repo_123")).toBe("repo_123");
		expect(deepLinkedBuildsRepo("?tab=x&builds=repo_123&y=1")).toBe("repo_123");
	});

	it("is null on every ordinary visit, so nothing changes for a normal navigation", () => {
		for (const s of ["", "?", "?other=1", "?builds=", "?builds"]) {
			expect(deepLinkedBuildsRepo(s)).toBeNull();
		}
	});
});

describe("notificationRoute", () => {
	// The router already prepends the basename; leaving it on lands you at /console/console/…
	it("strips the console base so the router can add it back", () => {
		expect(notificationRoute("/console/instances/i1/coding?builds=r1")).toBe("/instances/i1/coding?builds=r1");
		expect(notificationRoute("/console/profile")).toBe("/profile");
		expect(notificationRoute("/console/")).toBe("/");
		expect(notificationRoute("/console")).toBe("/");
	});

	it("passes through a path that is already base-relative", () => {
		expect(notificationRoute("/instances/i1")).toBe("/instances/i1");
	});

	// Rows written before #338 point at github.com. Routing to those would 404 inside the SPA.
	it("refuses anything that is not an in-app path", () => {
		for (const u of [undefined, null, "", "https://github.com/acme/app/actions/runs/2", "javascript:alert(1)"]) {
			expect(notificationRoute(u)).toBeNull();
		}
	});
});
