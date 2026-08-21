// Declarative connectors (issue #143/#145). A connector-manifest describes an integration
// as DATA — its auth + a list of tools whose requests are configuration — and `compileConnector`
// turns it into the exact `{ Connector, ToolDef[] }` shape `registry.ts` already consumes. So a
// new integration is a reviewed JSON manifest, not a hand-written `.ts` + deploy. Every tool
// runs through the shared `executeHttpRequest` engine (the same one behind the http connector),
// which carries the SSRF guard, `{{param}}` interpolation, responseMap extraction, and pagination.
//
// Design + rationale: docs/connector-manifest.md.
import type { Connector, EnvTokenKey } from "./types.js";
import type { ToolDef, JsonSchema } from "./types.js";
import { executeHttpRequest, SAFE_METHODS } from "./http.js";

// ── Manifest shape ───────────────────────────────────────────────────────────

/** One tool input parameter → becomes a JSON-Schema property + `{{name}}` binding. */
export interface ManifestToolParam {
	type: "string" | "number" | "boolean" | "object" | "array";
	description?: string;
	required?: boolean;
	/** Optional length cap on string args (bounds credentialed egress). */
	maxLength?: number;
}

/** The configuration-as-data request a tool runs (fed to executeHttpRequest). */
export interface ManifestToolRequest {
	method?: string;
	/** Path appended to the connector's `baseUrl`. Supports `{{param}}`. */
	path?: string;
	/** Full URL alternative to baseUrl+path. Supports `{{param}}`. */
	url?: string;
	query?: Record<string, unknown>;
	headers?: Record<string, unknown>;
	body?: unknown;
	/** Dotted / `array[].{a,b:path}` extraction over the response. */
	responseMap?: string;
	pagination?: { type?: string; path?: string };
}

export interface ManifestTool {
	name: string;
	description: string;
	/** read = safe; write = mutates (consent-gated, #90). Default read. */
	scope?: "read" | "write";
	/**
	 * Does a call CHANGE anything (`ToolDef.mutates`, #563)? Optional HERE and required on
	 * `ToolDef`, which is the one place the compiler cannot enforce it — a manifest tool is DATA,
	 * and `sanitizeConnectorManifest` builds one from untrusted JSON that has no such field.
	 *
	 * Derived when omitted, and the derivation is honest for a manifest specifically: a manifest
	 * tool's request is fixed configuration, so there is no caller-chosen verb to be wrong about
	 * (the case that forces `http_request` to declare `scope:"read", mutates:true` by hand). The
	 * author declares `scope:"write"` exactly when the fixed request mutates the target system, so
	 * `mutates = scope === "write"` says the same thing twice rather than guessing.
	 *
	 * Declare it only to say something the scope does not — a POST that is really a query, or a
	 * handler-escape tool whose code does more than its request template shows.
	 */
	mutates?: boolean;
	/** Configuration-as-data request (the default). Omitted for a `handler` tool. */
	request?: ManifestToolRequest;
	/**
	 * Escape hatch (#146): the name of a code handler supplied to `compileConnector`, for the
	 * rare tool whose logic isn't expressible as a request (custom output envelope, branching,
	 * etc.). BUILT-IN manifests only — `sanitizeConnectorManifest` never emits this, so an
	 * untrusted/creator manifest can't reference arbitrary code; those must be request-as-data.
	 */
	handler?: string;
	params?: Record<string, ManifestToolParam>;
}

/** How the connector authenticates. `secretRef` names a Worker secret / vault slot resolved
 *  server-side — a manifest never contains a credential value. */
export type ManifestAuth =
	| { type: "none" }
	| { type: "app" }
	| { type: "api-key"; key: { in: "header" | "query"; name: string } }
	/** A platform-wide token from a Worker env var (e.g. META_ACCESS_TOKEN). Built-in only. */
	| { type: "platform-token"; tokenEnv: EnvTokenKey }
	/** OAuth2 authorization-code flow. `clientIdEnv`/`secretEnv` name Worker env vars holding
	 *  the client credentials — built-in manifests only (sanitize strips them so an untrusted
	 *  manifest can't point at platform secrets). */
	| { type: "oauth2"; authUrl: string; tokenUrl: string; scopes?: string[]; clientIdEnv?: string; secretEnv?: string };

export interface ConnectorManifest {
	id: string;
	label: string;
	auth: ManifestAuth;
	/** What granting this connector's write scope permits, in the owner's terms (#720). Copied
	 *  verbatim onto the compiled `Connector`; required in fact whenever the compiled `scopes.write`
	 *  comes out true, which for a manifest connector is decided by its tools rather than declared. */
	writeMeaning?: string;
	/** Joined with each tool's `path`. */
	baseUrl?: string;
	tools: ManifestTool[];
}

// ── auth mapping ─────────────────────────────────────────────────────────────
// The registry `Connector.auth` union and the http executor's per-request `auth` are two
// different things: the former tells connectorClient HOW to mint a token; the latter tells the
// executor HOW to attach it. Map the manifest's declared auth onto both.

function connectorAuthKind(auth: ManifestAuth): Connector["auth"] {
	switch (auth.type) {
		case "app": return "app";
		case "oauth2": return "oauth";
		case "api-key": return "token";
		case "platform-token": return "token";
		default: return "none";
	}
}

/** The per-request auth passed to executeHttpRequest. api-key injects a vault key into the
 *  configured header/query; app/oauth2/platform-token send the minted token as Bearer. */
function requestAuth(auth: ManifestAuth): Record<string, unknown> {
	if (auth.type === "api-key") return { mode: "api-key", key: auth.key };
	if (auth.type === "app" || auth.type === "oauth2" || auth.type === "platform-token") return { mode: "bearer" };
	return { mode: "none" };
}

// ── compile ──────────────────────────────────────────────────────────────────

function toJsonSchema(params: Record<string, ManifestToolParam> | undefined): JsonSchema {
	const properties: JsonSchema["properties"] = {};
	const required: string[] = [];
	for (const [name, p] of Object.entries(params ?? {})) {
		properties[name] = { type: p.type, ...(p.description ? { description: p.description } : {}) };
		if (p.required) required.push(name);
	}
	return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/** Truncate string args to their declared maxLength before they reach the wire. */
function clampArgs(input: Record<string, unknown>, params: Record<string, ManifestToolParam> | undefined): Record<string, unknown> {
	if (!params) return input;
	const out: Record<string, unknown> = { ...input };
	for (const [name, p] of Object.entries(params)) {
		if (p.maxLength && typeof out[name] === "string" && (out[name] as string).length > p.maxLength) {
			out[name] = (out[name] as string).slice(0, p.maxLength);
		}
	}
	return out;
}

/**
 * Compile a manifest into the `{ Connector, ToolDef[] }` the registry consumes. Every tool's
 * handler feeds the manifest's request template + the caller's args (as `{{param}}` inputs) into
 * the shared `executeHttpRequest`, scoped to this connector's own vault slot (`connectorId`).
 * Nothing downstream (catalog, capability gating, consent gate, the three surfaces) changes —
 * it only ever sees Connector/ToolDef.
 */
export function compileConnector(
	m: ConnectorManifest,
	handlers: Record<string, ToolDef["handler"]> = {},
): { connector: Connector; tools: ToolDef[] } {
	const reqAuth = requestAuth(m.auth);
	const tools: ToolDef[] = m.tools.map((t): ToolDef => {
		const scope = t.scope ?? "read";
		// See ManifestTool.mutates: a manifest tool's request is fixed data, so the scope the author
		// declared already answers "does this change the target system" — there is no caller-chosen
		// verb here to be wrong about. An explicit `mutates` overrides it.
		const mutates = t.mutates ?? scope === "write";
		// Escape-hatch tool: bind the named code handler (built-in manifests only).
		if (t.handler) {
			const fn = handlers[t.handler];
			if (!fn) throw new Error(`Manifest ${m.id}: tool "${t.name}" references unknown handler "${t.handler}".`);
			return { name: t.name, description: t.description, jsonSchema: toJsonSchema(t.params), tier: "connector", connector: m.id, scope, mutates, handler: fn };
		}
		const req = t.request ?? {};
		return {
			name: t.name,
			description: t.description,
			jsonSchema: toJsonSchema(t.params),
			tier: "connector",
			connector: m.id,
			scope,
			mutates,
			handler: (ctx, input) =>
				executeHttpRequest(
					ctx,
					{
						method: req.method ?? "GET",
						...(req.url ? { url: req.url } : { base: m.baseUrl, path: req.path }),
						query: req.query,
						headers: req.headers,
						body: req.body,
						responseMap: req.responseMap,
						pagination: req.pagination,
						auth: reqAuth,
						inputs: clampArgs(input, t.params),
					},
					{ connectorId: m.id },
				),
		};
	});

	const connector: Connector = {
		id: m.id,
		label: m.label,
		auth: connectorAuthKind(m.auth),
		...(m.auth.type === "platform-token" ? { tokenEnv: m.auth.tokenEnv } : {}),
		...(m.auth.type === "oauth2"
			? { oauth: { authUrl: m.auth.authUrl, tokenUrl: m.auth.tokenUrl, scopes: m.auth.scopes, clientIdEnv: m.auth.clientIdEnv, secretEnv: m.auth.secretEnv } }
			: {}),
		scopes: {
			read: tools.some((t) => t.scope === "read"),
			write: tools.some((t) => t.scope === "write"),
		},
		...(m.writeMeaning ? { writeMeaning: m.writeMeaning } : {}),
		grantModel: "user",
		tools,
	};
	return { connector, tools };
}

// ── validation ───────────────────────────────────────────────────────────────
// Mirrors sanitizeDeclaredCapabilities: closed enums + required/charset checks so a
// (later, creator-supplied) manifest can't declare something the runtime can't safely run.

const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const AUTH_TYPES = new Set(["none", "app", "api-key", "oauth2"]);

/** Validate + normalize an untrusted manifest, or return null if it's malformed. Does NOT
 *  fetch anything or resolve secrets — pure shape/allowlist validation. */
export function sanitizeConnectorManifest(raw: unknown): ConnectorManifest | null {
	if (!raw || typeof raw !== "object") return null;
	const m = raw as Record<string, unknown>;
	const id = typeof m.id === "string" ? m.id : "";
	const label = typeof m.label === "string" ? m.label : "";
	if (!ID_RE.test(id) || !label) return null;

	const rawAuth = (m.auth ?? {}) as Record<string, unknown>;
	const authType = typeof rawAuth.type === "string" ? rawAuth.type : "none";
	if (!AUTH_TYPES.has(authType)) return null;
	let auth: ManifestAuth;
	if (authType === "api-key") {
		const key = (rawAuth.key ?? {}) as Record<string, unknown>;
		const where = key.in === "query" ? "query" : "header";
		const name = typeof key.name === "string" ? key.name : "";
		if (!name) return null;
		auth = { type: "api-key", key: { in: where, name } };
	} else if (authType === "oauth2") {
		const authUrl = typeof rawAuth.authUrl === "string" ? rawAuth.authUrl : "";
		const tokenUrl = typeof rawAuth.tokenUrl === "string" ? rawAuth.tokenUrl : "";
		if (!/^https:\/\//.test(authUrl) || !/^https:\/\//.test(tokenUrl)) return null;
		// NOTE: clientIdEnv/secretEnv are intentionally NOT copied — a creator manifest can
		// declare the OAuth endpoints but never point at platform env secrets; an operator wires
		// the credentials for a reviewed connector. So a sanitized oauth2 connector is inert
		// until credentials are attached.
		auth = {
			type: "oauth2",
			authUrl,
			tokenUrl,
			scopes: Array.isArray(rawAuth.scopes) ? rawAuth.scopes.filter((s): s is string => typeof s === "string") : undefined,
		};
	} else {
		auth = { type: authType as "none" | "app" };
	}

	const baseUrl = typeof m.baseUrl === "string" ? m.baseUrl : undefined;
	if (baseUrl && !/^https:\/\//.test(baseUrl)) return null; // https-only base

	const rawTools = Array.isArray(m.tools) ? m.tools : [];
	const tools: ManifestTool[] = [];
	for (const rt of rawTools.slice(0, 24)) {
		if (!rt || typeof rt !== "object") continue;
		const t = rt as Record<string, unknown>;
		const name = typeof t.name === "string" ? t.name : "";
		const description = typeof t.description === "string" ? t.description : "";
		const request = (t.request ?? {}) as ManifestToolRequest;
		if (!TOOL_RE.test(name) || !description) continue;
		if (typeof request !== "object") continue;
		// A tool must have either a url or a path (joined onto baseUrl).
		if (!request.url && !request.path && !baseUrl) continue;
		// `mutates` is DERIVED here rather than copied, and derived from the verb rather than from
		// the declared scope (#563). An untrusted manifest's `scope` defaults to "read", so trusting
		// it would let a POST-shaped tool report "changes nothing" — the exact under-report this
		// field exists to close. The runtime is unaffected either way (the per-call gate in
		// `executeHttpRequest` refuses an unconsented mutating verb whatever the manifest claims);
		// this is about the answer an auditor gets.
		const method = String(request.method ?? "GET").toUpperCase();
		tools.push({
			name,
			description,
			scope: t.scope === "write" ? "write" : "read",
			mutates: t.scope === "write" || !SAFE_METHODS.has(method),
			request,
			params: sanitizeParams(t.params),
		});
	}
	if (!tools.length) return null;

	return { id, label, auth, baseUrl, tools };
}

function sanitizeParams(raw: unknown): Record<string, ManifestToolParam> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const out: Record<string, ManifestToolParam> = {};
	const types = new Set(["string", "number", "boolean", "object", "array"]);
	for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!/^[a-zA-Z][\w]{0,39}$/.test(name) || !v || typeof v !== "object") continue;
		const p = v as Record<string, unknown>;
		const type = typeof p.type === "string" && types.has(p.type) ? (p.type as ManifestToolParam["type"]) : "string";
		out[name] = {
			type,
			description: typeof p.description === "string" ? p.description : undefined,
			required: p.required === true,
			maxLength: typeof p.maxLength === "number" && p.maxLength > 0 ? Math.min(p.maxLength, 100_000) : undefined,
		};
	}
	return Object.keys(out).length ? out : undefined;
}
