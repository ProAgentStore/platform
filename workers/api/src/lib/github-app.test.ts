import { describe, expect, it } from "vitest";
import { appJwt, githubAppConfigured } from "./github-app.js";
import type { Env } from "../types.js";

/** Export a generated RSA private key as PKCS#8 PEM (what GitHub gives you). */
async function makePem(): Promise<{ pem: string; publicKey: CryptoKey }> {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	let bin = "";
	for (const b of pkcs8) bin += String.fromCharCode(b);
	const b64 = btoa(bin).replace(/(.{64})/g, "$1\n");
	return { pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`, publicKey: pair.publicKey };
}

function b64urlToBytes(s: string): Uint8Array {
	const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	const raw = atob(pad);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

describe("github app config gate", () => {
	it("is off without app id + private key", () => {
		expect(githubAppConfigured({} as Env)).toBe(false);
		expect(githubAppConfigured({ GITHUB_APP_ID: "1" } as Env)).toBe(false);
	});
	it("is on with both set", () => {
		expect(githubAppConfigured({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k" } as Env)).toBe(true);
	});
});

describe("appJwt (WebCrypto RS256)", () => {
	it("mints a verifiable 3-part JWT with the right issuer", async () => {
		const { pem, publicKey } = await makePem();
		const env = { GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: pem } as Env;
		const jwt = await appJwt(env);
		const [h, p, s] = jwt.split(".");
		expect(h && p && s).toBeTruthy();

		const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
		const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
		expect(header.alg).toBe("RS256");
		expect(payload.iss).toBe("123456");
		expect(payload.exp).toBeGreaterThan(payload.iat);

		const ok = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			publicKey,
			b64urlToBytes(s),
			new TextEncoder().encode(`${h}.${p}`),
		);
		expect(ok).toBe(true);
	});

	it("throws when not configured", async () => {
		await expect(appJwt({} as Env)).rejects.toThrow(/not configured/);
	});
});
