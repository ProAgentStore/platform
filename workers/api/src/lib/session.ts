import type { SessionPayload } from "../types.js";

const THIRTY_DAYS = 30 * 24 * 60 * 60;

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

function b64url(buf: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(buf)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
	const padding = "=".repeat((4 - (s.length % 4)) % 4);
	const padded =
		s.replace(/-/g, "+").replace(/_/g, "/") + padding;
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function signSession(
	uid: string,
	signingKey: string,
	opts?: { roles?: string[]; ttl?: number },
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const payload: SessionPayload = {
		uid,
		roles: opts?.roles ?? ["user"],
		iat: now,
		exp: now + (opts?.ttl ?? THIRTY_DAYS),
	};
	const data = b64url(
		new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer,
	);
	const key = await hmacKey(signingKey);
	const sig = b64url(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)),
	);
	return `${data}.${sig}`;
}

/** Sign an arbitrary JSON payload (e.g. OAuth `state`) with the same HMAC. */
export async function signPayload<T>(payload: T, signingKey: string): Promise<string> {
	const data = b64url(
		new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer,
	);
	const key = await hmacKey(signingKey);
	const sig = b64url(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)),
	);
	return `${data}.${sig}`;
}

/** Verify + decode a payload produced by signPayload. Null if tampered/garbage. */
export async function verifyPayload<T>(
	token: string,
	signingKey: string,
): Promise<T | null> {
	const [data, sig] = token.split(".");
	if (!data || !sig) return null;
	const key = await hmacKey(signingKey);
	const valid = await crypto.subtle.verify(
		"HMAC",
		key,
		unb64url(sig),
		new TextEncoder().encode(data),
	);
	if (!valid) return null;
	try {
		return JSON.parse(new TextDecoder().decode(unb64url(data))) as T;
	} catch {
		return null;
	}
}

export async function verifySession(
	token: string,
	signingKey: string,
): Promise<SessionPayload | null> {
	const [data, sig] = token.split(".");
	if (!data || !sig) return null;
	const key = await hmacKey(signingKey);
	const valid = await crypto.subtle.verify(
		"HMAC",
		key,
		unb64url(sig),
		new TextEncoder().encode(data),
	);
	if (!valid) return null;
	const payload: SessionPayload = JSON.parse(
		new TextDecoder().decode(unb64url(data)),
	);
	if (payload.exp < Math.floor(Date.now() / 1000)) return null;
	return payload;
}
