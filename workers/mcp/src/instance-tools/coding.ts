import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import { type InstanceToolsCtx, findInstanceForAgent } from "./shared.js";

/** Coding tools — the surface-gated system_status plus the always-on Agent Loop tools. */
export function registerCodingTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor, groups } = ctx;
	// Coding-only: hits /coding/diagnostics, so gate it to coding-surface agents (the same
	// endpoint coding_diagnostics gates). Otherwise a Repo-Chat/apply-only user sees a
	// coding tool that can't apply to their agent — the exact leak the registry closes.
	if (groups.has("coding")) {
		server.tool(
			"system_status",
			"Full diagnostics for a coding instance: runner connectivity, node name, tmux sessions, repos, issues. Use this to understand why sessions are offline or to check the runner's machine.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				instance_id: z.string().describe("Instance ID or slug"),
			},
			async ({ token, instance_id }) => {
				const sessionToken = tokenFor(token);
				if (!sessionToken) return authRequired();
				const inst = await findInstanceForAgent(env, sessionToken, instance_id);
				const id = inst?.id || instance_id;
				const data = await authedCall(
					`/v1/instances/${id}/coding/diagnostics`,
					sessionToken,
					{},
					env,
				);
				return jsonText(data);
			},
		);
	}

	// ── Agent Loop tools ──
	//
	// These three drive the SERVER's durable loop (`POST /v1/instances/:id/loop` and the
	// `agent_loop_runs` row it creates) — the same runs `start_instance_loop` /
	// `check_instance_loop` / `stop_instance_loop` manage. They are not a separate mechanism.
	//
	// They used to be. `coding_loop_start` ran the entire loop INLINE in this Worker: a `/chat`
	// with the objective, then up to 49 more rounds of `/loop-decide` + `/chat`, all before the
	// tool returned. Neither of those endpoints touches the budget, so that was up to 50
	// unbudgeted BYOK Claude calls — no pool, no reservation, no account-ceiling check — on a
	// path that by definition has no human watching it (#502). #184 promised an admission check
	// at every autonomous entry point; this one never got it, and #374 had already closed the
	// identical escape for the browser Loop by routing it through `POST /loop`.
	//
	// Going through the durable path also buys, for free, everything the inline copy lacked: the
	// single-driver claim (#208) so two Loops cannot type into one engine, merge authority (#314),
	// a run row `stop_instance_loop`/`requestCancel` can actually act on, survival past this
	// request, and dispatch by the agent's DECLARED driver (#210) — so on a Coder this now drives
	// the Engine rather than talking to the chat about the repo.
	//
	// The return shape changed with it: start-and-poll, not a whole transcript. Holding an MCP
	// request open across 50 model calls was its own problem.

	server.tool(
		"coding_loop_start",
		"Give an agent an objective and let it work on it autonomously, on the server. Returns a run id immediately — poll it with coding_loop_status; the run keeps going after this call returns and after you disconnect. Durable and budgeted: its spend is drawn from a pool and stop_instance_loop / coding_loop_stop can end it. What it drives depends on the agent — a coding agent's engine, otherwise its chat. Same runs as start_instance_loop.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
			objective: z.string().describe("What the agent should accomplish"),
			max_iterations: z.number().int().min(1).max(50).optional().describe("Maximum loop iterations (default 10). The server clamps this to your account's loop ceiling."),
			dry_run: z.boolean().optional().describe("Report the run that would be started, and the spend it would commit, without starting it."),
		},
		async ({ token, instance_id, objective, max_iterations, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const maxIter = max_iterations ?? 10;
			// An autonomous run spends the instance's own model budget — runtime-scoped, gated by
			// MCP_READ_ONLY, and audited (was ungated).
			//
			// The gate runs BEFORE the instance is resolved (#328). Resolution is itself a
			// network call, so doing it first meant a caller the scope check was about to
			// refuse still made the server fetch on their behalf — and a dry run could not
			// honour its one promise of touching nothing.
			const denied = await requirePermission(safetyFor(token), "runtime", "coding_loop_start", { instance_id, max_iterations: maxIter });
			if (denied) return denied;
			if (dry_run) {
				// `max_iterations` is a spend commitment, and a model that defaults it to 50 has
				// no other way to find that out before the run starts.
				return dryRun(safetyFor(token), "coding_loop_start", "start an autonomous server-side run", { instance_id, max_iterations: maxIter }, {
					endpoint: `/v1/instances/${instance_id}/loop`,
					method: "POST",
					effect: `${instance_id} would work on this objective by itself, for up to ${maxIter} steps, and keep going after this call returns.`,
					objective,
					objectiveBytes: new TextEncoder().encode(objective).length,
					spend: `Each step spends the instance's own BYOK budget, drawn from a pool opened for the run. coding_loop_stop is the way to end it early.`,
					note: `instance_id is resolved against my_instances on the real call; this dry run does not resolve it, so a slug that does not exist still fails then.`,
				});
			}
			const id = await resolveId(sessionToken, instance_id);
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(id)}/loop`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ objective, maxIterations: maxIter }) },
				env,
			);
			// `authedCall` RETURNS a non-2xx as `{error}` rather than throwing, so reporting
			// without looking is how a refusal gets formatted as a started run.
			if ((data as { error?: string }).error) return jsonText(data);
			await audit(safetyFor(token), {
				tool: "coding_loop_start",
				action: "completed",
				input: { instance_id: id, objectiveBytes: new TextEncoder().encode(objective).length, maxIterations: maxIter },
				result: { runId: (data as { runId?: string }).runId ?? null, budgetId: (data as { budgetId?: string }).budgetId ?? null },
			});
			return jsonText(data);
		},
	);

	server.tool(
		"coding_loop_status",
		"Check an autonomous run on an instance: status, the step it is on, why it stopped, and the budget pool it draws from. Omit run_id to list the instance's recent runs. Reads the server's run record, so it is correct across reconnects and across clients.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
			run_id: z.string().optional().describe("A run id from coding_loop_start. Omit to list recent runs."),
		},
		async ({ token, instance_id, run_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "coding_loop_status", { instance_id, run_id });
			if (denied) return denied;
			const id = await resolveId(sessionToken, instance_id);
			const path = run_id
				? `/v1/instances/${encodeURIComponent(id)}/loop/${encodeURIComponent(run_id)}`
				: `/v1/instances/${encodeURIComponent(id)}/loop`;
			return jsonText(await authedCall(path, sessionToken, {}, env));
		},
	);

	// NO `dry_run`, for the same reason `stop_instance_loop` has none (#328): the answer is fully
	// determined by the run id, and the question worth asking first — "which run is that?" — is
	// answered better by `coding_loop_status`, a READ tool. Stopping is also the safe direction:
	// it is cooperative, the in-flight step settles its own spend, and a mistaken stop ends a run
	// early rather than committing anything.
	server.tool(
		"coding_loop_stop",
		"Ask an autonomous run on an instance to stop. Cooperative: the step in flight finishes and settles its spend. Omit run_id to stop the instance's most recent running run — call coding_loop_status first if you want to see which that is.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
			run_id: z.string().optional().describe("The run to stop. Omit to stop the most recent running one."),
		},
		async ({ token, instance_id, run_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "write", "coding_loop_stop", { instance_id, run_id });
			if (denied) return denied;
			const id = await resolveId(sessionToken, instance_id);

			let target = run_id;
			if (!target) {
				const listed = (await authedCall(`/v1/instances/${encodeURIComponent(id)}/loop`, sessionToken, {}, env)) as {
					runs?: Array<{ runId: string; status: string }>;
					error?: string;
				};
				if (listed.error) return jsonText(listed);
				// `listLoopRuns` orders by started_at DESC, so the first running row is the newest.
				target = listed.runs?.find((r) => r.status === "running")?.runId;
				if (!target) return text("No running loop on this instance.");
			}

			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(id)}/loop/${encodeURIComponent(target)}/cancel`,
				sessionToken,
				{ method: "POST" },
				env,
			);
			if ((data as { error?: string }).error) return jsonText(data);
			await audit(safetyFor(token), { tool: "coding_loop_stop", action: "completed", input: { instance_id: id, run_id: target }, result: { ok: true } });
			return jsonText({ ...(data as object), runId: target });
		},
	);

	/** Slug or id → the instance id the API routes expect. */
	async function resolveId(sessionToken: string, instanceId: string): Promise<string> {
		const inst = await findInstanceForAgent(env, sessionToken, instanceId);
		return inst?.id || instanceId;
	}
}
