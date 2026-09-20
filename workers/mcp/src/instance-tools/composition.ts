import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import { runHealthSentence } from "../state-vocabulary.js";
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

	// PAUSING AN EDGE, AND WHY IT TAKES NO `dry_run` (#667).
	//
	// `agent_supervision.enabled` (#664) and `agent_connections.enabled` (#644) each got a writer
	// and a `PATCH …/{id} {enabled}` route, and neither got a tool — so the only way an agent or a
	// console user could stop an edge was to DELETE it. Deleting is not a pause: it throws away the
	// subordinate's standing DIRECTION (#330) and the edge's budget defaults, or a connection's
	// routing filter and target pipeline, and it orphans the outbox rows that explain what is
	// stuck. Standing an agent down while it is reconfigured is an ordinary operation; making it
	// cost the owner's epic is not.
	//
	// No `dry_run`, on the same reasoning `stop_instance_loop` records. A dry run answers "what
	// would this call do?", and here the answer is fully determined by one id and one boolean —
	// there is no config to get wrong and no direction to swap. The question worth asking first is
	// "which edge is that?", and `list_supervision` / `list_connections` answer it with both ends
	// named. A preview could only echo the id back with less information than the read tool
	// already gives, while implying it was the safety step.
	//
	// `write`, not `destructive`, and that is the point of the ticket rather than a laxity: this
	// tool is the REVERSIBLE form of the delete beside it. Resuming is the same call with
	// `enabled: true`, and nothing about the edge is lost in between. It is also why the listings
	// are deliberately not filtered on `enabled` — an edge hidden while paused is an edge that
	// cannot be resumed.
	server.tool(
		"set_supervision_enabled",
		"Pause or resume a supervision link without deleting it. While paused the supervisor cannot delegate to that agent and the subordinate escalates past it, but the link keeps its label, its budget defaults and the owner's standing direction — all of which a delete destroys. Reversible: call again with enabled=true. Get the link id from list_supervision, which lists paused links too.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			supervisor_instance_id: z.string(),
			supervision_id: z.string().describe("Link id from list_supervision."),
			enabled: z.boolean().describe("false pauses the link, true resumes it. Strictly a boolean — the API rejects \"false\" and 0 rather than coercing them, since coercion on the one field whose job is to stop work would do the opposite of what was asked."),
		},
		async ({ token, supervisor_instance_id, supervision_id, enabled }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { supervisor_instance_id, supervision_id, enabled };
			const denied = await requirePermission(safetyFor(token), "write", "set_supervision_enabled", input);
			if (denied) return denied;
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(supervisor_instance_id)}/supervision/${encodeURIComponent(supervision_id)}`,
				sessionToken,
				{ method: "PATCH", body: JSON.stringify({ enabled }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_supervision_enabled", action: "completed", input, result: { ok: true } });
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

	/** The connection half of `set_supervision_enabled` above — same column, same route shape,
	 *  same reasoning about `dry_run` and about `write` rather than `destructive`. */
	server.tool(
		"set_connection_enabled",
		"Pause or resume an event connection without deleting it. While paused the source's events are counted and logged as connection.paused rather than delivered, and the edge keeps its routing filter, its target pipeline and its delivery history — all of which a delete destroys, orphaning the outbox rows that say what is stuck. Reversible: call again with enabled=true. Get the connection id from list_connections, which lists paused connections too.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Source instance — the one that emits the event."),
			connection_id: z.string().describe("Connection id from list_connections."),
			enabled: z.boolean().describe("false pauses the connection, true resumes it. Strictly a boolean — the API rejects \"false\" and 0 rather than coercing them, since coercion on the one field whose job is to stop deliveries would do the opposite of what was asked."),
		},
		async ({ token, instance_id, connection_id, enabled }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, connection_id, enabled };
			const denied = await requirePermission(safetyFor(token), "write", "set_connection_enabled", input);
			if (denied) return denied;
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/connections/${encodeURIComponent(connection_id)}`,
				sessionToken,
				{ method: "PATCH", body: JSON.stringify({ enabled }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_connection_enabled", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	// ── The pump's failure path (#613) ────────────────────────────────────────
	//
	// The three tools above wire an edge and pause it. What was missing is everything that
	// happens when a delivery does NOT arrive: the outbox that records it, the replay that
	// re-arms it, and the delete that ends the edge for good. A chain fails invisibly without
	// them — the emitting agent looks fine, the consuming agent simply never ran, and nothing
	// over MCP could say why.

	server.tool(
		"list_connection_deliveries",
		"The pump's delivery log: what each connection actually delivered, what is queued for retry, and what died after exhausting its attempts. Read this FIRST when a chain looks broken — a producer that looks healthy and a consumer that never ran leave their only trace here. ACCOUNT-WIDE, not per-connection, because \"what is stuck anywhere\" is the real question; `instance_id` only says which agent you are asking as. Rows carry `source` and `sourceInstanceId` because the outbox is shared with triggers, so a stuck trigger and a stuck connection are told apart by those two fields and not by the id. `lastError` is why it failed; `nextAttemptAt` is when it will try again; `traceId` joins it to the emitting run.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Any instance you own — the listing is account-wide."),
			status: z.enum(["pending", "delivered", "dead"]).optional().describe("Narrow to one state. `dead` is the one worth acting on: attempts exhausted, and it will not retry itself."),
			limit: z.coerce.number().int().min(1).max(200).optional().describe("How many rows, 1-200. Omit for 50."),
		},
		async ({ token, instance_id, status, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const query = [status ? `status=${encodeURIComponent(status)}` : "", limit ? `limit=${limit}` : ""].filter(Boolean).join("&");
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/connections/deliveries${query ? `?${query}` : ""}`,
				sessionToken,
				{},
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"replay_connection_delivery",
		"Re-arm ONE dead delivery so the pump tries it again — the escape hatch for \"the dependency is back up now\". Only a delivery whose attempts are exhausted can be replayed; anything else answers 404, so this cannot be used to re-send a delivery that already succeeded. The retry runs the consumer's work for real, which is why it is gated as runtime rather than as a write: idempotency is keyed on (connection, emitting run, payload), so a replay of the SAME event will not duplicate work the consumer already did, but work it never did will now happen.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Any instance you own — deliveries are account-scoped."),
			delivery_id: z.string().describe("Delivery id from list_connection_deliveries. Copy it exactly."),
			dry_run: z.boolean().optional().describe("Preview without re-arming it."),
		},
		async ({ token, instance_id, delivery_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, delivery_id };
			const denied = await requirePermission(safetyFor(token), "runtime", "replay_connection_delivery", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "replay_connection_delivery", "re-arm a dead delivery so the consumer runs", input, {
					endpoint: `/v1/instances/${instance_id}/connections/deliveries/${delivery_id}/replay`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/connections/deliveries/${encodeURIComponent(delivery_id)}/replay`,
				sessionToken,
				{ method: "POST" },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "replay_connection_delivery", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"delete_connection",
		"Delete an event connection for good. This destroys the edge's routing filter and its target pipeline, and orphans the outbox rows that record what was stuck on it — so if the intent is only to STOP deliveries, use set_connection_enabled, which keeps all three and is reversible. Deleting is the right call when the edge itself was a mistake.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Source instance — the one that emits the event."),
			connection_id: z.string().describe("Connection id from list_connections."),
			confirm: z.string().optional().describe('Exact confirmation string required for a real deletion: "delete_connection". Omit on dry_run.'),
			dry_run: z.boolean().optional().describe("Preview without deleting the connection."),
		},
		async ({ token, instance_id, connection_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, connection_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_connection", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_connection", "delete an event connection, with its filter and delivery history", input, {
					endpoint: `/v1/instances/${instance_id}/connections/${connection_id}`,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_connection", confirm, "delete_connection", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/connections/${encodeURIComponent(connection_id)}`,
				sessionToken,
				{ method: "DELETE" },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "delete_connection", action: "completed", input, result: data });
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
			max_iterations: z.coerce.number().optional().describe("Cap on steps (default 10, max 50)."),
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
		"continue_instance_run",
		"Carry a STOPPED run's objective onto a fresh run, briefed on what the stopped one already landed. Only for a run that ended WITHOUT a verdict — `interrupted`, `max_iterations`, `engine_limit`, `provider_credit`; anything else is refused, naming what to do instead. It reuses the stopped run's repository and step cap (pass `max_iterations` to grant more), opens its own budget, and reaches further back for its predecessor than an ordinary start, so continuing the next morning still works. Read a run first with check_instance_loop.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			run_id: z.string().describe("The stopped run to continue, from check_instance_loop."),
			max_iterations: z.coerce.number().optional().describe("Steps the new run may take. Omit to reuse the stopped run's own cap (max 50)."),
			dry_run: z.boolean().optional().describe("Report the run that would be started, without starting it."),
		},
		async ({ token, instance_id, run_id, max_iterations, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, run_id, max_iterations };
			const denied = await requirePermission(safetyFor(token), "write", "continue_instance_run", input);
			if (denied) return denied;
			if (dry_run) {
				// Same reasoning as `start_instance_loop`'s preview, and one fact more: a continue
				// SPENDS AGAIN. A caller that thought it was resuming a paid-for run rather than
				// starting another one has no other way to find out before the money goes.
				return dryRun(safetyFor(token), "continue_instance_run", "start a fresh run on a stopped run's objective", input, {
					endpoint: `/v1/instances/${instance_id}/loop/${run_id}/continue`,
					method: "POST",
					effect: `${instance_id} would start a NEW run on ${run_id}'s objective${max_iterations === undefined ? ", with that run's own step cap" : `, for up to ${max_iterations} steps`}. The stopped run is not reanimated.`,
					spend: "A new budget is opened — the stopped run's is not inherited. Each step spends the instance's own AI budget.",
				});
			}
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/loop/${encodeURIComponent(run_id)}/continue`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ maxIterations: max_iterations }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "continue_instance_run", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	server.tool(
		"preview_instance_run_continue",
		"What continuing a STOPPED run would actually carry forward, before spending anything on it (#806). Answers with `briefing.kind`: `this-run` (the new run is told what THIS run landed), `other-run` (a more recent stopped run on the same repo is the predecessor, so the briefing is that one's), or `none` (nothing carries forward — a later run reached a verdict, or nothing landed and the tree is clean — so continuing is a restart on the bare objective with a fresh budget). Also gives the exact `briefing.note` the new run would be handed, the landed actions, how many files sit uncommitted, and the step ceiling the continue would grant. `briefing.uncommittedFiles` is null when the runner is offline: that is 'we could not look', never 'the tree is clean'. A run that CANNOT be continued still answers 200, with `canContinue:false` and `refusal` naming what to do instead. Read this before continue_instance_run.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			run_id: z.string().describe("The stopped run to preview, from check_instance_loop."),
		},
		async ({ token, instance_id, run_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// Read, and no `dry_run`: it starts nothing and spends nothing, so a preview OF a
			// preview would be ceremony. That is also why it is not a flag on
			// `continue_instance_run` — a dry run there answers "would this be refused and how big
			// would it be", which is a different question from "what would the new run KNOW".
			const denied = await requirePermission(safetyFor(token), "read", "preview_instance_run_continue", { instance_id, run_id });
			if (denied) return denied;
			return jsonText(
				await authedCall(
					`/v1/instances/${encodeURIComponent(instance_id)}/loop/${encodeURIComponent(run_id)}/continue-preview`,
					sessionToken,
					{},
					env,
				),
			);
		},
	);

	// ── Loop presets (#613) ─────────────────────────────────────────────────────
	//
	// The objectives an owner curated for the loop form (#234). Without these, a caller starting a
	// loop over MCP could not see them and retyped an objective the owner had already written down.
	server.tool(
		"get_instance_loop_presets",
		"Read the saved objectives an instance offers when a loop starts — each `{id, label, objective}`. `source` says whose list it is: `instance` (the owner saved their own), `agent` (inherited from the agent's creator) or `default` (built-in; coding agents get five, chat agents none). `driver` is what this instance's loop drives. To run one, pass its `objective` to start_instance_loop.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_instance_loop_presets", { instance_id });
			if (denied) return denied;
			return jsonText(await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/loop-presets`, sessionToken, {}, env));
		},
	);

	server.tool(
		"set_instance_loop_presets",
		`Save an instance's own loop presets. REPLACES the whole list — nothing is merged — so to add one, read get_instance_loop_presets and send the full list back. An EMPTY list removes the instance's own list, and the instance goes back to inheriting the agent's or the built-in presets. At most ${MAX_LOOP_PRESETS} presets; each needs a non-blank \`label\` (max ${MAX_PRESET_LABEL} chars) and \`objective\` (max ${MAX_PRESET_OBJECTIVE} chars). A list outside those limits is refused here, whole, rather than silently trimmed by the server. \`id\` is optional and is stored as a lowercase slug (derived from the label when omitted). Returns the saved list with its \`source\`.`,
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			presets: z
				.array(
					z.object({
						id: z.string().optional().describe("Stable slug. Omit to derive it from the label."),
						label: z.string().describe("The button text."),
						objective: z.string().describe("The objective a loop is started with."),
					}),
				)
				.describe("The complete list, in display order. [] clears the instance's own list."),
			dry_run: z.boolean().optional().describe("Report the list that would be saved, without saving it."),
		},
		async ({ token, instance_id, presets, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, count: presets.length };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_loop_presets", input);
			if (denied) return denied;
			const problems = loopPresetProblems(presets);
			if (problems.length) return text(`Error: nothing saved — ${problems.join("; ")}.`);
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/loop-presets`;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_loop_presets", "replace an instance's loop presets", input, {
					endpoint,
					method: "PUT",
					effect: presets.length
						? `${instance_id}'s own list would become these ${presets.length} preset(s), replacing whatever it offers now.`
						: `${instance_id}'s own list would be removed; it would inherit the agent's or the built-in presets.`,
					labels: presets.map((p) => p.label),
				});
			}
			const data = await authedCall(endpoint, sessionToken, { method: "PUT", body: JSON.stringify({ presets }) }, env);
			if (!(data as { error?: string }).error) {
				await audit(safetyFor(token), { tool: "set_instance_loop_presets", action: "completed", input, result: { source: (data as { source?: string }).source } });
			}
			return jsonText(data);
		},
	);

	// ── Loop limits (#820) ──────────────────────────────────────────────────────
	//
	// The owner's standing answer to "how long may a run on this agent be". It exists because the
	// per-call number was chronically too low: runs on the Coder instance were started at
	// `start_instance_loop`'s default of 10 over and over and died at `max_iterations` 10/10 with
	// the work on track (#815, #813, #613, #806). A calling model is one of the callers that keeps
	// getting it wrong, which is exactly why it must not be the one deciding.
	server.tool(
		"get_instance_loop_limits",
		"Read the iteration floor and ceiling configured on an instance — the bounds the platform applies to EVERY run it starts, whatever `max_iterations` the caller passes. `limits.minIterations` clamps a request up, `limits.maxIterations` clamps it down; either may be absent, and `{}` means none are configured (a run then gets whatever the caller asked for, defaulting to 10). `accountCeiling` is the account-wide maximum these sit under and can only narrow — read it before judging a floor, since 30 means one thing under a ceiling of 50 and nothing under a ceiling of 20.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_instance_loop_limits", { instance_id });
			if (denied) return denied;
			return jsonText(await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/loop-limits`, sessionToken, {}, env));
		},
	);

	server.tool(
		"set_instance_loop_limits",
		`Set the iteration floor and ceiling for an instance's runs. A run started below \`min_iterations\` is silently raised to it — including a run that named no number at all — and one above \`max_iterations\` is lowered. This is a property of the INSTANCE, not of the call: it binds runs started from the console, from chat, from the objective queue, from a continue, and from another agent's delegation alike. Each bound is a whole number from 1 to ${MAX_CONFIGURABLE_ITERATIONS}; send neither to clear the configuration. The account-wide ceiling still wins — these can only narrow it, never widen it, so a floor above it is stored but capped at run time. Returns the stored bounds plus that ceiling.`,
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			min_iterations: z
				.number()
				.int()
				.min(1)
				.max(MAX_CONFIGURABLE_ITERATIONS)
				.optional()
				.describe("Clamp every run UP to at least this. Omit to leave no floor."),
			max_iterations: z
				.number()
				.int()
				.min(1)
				.max(MAX_CONFIGURABLE_ITERATIONS)
				.optional()
				.describe("Clamp every run DOWN to at most this. Omit to leave the account ceiling alone in charge."),
			dry_run: z.boolean().optional().describe("Report the bounds that would be saved, without saving them."),
		},
		async ({ token, instance_id, min_iterations, max_iterations, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, min_iterations, max_iterations };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_loop_limits", input);
			if (denied) return denied;
			// Refused here rather than repaired by the route. The route is total on purpose — it also
			// parses a stored blob, where throwing would take the instance's Loop button down — so it
			// normalises an inverted pair by lowering the floor and answers 200. A calling model would
			// read that success as "saved what I sent". It did not.
			if (min_iterations !== undefined && max_iterations !== undefined && min_iterations > max_iterations) {
				return text(
					`Error: nothing saved — min_iterations (${min_iterations}) is above max_iterations (${max_iterations}), so no run could satisfy both.`,
				);
			}
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/loop-limits`;
			const body = JSON.stringify({ minIterations: min_iterations, maxIterations: max_iterations });
			const describe =
				min_iterations === undefined && max_iterations === undefined
					? `${instance_id} would go back to having no iteration bounds; a run would get whatever the caller asks for, defaulting to 10.`
					: `Every run on ${instance_id} would be clamped into ${min_iterations ?? 1}–${max_iterations ?? "the account ceiling"} iterations, whatever the caller passes.`;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_loop_limits", "set an instance's iteration bounds", input, {
					endpoint,
					method: "PUT",
					effect: describe,
				});
			}
			const data = await authedCall(endpoint, sessionToken, { method: "PUT", body }, env);
			if (!(data as { error?: string }).error) {
				await audit(safetyFor(token), { tool: "set_instance_loop_limits", action: "completed", input, result: { limits: (data as { limits?: unknown }).limits } });
			}
			return jsonText(data);
		},
	);

	// WHAT THIS TOOL DOES NOT SPEAK FOR (#580 AC3).
	//
	// `status:"running"` hid three states, and until migration 0127 the record could not tell them
	// apart. Measured 2026-08-15: run `70ea298e` reported `running` with a `lastProgressAt` 3.5
	// minutes old for 4.35 HOURS, on iteration 1 of 30, while its engine had been dead since one
	// second after it started — because the pause tick refreshed that column on a timer.
	//
	// `fd1c323` split the fact into three that cannot contradict each other: `lastAliveAt`
	// (the orchestrator's heartbeat), `lastProgressAt` (an actual advance, now written only when
	// the iteration moves), and `waitingReason`/`waitingUntil` (a deliberate park). The route now
	// also sends `health` and `waitNote`, computed by `runHealth`/`waitClause` — the platform's own
	// verdict, so this surface quotes it rather than deriving a second one. Two surfaces answering
	// "is this alright" independently is the defect #580 documents, not the cure.
	//
	// WHAT THE DESCRIPTION MUST STILL NOT SAY. `health` reads LIVENESS. A fresh heartbeat with a
	// stale progress timestamp is ALSO what a healthy long engine turn and a legitimate park look
	// like, so "liveness fresh + progress stale ⇒ stalled" is an inference this surface must not
	// re-introduce — `work-report.ts:136-141` records a model making exactly it and telling the
	// owner there was "nothing I can do" while the engine was mid-edit. Progress is reported as a
	// fact; it is never a diagnosis.
	//
	// And none of the four speaks for the ENGINE. `work-report.ts:146` is the reference — "What it
	// deliberately does NOT claim: that the ENGINE is working … Asserting 'engine: working' from
	// this column would replace a false stall with a false all-clear." The engine's own state is
	// `runState`, behind `/capture`, which is a different tool and is named below.
	//
	// The DESCRIPTION rather than a joined `runState` field, deliberately: this tool is generic and
	// serves apply, pipeline and chat agents, none of which have an engine, so fetching one would
	// make every caller pay a runner round trip for a field null for most of them.
	//
	// THE VERDICT VOCABULARY IS RENDERED, NOT TYPED (#588). This sentence used to be written out
	// here and said "three values" — and stayed saying it when `RunHealth` gained `ended`, so a
	// listing with no status filter answered `health:"ended"` about most of its rows in a word its
	// own description did not define. `runHealthSentence()` builds it from the vocabulary, which
	// `state-vocabulary.test.ts` derives from `work-report.ts`'s `RunHealth` union: a member added
	// there fails this build. Do not retype the members back into this string — the test asserts
	// the rendered sentence is present verbatim, in both tools that publish it.
	//
	// A PARK'S DEADLINE IS NOT ONE KIND OF THING (#596). `waitingUntil` is the instant a park's
	// clock RUNS OUT, and what running out means is read off `waitingReason`: an `engine_limit` park
	// resumes at it, a `human` handoff GIVES UP at it — the run stops waiting for the reader who is
	// looking at the number. This description once promised the note said "what for and until when",
	// which was true of one producer and stayed coherent only because the other published nothing at
	// all. Do not re-derive a resume time from `waitingUntil` here or in a caller: `waitNote` carries
	// the verb, and the verb is the half that decides whether anyone has to move. The gloss this
	// tool publishes comes from `state-vocabulary.ts`'s `RUN_HEALTH_GLOSS`, which mirrors
	// `work-report.ts`'s `RUN_HEALTH_LEGEND`; those two are the only place to change the wording.
	server.tool(
		"check_instance_loop",
		`Check an autonomous run: status, how many steps it has taken, and why it stopped. Omit run_id to list recent runs for the instance — most of them will be CLOSED, because this listing has no status filter. Read \`health\` first. ${runHealthSentence()} Do not derive your own from the timestamps: \`lastAliveAt\` is the orchestrator's heartbeat and \`lastProgressAt\` is the last actual advance, and a fresh heartbeat beside a stale advance is equally what a long engine turn, a park and a stall look like — that inference has told an owner a run was stuck while the engine was mid-edit. None of these fields speaks for the ENGINE, whatever they say; for that use coding_timeline (its \`run_state\`, plus the events since your last poll) or coding_session_capture.`,
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

/**
 * A COPY of the limits in `workers/api/src/lib/loop-presets.ts` — this worker cannot import the API
 * worker. `loop-presets.test.ts` reads that file's source and fails when the two disagree.
 *
 * The route's `sanitizeLoopPresets` enforces them by DROPPING an entry with a blank label or
 * objective, truncating an over-long one and cutting the list at the cap, and answers 200 either
 * way. Its caller is the console editor, which never sends such a list. A calling model does, and
 * would read a success for a list that is not the one it sent — so this tool refuses it instead.
 */
/**
 * A COPY of `MAX_CONFIGURABLE_ITERATIONS` in `workers/api/src/lib/loop-limits.ts`, duplicated for
 * the same reason as the preset limits above: this worker cannot import the API worker.
 */
export const MAX_CONFIGURABLE_ITERATIONS = 1_000;

export const MAX_LOOP_PRESETS = 12;
export const MAX_PRESET_LABEL = 60;
export const MAX_PRESET_OBJECTIVE = 1000;

/** Every way `presets` would be altered by the route, in words; empty when it would be saved as sent. */
export function loopPresetProblems(presets: ReadonlyArray<{ label: string; objective: string }>): string[] {
	const problems: string[] = [];
	if (presets.length > MAX_LOOP_PRESETS) problems.push(`${presets.length} presets sent, at most ${MAX_LOOP_PRESETS} are kept`);
	presets.forEach((p, i) => {
		const n = `preset ${i + 1}`;
		const label = p.label.trim();
		const objective = p.objective.trim();
		if (!label) problems.push(`${n} has a blank label`);
		else if (label.length > MAX_PRESET_LABEL) problems.push(`${n}'s label is ${label.length} chars (max ${MAX_PRESET_LABEL})`);
		if (!objective) problems.push(`${n} has a blank objective`);
		else if (objective.length > MAX_PRESET_OBJECTIVE) problems.push(`${n}'s objective is ${objective.length} chars (max ${MAX_PRESET_OBJECTIVE})`);
	});
	return problems;
}
