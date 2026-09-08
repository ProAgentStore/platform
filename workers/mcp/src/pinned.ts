import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, type McpEnv, text } from "./http.js";
import { auditOk } from "./instance-tools/base.js";
import type { SafetyResolver, TokenResolver } from "./instance-tools/shared.js";
import { jsonSchemaToZodShape } from "./json-schema-zod.js";
import { audit, dryRun, type McpScope, requirePermission } from "./safety.js";

/**
 * A session pinned to ONE instance (#783) — the optional scoped endpoint, additive to the
 * platform-wide connector, which stays byte-identical.
 *
 * ── What it is for
 *
 * The platform-wide surface at `/mcp` is the right shape for a caller that does not know which
 * of a user's instances it will need: every tool takes an `instance_id`, and an instance's own
 * tools are reached through `list_instance_tools` → `call_instance_tool`. A growing class of
 * callers — a chat project pinned permanently to one Coder instance — knows the instance for the
 * whole life of the connection. For them the discovery hop is pure cost, and #771/#772 measured
 * what skipping it produces: guessed tool names, then guessed FIELD names.
 *
 * A client that connects to `/mcp/i/<instanceId>` instead gets a session whose `tools/list` is
 * that instance's OWN tools under their REAL names (`github_read_issue`, not
 * `call_instance_tool{tool:"github_read_issue"}`), with their real field names published as
 * the input schema and no `instance_id` argument anywhere — plus three fixed tools (`chat`,
 * `guide`, `messages`) for the conversation itself. Nothing from the platform-wide surface is
 * registered on a pinned session: "a minimal, unambiguous MCP surface instead of the full
 * platform schema" is the ticket's wording, and a caller that wants the full schema connects
 * to `/mcp` exactly as before.
 *
 * ── Why a URL rather than a scope or a parameter
 *
 * Every MCP session is already its own Durable Object (the agents SDK names it by
 * `Mcp-Session-Id`), so a per-session pin leaks into no other session. The pin has to arrive
 * before the FIRST registration on that DO (`init()` registers once and cannot re-register), so
 * it must be on the request, not on a later tool call. Of the two request-level carriers, a
 * custom OAuth scope is something most hosts (Claude.ai connectors, `mcp-remote`, Codex) cannot
 * set, while a different URL is something every one of them can. `PagsMcp.serve("/mcp")`
 * matches its path EXACTLY (`URLPattern`), so `withPinnedInstance` below reads the id off the
 * sub-path, puts it on `ctx.props` — the same channel the OAuth grant's `authToken` /
 * `mcpScopes` / `mcpSubject` travel on — and rewrites the URL to `/mcp` before delegating. The
 * OAuth provider's `apiRoute: "/mcp"` is a prefix, so the sub-path is token-protected the same
 * way `/mcp` is; `loginHandler` never sees it.
 *
 * ── Ownership
 *
 * The pin is a routing hint, never a grant. `loadPinnedSurface` reads
 * `GET /v1/instances/:id/tools?allowed=true&schemas=true`, which is owner-scoped: an instance the
 * token does not own answers 403/404 and the session registers ONE tool that says so. Every
 * pinned tool call then goes through `POST /v1/instances/:id/tools/:name`, which re-checks
 * ownership and the live policy on every call — a tool the owner switches off after the session
 * opened is refused by the API, whatever this session still lists.
 *
 * ── Why the guards do not see this, and why that is right
 *
 * Three guards hold the platform-wide surface to one static shape: `index.test.ts` and
 * `conformance.test.ts` require every registered name to be classified in `TOOL_RISK`, and
 * `scripts/docs-drift.mjs` extracts registered names from a quoted literal right after
 * `server.tool(` and requires
 * the README table to match them exactly. Pinned tools are named by DATA — the instance's policy
 * rows — so they cannot be classified in a static table and cannot be listed in a README. Hence:
 *
 *   · every registration below passes the name as a variable, never a literal, so docs-drift's
 *     count (and `MCP_TOOL_COUNT`) describe the platform-wide surface only, as they should;
 *   · annotations come from each row's own `mutates` (via `pinnedRiskFor`, which `index.ts`
 *     maps through `annotationsForRisk`), not from `TOOL_RISK`;
 *   · `pinned.test.ts` holds THIS surface to its own contract, separately.
 *
 * This module may not import `tool-metadata.ts` (only the registration seam and the /surface
 * route may — `index.test.ts` enforces it), which is why it reports a risk CLASS and lets
 * `index.ts` turn it into the wire annotation.
 *
 * ── Naming
 *
 * "Pinned", never "connection": `create_connection` / `list_connections` /
 * `set_connection_enabled` already mean agent-to-agent event routing on this surface.
 */

/** `/mcp/i/<instanceId>` — ids are UUID-ish or slugs; the class is what the API accepts in a path. */
export const PINNED_PATH = /^\/mcp\/i\/([A-Za-z0-9_-]{1,64})\/?$/;

export function pinnedInstanceFromPath(pathname: string): string | null {
	const m = PINNED_PATH.exec(pathname);
	return m ? m[1] : null;
}

/** What the OAuth provider hands the API handler: a Workers context carrying the grant's props. */
type PropsCtx = ExecutionContext & { props?: Record<string, unknown> };

/** The request type an `ExportedHandler` receives (Workers' `cf` generic, not the DOM's). */
type IncomingRequest = Request<unknown, IncomingRequestCfProperties<unknown>>;

interface FetchHandler<E> {
	fetch: (request: IncomingRequest, env: E, ctx: PropsCtx) => Response | Promise<Response>;
}

/**
 * Wrap the MCP transport so `/mcp/i/<instanceId>` reaches the same transport as `/mcp`, with
 * the instance id on `ctx.props.pinnedInstance`. Any other path is passed through untouched —
 * the platform-wide connector's behaviour is not changed by one byte.
 */
export function withPinnedInstance<E>(inner: FetchHandler<E>): FetchHandler<E> {
	return {
		...inner,
		fetch(request, env, ctx) {
			const url = new URL(request.url);
			const instanceId = pinnedInstanceFromPath(url.pathname);
			if (!instanceId) return inner.fetch(request, env, ctx);
			url.pathname = "/mcp";
			ctx.props = { ...(ctx.props ?? {}), pinnedInstance: instanceId };
			// Same method, headers, body and `cf` — only the path differs. The cast restores the
			// incoming `cf` generic the constructor widens to `RequestInitCfProperties`.
			return inner.fetch(new Request(url.toString(), request) as IncomingRequest, env, ctx);
		},
	};
}

/**
 * One row of `GET /v1/instances/:id/tools`, the fields this module reads. COPIED from
 * `workers/api/src/lib/instance-tool-policy.ts` — this worker is a separate deployable and cannot
 * import it (see the `columnFor` note in `instance-tools/shared.ts`). Every field is optional
 * so a row shape change over there cannot throw here.
 */
export interface PinnedToolRow {
	name: string;
	description?: string;
	allowed?: boolean;
	mutates?: boolean;
	invocableBy?: readonly string[];
	jsonSchema?: unknown;
}

export interface PinnedSurface {
	instanceId: string;
	/** The rows this session registers: allowed, and reachable through the invoker route. */
	rows: PinnedToolRow[];
	/** Set when the listing could not be read — the session then registers only `pinned_instance_unavailable`. */
	error?: string;
	/** Names the listing carried that were NOT registered, with the reason — reported in `guide`. */
	skipped: string[];
}

/** The three fixed tools, plus the one that stands in for all of them when the pin is unusable. */
const FIXED = {
	chat: "chat",
	guide: "guide",
	messages: "messages",
	unavailable: "pinned_instance_unavailable",
} as const;

/** MCP names are ≤64 chars of `[A-Za-z0-9_-]`; the policy names are snake_case already. */
const TOOL_NAME = /^[a-z0-9_]{1,64}$/;

export async function loadPinnedSurface(env: McpEnv, token: string | null, instanceId: string): Promise<PinnedSurface> {
	if (!token) return { instanceId, rows: [], skipped: [], error: "authentication required" };
	const data = (await authedCall(
		`/v1/instances/${encodeURIComponent(instanceId)}/tools?allowed=true&schemas=true`,
		token,
		{},
		env,
	)) as { tools?: PinnedToolRow[]; error?: string };
	if (data.error || !Array.isArray(data.tools)) {
		return { instanceId, rows: [], skipped: [], error: data.error || "tool listing unavailable" };
	}
	const rows: PinnedToolRow[] = [];
	const skipped: string[] = [];
	const fixed = new Set<string>(Object.values(FIXED));
	for (const row of data.tools) {
		if (!row || typeof row.name !== "string") continue;
		if (row.allowed === false) {
			skipped.push(`${row.name} (not allowed on this instance)`);
		} else if (!(row.invocableBy ?? []).includes("call_instance_tool")) {
			// `invocableBy:["chat"]` means the agent runs it in conversation; the invoker route
			// cannot reach it, so a pinned tool for it would refuse every call (#525).
			skipped.push(`${row.name} (chat-only — ask for it through chat)`);
		} else if (fixed.has(row.name) || !TOOL_NAME.test(row.name)) {
			skipped.push(`${row.name} (name reserved or not an MCP tool name)`);
		} else {
			rows.push(row);
		}
	}
	return { instanceId, rows, skipped };
}

/**
 * The risk class a pinned tool is announced under — what `index.ts` turns into annotations.
 * A row's class is its own `mutates`: the policy already states whether a call CHANGES anything,
 * which is exactly the question `readOnlyHint` answers. The fixed tools mirror the platform-wide
 * tools they stand in for (`chat_with_instance` is `runtime`; the two reads are `read`).
 */
export function pinnedRiskFor(surface: PinnedSurface): (name: string) => McpScope | undefined {
	const byName = new Map(surface.rows.map((r) => [r.name, r.mutates ? "write" : "read"] as const));
	return (name) => {
		if (name === FIXED.chat) return "runtime";
		if (name === FIXED.guide || name === FIXED.messages || name === FIXED.unavailable) return "read";
		return byName.get(name);
	};
}

export interface PinnedCtx {
	env: McpEnv;
	tokenFor: TokenResolver;
	safetyFor: SafetyResolver;
}

/**
 * Register the pinned surface. Every name is passed as a VARIABLE (see the module header for
 * why): `server.tool(def.name, …)`, never a quoted name inline.
 *
 * Pinned handlers take no `token` argument and never read one for identity: a pinned session is
 * bound to its OAuth grant, and an instance tool's own field happening to be called `token`
 * must reach the API as data, not be mistaken for a session.
 */
export function registerPinnedTools(server: McpServer, ctx: PinnedCtx, surface: PinnedSurface): void {
	const { env, tokenFor, safetyFor } = ctx;
	const id = surface.instanceId;
	const path = (suffix: string) => `/v1/instances/${encodeURIComponent(id)}${suffix}`;

	if (surface.error) {
		const def = {
			name: FIXED.unavailable,
			description: `This session is pinned to instance ${id}, but its tools could not be read (${surface.error}). Either the instance is not yours, it no longer exists, or the connection is not signed in. Connect to /mcp for the platform-wide surface, or pin a different instance id from my_instances there.`,
		};
		server.tool(def.name, def.description, {}, async () => text(`Error: ${def.description}`));
		return;
	}

	// ── The instance's own tools, under their real names ──
	for (const row of surface.rows) {
		const { shape, unsupported } = jsonSchemaToZodShape(row.jsonSchema);
		const scope: McpScope = row.mutates ? "write" : "read";
		const note = unsupported.length
			? ` (Fields without a published shape, sent through as given: ${unsupported.map((u) => u || "<root>").join(", ")}.)`
			: "";
		const description = `${row.description || row.name} [pinned to instance ${id}]${note}`;
		server.tool(row.name, description, shape, async (input: Record<string, unknown>) => {
			const sessionToken = tokenFor();
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(), scope, row.name, { tool: row.name, pinned: id });
			if (denied) return denied;
			const data = await authedCall(
				path(`/tools/${encodeURIComponent(row.name)}`),
				sessionToken,
				{ method: "POST", body: JSON.stringify(input ?? {}) },
				env,
			);
			// Same vocabulary as `call_instance_tool` (`argKeys` + `argBytes`), so a pinned call and
			// an unpinned call of the same tool audit alike — plus `pinned`, so a reader can tell.
			const args = JSON.stringify(input ?? {});
			await audit(safetyFor(), {
				tool: row.name,
				action: "completed",
				input: { instance_id: id, pinned: true, argKeys: Object.keys(input ?? {}), argBytes: new TextEncoder().encode(args).length },
				result: { ok: auditOk(data) },
			});
			return jsonText(data);
		});
	}

	// ── The fixed three: the conversation itself ──
	const chat = {
		name: FIXED.chat,
		description: `Send a message to this pinned instance (${id}) and get its reply — the real runtime path with the owner's state and credentials. The instance's own tools above are the direct path for anything they cover; chat is for what needs the agent's judgement.`,
	};
	server.tool(
		chat.name,
		chat.description,
		{
			message: z.string().describe("Your message to the agent."),
			dry_run: z.boolean().optional().describe("Describe what would be sent without sending it."),
		},
		async ({ message, dry_run }: { message: string; dry_run?: boolean }) => {
			const sessionToken = tokenFor();
			if (!sessionToken) return authRequired();
			const input = { instance_id: id, message, pinned: true };
			const denied = await requirePermission(safetyFor(), "runtime", chat.name, input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(), chat.name, "send private instance chat message", input, {
					endpoint: path("/chat"),
					method: "POST",
					messageBytes: new TextEncoder().encode(message).length,
				});
			}
			const data = (await authedCall(path("/chat"), sessionToken, { method: "POST", body: JSON.stringify({ message, origin: "mcp" }) }, env)) as {
				message?: { content?: string; traceId?: string };
				error?: string;
			};
			if (!data.error) {
				await audit(safetyFor(), {
					tool: chat.name,
					action: "completed",
					input: { ...input, messageBytes: new TextEncoder().encode(message).length, ...(data.message?.traceId ? { traceId: data.message.traceId } : {}) },
				});
			}
			return text(data.message?.content || data.error || "No response");
		},
	);

	const guide = {
		name: FIXED.guide,
		description: `The connection guide for this pinned instance (${id}): its agent type, repos, and every tool it exposes with exact field names — the same document get_instance_connection_guide renders on /mcp. Generated per call from live state.`,
	};
	server.tool(guide.name, guide.description, {}, async () => {
		const sessionToken = tokenFor();
		if (!sessionToken) return authRequired();
		const denied = await requirePermission(safetyFor(), "read", guide.name, { instance_id: id, pinned: true });
		if (denied) return denied;
		const data = (await authedCall(path("/connection-guide"), sessionToken, {}, env)) as { guide?: string; error?: string };
		if (data.error) return text(`Error: ${data.error}`);
		const skipped = surface.skipped.length
			? `\n\n## Not registered on this pinned session\n${surface.skipped.map((s) => `- ${s}`).join("\n")}`
			: "";
		return text(`${data.guide || "(empty guide)"}${skipped}`);
	});

	const messages = {
		name: FIXED.messages,
		description: `Recent messages of this pinned instance (${id}), newest page first. When \`hasMore\` is true, call again with \`before\` set to \`nextCursor\` for the older page.`,
	};
	server.tool(
		messages.name,
		messages.description,
		{
			before: z.string().optional().describe("Cursor from a previous call's `nextCursor` — returns the page OLDER than it."),
			limit: z.coerce.number().int().min(1).max(100).optional().describe("Messages per page (default 50, max 100)."),
		},
		async ({ before, limit }: { before?: string; limit?: number }) => {
			const sessionToken = tokenFor();
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(), "read", messages.name, { instance_id: id, pinned: true });
			if (denied) return denied;
			const cursor = before ? `&before=${encodeURIComponent(before)}` : "";
			return jsonText(await authedCall(path(`/messages?limit=${limit || 50}${cursor}`), sessionToken, {}, env));
		},
	);
}
