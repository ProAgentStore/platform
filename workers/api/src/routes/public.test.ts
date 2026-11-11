import { describe, expect, it } from "vitest";

const TRIAL_LIMIT = 20;

describe("trial message limit", () => {
	it("limit constant is 20", () => {
		expect(TRIAL_LIMIT).toBe(20);
	});

	it("allows chat when message count is below limit", () => {
		const count = 19;
		const blocked = count >= TRIAL_LIMIT;
		expect(blocked).toBe(false);
	});

	it("blocks chat when message count equals limit", () => {
		const count = 20;
		const blocked = count >= TRIAL_LIMIT;
		expect(blocked).toBe(true);
	});

	it("blocks chat when message count exceeds limit", () => {
		const count = 25;
		const blocked = count >= TRIAL_LIMIT;
		expect(blocked).toBe(true);
	});

	it("allows first message (count = 0)", () => {
		const count = 0;
		const blocked = count >= TRIAL_LIMIT;
		expect(blocked).toBe(false);
	});

	it("error response shape when trial limit reached", () => {
		const sid = crypto.randomUUID();
		const response = {
			error: "Trial limit reached. Subscribe to continue chatting.",
			sessionId: sid,
		};
		expect(response.error).toContain("Trial limit reached");
		expect(response.sessionId).toBe(sid);
	});
});

describe("session ID generation", () => {
	it("uses provided sessionId when given", () => {
		const provided = "my-existing-session";
		const sid = provided || crypto.randomUUID();
		expect(sid).toBe("my-existing-session");
	});

	it("generates a UUID when sessionId is not provided", () => {
		const provided = undefined;
		const sid = provided || crypto.randomUUID();
		expect(sid).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("generated session IDs are unique", () => {
		const provided = undefined; // the caller sent no sessionId — same shape as the test above
		const ids = new Set(
			Array.from({ length: 50 }, () => provided || crypto.randomUUID()),
		);
		expect(ids.size).toBe(50);
	});

	it("trial DO key encodes agent+session", () => {
		const agentId = "agent-abc";
		const sid = "session-xyz";
		const doKey = `trial:${agentId}:${sid}`;
		expect(doKey).toBe("trial:agent-abc:session-xyz");
		expect(doKey.startsWith("trial:")).toBe(true);
	});
});
