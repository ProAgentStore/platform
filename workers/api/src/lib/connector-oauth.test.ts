import { describe, expect, it } from "vitest";
import { signConnectorState, verifyConnectorState } from "./connector-oauth.js";
import { newOauthNonce } from "./oauth-nonce.js";

const SECRET = "connector-oauth-test-secret";
const soon = () => Math.floor(Date.now() / 1000) + 60;

describe("connector OAuth state", () => {
	it("signs and verifies a user id when the browser and connector both match", async () => {
		const nonce = newOauthNonce();
		const token = await signConnectorState("user-1", soon(), SECRET, { nonce, provider: "gmail" });

		await expect(verifyConnectorState(token, SECRET, { cookieNonce: nonce, provider: "gmail" })).resolves.toBe("user-1");
	});

	it("rejects tampered, expired, and wrongly signed state", async () => {
		const nonce = newOauthNonce();
		const bind = { nonce, provider: "gmail" };
		const check = { cookieNonce: nonce, provider: "gmail" };
		const valid = await signConnectorState("user-1", soon(), SECRET, bind);
		const [payload, sig] = valid.split(".");
		const expired = await signConnectorState("user-1", 1, SECRET, bind);

		await expect(verifyConnectorState(`${payload}a.${sig}`, SECRET, check)).resolves.toBeNull();
		await expect(verifyConnectorState(expired, SECRET, check)).resolves.toBeNull();
		await expect(verifyConnectorState(valid, "other-secret", check)).resolves.toBeNull();
	});

	it("refuses a state completed by a DIFFERENT browser — the account-takeover shape", async () => {
		// The attacker starts the flow with their own bearer, so the state names THEIR uid, then
		// sends the consent URL to a victim. The victim's browser carries no bind cookie, so the
		// victim's refresh token must not land under the attacker's account.
		const attacker = await signConnectorState("attacker", soon(), SECRET, { nonce: newOauthNonce(), provider: "gmail" });
		await expect(verifyConnectorState(attacker, SECRET, { cookieNonce: null, provider: "gmail" })).resolves.toBeNull();
		await expect(
			verifyConnectorState(attacker, SECRET, { cookieNonce: newOauthNonce(), provider: "gmail" }),
		).resolves.toBeNull();
	});

	it("refuses a state minted for a DIFFERENT connector", async () => {
		// Every callback shared one `{uid, exp}` shape, so a state minted at /v1/drive/google/start
		// was accepted verbatim by the Gmail, WorkDrive and generic-connector callbacks.
		const nonce = newOauthNonce();
		const driveState = await signConnectorState("user-1", soon(), SECRET, { nonce, provider: "google_drive" });
		await expect(verifyConnectorState(driveState, SECRET, { cookieNonce: nonce, provider: "gmail" })).resolves.toBeNull();
		await expect(
			verifyConnectorState(driveState, SECRET, { cookieNonce: nonce, provider: "google_drive" }),
		).resolves.toBe("user-1");
	});
});
