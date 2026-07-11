import { HttpError } from "./auth.js";
import { decryptKey, encryptKey } from "./crypto.js";
import type { Env } from "../types.js";

export interface ConnectorTokenInput {
	userId: string;
	provider: string;
	refreshToken: string;
	accountLabel?: string | null;
}

function b64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
	const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function signConnectorState(uid: string, exp: number, secret: string): Promise<string> {
	const payload = b64url(new TextEncoder().encode(JSON.stringify({ uid, exp })));
	const sig = b64url(
		new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload))),
	);
	return `${payload}.${sig}`;
}

export async function verifyConnectorState(token: string, secret: string): Promise<string | null> {
	try {
		const [payload, sig] = token.split(".");
		if (!payload || !sig) return null;
		const valid = await crypto.subtle.verify(
			"HMAC",
			await hmacKey(secret),
			unb64url(sig),
			new TextEncoder().encode(payload),
		);
		if (!valid) return null;
		const { uid, exp } = JSON.parse(new TextDecoder().decode(unb64url(payload))) as {
			uid: string;
			exp: number;
		};
		if (typeof uid !== "string" || typeof exp !== "number") return null;
		if (exp < Math.floor(Date.now() / 1000)) return null;
		return uid;
	} catch {
		return null;
	}
}

export async function readConnectorRefreshToken(
	env: Env,
	userId: string,
	provider: string,
	displayName: string,
): Promise<string> {
	if (!env.KEY_ENCRYPTION_KEY) throw new HttpError(500, "Key encryption not configured");
	const row = await env.DB.prepare(
		"SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(userId, provider)
		.first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();
	if (!row) throw new HttpError(400, `${displayName} is not connected`);
	return decryptKey(
		new Uint8Array(row.key_ciphertext),
		new Uint8Array(row.dek_wrapped),
		new Uint8Array(row.iv),
		env.KEY_ENCRYPTION_KEY,
	);
}

export async function saveConnectorRefreshToken(env: Env, input: ConnectorTokenInput): Promise<void> {
	if (!env.KEY_ENCRYPTION_KEY) throw new HttpError(500, "Key encryption not configured");
	const { ciphertext, dekWrapped, iv } = await encryptKey(
		input.refreshToken,
		env.KEY_ENCRYPTION_KEY,
	);
	await env.DB.prepare(
		`INSERT INTO user_api_keys (user_id, provider, key_ciphertext, dek_wrapped, iv, account_label, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
     ON CONFLICT(user_id, provider) DO UPDATE SET
       key_ciphertext = excluded.key_ciphertext,
       dek_wrapped = excluded.dek_wrapped,
       iv = excluded.iv,
       account_label = excluded.account_label,
       created_at = excluded.created_at`,
	)
		.bind(input.userId, input.provider, ciphertext, dekWrapped, iv, input.accountLabel ?? null)
		.run();
}
