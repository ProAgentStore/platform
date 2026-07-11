import { describe, expect, it } from "vitest";
import { signConnectorState, verifyConnectorState } from "./connector-oauth.js";

const SECRET = "connector-oauth-test-secret";

describe("connector OAuth state", () => {
	it("signs and verifies a user id", async () => {
		const token = await signConnectorState("user-1", Math.floor(Date.now() / 1000) + 60, SECRET);

		await expect(verifyConnectorState(token, SECRET)).resolves.toBe("user-1");
	});

	it("rejects tampered, expired, and wrongly signed state", async () => {
		const valid = await signConnectorState("user-1", Math.floor(Date.now() / 1000) + 60, SECRET);
		const [payload, sig] = valid.split(".");
		const expired = await signConnectorState("user-1", 1, SECRET);

		await expect(verifyConnectorState(`${payload}a.${sig}`, SECRET)).resolves.toBeNull();
		await expect(verifyConnectorState(expired, SECRET)).resolves.toBeNull();
		await expect(verifyConnectorState(valid, "other-secret")).resolves.toBeNull();
	});
});
