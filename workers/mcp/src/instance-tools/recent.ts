import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { listInstanceTouches, RECENT_INSTANCES_LIMIT } from "../recent-instances.js";
import { requirePermission } from "../safety.js";
import { runHealthSentence } from "../state-vocabulary.js";
import type { InstanceSummary, InstanceToolsCtx } from "./shared.js";

/**
 * `recent_instances` (#787) — the instances this account drove most recently over MCP, each with
 * the live verdict on its latest run. One tool, its own module, for the reason `guide.ts` gives:
 * every neighbour states a membership rule this fails. `base.ts` is the lifecycle core and is
 * told not to grow; `observability.ts` is what an instance DID, and this is what the CALLER did.
 *
 * What it joins, and what it deliberately does not compute:
 *
 *   · the touch list — `recent-instances.ts`, written by the registration pipeline;
 *   · the roster — `GET /v1/instances/my/instances`, the same call `my_instances` makes, which is
 *     what resolves a slug, supplies the display name, and drops an instance the caller no longer
 *     has (a touch outlives a cancellation by up to its TTL);
 *   · each instance's runs — `GET /v1/instances/:id/loop`, the same call `coding_loop_status`
 *     makes without a `run_id`, newest run first. `health` and `waitNote` arrive COMPUTED by the
 *     API's `runHealth` / `waitClause` and are passed through untouched, which is the #580 rule:
 *     two surfaces deriving a verdict independently is how they came to disagree.
 *
 * Registered UNGATED: the question "what was I working on?" belongs to every agent type, and the
 * `/loop` route answers for every instance — an instance that has never run answers `run: null`.
 */

/** The run fields a caller needs to decide what to do next — the ones the ticket names, plus the
 *  identifiers that make the next call possible. Everything else on the run row is reachable
 *  through `coding_loop_status` by `runId`. */
interface RunSummary {
	runId: string;
	health: string | null;
	status: string;
	stopReason: string | null;
	waitingReason: string | null;
	waitingUntil: number | null;
	waitNote: string | null;
	objective: string;
	startedAt: number;
	finishedAt: number | null;
}

/** Longest `objective` the summary carries. An objective is often a whole issue body; the list
 *  needs enough to recognise it, and `coding_loop_status` has the rest. */
export const OBJECTIVE_PREVIEW_CHARS = 160;

export function registerRecentTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"recent_instances",
		`The ${RECENT_INSTANCES_LIMIT} instances THIS account drove most recently over MCP, newest first, each with its latest run's live verdict — the answer to "what was I working on?" for a fresh conversation that does not yet know an id. An interaction is a tool call that named an instance_id (coding_loop_start, coding_loop_status, coding_session_message, call_instance_tool, chat_with_instance and the rest) or any call on a session pinned to /mcp/i/<instance_id>; an instance's OWN scheduled activity does not count, and nothing is recorded before the first such call, so a new account answers an empty list — my_instances is the full roster. Each entry: instanceId, name (the display name when one is set), slug, status (the SUBSCRIPTION's), lastInteractionAt, lastTool, and run — the most recent autonomous run as coding_loop_status reports it (runId, health, status, stopReason, waitingReason, waitingUntil, waitNote, objective preview) or null when the instance has never run one. ${runHealthSentence()} For a parked run quote waitNote rather than reading waitingUntil yourself: under waitingReason human that instant is when the run GIVES UP, not when it resumes. Instances are capped at ${RECENT_INSTANCES_LIMIT}; pass the instanceId you want to coding_loop_status or coding_timeline for the rest.`,
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "recent_instances", {});
			if (denied) return denied;

			const touches = await listInstanceTouches(safetyFor(token));
			if (touches.length === 0) {
				return jsonText({
					instances: [],
					hint: "No instance has been driven from MCP by this account yet (or not in the last 30 days). The list fills as tools that take an instance_id are called; my_instances lists everything you own.",
				});
			}

			const roster = (await authedCall("/v1/instances/my/instances", sessionToken, {}, env)) as {
				instances?: InstanceSummary[];
				error?: string;
			};
			if (roster.error) return text(`Error: ${roster.error}`);
			// Id first, slug second, and a slug maps to the FIRST instance of that agent — the same
			// resolution `resolveId` in coding.ts applies when a coding tool is handed a slug, so the
			// instance this lists is the one those calls actually reached.
			const byRef = new Map<string, InstanceSummary>();
			for (const inst of roster.instances ?? []) byRef.set(inst.id, inst);
			for (const inst of roster.instances ?? []) if (inst.slug && !byRef.has(inst.slug)) byRef.set(inst.slug, inst);

			const seen = new Set<string>();
			const picked: Array<{ inst: InstanceSummary; at: string; tool: string }> = [];
			for (const t of touches) {
				const inst = byRef.get(t.instance);
				if (!inst || seen.has(inst.id)) continue;
				seen.add(inst.id);
				picked.push({ inst, at: t.at, tool: t.tool });
				if (picked.length === RECENT_INSTANCES_LIMIT) break;
			}

			const instances = await Promise.all(
				picked.map(async ({ inst, at, tool }) => {
					const loop = (await authedCall(`/v1/instances/${encodeURIComponent(inst.id)}/loop`, sessionToken, {}, env)) as {
						runs?: Array<Record<string, unknown>>;
						error?: string;
					};
					const latest = loop.runs?.[0];
					return {
						instanceId: inst.id,
						name: inst.name ?? null,
						slug: inst.slug ?? null,
						status: inst.status,
						lastInteractionAt: at,
						lastTool: tool,
						run: latest ? summarizeRun(latest) : null,
						// Present only when the run lookup itself failed, so `run: null` is never read as
						// "has never run" on an instance the API refused to answer for.
						...(loop.error ? { runError: loop.error } : {}),
					};
				}),
			);
			return jsonText({ instances });
		},
	);
}

function summarizeRun(run: Record<string, unknown>): RunSummary {
	const objective = typeof run.objective === "string" ? run.objective : "";
	return {
		runId: String(run.runId ?? ""),
		health: (run.health as string | undefined) ?? null,
		status: String(run.status ?? ""),
		stopReason: (run.stopReason as string | null | undefined) ?? null,
		waitingReason: (run.waitingReason as string | null | undefined) ?? null,
		waitingUntil: (run.waitingUntil as number | null | undefined) ?? null,
		waitNote: (run.waitNote as string | null | undefined) ?? null,
		objective: objective.length > OBJECTIVE_PREVIEW_CHARS ? `${objective.slice(0, OBJECTIVE_PREVIEW_CHARS)}…` : objective,
		startedAt: Number(run.startedAt ?? 0),
		finishedAt: (run.finishedAt as number | null | undefined) ?? null,
	};
}
