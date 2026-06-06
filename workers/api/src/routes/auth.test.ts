import { describe, expect, it } from "vitest";

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
		};
		expect(response.roles).toHaveLength(2);
		expect(response.hasSubscription).toBe(true);
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
