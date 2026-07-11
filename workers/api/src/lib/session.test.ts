import { describe, expect, it } from "vitest";
import { signSession, verifySession, signRelayToken, verifyRelayToken, signPayload } from "./session.js";

const SECRET = "test-secret-key-for-hmac-signing";

describe("relay token", () => {
	it("signs + verifies an instance-scoped relay token", async () => {
		const { token } = await signRelayToken("inst-1", "user-1", SECRET);
		const p = await verifyRelayToken(token, SECRET);
		expect(p?.instanceId).toBe("inst-1");
		expect(p?.uid).toBe("user-1");
		expect(p?.typ).toBe("relay");
	});

	it("rejects a full account session JWT (no relay typ)", async () => {
		const account = await signSession("user-1", SECRET);
		expect(await verifyRelayToken(account, SECRET)).toBeNull();
	});

	it("rejects an expired relay token", async () => {
		const expired = await signPayload({ typ: "relay", instanceId: "i", uid: "u", exp: 1 }, SECRET);
		expect(await verifyRelayToken(expired, SECRET)).toBeNull();
	});

	it("rejects a wrong signing key", async () => {
		const { token } = await signRelayToken("inst-1", "user-1", SECRET);
		expect(await verifyRelayToken(token, "other-key")).toBeNull();
	});
});

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
		const [data, sig] = token.split(".");
		const tampered = `${data}a.${sig}`;
		const payload = await verifySession(tampered, SECRET);
		expect(payload).toBeNull();
	});

	it("rejects malformed tokens without throwing", async () => {
		await expect(verifySession("not-base64.not-base64", SECRET)).resolves.toBeNull();
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
