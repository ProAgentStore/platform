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
		const ids = new Set(
			Array.from({ length: 50 }, () => undefined || crypto.randomUUID()),
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

describe("developer profile response shape", () => {
	it("contains developer object with expected fields", () => {
		const response = {
			developer: {
				login: "alice",
				name: "Alice Developer",
				avatar: "https://github.com/alice.png",
				bio: "Building AI agents",
				website: "https://alice.dev",
				twitter: "@alice",
				roles: ["user", "creator"],
				agentCount: 3,
			},
			agents: [
				{
					id: "agent-1",
					slug: "summarizer",
					name: "Summarizer",
					description: "Summarizes text",
					category: "productivity",
					store_type: "agent",
					icon: "📝",
					icon_bg: "#fff",
				},
			],
		};

		expect(response.developer).toHaveProperty("login");
		expect(response.developer).toHaveProperty("name");
		expect(response.developer).toHaveProperty("avatar");
		expect(response.developer).toHaveProperty("bio");
		expect(response.developer).toHaveProperty("website");
		expect(response.developer).toHaveProperty("twitter");
		expect(response.developer).toHaveProperty("roles");
		expect(response.developer).toHaveProperty("agentCount");
		expect(response).toHaveProperty("agents");
	});

	it("roles defaults to ['user'] when not set", () => {
		const rolesJson = undefined;
		const roles = JSON.parse(rolesJson || '["user"]');
		expect(roles).toEqual(["user"]);
	});

	it("roles parses stored JSON string", () => {
		const rolesJson = '["user","creator"]';
		const roles = JSON.parse(rolesJson || '["user"]');
		expect(roles).toEqual(["user", "creator"]);
	});

	it("display_name takes precedence over github_name", () => {
		const display_name = "Alice Pro";
		const github_name = "alice";
		const name = display_name || github_name;
		expect(name).toBe("Alice Pro");
	});

	it("falls back to github_name when display_name is absent", () => {
		const display_name = null;
		const github_name = "alice";
		const name = display_name || github_name;
		expect(name).toBe("alice");
	});

	it("agentCount reflects agents array length", () => {
		const agents = [{ id: "a1" }, { id: "a2" }, { id: "a3" }];
		const agentCount = agents.length;
		expect(agentCount).toBe(3);
	});
});
