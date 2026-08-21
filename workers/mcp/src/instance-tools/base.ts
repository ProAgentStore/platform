import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonResult, jsonText, structuredText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import { findInstanceForAgent, type InstanceSummary, type InstanceToolsCtx } from "./shared.js";

/**
 * Did the tool call actually do what was asked (#726)?
 *
 * Three shapes reach here and they mean different things:
 *   `{success:false, content:"…"}` — a GATE said no. HTTP 200, because a refusal is a valid
 *                                    answer. This is the one that used to audit as a success.
 *   `{error:"…"}`                  — a transport failure, synthesised by http.ts on a non-2xx.
 *   anything else                  — it ran.
 *
 * `success` is checked first and only when present, so a tool result that has never carried the
 * field is judged exactly as it was before.
 */
export function auditOk(data: unknown): boolean {
	if (typeof data !== "object" || data === null) return true;
	const shape = data as { success?: unknown; error?: unknown };
	if (typeof shape.success === "boolean") return shape.success;
	return !shape.error;
}

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

// ── The listing's remaining overflow (#578) ──────────────────────────────────────────────────
//
// #569 budgeted the DEFAULT listing down to ~54,000 B and made this worker send it compact. The
// `schemas:true` path was left over the limit, and re-measured on the deployed API across ALL 34
// instances on the account it is worse than the ticket said: 61,796–66,189 B, with **20 of 34 over
// 64 KiB** and the worst case 653 B over — not the 433 B of the coder-repo shape #569's guard
// happens to measure. A fix tuned to 433 B of headroom still ships over.
//
// WHERE THE BYTES ARE, which inverts the ticket's three options. In that 66,189 B worst case:
//
//   · every jsonSchema in the response        11,753 B — 18%
//   · `description` on the 68 NOT-DECLARED rows  25,074 B — 38%
//
// So the argument the tool blames is not what fills the response. Prose about tools the agent
// cannot run is more than twice the weight of every schema, and it is present on the default path
// too. Truncating it to 120 characters takes the worst case to 49,604 B (76%); dropping it takes
// it to 40,442 B (62%).
//
// WHY TRUNCATE RATHER THAN NARROW THE ARGUMENT. The ticket's options 1 and 3 both rest on a
// premise it flagged as unverified — "nobody wants all 104 schemas" — and that premise is
// UNMEASURABLE from anything this platform records: `list_instance_tools` is a read tool, its
// handler makes no `audit()` call, `requirePermission` writes only on denial, `audit()` no-ops
// without a subject, and there is no Analytics Engine binding in `workers/`. This option needs no
// premise about callers: it takes nothing away from anyone, no argument changes meaning, and
// #525's contract — that the listing says what the agent CANNOT reach and why — is intact, because
// `allowed`, `reason`, `connector`, `scope`, `mutates`, `tier` and `invocableBy` all stay.
//
// WHY HERE AND NOT IN `projectToolListing`. The 64 KiB ceiling is a property of the MCP host, not
// of the data. The API route's other consumer is the console's Tool Permissions panel, which
// renders `t.description` under every row INCLUDING the not-declared ones — that is how an owner
// reads what a tool they could switch on actually does (`store/console/src/components/
// ToolPermissions.tsx:139`). Truncating in the API to fix a limit the console does not have would
// degrade that panel to save bytes nobody there is short of.
//
// THE COST, stated rather than hidden: an auditor reading a `not_declared` row over MCP now gets
// the first clause of the description instead of all of it. The row still says what the tool is
// for at a glance and every verdict field is untouched, but the full prose is not there.
//
// AND WHAT THIS IS NOT: a bound. It scales with the number of rows, so a large enough catalogue
// overflows again — pagination (the ticket's option 2) is the only option that bounds it, and it
// remains the eventual answer. What this buys is ~25% of headroom on the measured worst case
// (66,189 -> ~49,300 B) and a guard that goes RED when the catalogue grows past the limit, which
// is the right moment to spend that larger fix. `tool-listing-wire-size.test.ts` asserts it on a
// deliberately heavier fixture, where the same cut lands at 83% of the limit rather than 75%.

/** Characters of a NOT-RUNNABLE row's description that survive the trip over MCP. */
export const UNRUNNABLE_DESCRIPTION_CHARS = 120;

/** A tool-listing row, as far as the size projection needs to understand one. */
interface ListingRow {
	allowed?: boolean;
	description?: string;
}

/**
 * Truncate the description of every row this instance cannot run, at a word boundary.
 *
 * Applied on BOTH paths, not just `schemas:true`: the prose is the same weight either way, one row
 * shape is easier to reason about than two, and the default path gains the same headroom. A row
 * that is runnable, or already short, is returned untouched — including its object identity, so
 * nothing is copied that does not need to be.
 */
export function budgetToolListing<T extends ListingRow>(rows: readonly T[]): T[] {
	return rows.map((row) => {
		const prose = row.description;
		if (row.allowed !== false || typeof prose !== "string" || prose.length <= UNRUNNABLE_DESCRIPTION_CHARS) return row;
		const cut = prose.slice(0, UNRUNNABLE_DESCRIPTION_CHARS);
		const space = cut.lastIndexOf(" ");
		// Only fall back to a hard cut when the word boundary would throw most of the clause away.
		const kept = space > UNRUNNABLE_DESCRIPTION_CHARS / 2 ? cut.slice(0, space) : cut;
		return { ...row, description: `${kept.trimEnd()}…` };
	});
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
			") and `invocableBy`, the surfaces that can actually reach it. Input schemas are NOT included by default: pass schemas:true to get them for the tools this instance may run (a schema for a tool it may not run describes inputs you could never send). Pass allowed_only:true for just the runnable set. To keep the response inside a calling host's limit, the `description` of a row this instance CANNOT run is truncated to its first clause and ends in `…` — every verdict field on it is complete, only the prose is cut; ask for allowed_only:true if you want full descriptions of the tools it can run. To verify an agent is read-only before trusting it with sensitive data, read `mutates` — NOT `scope`: a tool with no `connector` has nothing to consent to, so it reports scope `read` however much it changes (start_work, run_pipeline, dedupe_upsert all do). Then read `allowed`: a tool absent from the allowed set cannot be invoked, by chat or by call_instance_tool. Read `invocableBy` before concluding a tool is unreachable from here — `[\"chat\"]` means the agent runs it in conversation and `call_instance_tool` cannot; only tools listing `call_instance_tool` are callable through that tool. To audit what an agent can REACH, read `reach` — `platform` (never leaves ProAgentStore), `machine` (the owner's computer) or `internet` (anywhere else). Do NOT filter on `connector` for this: it is wrong in both directions and was measured so — fetch_url names no connector and reaches the internet, which is how 10 of 34 instances were told they had nothing reaching outside the platform while it was allowed on all ten; every supervision tool names one and never leaves.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			allowed_only: z.boolean().optional().describe("Return only the tools this instance may actually run."),
			// "Schemas are the bulk of the response" was measured wrong and is corrected here (#578):
			// across all 34 instances every schema together is 18% of the worst-case payload, while
			// the descriptions of the rows the agent cannot run are 38%.
			schemas: z.boolean().optional().describe("Include each allowed tool's input schema. Off by default — ask for them when you are about to call one."),
		},
		async ({ token, instance_id, allowed_only, schemas }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const qs = [allowed_only ? "allowed=true" : "", schemas ? "schemas=true" : ""].filter(Boolean).join("&");
			const data = (await authedCall(`/v1/instances/${instance_id}/tools${qs ? `?${qs}` : ""}`, sessionToken, {}, env)) as {
				tools?: Array<{ allowed?: boolean; description?: string }>;
				error?: string;
			};
			// The remaining overflow (#578) — see `budgetToolListing` for where the bytes actually
			// are and why this is done here rather than in the route. An `{error}` body carries no
			// `tools`, so it passes through untouched rather than being reshaped into a success.
			const budgeted = Array.isArray(data.tools) ? { ...data, tools: budgetToolListing(data.tools) } : data;
			// The API body for a 104-row instance is ~54 KB; pretty-printing it here added ~22% and
			// took the WIRE response to 66,042 bytes — still over the calling host's limit this was
			// filed about, after the payload had already been budgeted down. Measured in production,
			// which is the only reason it was noticed at all: every test asserted the API's compact
			// body, not what MCP sends. `jsonText` is compact for every tool since #586, so the
			// `{compact:true}` this line carried is no longer expressible or needed.
			return jsonText(budgeted);
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
			// This tool recorded NOTHING on either side (#701): no MCP audit row, and no
			// `agent_events` row either, because `routes/tools.ts` calls `runRegistryTool`
			// without a `traceId` and `lib/tool-registry.ts` only traces a delegated call. So an
			// MCP-driven `github_create_issue` existed in no log anywhere — and unlike the chat
			// tools there is no persisted content for a join key to point AT, which is why this
			// is the one gap the correlation ids cannot close.
			//
			// `argKeys` + `argBytes` is the vocabulary `lib/connectors/mcp.ts` and
			// `routes/tools.ts` already settled on, so this introduces no new privacy posture.
			const args = JSON.stringify(input || {});
			await audit(safetyFor(token), {
				tool: "call_instance_tool",
				action: "completed",
				input: {
					instance_id,
					invoked: tool,
					argKeys: Object.keys(input || {}),
					argBytes: new TextEncoder().encode(args).length,
				},
				// `success` FIRST, then `error` (#726). This read `!data.error` alone, and a tool that
				// REFUSES does not set `error`: the route answers HTTP 200 with `{success:false}` and
				// the refusal in `content`, because a gate saying no is a valid answer rather than a
				// transport failure. So every refusal audited as a success.
				//
				// Measured on a live account: six `gmail_search` calls, five of them blocked by the
				// email-permission gate and one that actually read a mailbox, recorded as six
				// identical `ok:true` rows. An audit log that cannot tell a refused mailbox read from
				// a completed one is worse than no audit log, because it is believed.
				//
				// `error` is still consulted for the transport failures `http.ts` synthesises on a
				// non-2xx, which carry no `success` field at all.
				result: { ok: auditOk(data) },
			});
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
			// `origin: "mcp"` marks the turn's provenance in the trace. It is a SEPARATE field
			// from `channel`, which the API route hardcodes to "chat" and the AgentDO uses for
			// message threading — putting "mcp" there would land reaped-turn notices and system
			// messages on a channel no client polls (#701).
			const data = (await authedCall(
				`/v1/instances/${instance_id}/chat`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ message, origin: "mcp" }) },
				env,
			)) as {
				message?: { content?: string; traceId?: string };
				error?: string;
			};
			// `traceId` is the turn id the API mints before the DO is asked, and every
			// `instance_messages` row and `agent_events` row for this turn carries it. Recording
			// it costs zero extra bytes and is an EXACT join back to the prose the audit event
			// deliberately does not copy — ADR 0004. Omitted when absent (an older API, or an
			// error reply), which is additive rather than a broken field.
			if (!(data as { error?: string }).error)
				await audit(safetyFor(token), {
					tool: "chat_with_instance",
					action: "completed",
					input: {
						instance_id,
						messageBytes: new TextEncoder().encode(message).length,
						...(data.message?.traceId ? { traceId: data.message.traceId } : {}),
					},
				});
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
