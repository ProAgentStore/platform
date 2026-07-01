import { decryptKey, encryptKey } from "./crypto.js";
import type { Env } from "../types.js";

/**
 * GitHub App integration (the AgentCoder port), Worker-native.
 *
 * AgentCoder signed the App JWT with `jsonwebtoken` (RS256) in a Node Cloud
 * Function. Workers have no Node crypto, so we mint the JWT with WebCrypto
 * (RSASSA-PKCS1-v1_5 / SHA-256) — the same approach as the FWS contribution
 * program. The short-lived installation token is cached in `github_installations`
 * envelope-encrypted under the master KEK (the trio scheme from crypto.ts).
 *
 * Two GitHub integrations live in this codebase, kept distinct:
 *  - GITHUB_CLIENT_ID/SECRET → OAuth *identity* (who the user is).
 *  - GITHUB_APP_ID/PRIVATE_KEY → the App *installation* (repo access). ← this file
 */

export function githubAppConfigured(env: Env): boolean {
	return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = "";
	for (const b of arr) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a PEM PKCS#8 private key into an importable ArrayBuffer. */
function pemToPkcs8(pem: string): ArrayBuffer {
	const body = pem
		.replace(/\\n/g, "\n")
		.replace(/-----BEGIN [^-]+-----/g, "")
		.replace(/-----END [^-]+-----/g, "")
		.replace(/\s+/g, "");
	const raw = atob(body);
	const buf = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
	return buf.buffer;
}

/** Mint a ~10-minute App JWT (RS256) — the credential for App-level GitHub calls. */
export async function appJwt(env: Env): Promise<string> {
	if (!githubAppConfigured(env)) throw new Error("GitHub App not configured");
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToPkcs8(env.GITHUB_APP_PRIVATE_KEY as string),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const now = Math.floor(Date.now() / 1000);
	const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	const payload = b64url(
		new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })),
	);
	const signingInput = `${header}.${payload}`;
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
	return `${signingInput}.${b64url(sig)}`;
}

const GH_HEADERS = (token: string, scheme: "Bearer" | "token" = "Bearer") => ({
	Authorization: `${scheme} ${token}`,
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
	"User-Agent": "proagentstore-coding/1.0",
});

export interface GhInstallation {
	id: number;
	account: { login: string; type?: string };
}

export async function listInstallations(env: Env): Promise<GhInstallation[]> {
	const jwt = await appJwt(env);
	const res = await fetch("https://api.github.com/app/installations", { headers: GH_HEADERS(jwt) });
	if (!res.ok) throw new Error(`installations ${res.status}`);
	return (await res.json()) as GhInstallation[];
}

/** Mint a fresh installation access token (valid ~1h). */
async function mintInstallationToken(env: Env, installationId: number): Promise<{ token: string; expiresAt: string } | null> {
	const jwt = await appJwt(env);
	const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
		method: "POST",
		headers: GH_HEADERS(jwt),
	});
	if (!res.ok) return null;
	const data = (await res.json()) as { token: string; expires_at: string };
	return { token: data.token, expiresAt: data.expires_at };
}

/**
 * Return a valid installation token, reusing the cached (encrypted) one until it
 * is within 5 minutes of expiry, then refreshing + re-caching.
 */
export async function getInstallationToken(env: Env, userId: string, installationId: number): Promise<string | null> {
	const row = await env.DB.prepare(
		"SELECT id, token_ciphertext, token_dek, token_iv, token_expires_at FROM github_installations WHERE user_id = ?1 AND installation_id = ?2",
	)
		.bind(userId, installationId)
		.first<{ id: string; token_ciphertext: ArrayBuffer | null; token_dek: ArrayBuffer | null; token_iv: ArrayBuffer | null; token_expires_at: string | null }>();

	// SECURITY: never mint for an installation this user has no *verified* binding
	// to. The binding row is created only by authorizeInstallation() after we
	// confirm the user controls the account. Without this guard, any signed-in
	// user could mint a token for ANY installationId (the App JWT will happily
	// issue one) and read every installed org's private repos — a cross-tenant IDOR.
	if (!row) return null;

	const fresh = row?.token_expires_at && new Date(row.token_expires_at).getTime() - Date.now() > 5 * 60 * 1000;
	if (fresh && row?.token_ciphertext && row.token_dek && row.token_iv && env.KEY_ENCRYPTION_KEY) {
		try {
			return await decryptKey(new Uint8Array(row.token_ciphertext), new Uint8Array(row.token_dek), new Uint8Array(row.token_iv), env.KEY_ENCRYPTION_KEY);
		} catch {
			/* fall through to refresh */
		}
	}

	const minted = await mintInstallationToken(env, installationId);
	if (!minted) return null;
	await cacheInstallationToken(env, userId, installationId, minted.token, minted.expiresAt);
	return minted.token;
}

/** Persist (encrypt) the installation token + metadata for reuse. */
export async function cacheInstallationToken(
	env: Env,
	userId: string,
	installationId: number,
	token: string,
	expiresAt: string,
	account?: { login: string; type?: string },
): Promise<void> {
	let cipher: { ciphertext: Uint8Array; dekWrapped: Uint8Array; iv: Uint8Array } | null = null;
	if (env.KEY_ENCRYPTION_KEY) cipher = await encryptKey(token, env.KEY_ENCRYPTION_KEY);
	const id = `ghinst_${userId}_${installationId}`;
	await env.DB.prepare(
		`INSERT INTO github_installations (id, user_id, installation_id, account_login, account_type, token_ciphertext, token_dek, token_iv, token_expires_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
		 ON CONFLICT(user_id, installation_id) DO UPDATE SET
		   account_login = excluded.account_login,
		   account_type = excluded.account_type,
		   token_ciphertext = excluded.token_ciphertext,
		   token_dek = excluded.token_dek,
		   token_iv = excluded.token_iv,
		   token_expires_at = excluded.token_expires_at,
		   updated_at = datetime('now')`,
	)
		.bind(
			id,
			userId,
			installationId,
			account?.login ?? "",
			account?.type ?? "",
			cipher ? cipher.ciphertext : null,
			cipher ? cipher.dekWrapped : null,
			cipher ? cipher.iv : null,
			expiresAt,
		)
		.run();
}

export interface GhRepo {
	id: number;
	name: string;
	full_name: string;
	default_branch: string;
	html_url: string;
	clone_url: string;
	private: boolean;
	description: string | null;
}

/** List the repos an installation can access (using a fresh installation token). */
export async function listInstallationRepos(env: Env, userId: string, installationId: number): Promise<GhRepo[]> {
	const token = await getInstallationToken(env, userId, installationId);
	if (!token) return [];
	const res = await fetch("https://api.github.com/installation/repositories?per_page=100", { headers: GH_HEADERS(token, "token") });
	if (!res.ok) throw new Error(`repos ${res.status}`);
	const data = (await res.json()) as { repositories: GhRepo[] };
	return data.repositories ?? [];
}

/**
 * Best-effort installation token for cloning a repo owned by `owner`. Returns
 * null when the App isn't configured or `owner` has no matching installation —
 * callers treat that as "public clone, no auth". Never throws.
 */
export async function installationTokenForOwner(env: Env, userId: string, owner: string): Promise<string | null> {
	if (!githubAppConfigured(env) || !owner) return null;
	try {
		const installs = await listInstallations(env);
		const match = installs.find((i) => i.account.login.toLowerCase() === owner.toLowerCase());
		if (!match) return null;
		return await getInstallationToken(env, userId, match.id);
	} catch {
		return null;
	}
}

/**
 * Does `githubLogin` control this installation's account? A personal (User)
 * install is owned iff the login matches. An Organization install is owned iff
 * the user is an *active* member — checked with a throwaway installation token
 * (server-side, read-only). No login, no match, or an unverifiable org all fail
 * closed. This is the ownership proof that gates binding creation.
 */
async function verifyUserOwnsInstallation(env: Env, githubLogin: string | null, inst: GhInstallation): Promise<boolean> {
	if (!githubLogin) return false;
	const type = (inst.account.type || "User").toLowerCase();
	if (type !== "organization") {
		return inst.account.login.toLowerCase() === githubLogin.toLowerCase();
	}
	// Org install: verify active membership via a short-lived installation token.
	try {
		const minted = await mintInstallationToken(env, inst.id);
		if (!minted) return false;
		const res = await fetch(
			`https://api.github.com/orgs/${encodeURIComponent(inst.account.login)}/memberships/${encodeURIComponent(githubLogin)}`,
			{ headers: GH_HEADERS(minted.token, "token") },
		);
		if (!res.ok) return false;
		const body = (await res.json()) as { state?: string };
		return body.state === "active";
	} catch {
		return false;
	}
}

/**
 * Verify the user controls `installationId`, and only then create the binding
 * (mint + cache its token). This is the ONLY path that may create a
 * github_installations row; getInstallationToken() refuses to mint without one.
 * Returns a reason on failure so the callback can surface it.
 */
export async function authorizeInstallation(
	env: Env,
	userId: string,
	githubLogin: string | null,
	installationId: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (!githubAppConfigured(env)) return { ok: false, reason: "not_configured" };
	const installs = await listInstallations(env).catch(() => [] as GhInstallation[]);
	const match = installs.find((i) => i.id === installationId);
	if (!match) return { ok: false, reason: "unknown_installation" };
	if (!(await verifyUserOwnsInstallation(env, githubLogin, match))) {
		return { ok: false, reason: "not_authorized" };
	}
	const minted = await mintInstallationToken(env, installationId);
	if (!minted) return { ok: false, reason: "mint_failed" };
	await cacheInstallationToken(env, userId, installationId, minted.token, minted.expiresAt, {
		login: match.account.login,
		type: match.account.type,
	});
	return { ok: true };
}

/** The installations this user has a *verified* binding to (from our DB, not the global App list). */
export async function listUserInstallations(
	env: Env,
	userId: string,
): Promise<{ id: number; account: string; type: string }[]> {
	const { results } = await env.DB.prepare(
		"SELECT installation_id, account_login, account_type FROM github_installations WHERE user_id = ?1 ORDER BY updated_at DESC",
	)
		.bind(userId)
		.all<{ installation_id: number; account_login: string; account_type: string }>();
	return (results ?? []).map((r) => ({ id: r.installation_id, account: r.account_login, type: r.account_type }));
}

/** The App's slug (for building install URLs) — falls back to the numeric App id. */
export async function appIdentifier(env: Env): Promise<string> {
	if (env.GITHUB_APP_SLUG) return env.GITHUB_APP_SLUG;
	try {
		const jwt = await appJwt(env);
		const res = await fetch("https://api.github.com/app", { headers: GH_HEADERS(jwt) });
		if (res.ok) {
			const app = (await res.json()) as { slug?: string };
			if (app.slug) return app.slug;
		}
	} catch {
		/* ignore */
	}
	return String(env.GITHUB_APP_ID ?? "");
}
