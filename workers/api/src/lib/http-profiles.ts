/**
 * Named HTTP credential profiles and their per-instance bindings (#1123 — part 1 of epic #1122).
 *
 * ── What this is
 *
 * The generic HTTP connector had one opaque credential per owner (`user_api_keys` provider "http").
 * A PROFILE is a named secret an owner keeps for it — any number of them — and a BINDING attaches a
 * profile to one instance and connector under a binding name, which is how an agent will select it
 * (#1124 makes `http_request` take that name). An instance reaches a profile ONLY through one of its
 * own bindings.
 *
 * ── The secret never leaves this module in the clear
 *
 * It is envelope-encrypted on write (`encryptKey`: AES-256-GCM, its data key wrapped under
 * `KEY_ENCRYPTION_KEY`) and every view this module returns is built from the metadata columns alone
 * — there is no "reveal". The only function that decrypts for use is {@link resolveBoundSecret},
 * which nothing exposes: it exists for #1124 to render a request with, and it answers only for an
 * instance holding a binding. Error messages never quote a submitted secret. A rotation is visible as
 * `secret.version` + `rotatedAt`, never as any part of the value (no prefix, suffix or hash is kept).
 *
 * ── Deliberately not here (later parts of #1122)
 *
 *   - (#1124 added them) `strategy` / `strategy_config` — HOW the secret becomes a request: validated
 *     and rendered by `lib/http-auth-strategies.ts`, OAuth2 grants by `lib/http-profile-oauth.ts`. A
 *     profile created without one stays `unspecified` and renders nothing until a strategy is set.
 *   - `allowedOrigins` — stored and returned so an agent can see where a binding is MEANT for; the
 *     host allowlist, scheme and redirect policy that enforce them are #1125.
 *   - The connection "test" here is a STORAGE test (present, decryptable, origins well-formed). A live
 *     request needs a rendering strategy and the execution policy, which do not exist yet — said so in
 *     the result rather than implied.
 */
import { HttpError } from "./auth.js";
import { decryptKey, encryptKey } from "./crypto.js";
import { describeRendering, OAUTH2_STRATEGIES, type RenderedAuth, renderAuth, type StrategyConfig, StrategyError, validateStrategy } from "./http-auth-strategies.js";
import { clearProfileTokens, completeProfileAuthorization, ProfileAuthError, profileAccessToken, profileAuthorizeUrl, profileTokenStatus, type OAuthDeps } from "./http-profile-oauth.js";
import type { Env } from "../types.js";

/** A profile or binding name: what an agent types, so lower-case and plain. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CONNECTOR = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const SECRET_MAX_CHARS = 8_192;
export const ORIGINS_MAX = 20;
export const DESCRIPTION_MAX_CHARS = 500;
/** The only strategy a profile has until #1124 defines how a secret is rendered. */
export const UNSPECIFIED_STRATEGY = "unspecified";

/** A profile as every surface returns it — metadata only, by construction. */
export interface HttpProfileView {
	id: string;
	name: string;
	description: string;
	strategy: string;
	/** The strategy's non-secret configuration (#1124): names, literals, URLs, the OAuth2 client id. Null while `unspecified`. */
	strategyConfig: StrategyConfig | null;
	/** Which header and query parameter NAMES a request carries — never a value. */
	renders: { headers: string[]; query: string[] };
	allowedOrigins: string[];
	secret: { set: true; version: number; rotatedAt: string | null };
	bindings: Array<{ instanceId: string; connector: string; bindingName: string }>;
	createdAt: string;
	updatedAt: string;
}

/** A binding as an instance's caller sees it: enough to choose one, never the secret. */
export interface HttpBindingView {
	bindingName: string;
	connector: string;
	profileId: string;
	profileName: string;
	description: string;
	strategy: string;
	allowedOrigins: string[];
	secretVersion: number;
	createdAt: string;
}

type ProfileRow = {
	id: string;
	user_id: string;
	name: string;
	description: string;
	strategy: string;
	strategy_config: string;
	allowed_origins: string;
	secret_version: number;
	secret_rotated_at: string | null;
	created_at: string;
	updated_at: string;
};
/** The metadata columns — the only ones a view is ever read from. */
const META = "id, user_id, name, description, strategy, strategy_config, allowed_origins, secret_version, secret_rotated_at, created_at, updated_at";

/** The stored strategy, re-validated on every read — a row written by hand is not trusted to render. */
function storedStrategy(row: Pick<ProfileRow, "strategy" | "strategy_config">): StrategyConfig | null {
	if (row.strategy === UNSPECIFIED_STRATEGY) return null;
	try {
		return validateStrategy(row.strategy, JSON.parse(row.strategy_config || "{}"));
	} catch {
		return null;
	}
}

/** Validate a strategy from an owner's input, as a 400 the owner can act on. */
function strategyFrom(strategy: unknown, config: unknown): StrategyConfig {
	try {
		return validateStrategy(strategy, config);
	} catch (e) {
		throw new HttpError(400, e instanceof StrategyError ? e.message : "Invalid strategy.");
	}
}
const configColumn = (cfg: StrategyConfig) => {
	const { strategy: _s, ...rest } = cfg;
	return JSON.stringify(rest);
};

const origins = (raw: string): string[] => {
	try {
		const v = JSON.parse(raw) as unknown;
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
};

// ── Validation (at the boundary; every refusal names the field, never echoes a secret) ──────────

export function validName(raw: unknown, field = "name"): string {
	const name = typeof raw === "string" ? raw.trim() : "";
	if (!NAME.test(name)) throw new HttpError(400, `\`${field}\` must be 1–64 characters: lower-case letters, digits, "-" or "_", starting with a letter or digit.`);
	return name;
}

export function validConnector(raw: unknown): string {
	const connector = raw === undefined || raw === null || raw === "" ? "http" : typeof raw === "string" ? raw.trim() : "";
	if (!CONNECTOR.test(connector)) throw new HttpError(400, "`connector` must be a connector id such as \"http\".");
	return connector;
}

/** The secret, unchanged — or a refusal that says what was wrong with it without quoting it. */
export function validSecret(raw: unknown): string {
	if (typeof raw !== "string" || raw.length === 0) throw new HttpError(400, "`secret` is required and must be a non-empty string.");
	if (raw.length > SECRET_MAX_CHARS) throw new HttpError(400, `\`secret\` is too long (${raw.length} characters; at most ${SECRET_MAX_CHARS}).`);
	// A line break or NUL inside a secret would split a header once #1124 renders it.
	if (/[\r\n\0]/.test(raw)) throw new HttpError(400, "`secret` must not contain line breaks or NUL characters.");
	return raw;
}

/** Normalised `scheme://host[:port]` origins. Anything else — a path, query, credentials — is refused. */
export function validOrigins(raw: unknown): string[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new HttpError(400, "`allowedOrigins` must be a list of origins such as \"https://discord.com\".");
	if (raw.length > ORIGINS_MAX) throw new HttpError(400, `\`allowedOrigins\` holds at most ${ORIGINS_MAX} origins.`);
	const out: string[] = [];
	// A refusal names the entry by position rather than quoting it: an origin pasted with a key in
	// its query string would otherwise be echoed straight back.
	for (const [i, item] of raw.entries()) {
		let u: URL;
		try {
			u = new URL(String(item));
		} catch {
			throw new HttpError(400, `\`allowedOrigins\` entry ${i + 1} is not an origin.`);
		}
		const bare = (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash && !u.username && !u.password;
		if ((u.protocol !== "https:" && u.protocol !== "http:") || !bare) {
			throw new HttpError(400, `\`allowedOrigins\` entry ${i + 1} must be just a scheme and host, e.g. "https://discord.com" — no path, query or credentials.`);
		}
		if (!out.includes(u.origin)) out.push(u.origin);
	}
	return out;
}

function validDescription(raw: unknown): string {
	if (raw === undefined || raw === null) return "";
	if (typeof raw !== "string") throw new HttpError(400, "`description` must be a string.");
	if (raw.length > DESCRIPTION_MAX_CHARS) throw new HttpError(400, `\`description\` holds at most ${DESCRIPTION_MAX_CHARS} characters.`);
	return raw.trim();
}

function kek(env: Pick<Env, "KEY_ENCRYPTION_KEY">): string {
	if (!env.KEY_ENCRYPTION_KEY) throw new HttpError(503, "Credential encryption is not configured on this platform.");
	return env.KEY_ENCRYPTION_KEY;
}

// ── Views ───────────────────────────────────────────────────────────────────────────────────

async function bindingsOf(env: Pick<Env, "DB">, userId: string, profileIds: string[]): Promise<Map<string, HttpProfileView["bindings"]>> {
	const out = new Map<string, HttpProfileView["bindings"]>();
	if (!profileIds.length) return out;
	const marks = profileIds.map((_, i) => `?${i + 2}`).join(", ");
	const { results } = await env.DB.prepare(
		`SELECT profile_id, instance_id, connector, binding_name FROM http_credential_bindings WHERE user_id = ?1 AND profile_id IN (${marks}) ORDER BY created_at, id`,
	)
		.bind(userId, ...profileIds)
		.all<{ profile_id: string; instance_id: string; connector: string; binding_name: string }>();
	for (const r of results ?? []) {
		const list = out.get(r.profile_id) ?? [];
		list.push({ instanceId: r.instance_id, connector: r.connector, bindingName: r.binding_name });
		out.set(r.profile_id, list);
	}
	return out;
}

function view(row: ProfileRow, bindings: HttpProfileView["bindings"]): HttpProfileView {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		strategy: row.strategy,
		strategyConfig: storedStrategy(row),
		renders: (() => {
			const cfg = storedStrategy(row);
			return cfg ? describeRendering(cfg) : { headers: [], query: [] };
		})(),
		allowedOrigins: origins(row.allowed_origins),
		secret: { set: true, version: Number(row.secret_version), rotatedAt: row.secret_rotated_at },
		bindings,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

async function ownedRow(env: Pick<Env, "DB">, userId: string, id: string): Promise<ProfileRow> {
	const row = await env.DB.prepare(`SELECT ${META} FROM http_credential_profiles WHERE id = ?1 AND user_id = ?2`).bind(id, userId).first<ProfileRow>();
	// Another owner's profile and a missing one read the same: its existence is not disclosed.
	if (!row) throw new HttpError(404, "No such HTTP credential profile.");
	return row;
}

// ── Profiles ────────────────────────────────────────────────────────────────────────────────

export async function listHttpProfiles(env: Pick<Env, "DB">, userId: string): Promise<HttpProfileView[]> {
	const { results } = await env.DB.prepare(`SELECT ${META} FROM http_credential_profiles WHERE user_id = ?1 ORDER BY name`).bind(userId).all<ProfileRow>();
	const rows = results ?? [];
	const bindings = await bindingsOf(env, userId, rows.map((r) => r.id));
	return rows.map((r) => view(r, bindings.get(r.id) ?? []));
}

export async function getHttpProfile(env: Pick<Env, "DB">, userId: string, id: string): Promise<HttpProfileView> {
	const row = await ownedRow(env, userId, id);
	return view(row, (await bindingsOf(env, userId, [row.id])).get(row.id) ?? []);
}

export async function createHttpProfile(env: Pick<Env, "DB" | "KEY_ENCRYPTION_KEY">, userId: string, input: Record<string, unknown>): Promise<HttpProfileView> {
	const name = validName(input.name);
	const secret = validSecret(input.secret);
	const description = validDescription(input.description);
	const allowed = validOrigins(input.allowedOrigins);
	const cfg = input.strategy === undefined || input.strategy === UNSPECIFIED_STRATEGY ? null : strategyFrom(input.strategy, input.strategyConfig);
	const existing = await env.DB.prepare("SELECT 1 AS x FROM http_credential_profiles WHERE user_id = ?1 AND name = ?2").bind(userId, name).first();
	if (existing) throw new HttpError(409, `A profile named "${name}" already exists. Rotate its secret, or choose another name.`);
	const sealed = await encryptKey(secret, kek(env));
	const id = `hcp_${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO http_credential_profiles (id, user_id, name, description, strategy, strategy_config, allowed_origins, secret_ciphertext, secret_dek, secret_iv)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
	)
		.bind(id, userId, name, description, cfg?.strategy ?? UNSPECIFIED_STRATEGY, cfg ? configColumn(cfg) : "{}", JSON.stringify(allowed), sealed.ciphertext, sealed.dekWrapped, sealed.iv)
		.run();
	return getHttpProfile(env, userId, id);
}

/** Metadata only. A secret sent here is refused, not silently ignored: rotation is its own act. */
export async function updateHttpProfile(env: Pick<Env, "DB">, userId: string, id: string, input: Record<string, unknown>): Promise<HttpProfileView> {
	const current = await ownedRow(env, userId, id);
	if ("secret" in input) throw new HttpError(400, "A profile's secret is changed with rotate, never with update.");
	const sets: string[] = [];
	const binds: unknown[] = [id, userId];
	if (input.name !== undefined) {
		const name = validName(input.name);
		const clash = await env.DB.prepare("SELECT 1 AS x FROM http_credential_profiles WHERE user_id = ?1 AND name = ?2 AND id <> ?3").bind(userId, name, id).first();
		if (clash) throw new HttpError(409, `A profile named "${name}" already exists.`);
		binds.push(name);
		sets.push(`name = ?${binds.length}`);
	}
	if (input.description !== undefined) {
		binds.push(validDescription(input.description));
		sets.push(`description = ?${binds.length}`);
	}
	if (input.allowedOrigins !== undefined) {
		binds.push(JSON.stringify(validOrigins(input.allowedOrigins)));
		sets.push(`allowed_origins = ?${binds.length}`);
	}
	// The strategy and its config are validated TOGETHER (#1124): a config is only meaningful for its strategy.
	let strategyChanged = false;
	if (input.strategy !== undefined || input.strategyConfig !== undefined) {
		const strategy = input.strategy ?? current.strategy;
		if (strategy === UNSPECIFIED_STRATEGY) throw new HttpError(400, "Set a `strategy` to configure how this profile's secret is sent.");
		const cfg = strategyFrom(strategy, input.strategyConfig ?? (input.strategy === undefined ? JSON.parse(current.strategy_config || "{}") : undefined));
		binds.push(cfg.strategy);
		sets.push(`strategy = ?${binds.length}`);
		binds.push(configColumn(cfg));
		sets.push(`strategy_config = ?${binds.length}`);
		strategyChanged = true;
	}
	if (!sets.length) throw new HttpError(400, "Nothing to update: send name, description, allowedOrigins, strategy or strategyConfig.");
	await env.DB.prepare(`UPDATE http_credential_profiles SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?1 AND user_id = ?2`)
		.bind(...binds)
		.run();
	// A grant was issued for the OLD client or endpoint: never spend it against a new one.
	if (strategyChanged) await clearProfileTokens(env, id, userId);
	return getHttpProfile(env, userId, id);
}

/** Replace the secret. Bindings keep pointing at the profile, so every bound instance uses the new one. */
export async function rotateHttpProfileSecret(env: Pick<Env, "DB" | "KEY_ENCRYPTION_KEY">, userId: string, id: string, input: Record<string, unknown>): Promise<HttpProfileView> {
	await ownedRow(env, userId, id);
	const sealed = await encryptKey(validSecret(input.secret), kek(env));
	await env.DB.prepare(
		`UPDATE http_credential_profiles SET secret_ciphertext = ?3, secret_dek = ?4, secret_iv = ?5, secret_version = secret_version + 1,
		        secret_rotated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1 AND user_id = ?2`,
	)
		.bind(id, userId, sealed.ciphertext, sealed.dekWrapped, sealed.iv)
		.run();
	return getHttpProfile(env, userId, id);
}

/** Delete the profile and, with it, every binding to it. */
export async function deleteHttpProfile(env: Pick<Env, "DB">, userId: string, id: string): Promise<{ deleted: true; id: string; unbound: number }> {
	await ownedRow(env, userId, id);
	const unbound = await env.DB.prepare("DELETE FROM http_credential_bindings WHERE profile_id = ?1 AND user_id = ?2").bind(id, userId).run();
	await clearProfileTokens(env, id, userId);
	await env.DB.prepare("DELETE FROM http_credential_profiles WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
	return { deleted: true, id, unbound: unbound.meta?.changes ?? 0 };
}

async function sealedSecret(env: Pick<Env, "DB" | "KEY_ENCRYPTION_KEY">, profileId: string): Promise<string> {
	const row = await env.DB.prepare("SELECT secret_ciphertext, secret_dek, secret_iv FROM http_credential_profiles WHERE id = ?1")
		.bind(profileId)
		.first<{ secret_ciphertext: ArrayBuffer; secret_dek: ArrayBuffer; secret_iv: ArrayBuffer }>();
	if (!row) throw new HttpError(404, "No such HTTP credential profile.");
	return decryptKey(new Uint8Array(row.secret_ciphertext), new Uint8Array(row.secret_dek), new Uint8Array(row.secret_iv), kek(env));
}

export interface HttpProfileTestResult {
	profileId: string;
	ok: boolean;
	checks: Array<{ check: string; ok: boolean; detail: string }>;
	/** What this test does NOT establish — said, not implied. */
	scope: string;
}

/**
 * A storage test: the secret is present and decrypts, the origins are well-formed, and which
 * instances can use it. It reports facts about the secret, never the secret, and sends nothing over
 * the network — a live request needs a rendering strategy (#1124) and the execution policy (#1125).
 */
export async function testHttpProfile(env: Pick<Env, "DB" | "KEY_ENCRYPTION_KEY">, userId: string, id: string): Promise<HttpProfileTestResult> {
	const profile = await getHttpProfile(env, userId, id);
	const checks: HttpProfileTestResult["checks"] = [];
	try {
		const secret = await sealedSecret(env, id);
		checks.push({ check: "secret_decrypts", ok: secret.length > 0, detail: `The stored secret (version ${profile.secret.version}) decrypts with the platform key.` });
	} catch (e) {
		// The message is about the KEY or the ciphertext, never the value.
		checks.push({ check: "secret_decrypts", ok: false, detail: e instanceof HttpError ? e.message : "The stored secret could not be decrypted with the platform key; rotate it." });
	}
	const cfg = await env.DB.prepare("SELECT strategy, strategy_config FROM http_credential_profiles WHERE id = ?1 AND user_id = ?2").bind(id, userId).first<Pick<ProfileRow, "strategy" | "strategy_config">>();
	const strategy = cfg ? storedStrategy(cfg) : null;
	checks.push(
		strategy
			? { check: "strategy_renders", ok: true, detail: `Strategy ${strategy.strategy}: a request carries ${[...profile.renders.headers.map((h) => `header ${h}`), ...profile.renders.query.map((q) => `query parameter ${q}`)].join(", ") || "no credential"}.` }
			: { check: "strategy_renders", ok: false, detail: "No strategy is set, so this profile renders nothing: set `strategy` (and `strategyConfig`) with update." },
	);
	if (strategy && OAUTH2_STRATEGIES.has(strategy.strategy)) {
		const grant = await profileTokenStatus(env, id, userId);
		const authorized = strategy.strategy === "oauth2_client_credentials" || grant.refreshToken;
		checks.push({
			check: "oauth2_grant",
			ok: !!authorized,
			detail: authorized
				? `OAuth2 grant ${grant.accessToken ? `holds an access token${grant.expiresAt ? ` expiring ${grant.expiresAt}` : ""}` : "will mint an access token on first use"}${grant.refreshToken ? "; a refresh token is stored" : ""}.`
				: "Not authorized yet: the owner must grant access once in a browser before a request can be made.",
		});
	}
	checks.push({ check: "allowed_origins", ok: true, detail: profile.allowedOrigins.length ? `${profile.allowedOrigins.length} origin(s) recorded.` : "No origins recorded yet." });
	checks.push({ check: "bindings", ok: true, detail: profile.bindings.length ? `Bound to ${profile.bindings.length} instance binding(s).` : "Not bound to any instance — no agent can use it until it is bound." });
	return {
		profileId: id,
		ok: checks.every((c) => c.ok),
		checks,
		scope: "Storage and configuration check only: nothing was sent to any server, and no token was minted. Which hosts may receive the credential is #1125, not checked here.",
	};
}

// ── Bindings ────────────────────────────────────────────────────────────────────────────────

/** Bind an owner's profile to one of their instances under a name. The caller has checked the instance is theirs. */
export async function bindHttpProfile(
	env: Pick<Env, "DB">,
	userId: string,
	instanceId: string,
	input: { bindingName: unknown; profileId: unknown; connector?: unknown },
): Promise<HttpBindingView> {
	const bindingName = validName(input.bindingName, "bindingName");
	const connector = validConnector(input.connector);
	const profile = await ownedRow(env, userId, String(input.profileId ?? ""));
	await env.DB.prepare(
		`INSERT INTO http_credential_bindings (id, profile_id, instance_id, user_id, connector, binding_name) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
		 ON CONFLICT(instance_id, connector, binding_name) DO UPDATE SET profile_id = excluded.profile_id`,
	)
		.bind(`hcb_${crypto.randomUUID()}`, profile.id, instanceId, userId, connector, bindingName)
		.run();
	const bound = (await listInstanceHttpBindings(env, userId, instanceId)).find((b) => b.connector === connector && b.bindingName === bindingName);
	return bound as HttpBindingView;
}

export async function unbindHttpProfile(env: Pick<Env, "DB">, userId: string, instanceId: string, bindingName: string, connector?: unknown): Promise<{ unbound: boolean }> {
	const res = await env.DB.prepare("DELETE FROM http_credential_bindings WHERE instance_id = ?1 AND user_id = ?2 AND connector = ?3 AND binding_name = ?4")
		.bind(instanceId, userId, validConnector(connector), validName(bindingName, "bindingName"))
		.run();
	return { unbound: (res.meta?.changes ?? 0) > 0 };
}

/** What one instance may use: its bindings, with each profile's metadata. Never a secret. */
export async function listInstanceHttpBindings(env: Pick<Env, "DB">, userId: string, instanceId: string): Promise<HttpBindingView[]> {
	const { results } = await env.DB.prepare(
		`SELECT b.binding_name, b.connector, b.profile_id, b.created_at, p.name, p.description, p.strategy, p.allowed_origins, p.secret_version
		   FROM http_credential_bindings b JOIN http_credential_profiles p ON p.id = b.profile_id AND p.user_id = b.user_id
		  WHERE b.instance_id = ?1 AND b.user_id = ?2 ORDER BY b.connector, b.binding_name`,
	)
		.bind(instanceId, userId)
		.all<{ binding_name: string; connector: string; profile_id: string; created_at: string; name: string; description: string; strategy: string; allowed_origins: string; secret_version: number }>();
	return (results ?? []).map((r) => ({
		bindingName: r.binding_name,
		connector: r.connector,
		profileId: r.profile_id,
		profileName: r.name,
		description: r.description,
		strategy: r.strategy,
		allowedOrigins: origins(r.allowed_origins),
		secretVersion: Number(r.secret_version),
		createdAt: r.created_at,
	}));
}

/**
 * The secret a bound instance may use — the ONE decrypting path, for #1124's request rendering. Not
 * reachable from any route or tool. Null unless THIS instance holds THIS binding for THIS connector,
 * under the same owner as the profile: an unbound instance, another owner, or a binding name it does
 * not hold all get nothing.
 */
export async function resolveBoundSecret(
	env: Pick<Env, "DB" | "KEY_ENCRYPTION_KEY">,
	q: { userId: string; instanceId: string; connector: string; bindingName: string },
): Promise<{ binding: HttpBindingView; secret: string } | null> {
	const binding = (await listInstanceHttpBindings(env, q.userId, q.instanceId)).find((b) => b.connector === q.connector && b.bindingName === q.bindingName);
	if (!binding) return null;
	return { binding, secret: await sealedSecret(env, binding.profileId) };
}

/**
 * Render the credential a bound instance may send (#1124) — the one path from a binding to a request.
 * Null when this instance holds no such binding (see {@link resolveBoundSecret}). Throws an
 * {@link HttpError} the agent can read — never quoting the secret — for an unconfigured strategy or an
 * OAuth2 grant that cannot be obtained. `forceRefresh` skips a stored OAuth2 access token the API refused.
 */
export async function renderBoundProfile(
	env: Pick<Env, "DB" | "KEY_ENCRYPTION_KEY">,
	q: { userId: string; instanceId: string; connector: string; bindingName: string },
	opts: OAuthDeps & { forceRefresh?: boolean } = {},
): Promise<{ binding: HttpBindingView; strategy: StrategyConfig["strategy"]; rendered: RenderedAuth } | null> {
	const bound = await resolveBoundSecret(env, q);
	if (!bound) return null;
	const row = await env.DB.prepare("SELECT strategy, strategy_config FROM http_credential_profiles WHERE id = ?1 AND user_id = ?2").bind(bound.binding.profileId, q.userId).first<Pick<ProfileRow, "strategy" | "strategy_config">>();
	const cfg = row ? storedStrategy(row) : null;
	if (!cfg) throw new HttpError(409, `The profile bound as "${q.bindingName}" has no auth strategy yet — its owner sets one with update_http_profile.`);
	try {
		const accessToken =
			cfg.strategy === "oauth2_client_credentials" || cfg.strategy === "oauth2_authorization_code"
				? await profileAccessToken(env, { id: bound.binding.profileId, userId: q.userId, strategy: cfg.strategy, cfg }, bound.secret, { ...opts, force: opts.forceRefresh })
				: undefined;
		return { binding: bound.binding, strategy: cfg.strategy, rendered: renderAuth(cfg, { secret: bound.secret, accessToken }) };
	} catch (e) {
		if (e instanceof ProfileAuthError || e instanceof StrategyError) throw new HttpError(409, e.message);
		throw e;
	}
}

/** The owner's authorization-code profile and its config, or a 4xx that says why it cannot be authorized. */
async function authorizationCodeProfile(env: Pick<Env, "DB">, userId: string, id: string) {
	const row = await ownedRow(env, userId, id);
	const cfg = storedStrategy(row);
	if (cfg?.strategy !== "oauth2_authorization_code") throw new HttpError(409, "Only an oauth2_authorization_code profile is authorized in a browser; a client-credentials profile mints its own tokens.");
	return cfg;
}

/** Where the owner grants access (#1124). `state` is signed and browser-bound by the route. */
export async function httpProfileAuthorizeUrl(env: Pick<Env, "DB">, userId: string, id: string, redirectUri: string, state: string): Promise<string> {
	return profileAuthorizeUrl(await authorizationCodeProfile(env, userId, id), redirectUri, state);
}

/** Finish the consent: exchange the code for the profile's grant, stored encrypted. */
export async function completeHttpProfileAuthorization(env: Pick<Env, "DB" | "KEY_ENCRYPTION_KEY">, userId: string, id: string, code: string, redirectUri: string, deps: OAuthDeps = {}): Promise<void> {
	const cfg = await authorizationCodeProfile(env, userId, id);
	try {
		await completeProfileAuthorization(env, { id, userId, cfg }, await sealedSecret(env, id), code, redirectUri, deps);
	} catch (e) {
		if (e instanceof ProfileAuthError) throw new HttpError(400, e.message);
		throw e;
	}
}
