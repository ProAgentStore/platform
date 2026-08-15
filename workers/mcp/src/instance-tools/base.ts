import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonResult, jsonText, structuredText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import { findInstanceForAgent, type InstanceSummary, type InstanceToolsCtx } from "./shared.js";

/**
 * The `tier` vocabulary a `list_instance_tools` row can carry, with the gloss the API worker's own
 * `ToolTier` carries (`workers/api/src/lib/builtin-tool-policy.ts`).
 *
 * COPIED, not imported: this worker is a separate deployable and cannot import from `workers/api`
 * (see the `columnFor` note in ./shared.ts). `tool-listing-contract.test.ts` reads that file as
 * text and fails when the two vocabularies diverge, which is the only honest way to keep a copy.
 *
 * A LIST, so the description below is BUILT from it (#569). The description defined `base` and
 * `connector` and no others while the API returned all four — measured on the audited instance,
 * 34 of 104 rows carried an undocumented tier, `standard` (30) and `runtime` (4), and a caller
 * filtering on the documented pair silently dropped every tool that reaches the owner's machine.
 * Prose and vocabulary drift apart; prose generated from the vocabulary cannot.
 */
export const TOOL_TIERS: ReadonlyArray<readonly [string, string]> = [
	["base", "a universal facility every agent has"],
	["standard", "creator-selectable, and this agent declared it"],
	["runtime", "needs a local runner — the machine running `pags up`"],
	["connector", "reaches an external system"],
];

/** The tier clause of the listing tool's description, rendered from the vocabulary itself. */
function tierGloss(): string {
	return TOOL_TIERS.map(([id, gloss]) => `${id} = ${gloss}`).join("; ");
}

/**
 * The instance surface's LIFECYCLE core: what an instance may do (the connector-tool gate),
 * how one comes into and goes out of existence, and how you talk to it.
 *
 * This file is deliberately small now. It was 1871 lines and 67 tools (#305) — the file
 * everything landed in when nobody decided where it went, which is exactly the shape that
 * makes a tool's scope or its confirmation gate easy to lose in review. The other eight
 * groups moved out beside it, verbatim; `contract.test.ts` holds the whole surface to a
 * per-tool table of scope / confirmation / dry-run so a move cannot quietly change one.
 *
 * Anything registered from here is UNGATED — every subscriber has it. Surface-gated tools
 * live in `apply.ts` / `repo.ts` / `coding.ts`.
 */
export function registerBaseTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	// Connector/registry tools (issue #87): list + invoke over MCP so external clients
	// get the same connector capabilities (e.g. GitHub) as the agent runtime. One
	// definition in the API registry → surfaced here via a thin proxy.

	server.tool(
		"list_instance_tools",
		"Audit exactly what one of your instances may do. Returns EVERY tool it could run — its built-in agent facilities (memory, tasks, board, fetch_url, knowledge, files, collections) as well as its connector tools — each with this instance's verdict: `allowed` (may it run), `mutates` (does a call CHANGE anything — the external system, your machine, or the agent's own stored data), `scope` (read/write — whether the write-CONSENT gate applies to it, NOT whether it changes anything), `disabled` (you switched it off), `reason` (ok | not_declared | disabled_by_owner), `writeConsent` (n/a | granted | required | per_call) — the SEPARATE consent gate, so `allowed:true, writeConsent:\"required\"` means the tool is this agent's but every call is refused until write access for its `connector` is granted; `per_call` means some calls run and mutating ones don't (a caller-chosen HTTP method, or an MCP server/tool that has not been granted) — plus `tier` (" +
			// Rendered from TOOL_TIERS, never typed out: the two-of-four description that shipped is
			// what #569 is about.
			tierGloss() +
			") and `invocableBy`, the surfaces that can actually reach it. Input schemas are NOT included by default: pass schemas:true to get them for the tools this instance may run (they are the bulk of the response, and a schema for a tool it may not run describes inputs you could never send). Pass allowed_only:true for just the runnable set. To verify an agent is read-only before trusting it with sensitive data, read `mutates` — NOT `scope`: a tool with no `connector` has nothing to consent to, so it reports scope `read` however much it changes (start_work, run_pipeline, dedupe_upsert all do). Then read `allowed`: a tool absent from the allowed set cannot be invoked, by chat or by call_instance_tool. Read `invocableBy` before concluding a tool is unreachable from here — `[\"chat\"]` means the agent runs it in conversation and `call_instance_tool` cannot; only tools listing `call_instance_tool` are callable through that tool. To audit reach into EXTERNAL systems specifically, filter on `connector`.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			allowed_only: z.boolean().optional().describe("Return only the tools this instance may actually run."),
			schemas: z.boolean().optional().describe("Include each allowed tool's input schema. Off by default — schemas are the bulk of the response; ask for them when you are about to call one."),
		},
		async ({ token, instance_id, allowed_only, schemas }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const qs = [allowed_only ? "allowed=true" : "", schemas ? "schemas=true" : ""].filter(Boolean).join("&");
			const data = await authedCall(`/v1/instances/${instance_id}/tools${qs ? `?${qs}` : ""}`, sessionToken, {}, env);
			// Compact (#569). The API body for a 104-row instance is ~54 KB; pretty-printing it here
			// added ~22% and took the WIRE response to 66,042 bytes — still over the calling host's
			// limit that this issue was filed about, after the payload had already been budgeted
			// down. Measured in production, which is the only reason it was noticed at all: every
			// test asserted the API's compact body, not what MCP actually sends.
			return jsonText(data, { compact: true });
		},
	);

	server.tool(
		"set_instance_tool",
		"Switch one tool on or off for one of your instances — the owner's veto over what their own copy may do. A tool switched off is removed from the agent's chat AND refused by call_instance_tool, so this is a real capability change, not a UI preference. You can only toggle tools the agent declares; everything else is already refused.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			tool: z.string().describe("Tool name, e.g. repo_read_file (see list_instance_tools)."),
			enabled: z.boolean().describe("true to allow the tool, false to switch it off."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, tool, enabled, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// Gated as a write: this changes what an agent is permitted to do, so a read-only
			// MCP session must not be able to widen an agent's reach.
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_tool", { tool, enabled });
			if (denied) return denied;
			if (dry_run) return text(`Dry run: would set ${tool} to ${enabled ? "enabled" : "disabled"} on ${instance_id}.`);
			const data = await authedCall(
				`/v1/instances/${instance_id}/tools/${encodeURIComponent(tool)}`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ enabled }) },
				env,
			);
			await audit(safetyFor(token), { tool: "set_instance_tool", action: "completed", input: { instance_id, tool, enabled } });
			return jsonText(data);
		},
	);

	// NO `dry_run`, on purpose (#328). This tool is a generic invoker: what a call would do
	// is decided entirely by the registry entry for `tool` over in `workers/api`, which this
	// worker deliberately cannot import and does not model. A dry run could therefore only
	// echo back the caller's own `tool` and `input` — a preview that reads like a safety
	// check while actually knowing nothing about the side effect it is previewing, which is
	// worse than not offering one.
	//
	// The real preview already exists as a separate READ tool: `list_instance_tools` returns
	// every registry tool with this instance's verdict (`allowed`, `mutates`, `scope`,
	// `disabled`, `reason`) and its input schema. That answers both questions a caller has —
	// may this run (`allowed`), and does it mutate (`mutates`, which is NOT `scope`; see #563)
	// — without touching anything, and it answers them from the registry rather than from a
	// guess made here.
	server.tool(
		"call_instance_tool",
		"Invoke a connector tool (e.g. github_workflow_runs, github_list_issues) on one of your instances. `input` is the tool's argument object. No dry run: call list_instance_tools with schemas:true first — that is where the input schema lives, and where you learn whether this instance may run the tool at all.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			tool: z.string().describe("Tool name, e.g. github_list_issues"),
			input: z.record(z.any()).optional().describe("The tool's input arguments object"),
		},
		async ({ token, instance_id, tool, input }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// Gated as a write: this is a generic invoker that will include write connector
			// tools later; MCP_READ_ONLY mode should block it. Reads still work via the agent.
			const denied = await requirePermission(safetyFor(token), "write", "call_instance_tool", { tool });
			if (denied) return denied;
			const data = await authedCall(
				`/v1/instances/${instance_id}/tools/${encodeURIComponent(tool)}`,
				sessionToken,
				{ method: "POST", body: JSON.stringify(input || {}) },
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"subscribe_agent",
		"Subscribe to a published agent and create your own private runnable instance. Use this before chat_with_instance for real user runs.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: z.string().describe("Published agent ID or slug"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, agent_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { agent_id };
			const denied = await requirePermission(safetyFor(token), "write", "subscribe_agent", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "subscribe_agent", "subscribe to published agent", input, {
					endpoint: `/v1/instances/${agent_id}/subscribe`,
					method: "POST",
				});
			}
			const data = (await authedCall(
				`/v1/instances/${agent_id}/subscribe`,
				sessionToken,
				{ method: "POST" },
				env,
			)) as { instanceId?: string; agentId?: string; status?: string; error?: string };
			if (data.instanceId) {
				await audit(safetyFor(token), { tool: "subscribe_agent", action: "completed", input, result: data });
				return text(
					`Subscribed.\nInstance: ${data.instanceId}\nAgent: ${data.agentId}\nStatus: ${data.status}`,
				);
			}
			if (data.error?.includes("Already subscribed")) {
				const existing = await findInstanceForAgent(env, sessionToken, agent_id);
				if (existing) {
					return text(
						`Already subscribed.\nInstance: ${existing.id}\nAgent: ${existing.agent_id}\nStatus: ${existing.status}`,
					);
				}
			}
			return text(`Error: ${data.error || "subscribe failed"}`);
		},
	);

	server.tool(
		"my_instances",
		"List your subscribed runnable agent instances. These are the correct targets for real agent chats.",
		{ token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.") },
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = (await authedCall(
				"/v1/instances/my/instances",
				sessionToken,
				{},
				env,
			)) as { instances?: InstanceSummary[]; error?: string };
			// This tool declares an outputSchema (#561), so every path answers with structure as
			// well as text: `structuredContent` must be an object, and the SDK rejects the call
			// outright if a schema'd tool returns none. The prose is kept where it is the more
			// useful answer — "none yet, subscribe first" tells a caller what to do next in a
			// way `{instances: []}` does not.
			if (data.error) return structuredText(`Error: ${data.error}`, { error: data.error });
			const instances = data.instances || [];
			if (instances.length === 0) {
				return structuredText("No subscribed instances yet. Use subscribe_agent with a published agent first.", { instances: [] });
			}
			return jsonResult({ instances });
		},
	);

	server.tool(
		"chat_with_instance",
		"Chat with your private subscribed instance of an agent. This is the real runtime path with user-owned state and credentials.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from subscribe_agent or my_instances"),
			message: z.string(),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, message, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, message };
			const denied = await requirePermission(safetyFor(token), "runtime", "chat_with_instance", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "chat_with_instance", "send private instance chat message", input, {
					endpoint: `/v1/instances/${instance_id}/chat`,
					method: "POST",
					messageBytes: new TextEncoder().encode(message).length,
				});
			}
			const data = (await authedCall(
				`/v1/instances/${instance_id}/chat`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ message }) },
				env,
			)) as {
				message?: { content?: string };
				error?: string;
			};
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "chat_with_instance", action: "completed", input: { instance_id, messageBytes: new TextEncoder().encode(message).length } });
			return text(data.message?.content || data.error || "No response");
		},
	);

	server.tool(
		"cancel_instance",
		"Cancel your subscription and deactivate one private subscribed instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			confirm: z.string().optional().describe('Must be "cancel_instance" to cancel a private instance subscription.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "cancel_instance", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "cancel_instance", "cancel private instance subscription", input, {
					endpoint: `/v1/instances/${instance_id}/cancel`,
					method: "POST",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "cancel_instance", confirm, "cancel_instance", input);
			if (unconfirmed) return unconfirmed;
			const data = (await authedCall(
				`/v1/instances/${instance_id}/cancel`,
				sessionToken,
				{ method: "POST" },
				env,
			)) as { success?: boolean; error?: string };
			if (data.success) await audit(safetyFor(token), { tool: "cancel_instance", action: "completed", input });
			return text(data.success ? "Canceled" : `Error: ${data.error}`);
		},
	);
}
