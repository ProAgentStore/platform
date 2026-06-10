export interface SessionPayload {
	uid: string;
	roles: string[];
	iat: number;
	exp: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
}

function unb64url(s: string): Uint8Array {
	const padded =
		s.replace(/-/g, "+").replace(/_/g, "/") +
		"==".slice(0, (4 - (s.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
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
