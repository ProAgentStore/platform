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

	// Security: other tokens are signed with the SAME key and carry uid+exp. verifySession
	// must NOT accept them as a full account session (a leaked relay URL / OAuth state → takeover).
	it("rejects a relay token (same key, but typ:relay + no roles[])", async () => {
		const { token } = await signRelayToken("inst-1", "victim", SECRET);
		expect(await verifySession(token, SECRET)).toBeNull();
	});

	it("rejects a connector-OAuth state payload (uid+exp, no roles[])", async () => {
		const state = await signPayload({ uid: "victim", exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
		expect(await verifySession(state, SECRET)).toBeNull();
	});

	it("rejects any token bearing a typ marker even if it has roles[]", async () => {
		const weird = await signPayload({ typ: "relay", uid: "victim", roles: ["user"], exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
		expect(await verifySession(weird, SECRET)).toBeNull();
	});

	it("respects custom TTL", async () => {
		const token = await signSession("user-123", SECRET, { ttl: 3600 });
		const payload = await verifySession(token, SECRET);
		expect(payload).not.toBeNull();
		expect(payload?.exp - payload?.iat).toBe(3600);
	});
});
