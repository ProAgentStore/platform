import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, text } from "../http.js";
import { requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * The per-instance connection guide (#772) — one tool, its own module.
 *
 * It is here rather than folded into a neighbour because every neighbour states a membership rule
 * this tool fails. `settings.ts`: "configuration a human could set in the console" — a generated
 * document is not. `observability.ts`: "read-only windows onto what an instance DID" — this says
 * what an instance IS. `base.ts`: "the instance surface's LIFECYCLE core… This file is
 * deliberately small now", which is an instruction not to grow it by convenience. A new file costs
 * two lines in `index.ts` and keeps three docstrings true.
 *
 * Registration order is irrelevant (`index.ts`: "dispatch order-independent by tool name"), and
 * this is registered UNGATED — the discovery problem it solves belongs to every agent type, not
 * only the ones with a console surface.
 */
export function registerGuideTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"get_instance_connection_guide",
		"The ready-made briefing for driving ONE instance: its id, its agent type, its registered repos, the tools it actually exposes with their exact field names, and a worked call_instance_tool example using its real names. Plain Markdown — paste it into another assistant's system instructions. Use this INSTEAD of discovering the contract by trial and error: it is the same facts list_instance_tools returns, rendered as a short document rather than ~54 KB of JSON. It is generated per call from live state, so re-fetch it rather than storing it.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// An explicit read check, matching `coding_instance_deploy_status` rather than the older
			// bare-proxy reads in this directory: the safety layer should see the call so
			// MCP_READ_ONLY and a suspended account both gate it. No audit — a read that changes
			// nothing has nothing to record, and `audit()` no-ops without a subject anyway.
			const denied = await requirePermission(safetyFor(token), "read", "get_instance_connection_guide", { instance_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${instance_id}/connection-guide`, sessionToken, {}, env)) as {
				guide?: string;
				error?: string;
			};
			if (data.error) return text(`Error: ${data.error}`);
			// Text, not `jsonText`: the whole deliverable is a document meant to be pasted, and a
			// JSON-wrapped one arrives with escaped newlines that a reader has to undo by hand.
			return text(data.guide || "(empty guide)");
		},
	);
}
