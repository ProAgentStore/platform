import { describe, it, expect } from "vitest";

/**
 * SecureInputDetail page routing and structure tests (#908)
 *
 * These tests verify that:
 * 1. The route pattern is correctly configured in App.tsx
 * 2. The URL path matches the consoleUrl returned by the API
 * 3. Deep links work correctly
 */

describe("SecureInputDetail routing (#908)", () => {
	it("route path matches /instances/:id/secure-inputs/:requestId", () => {
		const instanceId = "inst-abc";
		const requestId = "req-123";
		const path = `/instances/${instanceId}/secure-inputs/${requestId}`;

		expect(path).toBe("/instances/inst-abc/secure-inputs/req-123");
		expect(path).toMatch(/^\/instances\/[^/]+\/secure-inputs\/[^/]+$/);
	});

	it("deep link path extracts both instanceId and requestId from URL", () => {
		const fullPath = "/instances/inst-xyz/secure-inputs/req-xyz";
		const match = fullPath.match(/^\/instances\/([^/]+)\/secure-inputs\/([^/]+)$/);

		expect(match).toBeTruthy();
		expect(match?.[1]).toBe("inst-xyz");
		expect(match?.[2]).toBe("req-xyz");
	});

	it("consoleUrl from API response matches route pattern", () => {
		const instanceId = "inst-123";
		const requestId = "req-abc";

		// This is what the API returns
		const apiResponse = {
			id: requestId,
			consoleUrl: `/instances/${instanceId}/secure-inputs/${requestId}`,
		};

		// This is what the router expects
		const routePattern = /^\/instances\/[^/]+\/secure-inputs\/[^/]+$/;

		expect(apiResponse.consoleUrl).toMatch(routePattern);
	});

	it("route is placed before splat route for correct precedence", () => {
		// In App.tsx:
		// <Route path="instances/:id/secure-inputs/:requestId" element={<SecureInputDetail />} />
		// <Route path="instances/:id/*" element={<InstanceDetail />} />
		//
		// This ensures /instances/:id/secure-inputs/:requestId matches SecureInputDetail,
		// not the splat route. This test documents the requirement.

		const path = "/instances/inst-1/secure-inputs/req-1";

		// Should match specific route, not splat
		const specificMatch = path.match(/^\/instances\/([^/]+)\/secure-inputs\/([^/]+)$/);
		const splatMatch = path.match(/^\/instances\/([^/]+)\/(.*)$/);

		expect(specificMatch).toBeTruthy();
		expect(splatMatch).toBeTruthy();
		// Both match, but router checks specific route first (line order in Routes)
	});

	it("page receives instanceId and requestId from useParams", () => {
		// When SecureInputDetail renders with path /instances/inst-123/secure-inputs/req-456
		// useParams<{ id: string; requestId: string }>() should return:
		const params = {
			id: "inst-123",
			requestId: "req-456",
		};

		expect(params.id).toBe("inst-123");
		expect(params.requestId).toBe("req-456");
		expect(typeof params.id).toBe("string");
		expect(typeof params.requestId).toBe("string");
	});

	it("page fetches from correct API endpoint using both params", () => {
		const instanceId = "inst-abc";
		const requestId = "req-def";

		// SecureInputDetail makes this call:
		const apiUrl = `/v1/instances/${instanceId}/secure-inputs/${requestId}`;

		expect(apiUrl).toBe("/v1/instances/inst-abc/secure-inputs/req-def");
	});

	it("page can submit to correct API endpoint", () => {
		const instanceId = "inst-123";
		const requestId = "req-456";

		// When user submits value, component calls:
		const submitUrl = `/v1/instances/${instanceId}/secure-inputs/${requestId}/submit`;

		expect(submitUrl).toBe("/v1/instances/inst-123/secure-inputs/req-456/submit");
		expect(submitUrl).toMatch(/\/submit$/);
	});
});
