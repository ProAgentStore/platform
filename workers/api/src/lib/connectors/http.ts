// Generic HTTP/REST connector (issue #95). The piece that makes "call any REST API" a
// CONFIGURATION, not bespoke Worker code: ONE `http_request` tool whose method, url,
// query, headers, and body are all templated (`{{param}}` from the caller's inputs), with
// an optional dotted responseMap extraction and an optional pagination descriptor.
//
// Auth (declared on the connector as auth:"token", grantModel:"user"):
//   • none         — no credential injected.
//   • api-key      — a vault-stored key (user_api_keys, provider "http") minted via the
//                    connectorClient (#86) and injected into a CONFIGURABLE header or query
//                    param (e.g. Google Places `X-Goog-Api-Key`). NEVER inlined or logged.
//
// Every outbound call goes through `safeFetch` (SSRF guard, https-only, redirect-revalidated),
// so a templated/attacker-influenced url can't reach cloud-metadata / loopback / RFC1918.
import type { ToolDef, RegistryToolCtx } from "./types.js";
import { safeFetch, SsrfError } from "../ssrf.js";

// ── {{param}} interpolation ────────────────────────────────────────────────
// Replace every {{name}} with String(inputs[name]). A missing input becomes "" (so a
// template with an unused optional slot doesn't leak the literal "{{x}}"). Applied to
// strings and recursively into query/headers/body values.
function interpolate(template: string, inputs: Record<string, unknown>): string {
	return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
		const v = inputs[key];
		return v === undefined || v === null ? "" : String(v);
	});
}

function interpolateDeep(value: unknown, inputs: Record<string, unknown>): unknown {
	if (typeof value === "string") return interpolate(value, inputs);
	if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, inputs));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolateDeep(v, inputs);
		return out;
	}
	return value;
}

// ── responseMap: simple JSONPath-ish dotted extraction ──────────────────────
// Grammar (deliberately tiny — no third-party JSONPath dep):
//   • dotted path              "candidates.0.content"           → nested lookup ([] index allowed)
//   • array-projection         "places[].displayName.text"      → map each element to that sub-path
//   • projection with reshape  "places[].{id,name:displayName.text,site:websiteUri}"
//                                → [{id, name, site}, …] pulling each field's dotted sub-path
//   • type-predicate select    "addressComponents[types~=locality].longText"  → in an ARRAY of
//                                typed components, pick the element whose `types` (array or
//                                scalar) contains the token, then continue the sub-path (#116).
//                                General for any "array of typed components" API (Google, etc.).
// Returns undefined for a path that doesn't resolve (rather than throwing) so a partial
// response maps to nulls, not an error.

// One segment with a type-predicate filter, e.g. "addressComponents[types~=locality]".
const PREDICATE_SEG = /^([\w-]+)\[([\w-]+)~=([^\]]+)\]$/;

/** Does `field`'s value (an array, or a scalar) contain `token`? Used by the [k~=v] predicate. */
function fieldContains(el: unknown, field: string, token: string): boolean {
	if (el === null || typeof el !== "object") return false;
	const v = (el as Record<string, unknown>)[field];
	if (Array.isArray(v)) return v.some((x) => String(x) === token);
	return v !== undefined && v !== null && String(v) === token;
}

export function getPath(obj: unknown, path: string): unknown {
	if (!path) return obj;
	let cur: unknown = obj;
	for (const seg of path.split(".")) {
		if (cur === null || cur === undefined) return undefined;
		const pred = PREDICATE_SEG.exec(seg);
		if (pred) {
			// `name[key~=token]`: read `name` off the current object (an array of components),
			// then select the element whose `key` contains `token`.
			const [, name, key, token] = pred;
			const arr = typeof cur === "object" && !Array.isArray(cur) ? (cur as Record<string, unknown>)[name] : undefined;
			cur = Array.isArray(arr) ? arr.find((el) => fieldContains(el, key, token)) : undefined;
		} else if (Array.isArray(cur)) {
			const idx = Number(seg);
			cur = Number.isInteger(idx) ? cur[idx] : undefined;
		} else if (typeof cur === "object") {
			cur = (cur as Record<string, unknown>)[seg];
		} else {
			return undefined;
		}
	}
	return cur;
}

// Parse the "{a,b:path,c:path}" reshape spec into [outKey, subPath] pairs.
function parseReshape(spec: string): Array<[string, string]> {
	return spec
		.slice(1, -1) // drop the braces
		.split(",")
		.map((f) => f.trim())
		.filter(Boolean)
		.map((f) => {
			const colon = f.indexOf(":");
			if (colon === -1) return [f, f] as [string, string]; // "id" → out "id" from sub-path "id"
			return [f.slice(0, colon).trim(), f.slice(colon + 1).trim()] as [string, string];
		});
}

function applyResponseMap(data: unknown, map: string): unknown {
	const m = map.trim();
	const arrIdx = m.indexOf("[]");
	if (arrIdx === -1) return getPath(data, m); // plain dotted path

	const beforeArr = m.slice(0, arrIdx); // path to the array
	let rest = m.slice(arrIdx + 2); // what to pull from each element
	if (rest.startsWith(".")) rest = rest.slice(1);

	const arr = getPath(data, beforeArr);
	if (!Array.isArray(arr)) return [];

	if (rest.startsWith("{") && rest.endsWith("}")) {
		const fields = parseReshape(rest);
		return arr.map((el) => {
			const row: Record<string, unknown> = {};
			for (const [outKey, subPath] of fields) row[outKey] = getPath(el, subPath) ?? null;
			return row;
		});
	}
	// projection of a single sub-path (or the element itself when rest === "")
	return arr.map((el) => (rest ? (getPath(el, rest) ?? null) : el));
}

// ── url assembly ────────────────────────────────────────────────────────────
function buildUrl(input: Record<string, unknown>, inputs: Record<string, unknown>): string {
	const rawUrl = typeof input.url === "string" && input.url ? interpolate(input.url, inputs) : "";
	const base = typeof input.base === "string" ? interpolate(input.base, inputs) : "";
	const path = typeof input.path === "string" ? interpolate(input.path, inputs) : "";
	let url = rawUrl || (base ? base.replace(/\/+$/, "") + (path ? "/" + path.replace(/^\/+/, "") : "") : "");
	if (!url) throw new Error("Provide `url`, or `base` (+ optional `path`).");

	const query = input.query && typeof input.query === "object" && !Array.isArray(input.query)
		? (interpolateDeep(input.query, inputs) as Record<string, unknown>)
		: undefined;
	if (query && Object.keys(query).length) {
		const u = new URL(url);
		for (const [k, v] of Object.entries(query)) {
			if (v !== undefined && v !== null && String(v) !== "") u.searchParams.set(k, String(v));
		}
		url = u.toString();
	}
	return url;
}

// ── api-key injection (from the vault, via connectorClient) ──────────────────
// auth = { mode: "api-key", key: { in: "header"|"query", name: "X-Goog-Api-Key" } }.
// The key VALUE never appears in inputs, the tool schema, or the returned result — it's
// read from user_api_keys (provider "http") through ctx.connectorClient("http").token()
// and attached to the outgoing request only.
interface ApiKeyAuth {
	mode: "api-key";
	key: { in: "header" | "query"; name: string };
}
// "bearer": mint the connector's token via connectorClient and send it as
// `Authorization: Bearer <token>` — the shape app/oauth manifest connectors use.
type HttpAuth = { mode: "none" } | { mode: "bearer" } | ApiKeyAuth;

function parseAuth(raw: unknown): HttpAuth {
	if (!raw || typeof raw !== "object") return { mode: "none" };
	const a = raw as Record<string, unknown>;
	if (a.mode === "bearer") return { mode: "bearer" };
	if (a.mode === "api-key") {
		const key = a.key as Record<string, unknown> | undefined;
		const where = key?.in === "query" ? "query" : "header";
		const name = typeof key?.name === "string" ? key.name : "";
		if (!name) throw new Error("auth.key.name is required for api-key mode.");
		return { mode: "api-key", key: { in: where, name } };
	}
	return { mode: "none" };
}

export const HTTP_TOOLS: ToolDef[] = [
	{
		name: "http_request",
		tier: "connector",
		connector: "http",
		scope: "read",
		description:
			"Call any REST/HTTP(S) API by configuration — no bespoke code. Supply `method`, and either `url` or `base`(+`path`), plus optional `query`, `headers`, and JSON `body`; every string supports `{{param}}` interpolation from `inputs`. Optional `auth` injects a vault-stored API key into a header or query param (e.g. Google Places X-Goog-Api-Key). Optional `responseMap` extracts fields (dotted paths + `array[].{a,b:path}` projection). Optional `pagination` returns the next cursor/offset for the caller to fan out. Returns { status, data, raw? }. HTTPS-only, SSRF-guarded.",
		jsonSchema: {
			type: "object",
			properties: {
				method: { type: "string", description: "HTTP method (GET, POST, …). Default GET." },
				url: { type: "string", description: "Full request URL (or use base+path). Supports {{param}}." },
				base: { type: "string", description: "Base URL, joined with `path`. Supports {{param}}." },
				path: { type: "string", description: "Path appended to `base`. Supports {{param}}." },
				query: { type: "object", description: "Query params (values interpolated + URL-encoded)." },
				headers: { type: "object", description: "Request headers (values interpolated)." },
				body: { type: "object", description: "JSON request body (interpolated). Sent as application/json." },
				inputs: { type: "object", description: "Values bound to {{param}} placeholders across url/query/headers/body." },
				auth: {
					type: "object",
					description:
						'Credential injection. { "mode": "none" } or { "mode": "api-key", "key": { "in": "header"|"query", "name": "X-Goog-Api-Key" } } — the key value is read from the vault, never passed here.',
				},
				responseMap: {
					type: "string",
					description: 'Dotted extraction, e.g. "places[].{id,name:displayName.text,site:websiteUri}" or "candidates.0.content".',
				},
				pagination: {
					type: "object",
					description:
						'Descriptor { "type": "nextPageToken"|"offset"|"cursor", "path": "nextPageToken" } — the response location of the next-page marker, returned as `nextCursor` for the caller to drive.',
				},
				includeRaw: { type: "boolean", description: "When true (and responseMap is set), also return the unmapped body as `raw`." },
			},
			required: [],
		},
		handler: (ctx: RegistryToolCtx, input) => executeHttpRequest(ctx, input),
	},
];

/**
 * The shared request executor (issue #144). Runs a configuration-described HTTP call —
 * `{{param}}` interpolation, api-key injection, SSRF-guarded fetch, responseMap extraction,
 * pagination marker — and returns the standard `{ content, success }` ToolCallResult. This is
 * the engine behind `http_request` AND every declarative connector-manifest tool
 * (`compileConnector` → runs its tools through here). `opts.connectorId` selects which vault
 * slot an `api-key` auth reads from (default "http") so a manifest connector uses its OWN key.
 */
export async function executeHttpRequest(
	ctx: RegistryToolCtx,
	input: Record<string, unknown>,
	opts: { connectorId?: string } = {},
): Promise<{ content: string; success: boolean }> {
	const connectorId = opts.connectorId ?? "http";
	const inputs = (input.inputs && typeof input.inputs === "object" && !Array.isArray(input.inputs)
		? input.inputs
		: {}) as Record<string, unknown>;

	let auth: HttpAuth;
	let url: string;
	try {
		auth = parseAuth(input.auth);
		url = buildUrl(input, inputs);
	} catch (e) {
		return { content: e instanceof Error ? e.message : String(e), success: false };
	}

	const method = (typeof input.method === "string" ? input.method : "GET").toUpperCase();
	const headers = new Headers();
	if (input.headers && typeof input.headers === "object" && !Array.isArray(input.headers)) {
		for (const [k, v] of Object.entries(interpolateDeep(input.headers, inputs) as Record<string, unknown>)) {
			if (v !== undefined && v !== null) headers.set(k, String(v));
		}
	}

	// Inject the vault API key into the configured header/query param. token() reads
	// user_api_keys (provider = the connector id) via the connectorClient — the value is
	// used only on the wire, never returned or logged.
	if (auth.mode === "api-key") {
		const key = await ctx.connectorClient?.(connectorId).token().catch(() => null);
		if (!key) return { content: `No API key connected for the ${connectorId} connector — add one in the instance's Connections settings.`, success: false };
		if (auth.key.in === "header") {
			headers.set(auth.key.name, key);
		} else {
			const u = new URL(url);
			u.searchParams.set(auth.key.name, key);
			url = u.toString();
		}
	} else if (auth.mode === "bearer") {
		const token = await ctx.connectorClient?.(connectorId).token().catch(() => null);
		if (!token) return { content: `No credential connected for the ${connectorId} connector — connect it in the instance's Connections settings.`, success: false };
		headers.set("Authorization", `Bearer ${token}`);
	}

	let bodyStr: string | undefined;
	if (method !== "GET" && method !== "HEAD" && input.body !== undefined && input.body !== null) {
		bodyStr = JSON.stringify(interpolateDeep(input.body, inputs));
		if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
	}

	let res: Response;
	try {
		res = await safeFetch(url, { method, headers, body: bodyStr });
	} catch (e) {
		if (e instanceof SsrfError) return { content: `Blocked: ${e.message}`, success: false };
		return { content: `Request failed: ${e instanceof Error ? e.message : String(e)}`, success: false };
	}

	const text = await res.text();
	let raw: unknown = text;
	try {
		raw = JSON.parse(text);
	} catch {
		/* keep as text */
	}

	const responseMap = typeof input.responseMap === "string" ? input.responseMap : "";
	const data = responseMap ? applyResponseMap(raw, responseMap) : raw;

	const result: Record<string, unknown> = { status: res.status, data };
	// pagination: surface the next-page marker so a source step can fan out.
	if (input.pagination && typeof input.pagination === "object" && !Array.isArray(input.pagination)) {
		const p = input.pagination as Record<string, unknown>;
		const path = typeof p.path === "string" ? p.path : "";
		const marker = path ? getPath(raw, path) : undefined;
		result.nextCursor = marker ?? null;
		result.paginationType = typeof p.type === "string" ? p.type : null;
	}
	if (responseMap && input.includeRaw === true) result.raw = raw;

	return { content: JSON.stringify(result, null, 2), success: res.ok };
}
