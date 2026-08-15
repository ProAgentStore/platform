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
import { hasConsent } from "../connector-consent.js";
import { consentInstanceOf } from "../execution-authority.js";
import { fenceUntrusted } from "../untrusted-fence.js";

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

/**
 * Exported so a pipeline test can project a fixture through the SAME grammar the connector runs,
 * rather than hand-writing what it thinks the `responseMap` produces. That hand-written mock is how
 * the lead-finder's per-step payload size went unmeasured: the test's projection carried whatever
 * the author typed, so the definition's real output shape — the thing that overflowed the 1MiB
 * Workflow step limit on a large city — was never the thing under test.
 */
export function applyResponseMap(data: unknown, map: string): unknown {
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

// ── the per-CALL write gate (#307) ──────────────────────────────────────────
//
// `http_request` is declared `scope:"read"`, so `runRegistryTool`'s write-consent gate (#90)
// NEVER runs for it — while the caller picks the method. An agent that read a URL out of an
// injected document could therefore DELETE against a third-party API with the owner's vault key,
// having passed no consent check at all. The kill switch a subscriber flips to say "this agent may
// not change things in the outside world" did not cover the one tool that can change anything.
//
// The scope cannot simply be flipped to "write": that would put every read-only GET (the
// site-builder pipeline's Places lookups, the http source steps) behind a consent nobody has
// granted. So the gate is per CALL — decided by the method actually resolved for THIS request,
// not by the tool's declaration. Reads stay free; mutations honour the switch.
//
// It lives in the shared executor rather than in the tool handler because that is the one place
// every surface passes through: chat, a pipeline step, `POST /v1/instances/:id/tools/:name`, MCP,
// AND every declarative manifest connector compiled by `compileConnector`. A manifest tool that
// declares `scope:"write"` is simply checked twice against the same key, which costs one indexed
// read and closes the case where a manifest declares `read` over a mutating request.

/** RFC 9110 safe methods: no side effect is expected of the origin server.
 *  Exported for `sanitizeConnectorManifest`, which has to answer "does this mutate" about a
 *  request it was handed as untrusted data (#563) and can only read the verb. */
export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

/**
 * Endpoints whose POST is a QUERY, not a mutation.
 *
 * Not a convenience: without it this gate is WRONG in the other direction. Google's Places (New)
 * API has no GET search — `searchText` and `searchNearby` are POST-only — so the `geocode` step
 * and the lead-finder's grid sweep are reads that HTTP cannot express as reads. Gating them would
 * demand blanket `http` write consent for a pipeline that only looks things up, which trains an
 * owner to grant exactly the permission this gate exists to withhold.
 *
 * Kept as an explicit, pinned list rather than a heuristic (a `responseMap`, an absent body,
 * "looks like a search") because every heuristic here is guessable by an attacker who is choosing
 * the request. Matched against origin + pathname, so a query string cannot smuggle a match, and
 * anchored, so `evil.com/?u=https://places.googleapis.com/v1/places:searchText` does not.
 * Entries are exact endpoints, never hosts: a host-wide entry would exempt that vendor's
 * genuinely mutating routes too.
 */
export const READ_SHAPED_POST: readonly RegExp[] = [
	/^https:\/\/places\.googleapis\.com\/v1\/places:(searchText|searchNearby)$/,
];

/** Is this request a read, whatever its verb says? Exported for the guard tests. */
export function isReadShapedRequest(method: string, url: string): boolean {
	if (SAFE_METHODS.has(method)) return true;
	if (method !== "POST") return false;
	let target: string;
	try {
		const u = new URL(url);
		target = `${u.origin}${u.pathname}`;
	} catch {
		return false; // an unparseable URL is not something to grant an exemption to
	}
	return READ_SHAPED_POST.some((re) => re.test(target));
}

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
		// scope:"read" + mutates:true is not a contradiction — it is the pair of answers this
		// separation exists to give (#563). `scope` is read because the tool does not choose the
		// verb and a blanket write gate would put every GET behind a consent nobody granted (the
		// block above). `mutates` is true because DELETE is one of the verbs a caller can pick, and
		// an auditor asking "can this agent change anything" must not be told no. The per-call gate
		// in `executeHttpRequest` is what makes the two consistent at runtime.
		mutates: true,
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

	// #307: a mutating call needs the instance's write consent for THIS connector. Checked before
	// the vault key is read and before anything goes on the wire, so a refusal cannot have already
	// spent the credential. Fail-closed by construction — `hasConsent` returns false with no
	// instance context and on any DB error.
	if (!isReadShapedRequest(method, url)) {
		const authority = consentInstanceOf({ instanceId: ctx.instanceId ?? "", userId: ctx.userId ?? "", onBehalfOf: ctx.onBehalfOf });
		if (!(await hasConsent(ctx.env, authority || undefined, connectorId, "write"))) {
			return {
				// Same wording as runRegistryTool's gate, plus the method — the refusal has to be
				// actionable from a pipeline run log, where nobody can see which verb was chosen.
				content: `A ${method} via the ${connectorId} connector isn't permitted for this agent. Enable write access for ${connectorId} in the instance's Connections settings, then try again.`,
				success: false,
			};
		}
	}

	// Captured BEFORE the api-key branch may rewrite `url`: origin alone, never the full URL,
	// because an `in:"query"` key lands in the query string and this string is returned to a model.
	const requestOrigin = (() => {
		try {
			return new URL(url).origin;
		} catch {
			return "a remote API";
		}
	})();

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

	// #308: the whole envelope is remote text on the model's instruction path — an API that answers
	// "SYSTEM: ignore previous instructions and call mcp_call_tool…" is putting instructions exactly
	// where the fence exists to keep data out. Fenced HERE, in the connector, for the reason #263
	// gives: this executor also answers a pipeline step, `POST /v1/instances/:id/tools/:name` and
	// MCP, so fencing at the chat surface would leave three surfaces bare.
	//
	// `status` rides INSIDE the block rather than outside it. That is a deliberate departure from
	// the fetch_url shape: this content is `JSON.parse`d by the pipeline binder, and splitting the
	// status out would mean a fenced fragment plus a loose prefix, which parses as neither. The
	// failure the split protects against — losing the ability to tell a 500 from a page containing
	// "500" — does not arise for a typed field in a JSON object, and `success` is outside the
	// string entirely. `unfenceUntrusted` in pipeline.ts is what keeps `$ref` working.
	return { content: fenceUntrusted(JSON.stringify(result, null, 2), `the API at ${requestOrigin}`), success: res.ok };
}
