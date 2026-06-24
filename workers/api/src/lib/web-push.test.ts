import { describe, expect, it } from "vitest";
import { __test, type PushSubscription, type VapidConfig } from "./web-push.js";

const { b64urlToBytes, bytesToB64url, concat, encryptPayload, vapidAuthHeader } = __test;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
	return bytesToB64url(bytes);
}

async function genVapid(): Promise<VapidConfig> {
	const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
	const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
	return { publicKey: b64url(pub), privateKey: jwk.d as string, subject: "mailto:test@example.com" };
}

describe("web-push base64url", () => {
	it("round-trips arbitrary bytes", () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 65, 66]);
		expect([...b64urlToBytes(bytesToB64url(bytes))]).toEqual([...bytes]);
	});
	it("emits url-safe, unpadded output", () => {
		const s = bytesToB64url(new Uint8Array([251, 255, 191]));
		expect(s).not.toMatch(/[+/=]/);
	});
});

describe("VAPID JWT (RFC 8292)", () => {
	it("produces a verifiable ES256 JWT with correct claims", async () => {
		const vapid = await genVapid();
		const header = await vapidAuthHeader("https://fcm.googleapis.com/fcm/send/abc", vapid);
		const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
		expect(m).toBeTruthy();
		const [, jwt, k] = m as RegExpMatchArray;
		expect(k).toBe(vapid.publicKey);

		const [h, p, sig] = jwt.split(".");
		const claims = JSON.parse(dec.decode(b64urlToBytes(p)));
		expect(claims.aud).toBe("https://fcm.googleapis.com");
		expect(claims.sub).toBe("mailto:test@example.com");
		expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

		// Verify the signature against the VAPID public key.
		const pub = b64urlToBytes(vapid.publicKey);
		const key = await crypto.subtle.importKey("raw", pub as unknown as ArrayBuffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
		const ok = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			key,
			b64urlToBytes(sig) as unknown as ArrayBuffer,
			enc.encode(`${h}.${p}`) as unknown as ArrayBuffer,
		);
		expect(ok).toBe(true);
	});
});

describe("aes128gcm payload encryption (RFC 8291)", () => {
	it("encrypts a payload that the subscriber can decrypt back", async () => {
		// Subscriber (user agent) key pair + auth secret.
		const uaKp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
		const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", uaKp.publicKey)) as ArrayBuffer);
		const authSecret = crypto.getRandomValues(new Uint8Array(16));
		const sub: PushSubscription = {
			endpoint: "https://push.example/abc",
			keys: { p256dh: b64url(uaPublic), auth: b64url(authSecret) },
		};

		const plaintext = "captcha needs you 🙋";
		const body = await encryptPayload(sub, enc.encode(plaintext));

		// --- Decrypt exactly as a push service / browser would (RFC 8291/8188) ---
		const salt = body.slice(0, 16);
		const idlen = body[20];
		const asPublic = body.slice(21, 21 + idlen);
		const ciphertext = body.slice(21 + idlen);

		const asKey = await crypto.subtle.importKey("raw", asPublic as unknown as ArrayBuffer, { name: "ECDH", namedCurve: "P-256" }, false, []);
		const ecdh = new Uint8Array(
			await crypto.subtle.deriveBits(
				{ name: "ECDH", public: asKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0],
				uaKp.privateKey,
				256,
			),
		);

		const hkdf = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) => {
			const k = await crypto.subtle.importKey("raw", ikm as unknown as ArrayBuffer, "HKDF", false, ["deriveBits"]);
			return new Uint8Array(
				await crypto.subtle.deriveBits(
					{ name: "HKDF", hash: "SHA-256", salt: s, info } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0],
					k,
					len * 8,
				),
			);
		};

		const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
		const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
		const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
		const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

		const aesKey = await crypto.subtle.importKey("raw", cek as unknown as ArrayBuffer, "AES-GCM", false, ["decrypt"]);
		const recordBuf = new Uint8Array(
			await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as unknown as ArrayBuffer }, aesKey, ciphertext as unknown as ArrayBuffer),
		);
		// Strip the 0x02 last-record delimiter.
		expect(recordBuf[recordBuf.length - 1]).toBe(2);
		const recovered = dec.decode(recordBuf.slice(0, recordBuf.length - 1));
		expect(recovered).toBe(plaintext);
	});

	it("uses a fresh salt + ephemeral key each call (header differs)", async () => {
		const uaKp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
		const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", uaKp.publicKey)) as ArrayBuffer);
		const sub: PushSubscription = {
			endpoint: "https://push.example/abc",
			keys: { p256dh: b64url(uaPublic), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) },
		};
		const a = await encryptPayload(sub, enc.encode("x"));
		const b = await encryptPayload(sub, enc.encode("x"));
		// salt (first 16 bytes) must differ between calls.
		expect([...a.slice(0, 16)]).not.toEqual([...b.slice(0, 16)]);
	});
});
