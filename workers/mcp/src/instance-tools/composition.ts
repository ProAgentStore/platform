import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * How agents are wired to each other, and how one is given an objective.
 *
 * Two different couplings live here on purpose, so the difference stays visible:
 * SUPERVISION (#183) is one agent directing another and owning the result; CONNECTIONS
 * (#182, "the pump") are choreography — an agent announces a FACT and does not know who
 * consumes it. Loops are the third: an objective an instance works on by itself, durably.
 *
 * Every WIDENING tool here takes `dry_run` (#328). Their arguments are two or three opaque
 * instance ids and a direction, and the mistake a calling model actually makes is swapping
 * them: a supervision edge pointed the wrong way, or a fact routed from the consumer to the
 * producer. Without a preview the only way to find that out is to build the edge and watch
 * the wrong agent start receiving work. The envelope restates the wiring in a sentence, in
 * the direction it will really run.
 */
export function registerCompositionTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	// The supervision + pump tools existed only as HTTP routes, which meant assembling a
	// multi-agent system — the whole point of the supervision work — required curl or a SQL
	// migration. An agent platform whose composition step is not self-serve is not a platform.

	server.tool(
		"list_supervision",
		"List the agents a supervisor instance oversees (its direct reports). Supervision is how one agent delegates goals to others.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			supervisor_instance_id: z.string(),
		},
		async ({ token, supervisor_instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_supervision", { supervisor_instance_id });
			if (denied) return denied;
			return jsonText(await authedCall(`/v1/instances/${encodeURIComponent(supervisor_instance_id)}/supervision`, sessionToken, {}, env));
		},
	);

	server.tool(
		"create_supervision",
		"Put one agent in charge of another: the supervisor may then delegate goals to the subordinate. Rejected if the SUPERVISOR's agent declares no supervision tool (it could never delegate, so the link would be dead on arrival — check with list_instance_tools), if it would create a supervision loop, if it would exceed the depth or fan-out limits, or if it would give the subordinate a second supervisor. The subordinate needs nothing declared: being delegated to is not a capability.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			supervisor_instance_id: z.string().describe("The instance that will delegate."),
			subordinate_instance_id: z.string().describe("The instance that will receive goals."),
			dry_run: z.boolean().optional().describe("Describe the edge that would be created, in the direction it would run, without creating it."),
		},
		async ({ token, supervisor_instance_id, subordinate_instance_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { supervisor_instance_id, subordinate_instance_id };
			const denied = await requirePermission(safetyFor(token), "write", "create_supervision", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "create_supervision", "put one agent in charge of another", input, {
					endpoint: `/v1/instances/${supervisor_instance_id}/supervision`,
					method: "POST",
					effect: `${supervisor_instance_id} would be able to delegate goals to ${subordinate_instance_id} and would own the results. The reverse would NOT be true.`,
					// Said out loud because it is the limit of the preview: the interesting
					// rejections are graph properties the API evaluates against the live edge
					// set, which this worker cannot see without making the call.
					note: "The API still rejects the real call if it would close a supervision loop, exceed the depth or fan-out limit, or give the subordinate a second supervisor. A clean dry run is not a promise that it will be accepted.",
				});
			}
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(supervisor_instance_id)}/supervision`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ subordinateInstanceId: subordinate_instance_id }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "create_supervision", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	// Confirmed and previewable since #328. It was the only `destructive` tool in the whole
	// surface that took neither, which mattered more here than the asymmetry suggests: cutting
	// a supervision edge produces NO error anywhere afterwards. `delegate_goal` re-checks
	// membership against the resolved id, so the supervisor does not fail loudly — the
	// subordinate just stops being reachable, and the operator experiences it as the Lead
	// having "forgotten" a repo. A confirmation makes the deletion deliberate; the dry run
	// (which, per the house order, comes BEFORE the confirmation) is how you check you have
	// the right link id without having to type the confirmation to find out.
	server.tool(
		"delete_supervision",
		"Remove a supervision link so the supervisor can no longer delegate to that agent. Destructive and silent: afterwards the supervisor does not error, the subordinate simply becomes unreachable to it. Dry-run it first to check the link id, then pass confirm.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			supervisor_instance_id: z.string(),
			supervision_id: z.string().describe("Link id from list_supervision."),
			confirm: z.string().optional().describe('Must be "delete_supervision" to remove the link.'),
			dry_run: z.boolean().optional().describe("Describe the link that would be cut, without cutting it. Does not require confirm."),
		},
		async ({ token, supervisor_instance_id, supervision_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { supervisor_instance_id, supervision_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_supervision", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_supervision", "remove a supervision link", input, {
					endpoint: `/v1/instances/${supervisor_instance_id}/supervision/${supervision_id}`,
					method: "DELETE",
					effect: `${supervisor_instance_id} would lose the ability to delegate goals to the agent on link ${supervision_id}. Check that id against list_supervision — this tool cannot tell you which subordinate it names.`,
					afterwards: "No error is raised anywhere. delegate_goal re-checks membership on the resolved id, so the supervisor silently stops reaching that subordinate rather than failing.",
					reversible: "Only by create_supervision, which mints a NEW link id — this one does not come back.",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_supervision", confirm, "delete_supervision", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(supervisor_instance_id)}/supervision/${encodeURIComponent(supervision_id)}`,
				sessionToken,
				{ method: "DELETE" },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "delete_supervision", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	server.tool(
		"list_connections",
		"List the agent-to-agent event connections leaving an instance — how a fact it emits (e.g. lead.created) is routed to another agent.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_connections", { instance_id });
			if (denied) return denied;
			return jsonText(await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/connections`, sessionToken, {}, env));
		},
	);

	server.tool(
		"create_connection",
		"Route an event one agent emits to another agent — the 'pump'. Choreography, not supervision: the source announces a FACT and does not know who consumes it. Use supervision instead when one agent must direct another and own the result.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Source instance — the one that emits the event."),
			event_type: z.string().describe("The emitted fact, e.g. lead.created or site.live."),
			target_instance_id: z.string().describe("Instance that receives the payload."),
			action: z.string().describe("What the target does: run_pipeline | insert_record | create_task | add_knowledge."),
			config: z.record(z.unknown()).optional().describe("Action config (pipeline name, collection, filter, params)."),
			dry_run: z.boolean().optional().describe("Describe the route that would be created, in the direction it would run, without creating it."),
		},
		async ({ token, instance_id, event_type, target_instance_id, action, config, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, event_type, target_instance_id, action };
			const denied = await requirePermission(safetyFor(token), "write", "create_connection", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "create_connection", "route an emitted fact to another agent", input, {
					endpoint: `/v1/instances/${instance_id}/connections`,
					method: "POST",
					effect: `Every ${event_type} emitted by ${instance_id} would be delivered to ${target_instance_id}, which would run ${action}. Nothing flows the other way.`,
					config: config ?? {},
					// A connection is not a one-off call, which is exactly what makes the
					// preview worth having: the cost of getting it wrong is paid on every
					// future emit, by an agent nobody is watching.
					note: "This changes what happens on EVERY future emit, not just the next one. Delivery is at-least-once and retried, so a wrongly aimed route keeps firing until it is removed.",
				});
			}
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/connections`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ eventType: event_type, targetInstanceId: target_instance_id, action, config: config ?? {} }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "create_connection", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	server.tool(
		"start_instance_loop",
		"Give an agent an objective and let it work autonomously on the server. Durable: it survives you closing the browser, and its spend is bounded by a budget. Returns a run id — poll it with check_instance_loop.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			objective: z.string().describe("The outcome you want, in plain language."),
			max_iterations: z.number().optional().describe("Cap on steps (default 10, max 50)."),
			dry_run: z.boolean().optional().describe("Report the objective and the step cap that would be committed, without starting the run."),
		},
		async ({ token, instance_id, objective, max_iterations, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, objective, max_iterations };
			const denied = await requirePermission(safetyFor(token), "write", "start_instance_loop", input);
			if (denied) return denied;
			if (dry_run) {
				// The one tool here that spends money on its own afterwards, so the preview
				// is about the BUDGET as much as the wiring: a caller that meant 5 steps and
				// sent 50 has no other way to notice before the spend happens.
				return dryRun(safetyFor(token), "start_instance_loop", "start an autonomous server-side run", input, {
					endpoint: `/v1/instances/${instance_id}/loop`,
					method: "POST",
					effect: `${instance_id} would work on this objective by itself, for up to ${max_iterations ?? 10} steps (server default 10, hard cap 50).`,
					objective,
					spend: "Each step spends the instance's own AI budget. The run is durable — it keeps going after you disconnect, and stop_instance_loop is the only way to end it early.",
				});
			}
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/loop`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ objective, maxIterations: max_iterations }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "start_instance_loop", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	server.tool(
		"check_instance_loop",
		"Check an autonomous run: status, how many steps it has taken, and why it stopped. Omit run_id to list recent runs for the instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			run_id: z.string().optional(),
		},
		async ({ token, instance_id, run_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "check_instance_loop", { instance_id, run_id });
			if (denied) return denied;
			const path = run_id
				? `/v1/instances/${encodeURIComponent(instance_id)}/loop/${encodeURIComponent(run_id)}`
				: `/v1/instances/${encodeURIComponent(instance_id)}/loop`;
			return jsonText(await authedCall(path, sessionToken, {}, env));
		},
	);

	// NO `dry_run`, on purpose (#328). A dry run answers "what would this call do?", and for a
	// stop the answer is fully determined by `run_id` — there are no other arguments and no
	// config to get wrong. The question worth asking first is "which run is that?", and that
	// is `check_instance_loop`, a READ tool that answers it with the objective, the step count
	// and the stop reason. A dry run here could only echo the id back with less information
	// than the read tool already gives, while implying the preview was the safety step.
	// It is also the one direction that is safe to be wrong in: stopping is cooperative, the
	// in-flight step settles its own spend, and the failure mode of a mistaken stop is a run
	// that ends early — not an edge pointed the wrong way or a budget quietly committed.
	server.tool(
		"stop_instance_loop",
		"Ask an autonomous run to stop. Cooperative: the step in flight finishes and settles its spend rather than being killed mid-way. No dry run — call check_instance_loop first to see which run you are about to stop.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			run_id: z.string(),
		},
		async ({ token, instance_id, run_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "write", "stop_instance_loop", { instance_id, run_id });
			if (denied) return denied;
			return jsonText(await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/loop/${encodeURIComponent(run_id)}/cancel`,
				sessionToken,
				{ method: "POST" },
				env,
			));
		},
	);
}
