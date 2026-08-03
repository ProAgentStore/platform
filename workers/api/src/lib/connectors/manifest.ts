// Declarative connectors (issue #143/#145). A connector-manifest describes an integration
// as DATA — its auth + a list of tools whose requests are configuration — and `compileConnector`
// turns it into the exact `{ Connector, ToolDef[] }` shape `registry.ts` already consumes. So a
// new integration is a reviewed JSON manifest, not a hand-written `.ts` + deploy. Every tool
// runs through the shared `executeHttpRequest` engine (the same one behind the http connector),
// which carries the SSRF guard, `{{param}}` interpolation, responseMap extraction, and pagination.
//
// Design + rationale: docs/connector-manifest.md.
import type { Connector } from "./registry.js";
import type { ToolDef, JsonSchema } from "../tool-registry.js";
import { executeHttpRequest } from "./http.js";

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
	request: ManifestToolRequest;
	params?: Record<string, ManifestToolParam>;
}

/** How the connector authenticates. `secretRef` names a Worker secret / vault slot resolved
 *  server-side — a manifest never contains a credential value. */
export type ManifestAuth =
	| { type: "none" }
	| { type: "app" }
	| { type: "api-key"; key: { in: "header" | "query"; name: string } }
	| { type: "oauth2"; authUrl: string; tokenUrl: string; scopes?: string[]; secretRef?: string };

export interface ConnectorManifest {
	id: string;
	label: string;
	auth: ManifestAuth;
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
		default: return "none";
	}
}

/** The per-request auth passed to executeHttpRequest. api-key injects a vault key into the
 *  configured header/query; app/oauth2 send the minted token as `Authorization: Bearer`. */
function requestAuth(auth: ManifestAuth): Record<string, unknown> {
	if (auth.type === "api-key") return { mode: "api-key", key: auth.key };
	if (auth.type === "app" || auth.type === "oauth2") return { mode: "bearer" };
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
export function compileConnector(m: ConnectorManifest): { connector: Connector; tools: ToolDef[] } {
	const reqAuth = requestAuth(m.auth);
	const tools: ToolDef[] = m.tools.map((t): ToolDef => {
		const scope = t.scope ?? "read";
		return {
			name: t.name,
			description: t.description,
			jsonSchema: toJsonSchema(t.params),
			tier: "connector",
			connector: m.id,
			scope,
			handler: (ctx, input) =>
				executeHttpRequest(
					ctx,
					{
						method: t.request.method ?? "GET",
						...(t.request.url ? { url: t.request.url } : { base: m.baseUrl, path: t.request.path }),
						query: t.request.query,
						headers: t.request.headers,
						body: t.request.body,
						responseMap: t.request.responseMap,
						pagination: t.request.pagination,
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
		scopes: {
			read: tools.some((t) => t.scope === "read"),
			write: tools.some((t) => t.scope === "write"),
		},
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
		auth = {
			type: "oauth2",
			authUrl,
			tokenUrl,
			scopes: Array.isArray(rawAuth.scopes) ? rawAuth.scopes.filter((s): s is string => typeof s === "string") : undefined,
			secretRef: typeof rawAuth.secretRef === "string" ? rawAuth.secretRef : undefined,
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
		tools.push({
			name,
			description,
			scope: t.scope === "write" ? "write" : "read",
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
