/**
 * HTTP authentication strategies for credential profiles (#1124 — part 2 of epic #1122).
 *
 * A profile (`lib/http-profiles.ts`, #1123) holds ONE encrypted secret and, since this, a strategy that
 * says how that secret becomes a request. The agent names a binding; the platform renders the request.
 * The agent never sees the secret and never concatenates it — `Bot `, `Bearer `, `Basic` and the like
 * are the platform's, from configuration the OWNER wrote.
 *
 * Pure: validation and rendering only. Decrypting the secret and minting OAuth2 access tokens is
 * `lib/http-profile-oauth.ts`; which hosts may receive the result is #1125, not this.
 *
 * ── Templating is literals around ONE secret reference, nothing else
 *
 * A custom header is `{ name, template }`, where `template` is static text with at most one
 * `{{secret}}`. No other placeholder exists — not `{{input}}`, not an environment variable, not a second
 * secret — so nothing the agent sends can reach a credential header, and nothing a template says can
 * pull in anything but the profile's own secret. Literals are printable ASCII without `{` or `}` (so a
 * would-be placeholder is refused, not passed through) and never a line break (header injection).
 */

export const HTTP_AUTH_STRATEGIES = [
	"none",
	"api_key",
	"bearer",
	"header_template",
	"basic",
	"multi_header",
	"oauth2_client_credentials",
	"oauth2_authorization_code",
] as const;
export type HttpAuthStrategy = (typeof HTTP_AUTH_STRATEGIES)[number];

/** The OAuth2 strategies: their secret is the CLIENT secret, and the request carries a minted access token. */
export const OAUTH2_STRATEGIES: ReadonlySet<string> = new Set(["oauth2_client_credentials", "oauth2_authorization_code"]);

export interface HeaderTemplate {
	name: string;
	/** Static literal text, with `{{secret}}` at most once. */
	template: string;
}

export interface OAuth2Config {
	tokenUrl: string;
	clientId: string;
	scope?: string;
	/** How the client authenticates at the token endpoint. Default `body` (client_id + client_secret form fields). */
	clientAuth?: "body" | "basic";
	/** Authorization-code only: where the owner grants access. */
	authorizeUrl?: string;
}

/** A validated strategy configuration. Every field is non-secret by construction — it is shown as profile metadata. */
export type StrategyConfig =
	| { strategy: "none"; staticHeaders?: Record<string, string> }
	| { strategy: "api_key"; in: "header" | "query"; name: string; staticHeaders?: Record<string, string> }
	| { strategy: "bearer"; staticHeaders?: Record<string, string> }
	| { strategy: "header_template"; header: HeaderTemplate; staticHeaders?: Record<string, string> }
	| { strategy: "basic"; username: string; staticHeaders?: Record<string, string> }
	| { strategy: "multi_header"; headers: HeaderTemplate[] }
	| ({ strategy: "oauth2_client_credentials"; staticHeaders?: Record<string, string> } & OAuth2Config)
	| ({ strategy: "oauth2_authorization_code"; staticHeaders?: Record<string, string> } & OAuth2Config);

export class StrategyError extends Error {}

/** RFC 9110 token characters — what a header NAME (and a query parameter name, here) may be. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
/** A literal around the secret: printable ASCII, no braces (so no placeholder can hide in it), no line break. */
const LITERAL = /^[\x20-\x7a\x7c\x7e]*$/;
const SECRET_REF = "{{secret}}";
/** Headers the platform owns: setting them from a profile would change how the request is framed. */
const RESERVED = new Set(["host", "content-length", "transfer-encoding", "connection", "cookie", "set-cookie"]);
const MAX_LITERAL = 128;
const MAX_HEADERS = 8;

function headerName(raw: unknown, field: string): string {
	const name = typeof raw === "string" ? raw.trim() : "";
	if (!TOKEN.test(name)) throw new StrategyError(`\`${field}\` must be a header name (letters, digits and !#$%&'*+.^_\`|~-).`);
	if (RESERVED.has(name.toLowerCase())) throw new StrategyError(`\`${field}\` may not be "${name}" — the platform sets that header.`);
	return name;
}

function literal(raw: unknown, field: string): string {
	const s = typeof raw === "string" ? raw : "";
	if (s.length > MAX_LITERAL || !LITERAL.test(s)) throw new StrategyError(`\`${field}\` must be static text: printable ASCII, no { or }, no line breaks, at most ${MAX_LITERAL} characters.`);
	return s;
}

/** A template: literals around at most one `{{secret}}`. Any other `{{…}}`, or a second reference, is refused. */
export function parseTemplate(raw: unknown, field: string): { prefix: string; suffix: string; usesSecret: boolean } {
	const t = typeof raw === "string" ? raw : "";
	const at = t.indexOf(SECRET_REF);
	if (at === -1) return { prefix: literal(t, field), suffix: "", usesSecret: false };
	if (t.indexOf(SECRET_REF, at + 1) !== -1) throw new StrategyError(`\`${field}\` may reference {{secret}} only once.`);
	return { prefix: literal(t.slice(0, at), field), suffix: literal(t.slice(at + SECRET_REF.length), field), usesSecret: true };
}

function headerTemplate(raw: unknown, field: string): HeaderTemplate {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const name = headerName(r.name, `${field}.name`);
	const template = typeof r.template === "string" ? r.template : "";
	parseTemplate(template, `${field}.template`);
	return { name, template };
}

function staticHeaders(raw: unknown): Record<string, string> | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) throw new StrategyError("`staticHeaders` must be an object of header name → static value.");
	const out: Record<string, string> = {};
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length > MAX_HEADERS) throw new StrategyError(`\`staticHeaders\` holds at most ${MAX_HEADERS} headers.`);
	for (const [k, v] of entries) {
		const value = literal(v, `staticHeaders.${k}`);
		if (value.includes(SECRET_REF)) throw new StrategyError("`staticHeaders` are non-secret literals; reference the secret through the strategy itself.");
		out[headerName(k, "staticHeaders")] = value;
	}
	return Object.keys(out).length ? out : undefined;
}

function httpsUrl(raw: unknown, field: string): string {
	const s = typeof raw === "string" ? raw.trim() : "";
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		throw new StrategyError(`\`${field}\` must be an https URL.`);
	}
	if (u.protocol !== "https:" || u.username || u.password) throw new StrategyError(`\`${field}\` must be an https URL without credentials in it.`);
	return u.toString();
}

function oauth2(raw: Record<string, unknown>, code: boolean): OAuth2Config {
	const clientId = typeof raw.clientId === "string" ? raw.clientId.trim() : "";
	if (!clientId || clientId.length > 256 || /[\r\n]/.test(clientId)) throw new StrategyError("`clientId` is required (the OAuth2 client id — not secret; the client secret is the profile's secret).");
	const scope = raw.scope === undefined || raw.scope === null ? undefined : literal(raw.scope, "scope");
	const clientAuth = raw.clientAuth === "basic" ? "basic" : raw.clientAuth === undefined || raw.clientAuth === "body" ? "body" : null;
	if (!clientAuth) throw new StrategyError('`clientAuth` is "body" (default) or "basic".');
	return {
		tokenUrl: httpsUrl(raw.tokenUrl, "tokenUrl"),
		clientId,
		...(scope ? { scope } : {}),
		clientAuth,
		...(code ? { authorizeUrl: httpsUrl(raw.authorizeUrl, "authorizeUrl") } : {}),
	};
}

/** Validate an owner's strategy + config into the stored, non-secret shape. */
export function validateStrategy(strategyRaw: unknown, configRaw: unknown): StrategyConfig {
	const strategy = typeof strategyRaw === "string" ? strategyRaw : "";
	if (!(HTTP_AUTH_STRATEGIES as readonly string[]).includes(strategy)) throw new StrategyError(`\`strategy\` must be one of: ${HTTP_AUTH_STRATEGIES.join(", ")}.`);
	const c = (configRaw && typeof configRaw === "object" && !Array.isArray(configRaw) ? configRaw : {}) as Record<string, unknown>;
	const extra = staticHeaders(c.staticHeaders);
	const withStatic = <T extends object>(o: T) => (extra ? { ...o, staticHeaders: extra } : o);
	switch (strategy as HttpAuthStrategy) {
		case "none":
			return withStatic({ strategy: "none" as const });
		case "api_key": {
			const where = c.in === "query" ? "query" : c.in === undefined || c.in === "header" ? "header" : null;
			if (!where) throw new StrategyError('`in` is "header" (default) or "query".');
			const name = where === "header" ? headerName(c.name, "name") : (() => {
				const n = typeof c.name === "string" ? c.name.trim() : "";
				if (!TOKEN.test(n)) throw new StrategyError("`name` must be the query parameter's name.");
				return n;
			})();
			return withStatic({ strategy: "api_key" as const, in: where, name });
		}
		case "bearer":
			return withStatic({ strategy: "bearer" as const });
		case "header_template": {
			const header = headerTemplate(c.header ?? { name: c.name, template: c.template }, "header");
			if (!parseTemplate(header.template, "header.template").usesSecret) throw new StrategyError("`header.template` must contain {{secret}} — a header without the secret is a staticHeader.");
			return withStatic({ strategy: "header_template" as const, header });
		}
		case "basic": {
			const username = typeof c.username === "string" ? c.username : "";
			// RFC 7617: a user-id containing ':' cannot be decoded unambiguously.
			if (!username || username.includes(":") || username.length > 256 || /[\r\n]/.test(username)) throw new StrategyError("`username` is required (no ':' or line breaks). It is metadata, shown to the owner; the password is the profile's secret.");
			return withStatic({ strategy: "basic" as const, username });
		}
		case "multi_header": {
			if (!Array.isArray(c.headers) || !c.headers.length || c.headers.length > MAX_HEADERS) throw new StrategyError(`\`headers\` must list 1–${MAX_HEADERS} headers, each { name, template }.`);
			const headers = c.headers.map((h, i) => headerTemplate(h, `headers[${i}]`));
			const names = headers.map((h) => h.name.toLowerCase());
			if (new Set(names).size !== names.length) throw new StrategyError("`headers` names each header once.");
			if (!headers.some((h) => parseTemplate(h.template, "headers").usesSecret)) throw new StrategyError("At least one of `headers` must reference {{secret}}.");
			return { strategy: "multi_header", headers };
		}
		case "oauth2_client_credentials":
			return withStatic({ strategy: "oauth2_client_credentials" as const, ...oauth2(c, false) });
		case "oauth2_authorization_code":
			return withStatic({ strategy: "oauth2_authorization_code" as const, ...oauth2(c, true) });
	}
}

/** What a rendered credential puts on a request — and every string derived from the secret, to scrub. */
export interface RenderedAuth {
	headers: Array<[string, string]>;
	query: Array<[string, string]>;
	/** Every value that carries secret material, longest first — `scrubSecrets` removes them from anything returned. */
	sensitive: string[];
}

const base64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/**
 * Render a profile's credential. `secret` is the profile's decrypted secret; for OAuth2 strategies the
 * request carries `accessToken` (minted by `http-profile-oauth.ts`) and the client secret never leaves
 * the token exchange.
 */
export function renderAuth(cfg: StrategyConfig, material: { secret: string; accessToken?: string }): RenderedAuth {
	const headers: Array<[string, string]> = [];
	const query: Array<[string, string]> = [];
	const sensitive = new Set<string>([material.secret]);
	const secretHeader = (name: string, value: string) => {
		headers.push([name, value]);
		sensitive.add(value);
	};
	const fromTemplate = (h: HeaderTemplate) => {
		const t = parseTemplate(h.template, h.name);
		if (t.usesSecret) secretHeader(h.name, `${t.prefix}${material.secret}${t.suffix}`);
		else headers.push([h.name, t.prefix]);
	};
	switch (cfg.strategy) {
		case "none":
			break;
		case "api_key":
			if (cfg.in === "header") secretHeader(cfg.name, material.secret);
			else {
				query.push([cfg.name, material.secret]);
				sensitive.add(encodeURIComponent(material.secret));
			}
			break;
		case "bearer":
			secretHeader("Authorization", `Bearer ${material.secret}`);
			break;
		case "header_template":
			fromTemplate(cfg.header);
			break;
		case "basic": {
			const token = base64(`${cfg.username}:${material.secret}`);
			sensitive.add(token);
			secretHeader("Authorization", `Basic ${token}`);
			break;
		}
		case "multi_header":
			for (const h of cfg.headers) fromTemplate(h);
			break;
		case "oauth2_client_credentials":
		case "oauth2_authorization_code": {
			if (!material.accessToken) throw new StrategyError("No OAuth2 access token is available for this profile.");
			sensitive.add(material.accessToken);
			secretHeader("Authorization", `Bearer ${material.accessToken}`);
			break;
		}
	}
	// Static headers never override a credential header the strategy set.
	if ("staticHeaders" in cfg && cfg.staticHeaders) {
		for (const [k, v] of Object.entries(cfg.staticHeaders)) if (!headers.some(([n]) => n.toLowerCase() === k.toLowerCase())) headers.push([k, v]);
	}
	return { headers, query, sensitive: [...sensitive].filter((s) => s.length > 0).sort((a, b) => b.length - a.length) };
}

/** Remove every secret-derived value from text that is about to be returned or recorded. Longest first, so a header value goes before the secret inside it. */
export function scrubSecrets(text: string, sensitive: readonly string[]): string {
	let out = text;
	for (const s of sensitive) if (s.length >= 4) out = out.split(s).join("[redacted]");
	return out;
}

/** What a profile's view and test say about its rendering — header and parameter NAMES, never values. */
export function describeRendering(cfg: StrategyConfig): { headers: string[]; query: string[] } {
	switch (cfg.strategy) {
		case "api_key":
			return cfg.in === "query" ? { headers: Object.keys(cfg.staticHeaders ?? {}), query: [cfg.name] } : { headers: [cfg.name, ...Object.keys(cfg.staticHeaders ?? {})], query: [] };
		case "multi_header":
			return { headers: cfg.headers.map((h) => h.name), query: [] };
		case "header_template":
			return { headers: [cfg.header.name, ...Object.keys(cfg.staticHeaders ?? {})], query: [] };
		case "none":
			return { headers: Object.keys(cfg.staticHeaders ?? {}), query: [] };
		default:
			return { headers: ["Authorization", ...Object.keys(cfg.staticHeaders ?? {})], query: [] };
	}
}
