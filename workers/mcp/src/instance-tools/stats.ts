import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, jsonText } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Stats-card tools (#312) — creator-side on the AGENT, subscriber-side on the INSTANCE.
 *
 * Its OWN group rather than four more registrations in `base.ts`, which is already the largest
 * file in the repo and pinned by the #302 size ratchet. The split is also the honest one: these
 * four are one feature with one vocabulary, and `base.ts` is where tools go when nobody decided.
 *
 * Thin proxies over the routes the console uses, so all four go through the SAME sanitizer and the
 * same closed source vocabulary (`workers/api/src/lib/stats-schema.ts`). That is the whole safety
 * story of #312: there is no privileged path here that could express a card a human cannot, so
 * "MCP configured it", "the agent configured it" and "the user configured it" cannot diverge.
 *
 * Ungated: every instance can have stats, exactly as every instance has settings and behaviour, so
 * these are always registered rather than tied to a console surface.
 */
export function registerStatsTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"get_agent_stats_schema",
		"Read an agent's declared stats cards (creator view — the default card set every subscriber inherits on the Stats tab).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: z.string(),
		},
		async ({ token, agent_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			return jsonText(await authedCall(`/v1/agents/${agent_id}/stats-schema`, sessionToken, {}, env));
		},
	);

	server.tool(
		"set_agent_stats_schema",
		"Replace an agent's stats cards (owner only). Each card: {id, title, kind: number|line|bar|table, source, params}. `source` must be one of the fixed sources — read them from GET /v1/stats/sources; a card can never carry a query. `line` cards are daily trends served from a nightly snapshot and start empty (no backfill). Max 12 cards. Rejected cards come back named in `rejected`.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: z.string(),
			cards: z.array(z.record(z.unknown())).describe("The full card array (replaces the old one; [] clears)"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, agent_id, cards, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { agent_id, cards: cards.length };
			const denied = await requirePermission(safetyFor(token), "write", "set_agent_stats_schema", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_agent_stats_schema", "replace agent stats cards", input, {
					endpoint: `/v1/agents/${agent_id}/stats-schema`,
					method: "PUT",
				});
			}
			const data = await authedCall(`/v1/agents/${agent_id}/stats-schema`, sessionToken, { method: "PUT", body: JSON.stringify({ cards }) }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_agent_stats_schema", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"get_instance_stats",
		"Read a subscribed instance's resolved stats cards AND their current numbers, for one window (7/30/90 days). In a `line` card's series, `value: null` means NOTHING RAN that day — it is NOT zero, and must never be reported as a day with no results. `historyStart` says when the daily snapshot began (there is no backfill), and each card carries a `caveat` saying what its number does not count.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			window: z.enum(["7", "30", "90"]).optional().describe("Days to cover (default 30)."),
			schema_only: z.boolean().optional().describe("Return just the card definitions, without running any query."),
		},
		async ({ token, instance_id, window, schema_only }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const path = schema_only ? `/v1/instances/${instance_id}/stats/schema` : `/v1/instances/${instance_id}/stats?window=${window ?? "30"}`;
			return jsonText(await authedCall(path, sessionToken, {}, env));
		},
	);

	server.tool(
		"set_instance_stats",
		"Add, edit or remove stats cards on YOUR subscribed instance. Patch semantics: pass ops as [{id, card}]; `card: null` removes it (a card inherited from the agent template is hidden for you, never deleted for everyone). Cards that fail validation are returned in `rejected` BY NAME while the valid ones still apply. This writes your own override only — it can never edit the agent template other subscribers get.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			ops: z.array(z.record(z.unknown())).describe("[{id, card}] — card: null removes/hides."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, ops, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, ops: ops.length };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_stats", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_stats", "change instance stats cards", input, {
					endpoint: `/v1/instances/${instance_id}/stats/cards`,
					method: "POST",
				});
			}
			const data = await authedCall(`/v1/instances/${instance_id}/stats/cards`, sessionToken, { method: "POST", body: JSON.stringify({ ops }) }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_instance_stats", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
}
