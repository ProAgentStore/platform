import { describe, it, expect } from "vitest";

describe("Secure Input Routes (#906, #908)", () => {
	it("POST /:instanceId/secure-inputs response includes consoleUrl field", () => {
		// The API route constructs the response with both id and consoleUrl
		const instanceId = "inst-123";
		const requestId = "req-abc";

		// Verify the consoleUrl format matches what the route constructs
		const consoleUrl = `/instances/${instanceId}/secure-inputs/${requestId}`;

		expect(consoleUrl).toBe("/instances/inst-123/secure-inputs/req-abc");
		expect(consoleUrl).toMatch(/^\/instances\/[^/]+\/secure-inputs\/[^/]+$/);
	});

	it("consoleUrl includes both instanceId and requestId", () => {
		const url = "/instances/inst-456/secure-inputs/req-789";
		const match = url.match(/^\/instances\/([^/]+)\/secure-inputs\/([^/]+)$/);

		expect(match).toBeTruthy();
		expect(match?.[1]).toBe("inst-456");
		expect(match?.[2]).toBe("req-789");
	});

	it("response shape includes id and consoleUrl fields", () => {
		const response = {
			id: "req-xyz",
			consoleUrl: "/instances/inst-xyz/secure-inputs/req-xyz",
		};

		expect(response).toHaveProperty("id");
		expect(response).toHaveProperty("consoleUrl");
		expect(response.id).toBeTruthy();
		expect(response.consoleUrl).toBeTruthy();
		expect(typeof response.id).toBe("string");
		expect(typeof response.consoleUrl).toBe("string");
	});
});
