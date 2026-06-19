import { describe, expect, it } from "vitest";
import { normalizeBoardConfigInput } from "./auth.js";

describe("auth route response shapes", () => {
	it("OAuth callback returns expected shape", () => {
		const response = {
			token: "eyJ...",
			user: {
				id: "12345",
				login: "testuser",
				avatar: "https://avatars.githubusercontent.com/u/12345",
				roles: ["user"],
			},
			return_to: "/dashboard",
		};
		expect(response.token).toBeTruthy();
		expect(response.user.id).toBe("12345");
		expect(response.user.roles).toContain("user");
		expect(response.return_to).toBe("/dashboard");
	});

	it("/me returns expected shape", () => {
		const response = {
			id: "12345",
			login: "testuser",
			name: "Test User",
			avatar: "https://avatars.githubusercontent.com/u/12345",
			roles: ["user", "creator"],
			hasSubscription: true,
			boardConfig: {
				summary: "setup and live",
				columns: [{ id: "setup", title: "Setup" }],
			},
		};
		expect(response.roles).toHaveLength(2);
		expect(response.hasSubscription).toBe(true);
		expect(response.boardConfig.columns[0].id).toBe("setup");
	});

	it("role parsing from JSON string", () => {
		const stored = '["user","creator"]';
		const roles = JSON.parse(stored);
		expect(roles).toEqual(["user", "creator"]);
	});

	it("default role fallback", () => {
		const stored = null;
		const roles = stored ? JSON.parse(stored) : ["user"];
		expect(roles).toEqual(["user"]);
	});
});

describe("board config normalization", () => {
	it("normalizes object configs for persistence", () => {
		const config = normalizeBoardConfigInput({
			summary: "custom board",
			columns: [
				{
					id: "Needs Review!",
					title: "Needs Review",
					color: 'red" onmouseover="alert(1)',
					statuses: ["inactive"],
					visibilities: ["draft"],
					excludeStatuses: ["error"],
				},
			],
		});

		expect(config.summary).toBe("custom board");
		expect(config.columns[0]).toMatchObject({
			id: "needs-review-",
			title: "Needs Review",
			color: "var(--accent)",
			statuses: ["inactive"],
			visibilities: ["draft"],
			excludeStatuses: ["error"],
			excludeVisibilities: [],
			catchAll: false,
		});
	});

	it("accepts JSON string configs", () => {
		const config = normalizeBoardConfigInput(JSON.stringify({
			columns: [{ id: "live", title: "Live", catchAll: true }],
		}));

		expect(config.columns[0].id).toBe("live");
		expect(config.columns[0].catchAll).toBe(true);
	});

	it("rejects invalid configs", () => {
		expect(() => normalizeBoardConfigInput("{")).toThrow("valid JSON");
		expect(() => normalizeBoardConfigInput({ columns: [] })).toThrow("at least one");
		expect(() => normalizeBoardConfigInput({ columns: [{ id: "x" }] })).toThrow("id and title");
	});
});
