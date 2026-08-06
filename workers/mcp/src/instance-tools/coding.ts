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

	// Track active loops per instance (in-memory, lives for the MCP DO lifespan)
	const activeLoops = new Map<string, { objective: string; iteration: number; maxIterations: number; running: boolean }>();

	server.tool(
		"coding_loop_start",
		"Start an autonomous agent loop on an instance. Sends the objective as the first message, then iteratively asks the loop-decide endpoint to continue, stop, or escalate. Runs the WHOLE loop before returning — dry-run it first to see how many model calls that is.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
			objective: z.string().describe("What the agent should accomplish"),
			max_iterations: z.number().int().min(1).max(50).optional().describe("Maximum loop iterations (default 10)"),
			dry_run: z.boolean().optional().describe("Report the calls and the model spend the loop would commit, without starting it."),
		},
		async ({ token, instance_id, objective, max_iterations, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const maxIter = max_iterations ?? 10;
			// An autonomous loop drives chat + engine for up to 50 iterations —
			// runtime-scoped, gated by MCP_READ_ONLY, and audited (was ungated).
			//
			// The gate runs BEFORE the instance is resolved (#328). Resolution is itself a
			// network call, so doing it first meant a caller the scope check was about to
			// refuse still made the server fetch on their behalf — and a dry run could not
			// honour its one promise of touching nothing.
			const denied = await requirePermission(safetyFor(token), "runtime", "coding_loop_start", { instance_id, max_iterations: maxIter });
			if (denied) return denied;
			if (dry_run) {
				// This loop is unusual and the preview is mostly about that: it is not a
				// request to start something, it runs every iteration inline and returns the
				// whole transcript. `max_iterations` is therefore a spend commitment made at
				// call time, and a model that defaults it to 50 has no other way to find out.
				return dryRun(safetyFor(token), "coding_loop_start", "run an autonomous agent loop", { instance_id, max_iterations: maxIter }, {
					first: `POST /v1/instances/${instance_id}/chat with the objective, verbatim`,
					thenPerIteration: [`POST /v1/instances/${instance_id}/loop-decide`, `POST /v1/instances/${instance_id}/chat with the instruction it returns`],
					iterations: `up to ${maxIter - 1} after the first message (max_iterations ${maxIter})`,
					spend: `Up to ${maxIter} agent turns and ${maxIter - 1} loop-decide calls, all on the instance's own BYOK model, all before this tool returns.`,
					objectiveBytes: new TextEncoder().encode(objective).length,
					note: `instance_id is resolved against my_instances on the real call; this dry run does not resolve it, so a slug that does not exist still fails then.`,
				});
			}
			const inst = await findInstanceForAgent(env, sessionToken, instance_id);
			const id = inst?.id || instance_id;
			await audit(safetyFor(token), { tool: "coding_loop_start", action: "completed", input: { instance_id: id, objectiveBytes: new TextEncoder().encode(objective).length, maxIterations: maxIter } });

			// Send the objective as the first message
			const chatRes = (await authedCall(
				`/v1/instances/${id}/chat`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ message: objective }) },
				env,
			)) as { message?: { content: string }; error?: string };
			if (chatRes.error) return text(`Error starting loop: ${chatRes.error}`);

			const state = { objective, iteration: 1, maxIterations: maxIter, running: true };
			activeLoops.set(id, state);

			// Run the loop.
			//
			// The transcript has to ADVANCE. It used to be built from `chatRes` — the iteration-0
			// reply — on every pass, so `/loop-decide` was asked the identical question each time,
			// with only `iteration` incremented. It therefore returned the same `continue` and the
			// same nextInstruction deterministically: duplicate instructions re-sent to the agent,
			// no way to ever observe that the objective was met, and all N iterations of BYOK
			// Claude spend burned. `nextRes` — the actual reply to each new instruction — was used
			// only for the human-readable string.
			const turns: Array<{ role: "user" | "assistant"; content: string }> = [
				{ role: "user", content: objective },
				{ role: "assistant", content: chatRes.message?.content || "" },
			];
			const results: string[] = [`Iteration 0: sent objective\nAgent: ${chatRes.message?.content?.slice(0, 200) || "(no response)"}`];

			while (state.running && state.iteration < state.maxIterations) {
				const decision = (await authedCall(
					`/v1/instances/${id}/loop-decide`,
					sessionToken,
					{
						method: "POST",
						body: JSON.stringify({
							objective: state.objective,
							messages: turns,
							iteration: state.iteration,
							maxIterations: state.maxIterations,
						}),
					},
					env,
				)) as { decision: string; nextInstruction?: string; reason?: string };

				if (decision.decision === "done") {
					results.push(`Done: ${decision.reason || "Objective met."}`);
					state.running = false;
					break;
				}
				if (decision.decision !== "continue" || !decision.nextInstruction) {
					results.push(`${decision.decision}: ${decision.reason || "Stopped."}`);
					state.running = false;
					break;
				}

				// Send the next instruction
				const nextRes = (await authedCall(
					`/v1/instances/${id}/chat`,
					sessionToken,
					{ method: "POST", body: JSON.stringify({ message: decision.nextInstruction }) },
					env,
				)) as { message?: { content: string }; error?: string };

				// Feed BOTH sides of this turn back in, or the next decision is made blind.
				turns.push({ role: "user", content: decision.nextInstruction });
				turns.push({ role: "assistant", content: nextRes.message?.content || nextRes.error || "" });
				results.push(`Iteration ${state.iteration}: ${decision.nextInstruction.slice(0, 100)}\nAgent: ${nextRes.message?.content?.slice(0, 200) || nextRes.error || "(no response)"}`);
				state.iteration++;
			}

			activeLoops.delete(id);
			return text(results.join("\n\n---\n\n"));
		},
	);

	server.tool(
		"coding_loop_status",
		"Check the status of a running agent loop on an instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const inst = await findInstanceForAgent(env, sessionToken, instance_id);
			const id = inst?.id || instance_id;
			const state = activeLoops.get(id);
			if (!state) return text("No active loop for this instance.");
			return jsonText({ running: state.running, objective: state.objective, iteration: state.iteration, maxIterations: state.maxIterations });
		},
	);

	server.tool(
		"coding_loop_stop",
		"Stop a running agent loop on an instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const inst = await findInstanceForAgent(env, sessionToken, instance_id);
			const id = inst?.id || instance_id;
			const state = activeLoops.get(id);
			if (!state) return text("No active loop to stop.");
			state.running = false;
			activeLoops.delete(id);
			return text(`Loop stopped at iteration ${state.iteration}/${state.maxIterations}.`);
		},
	);

}
