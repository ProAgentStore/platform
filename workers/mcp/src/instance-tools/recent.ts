import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { type InstanceTouch, listInstanceTouches, RECENT_INSTANCES_LIMIT } from "../recent-instances.js";
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

/**
 * The most a caller may ask `recent_instances` for (#192). The tool fans out one `/loop` call per
 * listed instance — the reason it is capped at all — so the ceiling bounds that fan-out, not the
 * account. A larger `limit` is clamped here and the clamp is REPORTED (`requestedLimit`), never
 * silently applied: the original defect was a `limit: 20` that vanished into a five-item answer.
 */
export const RECENT_INSTANCES_MAX = 20;

/** Why an instance is on the list. `active-run` entries are there because a run is open on them
 *  right now, whether or not this caller ever touched them over MCP (#192). */
type ListReason = "active-run" | "recent-touch";

/** The slice of `GET /v1/instances/my/activity` this tool reads: which instances are WORKING. */
interface ActivityRow {
	instanceId: string;
	health: string;
	lastOutcome?: { startedAt?: number; lastAliveAt?: number | null } | null;
}

export function registerRecentTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	// ── The whole account, in one call (#815) ─────────────────────────────────
	//
	// NOT `instance_activity` — that name is taken by the per-instance append-only LOG
	// (`observability.ts`), which is a different question about a different scope.
	//
	// `recent_instances` above answers "what was I working on" by FANNING OUT: the roster, then one
	// `/loop` per instance. That is why it is capped. `GET /my/activity` answers the same question
	// for EVERY instance in two queries, so this tool is the one to reach for when the question is
	// "is anything wrong anywhere" rather than "where was I".
	server.tool(
		"account_activity",
		"What every instance on this account is doing right now, in one call — `health` (`working` | `waiting` | `stalled` | `idle`), `queueDepth`, and the latest run's `lastOutcome`. Computed by the platform's own `runHealth`, so it agrees with the console and with coding_loop_status rather than being a second opinion. `stalled` is the one to act on: the run is open but has stopped ticking. `waiting` is a deliberate park and usually needs nothing. An instance with no run and no queued objective is OMITTED — absence means idle — so an empty list means the account is quiet, not that the call failed. Unlike recent_instances this does not fan out per instance and is not capped.",
		{ token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.") },
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "account_activity", {});
			if (denied) return denied;
			return jsonText(await authedCall("/v1/instances/my/activity", sessionToken, {}, env));
		},
	);

	server.tool(
		"recent_instances",
		`The instances THIS account is driving or drove most recently over MCP, each with its latest run's live verdict — the answer to "what was I working on?" for a fresh conversation that does not yet know an id. ORDER: every instance with a run open RIGHT NOW comes first (reason active-run), whether or not this caller ever touched it over MCP — a working instance is never dropped by the cap; then the instances this account issued tool calls against, newest first (reason recent-touch). An interaction is a tool call that named an instance_id (coding_loop_start, coding_loop_status, coding_session_message, call_instance_tool, chat_with_instance and the rest) or any call on a session pinned to /mcp/i/<instance_id>; an instance's OWN scheduled activity does not count as a touch, but its open run does count as active-run. SIZE: limit defaults to ${RECENT_INSTANCES_LIMIT} and is clamped to ${RECENT_INSTANCES_MAX} (the clamp is reported as requestedLimit); the response carries limit, total (instances that qualified before the cut), truncated (total > limit — when true, raise limit or call account_activity, which is uncapped) and working (how many are on the list because a run is open). Each entry: instanceId, name (the display name when one is set), slug, status (the SUBSCRIPTION's), reason, lastInteractionAt and lastTool (null for an active-run entry this caller never touched), and run — the most recent autonomous run as coding_loop_status reports it (runId, health, status, stopReason, waitingReason, waitingUntil, waitNote, objective preview) or null when the instance has never run one. ${runHealthSentence()} For a parked run quote waitNote rather than reading waitingUntil yourself: under waitingReason human that instant is when the run GIVES UP, not when it resumes. my_instances is the full roster.`,
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			limit: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe(`How many instances to return. Default ${RECENT_INSTANCES_LIMIT}, clamped to ${RECENT_INSTANCES_MAX}; the effective value is echoed as limit.`),
		},
		async ({ token, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "recent_instances", {});
			if (denied) return denied;

			const requestedLimit = limit ?? RECENT_INSTANCES_LIMIT;
			const effectiveLimit = Math.min(requestedLimit, RECENT_INSTANCES_MAX);

			// Two independent signals, read together (#192): what this caller TOUCHED (the recency
			// record, which a delegated or console-driven run never writes) and what is WORKING right
			// now (`/my/activity`, uncapped, the platform's own `runHealth`). The defect this closes
			// was reading only the first: a live coding run that the caller had not personally
			// touched over MCP sat outside the top five and vanished from a status report.
			const [touches, activity] = await Promise.all([
				listInstanceTouches(safetyFor(token)),
				authedCall("/v1/instances/my/activity", sessionToken, {}, env) as Promise<{ instances?: ActivityRow[]; error?: string }>,
			]);
			// A working instance sorts by real liveness, newest first; the activity route itself
			// orders by id for diff-stability, which is the wrong order for a "what is happening" list.
			const workingRows = (Array.isArray(activity.instances) ? activity.instances : [])
				.filter((a) => a && a.health === "working" && typeof a.instanceId === "string")
				.sort((a, b) => liveness(b) - liveness(a));

			if (touches.length === 0 && workingRows.length === 0) {
				return jsonText({
					instances: [],
					limit: effectiveLimit,
					total: 0,
					truncated: false,
					working: 0,
					hint: "No instance has been driven from MCP by this account yet (or not in the last 30 days), and none has a run open. The list fills as tools that take an instance_id are called; my_instances lists everything you own.",
				});
			}

			// The roster resolves stored ids/slugs. Paused instances remain valid MCP targets (#826).
			const roster = (await authedCall("/v1/instances/my/instances?includePaused=1", sessionToken, {}, env)) as {
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

			// The newest touch per resolved instance, so an active-run entry the caller DID touch
			// still carries its lastInteractionAt / lastTool.
			const touchByInstance = new Map<string, InstanceTouch>();
			for (const t of touches) {
				const inst = byRef.get(t.instance);
				if (inst && !touchByInstance.has(inst.id)) touchByInstance.set(inst.id, t);
			}

			const seen = new Set<string>();
			const candidates: Array<{ inst: InstanceSummary; touch: InstanceTouch | null; reason: ListReason }> = [];
			// 1. Working instances, ahead of everything — the cap must never cut one off.
			for (const row of workingRows) {
				const inst = byRef.get(row.instanceId);
				if (!inst || seen.has(inst.id)) continue;
				seen.add(inst.id);
				candidates.push({ inst, touch: touchByInstance.get(inst.id) ?? null, reason: "active-run" });
			}
			const working = candidates.length;
			// 2. Then the caller's own recency, newest first.
			for (const t of touches) {
				const inst = byRef.get(t.instance);
				if (!inst || seen.has(inst.id)) continue;
				seen.add(inst.id);
				candidates.push({ inst, touch: t, reason: "recent-touch" });
			}

			const total = candidates.length;
			const picked = candidates.slice(0, effectiveLimit);
			const truncated = total > effectiveLimit;

			const instances = await Promise.all(
				picked.map(async ({ inst, touch, reason }) => {
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
						reason,
						lastInteractionAt: touch?.at ?? null,
						lastTool: touch?.tool ?? null,
						run: latest ? summarizeRun(latest) : null,
						// Present only when the run lookup itself failed, so `run: null` is never read as
						// "has never run" on an instance the API refused to answer for.
						...(loop.error ? { runError: loop.error } : {}),
					};
				}),
			);
			return jsonText({
				instances,
				limit: effectiveLimit,
				...(requestedLimit !== effectiveLimit ? { requestedLimit } : {}),
				total,
				truncated,
				working,
				...(truncated
					? {
							hint: `${total - effectiveLimit} more instance(s) qualified; ${working > effectiveLimit ? `${working - effectiveLimit} of them have a run open right now — ` : ""}raise limit (max ${RECENT_INSTANCES_MAX}) or call account_activity, which is uncapped.`,
						}
					: {}),
			});
		},
	);
}

/** How recently a working instance showed life: `lastAliveAt`, else `startedAt`, else nothing. */
function liveness(row: ActivityRow): number {
	return row.lastOutcome?.lastAliveAt ?? row.lastOutcome?.startedAt ?? 0;
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
