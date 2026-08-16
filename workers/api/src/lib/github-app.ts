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

/**
 * The installation list, with the FAULT kept separate from the empty answer (#321).
 *
 * `listInstallations` throws one string for every non-2xx, so "GitHub is having a bad minute"
 * and "our own App credentials were rejected" arrived at the caller identically — and the caller
 * then had to guess, which is how a permanent failure came to advertise itself as transient.
 */
type InstallationsResult =
	| { ok: true; installs: GhInstallation[] }
	| { ok: false; state: "transient" | "app-not-configured"; detail: string };

async function installationsOrFault(env: Env): Promise<InstallationsResult> {
	let res: Response;
	try {
		const jwt = await appJwt(env);
		res = await fetch("https://api.github.com/app/installations", { headers: GH_HEADERS(jwt) });
	} catch (e) {
		// A network fault or an unusable private key. The key case is not transient, but it is also
		// not something the caller can tell apart here, and "try again" on a broken key costs one
		// retry — where the reverse mistake (calling a real outage permanent) costs the work.
		return { ok: false, state: "transient", detail: e instanceof Error ? e.message : String(e) };
	}
	if (res.ok) return { ok: true, installs: (await res.json().catch(() => [])) as GhInstallation[] };
	// 401/403 on the APP JWT is the platform's own credential being refused — no amount of
	// retrying, and nothing the owner can fix in their settings.
	if (res.status === 401 || res.status === 403) {
		return { ok: false, state: "app-not-configured", detail: `GitHub rejected the App credentials (${res.status})` };
	}
	return { ok: false, state: "transient", detail: `GitHub returned ${res.status}` };
}

/** Mint a fresh installation access token (valid ~1h). */
async function mintInstallationToken(
	env: Env,
	installationId: number,
	opts?: { repositories?: readonly string[] },
): Promise<{ token: string; expiresAt: string } | null> {
	const jwt = await appJwt(env);
	// `repositories` is GitHub's OWN scoping mechanism: the resulting token is rejected by GitHub
	// for any repo not named, so the refusal happens at the credential rather than in our code
	// (#676). Omitted entirely when not asked for — an empty array would mean "no repositories",
	// which is not the same request and would silently break every existing caller.
	const scoped = opts?.repositories?.length ? { repositories: [...opts.repositories] } : null;
	const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
		method: "POST",
		headers: GH_HEADERS(jwt),
		...(scoped ? { body: JSON.stringify(scoped) } : {}),
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
	const r = await installationTokenResult(env, userId, installationId);
	return r.ok ? r.token : null;
}

/**
 * The same read, keeping the two ways it can come back empty APART (#321).
 *
 * `no-binding` is an authorization fact and permanent until a human acts; `mint-failed` is GitHub
 * declining right now and is worth retrying. Collapsing them to `null` is what let the connector
 * describe both as the same thing.
 */
async function installationTokenResult(
	env: Env,
	userId: string,
	installationId: number,
): Promise<{ ok: true; token: string } | { ok: false; reason: "no-binding" | "mint-failed" }> {
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
	if (!row) return { ok: false, reason: "no-binding" };

	const fresh = row?.token_expires_at && new Date(row.token_expires_at).getTime() - Date.now() > 5 * 60 * 1000;
	if (fresh && row?.token_ciphertext && row.token_dek && row.token_iv && env.KEY_ENCRYPTION_KEY) {
		try {
			return { ok: true, token: await decryptKey(new Uint8Array(row.token_ciphertext), new Uint8Array(row.token_dek), new Uint8Array(row.token_iv), env.KEY_ENCRYPTION_KEY) };
		} catch {
			/* fall through to refresh */
		}
	}

	const minted = await mintInstallationToken(env, installationId);
	if (!minted) return { ok: false, reason: "mint-failed" };
	await cacheInstallationToken(env, userId, installationId, minted.token, minted.expiresAt);
	return { ok: true, token: minted.token };
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

// ── Why an owner has no token (#321) ─────────────────────────────────────────────────────────
//
// The old answer was one sentence — `No GitHub access for "X". Install/authorize the
// ProAgentStore GitHub App` — wrapped by the connector in "this is usually transient, try again".
// Live, the Lead passed `"fws"`, a display label that is not a GitHub owner at all, and was told
// to re-authorize an App that was installed and working, forever, on every retry.
//
// Four conditions were collapsed into that one sentence, and they have four different remedies —
// only ONE of which is "try again":
//
//   app-not-configured  the deployment has no GITHUB_APP_ID/PRIVATE_KEY (the App is inert), or
//                       GitHub refused the credentials it does have. Nothing the owner can do.
//   owner-unknown       `owner` is not a GitHub account or organisation. Retrying is guaranteed
//                       to fail identically; the caller passed the wrong string.
//   not-installed       a real GitHub owner, but this App is not installed on it. Install URL.
//   not-authorized      the App IS installed there, but this user has no VERIFIED binding to it
//                       (see getInstallationToken's IDOR guard). Connect GitHub, or be granted.
//   transient           GitHub itself declined right now. This one, and only this one, retries.
//
// The verification that gates binding creation is untouched — this file still mints only for a
// binding `authorizeInstallation` created. What changed is what the ABSENCE of one is called.

/** Which of the five conditions above stopped a token being minted. */
export type GithubAccessState = "app-not-configured" | "owner-unknown" | "not-installed" | "not-authorized" | "transient";

export interface GithubAccessDenial {
	state: GithubAccessState;
	owner: string;
	/**
	 * The ONLY field a caller should branch on to decide whether to say "try again".
	 * True for exactly one state — see the table above.
	 */
	retryable: boolean;
	/** One sentence naming the actual condition, safe to relay verbatim. */
	message: string;
	/** What would fix it, when a human can. Null when nothing the reader controls will. */
	remedy: string | null;
}

export type GithubAccess = { ok: true; token: string } | ({ ok: false } & GithubAccessDenial);

/**
 * The message for one condition. PURE — every wording this subsystem can produce is pinned by a
 * test without a network, which is the half that regressed: the old text was accurate for exactly
 * one of the cases it was emitted for.
 */
export function githubAccessDenial(input: {
	state: GithubAccessState;
	owner: string;
	/** `https://github.com/apps/<slug>/installations/new`, when we could resolve the App's slug. */
	installUrl?: string | null;
	/** The underlying fault, for the transient + misconfigured cases. */
	detail?: string | null;
}): GithubAccessDenial {
	const owner = input.owner || "(none)";
	const detail = input.detail ? ` (${input.detail.slice(0, 120)})` : "";
	switch (input.state) {
		case "app-not-configured":
			return {
				state: input.state,
				owner,
				retryable: false,
				message: `GitHub is not connected on this platform — the ProAgentStore GitHub App is not configured here${detail}.`,
				remedy: "Nothing in your own settings changes this; the deployment needs its GitHub App credentials.",
			};
		case "owner-unknown":
			return {
				state: input.state,
				owner,
				retryable: false,
				// Named as a WRONG ARGUMENT, not a permission problem, because that is what it is —
				// and because the reader's next move is to find the right string, not to grant anything.
				message: `"${owner}" is not a GitHub account or organisation, so there is no access to have. This is not an authorization problem — the owner passed is wrong.`,
				remedy:
					'Pass the repository\'s real "owner/name". A repo\'s display label is not a path: a coding agent\'s GitHub coordinates are `repo.githubRepo` in subordinate_status, never `repo.name`. Retrying with the same value will fail identically.',
			};
		case "not-installed":
			return {
				state: input.state,
				owner,
				retryable: false,
				message: `The ProAgentStore GitHub App is not installed on "${owner}".`,
				remedy: input.installUrl
					? `Install it on "${owner}": ${input.installUrl}`
					: `Install the ProAgentStore GitHub App on "${owner}" from that account's GitHub settings.`,
			};
		case "not-authorized":
			return {
				state: input.state,
				owner,
				retryable: false,
				message: `The ProAgentStore GitHub App is installed on "${owner}", but this account is not authorized to use it.`,
				remedy: `Connect GitHub in Settings so the platform can verify you control "${owner}" (for an organisation, you must be an active member).`,
			};
		case "transient":
			return {
				state: input.state,
				owner,
				retryable: true,
				message: `GitHub could not be reached for "${owner}" just now${detail}.`,
				remedy: "This one really is transient — try again in a moment.",
			};
	}
}

/** Best-effort install URL. Never throws; null when the App slug cannot be resolved. */
async function installUrlFor(env: Env): Promise<string | null> {
	const id = await appIdentifier(env).catch(() => "");
	return id ? `https://github.com/apps/${id}/installations/new` : null;
}

/**
 * Resolve an installation token for `owner`, or say precisely why not.
 *
 * `diagnose` buys the difference between "go install an App" and "you passed a display label" for
 * TWO extra GitHub calls (`/users/<owner>` and the App slug), and it is opt-in for that reason:
 * the failure path is the ordinary path for `installationTokenForOwner`, whose callers treat "no
 * token" as "clone it publicly" and never read a message. A tool talking to a human turns it on;
 * a clone that is about to succeed anyway does not pay for prose nobody reads.
 */
export async function resolveGithubAccess(
	env: Env,
	userId: string,
	owner: string,
	opts?: { diagnose?: boolean },
): Promise<GithubAccess> {
	const deny = (state: GithubAccessState, extra?: { installUrl?: string | null; detail?: string | null }) =>
		({ ok: false as const, ...githubAccessDenial({ state, owner, ...extra }) });
	if (!githubAppConfigured(env)) return deny("app-not-configured");
	if (!owner.trim()) return deny("owner-unknown");

	const list = await installationsOrFault(env);
	if (!list.ok) return deny(list.state, { detail: list.detail });

	const match = list.installs.find((i) => i.account?.login?.toLowerCase() === owner.toLowerCase());
	if (!match) {
		if (!opts?.diagnose) return deny("not-installed");
		const exists = await githubOwnerExists(env, owner);
		// `null` = GitHub would not say. We still KNOW there is no installation, which is the
		// permanent part; we simply do not assert which flavour of "no owner here" it is.
		if (exists === false) return deny("owner-unknown");
		return deny("not-installed", { installUrl: await installUrlFor(env) });
	}

	const token = await installationTokenResult(env, userId, match.id).catch(
		() => ({ ok: false, reason: "mint-failed" }) as const,
	);
	if (token.ok) return { ok: true, token: token.token };
	return token.reason === "no-binding" ? deny("not-authorized") : deny("transient", { detail: "the installation token could not be minted" });
}

/**
 * Does `owner` exist on GitHub at all? `null` when GitHub would not say — which must NOT be
 * reported as "no such owner", the exact over-claim this whole change is about.
 */
async function githubOwnerExists(env: Env, owner: string): Promise<boolean | null> {
	try {
		const jwt = await appJwt(env);
		const res = await fetch(`https://api.github.com/users/${encodeURIComponent(owner)}`, { headers: GH_HEADERS(jwt) });
		if (res.status === 404) return false;
		if (res.ok) return true;
		return null;
	} catch {
		return null;
	}
}

/**
 * Best-effort installation token for cloning a repo owned by `owner`. Returns
 * null when the App isn't configured or `owner` has no matching installation —
 * callers treat that as "public clone, no auth". Never throws.
 */
export async function installationTokenForOwner(env: Env, userId: string, owner: string): Promise<string | null> {
	if (!owner) return null;
	const r = await resolveGithubAccess(env, userId, owner).catch(() => ({ ok: false }) as const);
	return r.ok ? r.token : null;
}

/**
 * An installation token GitHub itself restricts to ONE repository (#676).
 *
 * The ordinary token is installation-wide: it can write to every repo in the org the App is
 * installed on. `resolveCloneCredential` embeds it in the clone URL, so a managed checkout's
 * `origin` carried an org-wide write credential — `git push` from that checkout to a SIBLING repo
 * authenticated fine. This mints one GitHub will reject for anything but `owner/repo`.
 *
 * ── NEVER CACHED, and that is the point ──
 *
 * `installationTokenResult` caches per `(user_id, installation_id)` — ONE slot per installation,
 * shared by `github-issues.ts`, `hosted-repo.ts` and the connectors. Writing a repo-scoped token
 * into it would silently narrow all of them to a single repository, which is precisely the
 * "reads must stay broad" property #676 protects. So this mints fresh every time and writes
 * nothing back. Installation tokens last an hour and a clone is one call, so the cost is a
 * request, not a pattern.
 *
 * The verified-binding guard is kept: minting still requires the `github_installations` row that
 * `authorizeInstallation` creates only after proving the user controls the account. Without it
 * this would be a second, unguarded path to the cross-tenant IDOR the cache path exists to close.
 *
 * Returns null — never throws — when the App is not configured, the owner has no installation, the
 * user has no verified binding, or the installation does not include that repository. Every caller
 * treats null as "no credential", which is the same contract `installationTokenForOwner` has.
 */
export async function repoScopedInstallationToken(
	env: Env,
	userId: string,
	owner: string,
	repo: string,
): Promise<string | null> {
	if (!githubAppConfigured(env) || !owner.trim() || !repo.trim()) return null;
	const list = await installationsOrFault(env).catch(() => ({ ok: false }) as const);
	if (!list.ok) return null;
	const match = list.installs.find((i) => i.account?.login?.toLowerCase() === owner.trim().toLowerCase());
	if (!match) return null;
	// The binding is the authorization proof — same check `installationTokenResult` makes before it
	// will mint. A missing row means this user never demonstrated control of this installation.
	const binding = await env.DB.prepare("SELECT id FROM github_installations WHERE user_id = ?1 AND installation_id = ?2")
		.bind(userId, match.id)
		.first<{ id: string }>()
		.catch(() => null);
	if (!binding) return null;
	const minted = await mintInstallationToken(env, match.id, { repositories: [repo.trim()] }).catch(() => null);
	return minted?.token ?? null;
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

/**
 * Bind EVERY installed org (and matching personal account) the user is a member of, verified
 * by the USER'S OWN OAuth token (`read:org`) rather than the App's Members permission. This is
 * what lets a Google-signed-in user light up all their orgs after one `Connect GitHub` — no
 * per-org "approve Members:read" step (which GitHub gates behind sudo-mode). Membership is the
 * user attesting their own orgs, which is a sound authorization basis for minting THEIR tokens.
 * Returns the org/account logins that were bound.
 */
export async function bindMemberOrgInstallations(
	env: Env,
	userId: string,
	githubLogin: string,
	userAccessToken: string,
): Promise<string[]> {
	const installs = await listInstallations(env).catch(() => [] as GhInstallation[]);
	const bound: string[] = [];
	for (const inst of installs) {
		const login = inst.account.login;
		const isOrg = (inst.account.type || "User").toLowerCase() === "organization";
		let ok = false;
		if (!isOrg) {
			ok = login.toLowerCase() === githubLogin.toLowerCase(); // personal install
		} else {
			try {
				const res = await fetch(
					`https://api.github.com/user/memberships/orgs/${encodeURIComponent(login)}`,
					{ headers: GH_HEADERS(userAccessToken) },
				);
				if (res.ok) ok = ((await res.json()) as { state?: string }).state === "active";
			} catch { ok = false; }
		}
		if (!ok) continue;
		const minted = await mintInstallationToken(env, inst.id);
		if (!minted) continue;
		await cacheInstallationToken(env, userId, inst.id, minted.token, minted.expiresAt, { login, type: inst.account.type });
		bound.push(login);
	}
	return bound;
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
