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

/**
 * A short-lived, instance-scoped token for the WebSocket relay handshake. Unlike
 * the account session JWT (30-day, full API authority), this grants ONLY the
 * ability to connect the relay for one instance and expires in minutes — so a
 * leaked relay URL (edge logs, support bundle) can't be replayed into account
 * takeover or machine control.
 */
export interface RelayToken {
	typ: "relay";
	instanceId: string;
	uid: string;
	exp: number;
}

const RELAY_TTL = 10 * 60; // only needs to be valid at the WS handshake

export async function signRelayToken(
	instanceId: string,
	uid: string,
	signingKey: string,
): Promise<{ token: string; exp: number }> {
	const exp = Math.floor(Date.now() / 1000) + RELAY_TTL;
	const token = await signPayload<RelayToken>({ typ: "relay", instanceId, uid, exp }, signingKey);
	return { token, exp };
}

export async function verifyRelayToken(token: string, signingKey: string): Promise<RelayToken | null> {
	const p = await verifyPayload<RelayToken>(token, signingKey);
	if (!p || p.typ !== "relay" || typeof p.exp !== "number" || !p.instanceId || !p.uid) return null;
	if (p.exp < Math.floor(Date.now() / 1000)) return null;
	return p;
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
	try {
		const key = await hmacKey(signingKey);
		const valid = await crypto.subtle.verify(
			"HMAC",
			key,
			unb64url(sig),
			new TextEncoder().encode(data),
		);
		if (!valid) return null;
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
	try {
		const key = await hmacKey(signingKey);
		const valid = await crypto.subtle.verify(
			"HMAC",
			key,
			unb64url(sig),
			new TextEncoder().encode(data),
		);
		if (!valid) return null;
		const payload = JSON.parse(
			new TextDecoder().decode(unb64url(data)),
		) as SessionPayload & { typ?: unknown };
		// Type-pin: other tokens are signed with the SAME key and carry uid+exp — a relay
		// token ({typ:"relay",…}, deliberately placed in a WS URL query → edge logs) and a
		// connector-OAuth `state` ({uid,exp} → travels via Google + browser history). Without
		// this check verifySession would accept them as a full account session (takeover via a
		// leaked URL). A real session ALWAYS has a roles[] and NEVER a `typ`; nothing else does.
		if (payload.typ !== undefined || !Array.isArray(payload.roles)) return null;
		if (payload.exp < Math.floor(Date.now() / 1000)) return null;
		return payload;
	} catch {
		return null;
	}
}
