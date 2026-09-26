import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, type McpEnv, text } from "./http.js";
import { auditOk } from "./instance-tools/base.js";
import {
	type FetchHandler,
	INSTANCE_ID_FIELD,
	type PinnedCtx,
	type PinnedToolRow,
	registerToolRows,
	selectInvocableRows,
	withPathPin,
} from "./pinned.js";
import { audit, type McpScope, requirePermission } from "./safety.js";

/**
 * A session pinned to one AGENT TYPE (#771) — `/mcp/t/<agentSlug>`, beside the instance pin
 * (`/mcp/i/<id>`, #783) and additive to the platform-wide `/mcp`, which neither changes.
 *
 * ── What it is for
 *
 * #783 serves a caller pinned to ONE instance. This serves one that works across SEVERAL instances
 * of the same type — a pilot driving three Coder instances — and wants each tool under its real
 * name with its real field names, without the `list_instance_tools` → `call_instance_tool` hop that
 * produced guessed names (#771/#772). Each tool is the type's own, plus an `instance_id` argument
 * naming which of the caller's instances of that type runs it.
 *
 * ── What "the type's tools" are
 *
 * Tool sets are NOT identical across instances of one type (#771's open question, answered in its
 * comment): the template declares the set, and each instance's owner can switch tools off, grant
 * connector write consent, or unlock a permission tool (`find_confirmation_link`). So this session
 * registers what the TYPE declares — `GET /v1/agents/:slug/tools` — and every call goes through
 * `POST /v1/instances/:id/tools/:name?agent=<slug>`, which re-checks ownership, the live
 * per-instance policy, and that the instance really is of this type. `call_instance_tool` stays as
 * the escape hatch for an instance-specific extra the type does not declare.
 *
 * Like the instance pin, the names are data: registered by variable, annotated from each row's own
 * `mutates`, outside `TOOL_RISK` and the README table, and held to their own contract by
 * `type-pinned.test.ts`. No `chat` / `guide` / `messages`: those are about ONE instance.
 */

/** `/mcp/t/<agentSlug>` — agent slugs are lowercase alphanumerics and hyphens. */
export const TYPE_PATH = /^\/mcp\/t\/([a-z0-9-]{1,64})\/?$/;

export function pinnedTypeFromPath(pathname: string): string | null {
	const m = TYPE_PATH.exec(pathname);
	return m ? m[1] : null;
}

/** `/mcp/t/<agentSlug>` → the transport, with the slug on `ctx.props.pinnedType`. */
export function withPinnedType<E>(inner: FetchHandler<E>): FetchHandler<E> {
	return withPathPin(inner, pinnedTypeFromPath, "pinnedType");
}

export interface TypeSurface {
	agentType: string;
	rows: PinnedToolRow[];
	/** Set when the type's tools could not be read — the session then registers only `agent_type_unavailable`. */
	error?: string;
	/** Declared names this session did not register, with why. */
	skipped: string[];
}

const FIXED = { call: "call_instance_tool", unavailable: "agent_type_unavailable" } as const;

export async function loadTypeSurface(env: McpEnv, token: string | null, agentType: string): Promise<TypeSurface> {
	if (!token) return { agentType, rows: [], skipped: [], error: "authentication required" };
	const data = (await authedCall(`/v1/agents/${encodeURIComponent(agentType)}/tools?allowed=true&schemas=true`, token, {}, env)) as {
		tools?: PinnedToolRow[];
		error?: string;
	};
	if (data.error || !Array.isArray(data.tools)) return { agentType, rows: [], skipped: [], error: data.error || "tool listing unavailable" };
	const { rows, skipped } = selectInvocableRows(data.tools, new Set<string>(Object.values(FIXED)), `for ${agentType}`);
	// A tool with its OWN `instance_id` field cannot also take the injected one — the escape hatch reaches it.
	const usable = rows.filter((r) => {
		const clash = Object.hasOwn((r.jsonSchema as { properties?: object } | undefined)?.properties ?? {}, INSTANCE_ID_FIELD);
		if (clash) skipped.push(`${r.name} (has its own ${INSTANCE_ID_FIELD} field — use ${FIXED.call})`);
		return !clash;
	});
	return { agentType, rows: usable, skipped };
}

/** The risk class each tool is announced under: a row's own `mutates`; the escape hatch is `write`, like its platform twin. */
export function typeRiskFor(surface: TypeSurface): (name: string) => McpScope | undefined {
	const byName = new Map(surface.rows.map((r) => [r.name, r.mutates ? "write" : "read"] as const));
	return (name) => (name === FIXED.call ? "write" : name === FIXED.unavailable ? "read" : byName.get(name));
}

export function registerTypeTools(server: McpServer, ctx: PinnedCtx, surface: TypeSurface): void {
	const { env, tokenFor, safetyFor } = ctx;
	const type = surface.agentType;
	if (surface.error) {
		const def = {
			name: FIXED.unavailable,
			description: `This session is pinned to agent type ${type}, but its tools could not be read (${surface.error}). The type may not exist, not be published, or the connection is not signed in. Connect to /mcp for the platform-wide surface.`,
		};
		server.tool(def.name, def.description, {}, async () => text(`Error: ${def.description}`));
		return;
	}

	registerToolRows(server, ctx, surface.rows, { agentType: type });

	// The escape hatch: a tool ONE instance of this type has and the type does not declare.
	const skipped = surface.skipped.length ? ` Not registered here: ${surface.skipped.join("; ")}.` : "";
	const call = {
		name: FIXED.call,
		description: `Run a tool on one of your ${type} instances by name — for a tool that instance has beyond the ${type} tools registered here (e.g. one its owner unlocked by a permission). The registered tools are the direct path for everything else.${skipped}`,
	};
	server.tool(
		call.name,
		call.description,
		{
			[INSTANCE_ID_FIELD]: z.string().describe(`Which of your ${type} instances — an id from my_instances.`),
			tool: z.string().describe("The tool's exact name, as list_instance_tools on /mcp reports it."),
			input: z.union([z.record(z.unknown()), z.string()]).optional().describe("The tool's arguments, as an object (or its JSON)."),
		},
		async ({ instance_id, tool, input }: { instance_id: string; tool: string; input?: Record<string, unknown> | string }) => {
			const sessionToken = tokenFor();
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(), "write", call.name, { instance_id, tool, agentType: type });
			if (denied) return denied;
			let args: Record<string, unknown> = {};
			try {
				args = typeof input === "string" ? (JSON.parse(input) as Record<string, unknown>) : (input ?? {});
			} catch {
				return text("Error: input is not valid JSON — pass the tool's arguments as an object.");
			}
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/tools/${encodeURIComponent(tool)}?agent=${encodeURIComponent(type)}`,
				sessionToken,
				{ method: "POST", body: JSON.stringify(args) },
				env,
			);
			await audit(safetyFor(), {
				tool: call.name,
				action: "completed",
				input: { instance_id, tool, agentType: type, argKeys: Object.keys(args), argBytes: new TextEncoder().encode(JSON.stringify(args)).length },
				result: { ok: auditOk(data) },
			});
			return jsonText(data);
		},
	);
}
