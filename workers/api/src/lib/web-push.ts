/**
 * Minimal Web Push for Cloudflare Workers — RFC 8291 (aes128gcm payload
 * encryption) + RFC 8292 (VAPID). Pure WebCrypto, no Node/library deps.
 *
 * Used to notify a user's phone (via their PWA service worker) when an agent
 * needs them — e.g. a CAPTCHA handoff during a job application.
 */

const enc = new TextEncoder();

export interface PushSubscription {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export interface VapidConfig {
	publicKey: string; // base64url, 65-byte uncompressed P-256 point
	privateKey: string; // base64url, 32-byte private scalar (jwk "d")
	subject: string; // mailto: or https: contact
}

function b64urlToBytes(input: string): Uint8Array {
	let s = input.replace(/-/g, "+").replace(/_/g, "/");
	s += "=".repeat((4 - (s.length % 4)) % 4);
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function bytesToB64url(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...arrays: Uint8Array[]): Uint8Array {
	const total = arrays.reduce((n, a) => n + a.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const a of arrays) {
		out.set(a, off);
		off += a.length;
	}
	return out;
}

// Coerce a Uint8Array to the BufferSource shape WebCrypto overloads want
// (TS 5.x types Uint8Array as Uint8Array<ArrayBufferLike>, which trips overload
// resolution even though the runtime accepts it).
type Bytes = ArrayBuffer | ArrayBufferView;
const bs = (u: Uint8Array): Bytes => u as unknown as Bytes;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", bs(ikm), "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt: bs(salt), info: bs(info) } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0],
		key,
		length * 8,
	);
	return new Uint8Array(bits);
}

/** Build the `Authorization: vapid t=<JWT>, k=<pub>` header for an endpoint. */
async function vapidAuthHeader(endpoint: string, vapid: VapidConfig): Promise<string> {
	const url = new URL(endpoint);
	const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const payload = bytesToB64url(
		enc.encode(
			JSON.stringify({
				aud: `${url.protocol}//${url.host}`,
				exp: Math.floor(Date.now() / 1000) + 12 * 3600,
				sub: vapid.subject,
			}),
		),
	);
	const signingInput = `${header}.${payload}`;

	const pub = b64urlToBytes(vapid.publicKey); // 0x04 || x(32) || y(32)
	const jwk: JsonWebKey = {
		kty: "EC",
		crv: "P-256",
		d: vapid.privateKey,
		x: bytesToB64url(pub.slice(1, 33)),
		y: bytesToB64url(pub.slice(33, 65)),
		ext: true,
	};
	const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	// WebCrypto ECDSA returns the IEEE-P1363 r||s signature ES256 expects.
	const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bs(enc.encode(signingInput))));
	return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${vapid.publicKey}`;
}

/** Encrypt a payload for a subscription using aes128gcm (RFC 8291). */
async function encryptPayload(sub: PushSubscription, payload: Uint8Array): Promise<Uint8Array> {
	const uaPublic = b64urlToBytes(sub.keys.p256dh); // 65 bytes
	const authSecret = b64urlToBytes(sub.keys.auth); // 16 bytes

	const asKeyPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits",
	])) as CryptoKeyPair;
	const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", asKeyPair.publicKey)) as ArrayBuffer); // 65 bytes
	const uaKey = await crypto.subtle.importKey("raw", bs(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
	const ecdh = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "ECDH", public: uaKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0],
			asKeyPair.privateKey,
			256,
		),
	);

	// IKM = HKDF(auth_secret, ecdh, "WebPush: info\0" || ua_public || as_public)
	const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
	const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);

	const salt = crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

	// Single record: payload followed by the 0x02 last-record delimiter.
	const record = concat(payload, new Uint8Array([2]));
	const aesKey = await crypto.subtle.importKey("raw", bs(cek), "AES-GCM", false, ["encrypt"]);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(nonce) }, aesKey, bs(record)));

	// Header: salt(16) || rs(4 = 4096) || idlen(1 = 65) || as_public(65) || ciphertext
	return concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([65]), asPublic, ciphertext);
}

/** Send one Web Push message. Returns the push service's HTTP response. */
export async function sendWebPush(
	sub: PushSubscription,
	payload: string,
	vapid: VapidConfig,
	ttlSeconds = 3600,
): Promise<Response> {
	const body = await encryptPayload(sub, enc.encode(payload));
	const authorization = await vapidAuthHeader(sub.endpoint, vapid);
	return fetch(sub.endpoint, {
		method: "POST",
		headers: {
			Authorization: authorization,
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
			TTL: String(ttlSeconds),
		},
		body,
	});
}

// Exposed for unit tests.
export const __test = { b64urlToBytes, bytesToB64url, concat };
