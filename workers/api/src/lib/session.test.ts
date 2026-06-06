import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "./session.js";

const SECRET = "test-secret-key-for-hmac-signing";

describe("session", () => {
	it("signs and verifies a session", async () => {
		const token = await signSession("user-123", SECRET);
		const payload = await verifySession(token, SECRET);
		expect(payload).not.toBeNull();
		expect(payload?.uid).toBe("user-123");
		expect(payload?.roles).toEqual(["user"]);
	});

	it("includes custom roles", async () => {
		const token = await signSession("creator-1", SECRET, {
			roles: ["user", "creator"],
		});
		const payload = await verifySession(token, SECRET);
		expect(payload?.roles).toEqual(["user", "creator"]);
	});

	it("rejects tampered token", async () => {
		const token = await signSession("user-123", SECRET);
		const tampered = `${token.slice(0, -2)}xx`;
		const payload = await verifySession(tampered, SECRET);
		expect(payload).toBeNull();
	});

	it("rejects wrong signing key", async () => {
		const token = await signSession("user-123", SECRET);
		const payload = await verifySession(token, "wrong-key");
		expect(payload).toBeNull();
	});

	it("rejects expired token", async () => {
		const token = await signSession("user-123", SECRET, { ttl: -1 });
		const payload = await verifySession(token, SECRET);
		expect(payload).toBeNull();
	});

	it("respects custom TTL", async () => {
		const token = await signSession("user-123", SECRET, { ttl: 3600 });
		const payload = await verifySession(token, SECRET);
		expect(payload).not.toBeNull();
		expect(payload?.exp - payload?.iat).toBe(3600);
	});
});
