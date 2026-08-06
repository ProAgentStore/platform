// The supervision connector — how a SUPERVISOR agent's brain drives its subordinates (#156/#159).
//
// This is the piece that makes a supervisor declarable. Everything else needed for a
// "Coder 2" existed: the graph is data (#183), delegation is enforced (#159), the loop is durable
// (#158), spend is bounded (#184). But an agent's brain can only act through TOOLS, and there was
// no delegation tool — so a declared supervisor could be wired up perfectly and still be unable
// to do the one thing that makes it a supervisor.
//
// The hardcoded Coder solved this with `drive_claude`, a bespoke tool defined inline in
// routes/coding.ts, hand-rolled into one route's LLM call, reaching a repo. These are the same
// idea with the Coder-specific parts removed: the target is an instance from the configured
// graph, and they surface through the ordinary registry — so they appear in the agent runtime,
// `/v1/instances/:id/tools` and MCP without any of them being taught about supervision.
//
// auth:"none" — supervision is internal to the platform and to ONE owner (both instances are
// theirs). There is no external system and so no credential; what governs it is the graph, and
// `delegate_goal` re-checks that on every call rather than trusting the caller.

import { delegateToInstance } from "../delegate-instance.js";
import { getLoopRun } from "../agent-loop-store.js";
import { loadGraph } from "../supervision.js";
import { subordinatesOf } from "../supervision-graph.js";
import { agentCapabilities, sanitizeBoardColumns, type BoardColumn } from "../agent-capabilities.js";
import { actsInWindow, recentActsForInstances, recentRunsForInstances, recentWorkForInstances, type ActItem } from "../instance-work.js";
import { summarizeSubordinates } from "../subordinate-observation.js";
import { runtimeConnectivityMany, type RuntimeFacts } from "../instance-connectivity.js";
import { classifySubordinateConnectivity } from "../subordinate-connectivity.js";
import { repoStateForInstances, type RepoStateReport } from "../repo-state.js";
import type { ToolDef } from "../tool-registry.js";

/** Names of the instances a supervisor may drive, with their display names for the model. */
interface SubordinateRow {
	instanceId: string;
	name: string;
	/** `active | paused | canceled` — the SUBSCRIPTION lifecycle, not work state. */
	subscription: string;
	/** Resolved per-instance override → agent declaration → per-surface default. */
	columns: BoardColumn[];
	/** `capabilities.runtime != null` — does its work need a machine running `pags up`? */
	requiresRunner: boolean;
}

async function subordinateSummaries(
	ctx: { env: { DB: D1Database }; userId?: string; instanceId?: string },
	only?: string,
): Promise<SubordinateRow[]> {
	const userId = ctx.userId ?? "";
	const supervisorId = ctx.instanceId ?? "";
	if (!userId || !supervisorId) return [];
	let ids = subordinatesOf(await loadGraph(ctx.env as never, userId), supervisorId);
	// A named instance is INTERSECTED with the graph, never trusted — same posture as
	// delegate_goal, which re-checks membership inside delegateToInstance rather than relying on
	// the tool description to discourage a model from naming someone else's agent.
	if (only) ids = ids.filter((id) => id === only);
	if (!ids.length) return [];
	const placeholders = ids.map((_, i) => `?${i + 2}`).join(",");
	// `agent_instances` has NO name column — a per-instance display name lives in
	// config.displayName (set by PUT /:id/name), and everything else falls back to the template's
	// name. Selecting i.name is a D1 error, not an empty result, so it takes the whole tool down.
	const res = await ctx.env.DB.prepare(
		`SELECT i.id AS id, i.status AS status, i.config AS config, a.name AS agent_name,
		        a.slug AS slug, a.category AS category, a.config AS agent_config
		   FROM agent_instances i LEFT JOIN agents a ON a.id = i.agent_id
		  WHERE i.user_id = ?1 AND i.id IN (${placeholders})`,
	)
		.bind(userId, ...ids)
		.all<{ id: string; status: string; config: string | null; agent_name: string | null; slug: string | null; category: string | null; agent_config: string | null }>();
	return (res.results ?? []).map((r) => {
		let displayName: string | null = null;
		try {
			const cfg = JSON.parse(r.config ?? "{}") as { displayName?: unknown };
			if (typeof cfg.displayName === "string" && cfg.displayName.trim()) displayName = cfg.displayName.trim();
		} catch {
			// A malformed config must not hide the subordinate — fall back to the template name.
		}
		// The subordinate's OWN status vocabulary, resolved the same way boardConfigForInstance
		// does: per-instance override → agent declaration → per-surface default. This is what lets
		// a supervisor interpret a free-text status without holding any vocabulary of its own.
		let override: BoardColumn[] | undefined;
		try {
			override = sanitizeBoardColumns((JSON.parse(r.config ?? "{}") as { boardColumns?: unknown }).boardColumns);
		} catch {
			/* malformed config — fall through to the agent's declared columns */
		}
		const caps = agentCapabilities({ slug: r.slug ?? undefined, category: r.category ?? undefined, config: r.agent_config ?? undefined });
		return {
			instanceId: r.id,
			name: displayName ?? r.agent_name ?? r.id,
			subscription: r.status,
			columns: override ?? caps.boardColumns,
			// Read from the capability registry rather than guessed from the slug — a declarative
			// agent that needs no local hands must not be reported as "runner offline" (#259).
			requiresRunner: caps.runtime != null,
		};
	});
}

/**
 * The supervisor's global picture. Shared by `subordinate_status` and by `check_delegation`'s
 * no-run-id branch, so the answer does not depend on which tool the model happens to reach for.
 */
async function observeSubordinates(
	ctx: { env: never; userId?: string; instanceId?: string },
	only?: string,
	limit?: number,
): Promise<{ content: string; success: boolean }> {
	const subs = await subordinateSummaries(ctx as never, only);
	if (!subs.length) {
		return {
			content: only ? "You do not supervise that agent. Call list_subordinates to see who you may address." : NO_SUBORDINATES,
			success: true,
		};
	}
	const userId = ctx.userId ?? "";
	const ids = subs.map((s) => s.instanceId);
	// Two statements for the work picture, regardless of fan-out — see instance-work.ts. The
	// connectivity read is a third plus one relay probe per subordinate (see MAX_RELAY_PROBES).
	const [work, runs, facts, acts] = await Promise.all([
		recentWorkForInstances(ctx.env, userId, ids, limit).catch(() => []),
		recentRunsForInstances(ctx.env, userId, ids).catch(() => []),
		runtimeConnectivityMany(ctx.env as never, userId, ids).catch(() => new Map<string, RuntimeFacts>()),
		// What each subordinate has actually DONE (#294). One more indexed read, on the same
		// per-instance UNION-ALL shape as work/runs — not a fan-out.
		//
		// MAX_ACTS_PER_SUBORDINATE, not the reader's default: acts are attached AFTER
		// `summarizeSubordinates` has trimmed to MAX_OBSERVATION_CHARS, so they are outside that
		// budget and a runaway loop force-pushing in circles would otherwise push tens of kilobytes
		// of command text into every prompt this supervisor builds. Small because acts are RARE by
		// construction — an ordinary run produces none — so this only bites the pathological case,
		// and in that case the newest few already say what is happening.
		recentActsForInstances(ctx.env, userId, ids, MAX_ACTS_PER_SUBORDINATE).catch(() => [] as ActItem[]),
	]);
	const view = summarizeSubordinates({ now: Date.now(), subordinates: subs, work, runs });
	// Connectivity is attached HERE rather than inside `summarizeSubordinates` because it is a
	// live probe, and that function is pure by design (it is the testable-without-a-DB half).
	const connectivityById = new Map(
		view.subordinates.map((s) => {
			const src = subs.find((x) => x.instanceId === s.instanceId);
			const f = facts.get(s.instanceId);
			return [
				s.instanceId,
				classifySubordinateConnectivity({
					requiresRunner: src?.requiresRunner ?? false,
					hasRuntimeRow: f?.hasRuntimeRow ?? false,
					relayConnected: f?.relayConnected ?? false,
					node: f?.node,
					runnerVersion: f?.runnerVersion,
					lastSeenAt: f?.lastSeenAt,
				}),
			] as const;
		}),
	);
	// Repo state (#276) — branch + working tree for the repo a delegated goal would run in.
	// Probed only where a runner is actually reachable: the read goes over the same relay, so
	// asking an unreachable subordinate buys a guaranteed timeout for a guaranteed null.
	const repoStates = await repoStateForInstances(
		ctx.env as never,
		userId,
		ids.filter((id) => connectivityById.get(id)?.canWork && connectivityById.get(id)?.requiresRunner),
	).catch(() => new Map<string, RepoStateReport>());
	// Grouped here rather than in `summarizeSubordinates` to keep that function pure over the two
	// records it was built for; the shape is already per-instance so grouping is a one-liner.
	const actsById = new Map<string, ActItem[]>();
	for (const a of acts) {
		const list = actsById.get(a.instanceId) ?? [];
		list.push({ ...a });
		actsById.set(a.instanceId, list);
	}
	const withConnectivity = view.subordinates.map((s) => {
		const repo = repoStates.get(s.instanceId);
		const theActs = actsById.get(s.instanceId) ?? [];
		return {
			...s,
			connectivity: connectivityById.get(s.instanceId),
			// Absent when unknown (no repo, no runner, an older runner) — never a fabricated
			// "clean on main", which a supervisor would act on.
			...(repo ? { repo } : {}),
			// Omitted rather than sent as `[]`. An empty array reads as "it did nothing
			// consequential", and this record cannot support that claim: only a stream-json engine
			// reports acts, so absence means "not observed".
			...(theActs.length
				? { acts: theActs.map(({ instanceId: _i, ...rest }) => rest) }
				: {}),
		};
	});
	return {
		content: JSON.stringify(
			{
				asOf: new Date().toISOString(),
				// Stated in the payload, not only in the tool description, because the description
				// is far away by the time the model reads this JSON — and the failure it prevents
				// is precisely a model reasoning from an empty board to "no runner" (#259).
				legend:
					"`connectivity.canWork` is the ONLY field that says whether an agent can be given work now. Empty `work`/`runs` means IDLE — which is normal and ready, not offline. " +
					"`repo` is the CURRENT state of the checkout a goal would run in — the branch it is parked on and any uncommitted work a previous run left. It is context, not a gate: a run starts from wherever the repo was left, and nothing resets or discards it. Relay `repo.note` to the human when it is present, and never instruct an agent to clear a working tree you did not put there. " +
					"`acts` is what an agent actually DID — a pull request opened or merged, a push, a force-push, a delete, a deploy — with the literal command as evidence. Anything with `irreversible: true` changed something that cannot simply be undone, so REPORT IT to the human unprompted: an outcome of 'done' says only that the agent believes it finished, never what it changed on the way. " +
					"An act with `ok: false` FAILED and one with `ok: null` was not observed to succeed — neither is a completed action and neither may be described as one. " +
					"ABSENT `acts` means NOT OBSERVED, never 'it did nothing': only some engines report acts at all. Never read a missing `acts` as an all-clear or tell the human the agent changed nothing.",
				...view,
				subordinates: withConnectivity,
			},
			null,
			2,
		),
		success: true,
	};
}

/**
 * Consequential acts reported per subordinate in one status call (#294).
 *
 * A PROMPT BUDGET, like `MAX_REPO_PROBES` is a latency budget. Acts are attached after
 * `summarizeSubordinates` has already trimmed work to `MAX_OBSERVATION_CHARS`, so nothing else
 * bounds them — and each carries up to 400 characters of command text.
 */
export const MAX_ACTS_PER_SUBORDINATE = 5;

const NO_SUBORDINATES = "You do not supervise any agents yet. Add a supervision link in Settings first.";

export const SUPERVISION_TOOLS: ToolDef[] = [
	{
		name: "list_subordinates",
		tier: "connector",
		connector: "supervision",
		scope: "read",
		description:
			"The roster of agents this one supervises — instance id, name, and SUBSCRIPTION state (active/paused), which is NOT what they are doing. Use subordinate_status to see what each is working on. You may only delegate to agents that appear here.",
		jsonSchema: { type: "object", properties: {} },
		handler: async (ctx) => {
			const subs = await subordinateSummaries(ctx as never);
			if (!subs.length) return { content: NO_SUBORDINATES, success: true };
			// Roster only — the columns are an implementation detail of subordinate_status.
			const roster = subs.map((s) => ({ instanceId: s.instanceId, name: s.name, subscription: s.subscription }));
			return { content: JSON.stringify(roster, null, 2), success: true };
		},
	},
	{
		name: "subordinate_status",
		tier: "connector",
		connector: "supervision",
		scope: "read",
		description:
			"What every agent you supervise is doing RIGHT NOW, in one call: what each is working on, " +
			"what finished, what is waiting on a human, and how long anything has been quiet. Call this " +
			"FIRST whenever you are asked about status, progress, or what is happening, and answer from " +
			"it — never start a run just to find out. Each item's `status` is that agent's own word for " +
			"it; `columnTitle` is what THAT agent says the word means. " +
			"`connectivity` is a SEPARATE question from busyness: `connectivity.canWork` says whether " +
			"an agent is reachable and can be given work now. An agent with no work in flight is IDLE " +
			"— that is the normal ready state, NOT a reason to refuse. Never infer reachability from " +
			"empty work, empty runs, or finished sessions; `connectivity` is the only field that says it. " +
			"`repo` says what state that agent's checkout is actually in — which branch it is parked on " +
			"and whether earlier work left uncommitted changes. Read it before handing over a goal and " +
			"pass `repo.note` on to the human when it is present: a new goal runs on whatever branch is " +
			"checked out, and nothing resets or discards a working tree. " +
				"`acts` is what each agent actually DID — pull requests opened and MERGED, pushes, force-pushes, " +
				"deletes, deploys — with the literal command as evidence. Read it whenever you report on a " +
				"subordinate, and volunteer anything marked `irreversible` without being asked: a finished run " +
				"says it met its objective, never what it changed to get there.",
		jsonSchema: {
			type: "object",
			properties: {
				instanceId: { type: "string", description: "Only this subordinate. Omit for all of them." },
				limit: { type: "number", description: "Recent items per agent (1-25, default 8)." },
			},
		},
		handler: async (ctx, input) => {
			const only = typeof input.instanceId === "string" && input.instanceId.trim() ? input.instanceId.trim() : undefined;
			const limit = typeof input.limit === "number" ? input.limit : undefined;
			return observeSubordinates(ctx as never, only, limit);
		},
	},
	{
		name: "delegate_goal",
		tier: "connector",
		connector: "supervision",
		// WRITE: it starts real work on another agent and spends real money, so it sits behind
		// the per-instance write-consent gate (#90) like every other write tool.
		scope: "write",
		description:
			"Hand a GOAL to an agent you supervise. It runs autonomously with its own tools and knowledge and reports back — you do not micro-manage it. Give an outcome ('get the test suite green'), not a single command. Returns a run id you can check with check_delegation. " +
			"It does NOT need an open coding session or a session you prepared — a coding subordinate starts its own. The only thing that blocks delegation is a subordinate whose `connectivity.canWork` is false; a cloud-only agent needs no runner at all. Do not ask the user to set anything up before trying.",
		jsonSchema: {
			type: "object",
			properties: {
				instanceId: { type: "string", description: "The subordinate's instance id, from list_subordinates." },
				objective: { type: "string", description: "The outcome you want, in plain language." },
				maxIterations: { type: "number", description: "Optional cap on how many steps it may take." },
			},
			required: ["instanceId", "objective"],
		},
		handler: async (ctx, input) => {
			// The graph is re-checked inside delegateToInstance — a model naming an instance it
			// does not supervise is refused there, not merely discouraged by the description.
			const res = await delegateToInstance(ctx.env as never, {
				userId: ctx.userId ?? "",
				supervisorInstanceId: ctx.instanceId ?? "",
				subordinateInstanceId: String(input.instanceId ?? ""),
				objective: String(input.objective ?? ""),
				maxIterations: typeof input.maxIterations === "number" ? input.maxIterations : undefined,
				// Correlate the child run with whatever run asked for it, so a multi-level
				// delegation renders as one tree.
				parentTraceId: ctx.traceId ?? null,
				// Share the TREE's pool. Omitting this made `delegateToInstance` open a fresh
				// budget per hop, so the real ceiling was allowance × edges — the per-tree bound
				// was inert on the only path an agent can actually delegate through.
				budgetId: ctx.budgetId ?? undefined,
			});
			if (!res.ok) return { content: res.error, success: false };
			return {
				content: `Delegated. Run ${res.runId} started at depth ${res.depth}. Check it with check_delegation.`,
				success: true,
			};
		},
	},
	{
		name: "check_delegation",
		tier: "connector",
		connector: "supervision",
		scope: "read",
		description:
			"Check ONE delegated run by id: its status, how many steps it has taken, why it stopped, and `acts` — the consequential things it DID along the way (a pull request opened or MERGED, a push, a force-push, a delete, a deploy). Report anything marked `irreversible` to the human: \"completed\" describes the objective, never what the run changed. With no run id this falls through to the same picture subordinate_status gives — so for \"what is happening across my agents\", prefer subordinate_status directly.",
		jsonSchema: {
			type: "object",
			properties: {
				runId: { type: "string", description: "A run id from delegate_goal. Omit to list recent runs." },
				instanceId: { type: "string", description: "Subordinate to list runs for, when omitting runId." },
			},
		},
		handler: async (ctx, input) => {
			const userId = ctx.userId ?? "";
			const runId = String(input.runId ?? "").trim();
			if (runId) {
				const run = await getLoopRun(ctx.env as never, userId, runId);
				if (!run) return { content: `No delegated run with id ${runId}.`, success: false };
				// What the run DID, not only how it ended (#294). Read over the run's own window —
				// see `actsInWindow` for why the trace id is not the key. A finished run reports
				// `detail: "objective completed"`; that is the whole gap this closes.
				const acts = await actsInWindow(
					ctx.env as never,
					userId,
					run.instanceId,
					run.startedAt,
					run.finishedAt ?? Date.now(),
				).catch(() => [] as ActItem[]);
				return {
					content: JSON.stringify(
						{
							...run,
							// Present only when something was observed — an empty array would read as
							// "this run changed nothing", which no engine can currently attest to.
							...(acts.length ? { acts: acts.map(({ instanceId: _i, ...rest }) => rest) } : {}),
							...(acts.length
								? {
										actsLegend:
											"What this run actually did. `irreversible: true` cannot simply be undone — say so when you report the run. `ok:false` failed and `ok:null` was not observed to succeed; neither is a completed action.",
									}
								: {}),
						},
						null,
						2,
					),
					success: true,
				};
			}
			// No run id → the caller is asking "what is going on", not "how is run X". Answer with
			// the SAME view subordinate_status returns rather than a bare list of loop rows.
			//
			// Not politeness — measured. Given both tools, the Lead reached for this one three
			// times in a row and never called subordinate_status, because it is the tool it has
			// always used and its own description advertises the listing branch. A new tool name
			// has to be DISCOVERED; the one already in the model's habit does not. Making both
			// paths return the good answer is robust to which one it picks.
			const only = String(input.instanceId ?? "").trim() || undefined;
			return observeSubordinates(ctx as never, only);
		},
	},
];
