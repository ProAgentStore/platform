import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import { getRegistryTool, registryTools, runRegistryTool, type JsonSchema } from "../lib/tool-registry.js";
import { DISABLED_TOOLS_KEY, explainRefusal, instanceToolPolicy, readDisabledTools } from "../lib/instance-tool-policy.js";
import { patchInstanceConfig } from "../lib/instance-config.js";
import { listConsents, revokeConsent, setConsent } from "../lib/connector-consent.js";
import { getConnector } from "../lib/connectors/registry.js";
import { startPipelineRun } from "../lib/pipeline-run-start.js";
import { validatePipeline, type PipelineDef } from "../lib/pipeline.js";
import { listRuns } from "../lib/pipeline-runs.js";
import { listConnections, createConnection, deleteConnection } from "../lib/connections.js";
import { listDeliveries, replayDelivery } from "../lib/connection-deliveries.js";
import { listSupervision, createSupervision, deleteSupervision } from "../lib/supervision.js";
import { createLoopRun, getLoopRun, listLoopRuns, requestCancel } from "../lib/agent-loop-store.js";
import { loopDriverFor } from "../lib/loop-drivers.js";
import { readLoopPresets, writeLoopPresets } from "../lib/loop-presets-store.js";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { sanitizeMaxIterations } from "../lib/agent-loop.js";
import { openBudget } from "../lib/delegation-budget-store.js";
import { delegateToInstance } from "../lib/delegate-instance.js";
import type { TriggerAction } from "../lib/triggers.js";
import type { Env } from "../types.js";

/**
 * Minimal draft-07 object-schema validator — required-fields + basic JSON types only,
 * deliberately dependency-free (the repo has no ajv). Returns an error string on the
 * first violation, or null when the input satisfies the schema. Unknown/extra keys are
 * allowed (schemas here don't set additionalProperties); properties without a matching
 * schema entry are skipped, matching the tools' permissive handlers.
 */
function validateAgainstSchema(schema: JsonSchema, input: Record<string, unknown>): string | null {
	for (const req of schema.required ?? []) {
		if (input[req] === undefined || input[req] === null) return `Missing required field: ${req}`;
	}
	for (const [key, spec] of Object.entries(schema.properties)) {
		const val = input[key];
		if (val === undefined || val === null) continue; // absent optional (or absent required already caught)
		if (!matchesType(val, spec.type)) return `Field "${key}" must be a ${spec.type}`;
	}
	return null;
}

function matchesType(val: unknown, type: string): boolean {
	switch (type) {
		case "string":
			return typeof val === "string";
		case "number":
		case "integer":
			return typeof val === "number" && Number.isFinite(val) && (type === "number" || Number.isInteger(val));
		case "boolean":
			return typeof val === "boolean";
		case "array":
			return Array.isArray(val);
		case "object":
			return typeof val === "object" && !Array.isArray(val);
		default:
			return true; // unknown type spec → don't block
	}
}

/**
 * Generic connector/registry tool surface (issue #87). The SAME tools the agent
 * runtime dispatches (agent-think → runRegistryTool) are callable directly here and,
 * via a thin MCP proxy, over MCP — so a connector tool is defined once and usable
 * everywhere. Owner-scoped; tools run with the owner's own connector auth.
 */
export const toolRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /v1/instances/:id/tools — EVERY registry tool with this instance's verdict on it.
 *
 * Returns the full list rather than only the runnable ones: "what can this agent do" is
 * only answerable if the answer also says what it can't and why. Each entry carries
 * `allowed` (the gate's decision), `disabled` (owner switched it off) and `reason`.
 * `?allowed=true` narrows to the runnable set for callers that want just that.
 */
toolRoutes.get("/:id/tools", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const policy = await instanceToolPolicy(c.env, instance.id, session.uid, instance.config);
	const onlyAllowed = c.req.query("allowed") === "true";
	return c.json({ tools: onlyAllowed ? policy.filter((t) => t.allowed) : policy });
});

/**
 * PUT /v1/instances/:id/tools/:name — the owner's per-tool off-switch (`{enabled:boolean}`).
 *
 * The subscriber's veto over their own copy, independent of what the creator declared: a
 * creator can only ever GRANT capability, so without this the owner has no way to take one
 * away short of unsubscribing. Switching a tool off removes it from the chat runtime AND
 * refuses it on this route, because a control that only covers one surface isn't control.
 * Undeclared tools are rejected rather than stored, so the list can't fill with names this
 * agent could never run anyway.
 */
toolRoutes.put("/:id/tools/:name", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const name = c.req.param("name");
	if (!getRegistryTool(name)) throw new HttpError(404, `Unknown tool: ${name}`);
	const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
	if (typeof body.enabled !== "boolean") throw new HttpError(400, "`enabled` must be true or false.");

	const policy = await instanceToolPolicy(c.env, instance.id, session.uid, instance.config);
	const entry = policy.find((t) => t.name === name);
	if (!entry || entry.reason === "not_declared") {
		throw new HttpError(403, explainRefusal(name, "not_declared"));
	}

	const disabled = new Set(readDisabledTools(instance.config));
	if (body.enabled) disabled.delete(name);
	else disabled.add(name);
	// Patch only this key (#231). Rewriting the whole blob here would drop a Settings or
	// behaviour change saved from another tab between our read and our write — and the toggle
	// is exactly the kind of thing done while other settings are open.
	await patchInstanceConfig(c.env, instance.id, session.uid, DISABLED_TOOLS_KEY, [...disabled]);
	return c.json({ name, enabled: body.enabled, disabledTools: [...disabled] });
});

/** POST /v1/instances/:id/tools/:name — invoke a connector tool (body = its input args). */
toolRoutes.post("/:id/tools/:name", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	const instance = await requireOwnedInstance(c.env, instanceId, session.uid);
	const name = c.req.param("name");
	const tool = getRegistryTool(name);
	if (!tool) throw new HttpError(404, `Unknown tool: ${name}`);
	// The capability gate. Owning the instance is NOT authority to run anything on it —
	// without this, `capabilities.tools` bounded only the chat, and a read-only agent's
	// instance could still be driven to any tool in the registry from here or via MCP.
	const policy = await instanceToolPolicy(c.env, instanceId, session.uid, instance.config);
	const entry = policy.find((t) => t.name === name);
	if (!entry?.allowed) {
		throw new HttpError(403, explainRefusal(name, entry?.reason ?? "not_declared"));
	}
	const input = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const invalid = validateAgainstSchema(tool.jsonSchema, input);
	if (invalid) throw new HttpError(400, invalid);
	const result = await runRegistryTool(name, { env: c.env, userId: session.uid, instanceId }, input);
	return c.json(result);
});

/**
 * GET /v1/instances/:id/pipelines — declarative pipelines (#97) configured on this
 * instance. Definitions live in the instance's `config.pipelines` (data, not code).
 */
toolRoutes.get("/:id/pipelines", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	let cfg: Record<string, unknown> = {};
	try {
		cfg = JSON.parse(instance.config || "{}") as Record<string, unknown>;
	} catch {
		/* malformed config → no pipelines */
	}
	const pipelines = (cfg.pipelines && typeof cfg.pipelines === "object" ? cfg.pipelines : {}) as Record<string, PipelineDef>;
	const list = Object.entries(pipelines).map(([name, def]) => ({
		name,
		steps: Array.isArray(def?.steps) ? def.steps.length : 0,
		sink: def?.sink?.collection,
		valid: validatePipeline(def) === null,
	}));
	return c.json({ pipelines: list });
});

/**
 * POST /v1/instances/:id/pipelines/:name/run { params } — start a durable pipeline run
 * (#97). Owner-scoped (requireOwnedInstance) + audited (startPipelineRun logs
 * pipeline.requested with the caller's uid). Kicks the PipelineRunWorkflow and returns the
 * run + workflow ids; results land in the trace/collection, not inline.
 */
toolRoutes.post("/:id/pipelines/:name/run", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const name = c.req.param("name");
	const body = (await c.req.json().catch(() => ({}))) as { params?: Record<string, unknown> };
	const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};
	const started = await startPipelineRun(c.env, instanceId, session.uid, name, params, "api");
	if (!started.ok) throw new HttpError(404, started.error);
	return c.json({ ok: true, runId: started.runId, workflowId: started.workflowId });
});

/**
 * PUT /v1/instances/:id/pipelines/:name — ATTACH (or replace) a declarative pipeline on
 * this instance. Definitions live in `config.pipelines[name]` (data, not code) and are the
 * only thing `run_pipeline`/…/run read — but nothing could set them per-instance, so a
 * runner-less agent could never be made runnable. Owner-authenticated; the body IS the
 * PipelineDef, rejected with 400 if `validatePipeline` fails.
 */
toolRoutes.put("/:id/pipelines/:name", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	const instance = await requireOwnedInstance(c.env, instanceId, session.uid);
	const name = c.req.param("name");
	const def = await c.req.json().catch(() => null);
	const err = validatePipeline(def);
	if (err !== null) throw new HttpError(400, `Invalid pipeline: ${typeof err === "string" ? err : JSON.stringify(err)}`);
	let cfg: Record<string, unknown> = {};
	try {
		cfg = JSON.parse(instance.config || "{}") as Record<string, unknown>;
	} catch {
		cfg = {};
	}
	const pipelines = (cfg.pipelines && typeof cfg.pipelines === "object" ? cfg.pipelines : {}) as Record<string, unknown>;
	pipelines[name] = def;
	cfg.pipelines = pipelines;
	const serialized = JSON.stringify(cfg);
	if (serialized.length > 256_000) throw new HttpError(413, "Instance config too large");
	await c.env.DB.prepare("UPDATE agent_instances SET config = ?1, updated_at = datetime('now') WHERE id = ?2 AND user_id = ?3")
		.bind(serialized, instanceId, session.uid)
		.run();
	return c.json({ ok: true, name });
});

/**
 * GET /v1/instances/:id/pipeline-runs — run observability (#98). Lists this instance's
 * pipeline runs (most recent first) with counts + status, owner-scoped. `pipeline` narrows
 * to one pipeline's history; `limit` caps rows. Per-record audit rides on each record's
 * `audit` field in the sink collection (read via the collections/records routes).
 */
toolRoutes.get("/:id/pipeline-runs", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runs = await listRuns(c.env, {
		userId: session.uid,
		instanceId,
		pipeline: c.req.query("pipeline") || undefined,
		limit: Number(c.req.query("limit")) || 50,
	});
	return c.json({ runs });
});

/**
 * Agent-to-agent connections (the "pump", lib/connections.ts). Scoped to the SOURCE instance
 * (:id). A connection routes this instance's emitted events (e.g. "lead.created") into another
 * of the caller's instances by running a trigger action — so one agent feeds another without
 * sharing storage. Owner-scoped; createConnection verifies the caller owns BOTH instances.
 */
toolRoutes.get("/:id/connections", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return c.json({ connections: await listConnections(c.env, session.uid, { sourceInstanceId: instanceId }) });
});

toolRoutes.post("/:id/connections", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as {
		eventType?: string;
		targetInstanceId?: string;
		action?: string;
		config?: Record<string, unknown>;
	};
	const res = await createConnection(c.env, session.uid, {
		sourceInstanceId: instanceId,
		eventType: String(body.eventType ?? ""),
		targetInstanceId: String(body.targetInstanceId ?? ""),
		action: body.action as TriggerAction,
		config: body.config,
	});
	if (!res.ok) throw new HttpError(res.status as 400, res.error);
	return c.json(res.connection, 201);
});

/**
 * The pump's delivery log (migration 0058) — what each connection actually delivered, what is
 * queued for retry, and what died. Without this a chain fails invisibly: the emitting agent
 * looks fine, the consuming agent simply never ran, and nothing says why. Owner-scoped, and
 * account-wide rather than per-connection because "what is stuck anywhere" is the question
 * you actually have. Filter with ?status=pending|delivered|dead.
 */
toolRoutes.get("/:id/connections/deliveries", async (c) => {
	const session = await requireUser(c);
	await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const status = c.req.query("status");
	const limit = Number(c.req.query("limit") ?? 50);
	const rows = await listDeliveries(c.env, session.uid, { status: status || undefined, limit });
	return c.json({
		deliveries: rows.map((r) => ({
			id: r.id,
			connectionId: r.connection_id,
			// The outbox is SHARED with triggers (#17), and this listing is account-wide — so
			// without these two a row is unreadable: you cannot tell a stuck connection from a
			// stuck trigger, nor which of your agents emitted the event in the first place.
			source: r.source ?? "connection",
			sourceInstanceId: r.source_instance_id,
			eventType: r.event_type,
			action: r.action,
			targetInstanceId: r.target_instance_id,
			status: r.status,
			attempts: r.attempts,
			nextAttemptAt: r.next_attempt_at,
			lastError: r.last_error,
			traceId: r.trace_id,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		})),
	});
});

/** Re-arm a dead delivery. The manual escape hatch for "the dependency is back up now". */
toolRoutes.post("/:id/connections/deliveries/:did/replay", async (c) => {
	const session = await requireUser(c);
	await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const ok = await replayDelivery(c.env, session.uid, c.req.param("did"));
	if (!ok) throw new HttpError(404, "no dead delivery with that id");
	return c.json({ ok: true, status: "pending" });
});

toolRoutes.delete("/:id/connections/:cid", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const removed = await deleteConnection(c.env, session.uid, c.req.param("cid"));
	if (!removed) throw new HttpError(404, "connection not found");
	return c.json({ ok: true });
});

/** GET /v1/instances/:id/connectors/consent — write-consents granted on this instance. */
toolRoutes.get("/:id/connectors/consent", async (c) => {
	const session = await requireUser(c);
	await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	return c.json({ consents: await listConsents(c.env, c.req.param("id")) });
});

/**
 * PUT /v1/instances/:id/connectors/:connector/consent { enabled } — grant/revoke
 * write consent for a connector (issue #90). Owner-scoped. Scope is "write" (reads
 * never need consent).
 */
toolRoutes.put("/:id/connectors/:connector/consent", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const connector = c.req.param("connector");
	const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };

	// Validate against the registry before writing (#216). runRegistryTool would refuse an
	// unknown or read-only connector's write tools anyway, so this is not a live bypass — but
	// storing the row anyway produced consent state that LOOKS granted and can never do
	// anything. A permission record that lies about what it permits is the raw material for a
	// later bypass: the next thing to read `instance_connector_consent` would have to
	// independently re-derive that "granted" here doesn't mean granted.
	//
	// Revocation is deliberately NOT validated: a row written before this check existed, or one
	// whose connector has since gone read-only, must remain removable.
	if (body.enabled) {
		const def = getConnector(connector);
		if (!def) throw new HttpError(404, `Unknown connector: ${connector}`);
		if (!def.scopes.write) {
			throw new HttpError(400, `The ${def.id} connector is read-only — write access cannot be granted to it.`);
		}
		await setConsent(c.env, instanceId, session.uid, connector, "write");
	} else {
		await revokeConsent(c.env, instanceId, connector, "write");
	}
	return c.json({ ok: true, connector, scope: "write", enabled: !!body.enabled });
});

/**
 * Supervision edges (#183, migration 0060) — who supervises whom, as configured data rather
 * than one agent's hardcoded structure. Scoped to the SUPERVISOR instance, mirroring how the
 * connection routes scope to the source.
 *
 * Deliberately separate from /connections: that is choreography (emit a FACT, consumers unknown),
 * this is delegation (name a subordinate, hand it a goal, own the result). Same delivery
 * substrate, different edge.
 */
toolRoutes.get("/:id/supervision", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return c.json({ supervision: await listSupervision(c.env, session.uid, { supervisorInstanceId: instanceId }) });
});

toolRoutes.post("/:id/supervision", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as {
		subordinateInstanceId?: string;
		config?: Record<string, unknown>;
	};
	// Every rejection here (cycle, tower, fan-out, two managers) is invisible at run time until
	// it has already spent money, so it is surfaced now, while the human is looking at the form.
	const res = await createSupervision(c.env, session.uid, {
		supervisorInstanceId: instanceId,
		subordinateInstanceId: String(body.subordinateInstanceId ?? ""),
		config: body.config,
	});
	if (!res.ok) throw new HttpError(res.status as 400, res.error);
	return c.json(res.supervision, 201);
});

toolRoutes.delete("/:id/supervision/:sid", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const removed = await deleteSupervision(c.env, session.uid, c.req.param("sid"));
	if (!removed) throw new HttpError(404, "supervision link not found");
	return c.json({ ok: true });
});

/**
 * Durable agent loops (#158, migration 0062).
 *
 * The console Loop used to run in the browser — poll `/loop-decide`, send the next instruction —
 * so closing the tab killed an in-flight objective, and spend could not be bounded because the
 * platform did not drive the loop. These start/watch/stop endpoints put the loop on the server;
 * the console becomes a thin UI over them.
 */
toolRoutes.post("/:id/loop", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as {
		objective?: string;
		maxIterations?: number;
		budget?: { costMicros?: number; delegations?: number; maxDepth?: number };
	};
	const objective = String(body.objective ?? "").trim();
	if (!objective) throw new HttpError(400, "objective is required");
	if (objective.length > 2000) throw new HttpError(400, "objective too long");

	const maxIterations = sanitizeMaxIterations(body.maxIterations);
	// Every server-driven loop gets a budget, even an unconfigured one — an autonomous run with
	// no spend bound is the failure #184 exists to prevent, and "we'll set a limit later" is how
	// the first runaway happens. sanitizeLimits clamps a request to the ceiling.
	const budget = await openBudget(c.env, session.uid, instanceId, body.budget);

	// ONE Loop, in the ONE chat — but what it DRIVES is whatever the agent declares (#210).
	// Hardcoding AGENT_LOOP here meant a Repo Coder's Loop looped a chat with no write tools:
	// it could read its repo in a circle and never touch the engine. The supervisor path already
	// dispatched correctly; the owner's own button did not.
	const caps = await capabilitiesForInstance(c.env, instanceId, session.uid).catch(() => null);
	const driver = loopDriverFor(caps);
	const started = await driver.start({
		env: c.env,
		instanceId,
		userId: session.uid,
		objective,
		maxIterations,
		budgetId: budget.id,
		depth: 0,
	});
	if (!started.ok) throw new HttpError(started.status, started.error);
	return c.json({ runId: started.runId, driver: started.driver, budgetId: budget.id, maxIterations, status: "running" }, 201);
});

/**
 * Loop presets (#234) — the named objectives the loop form offers, per instance.
 *
 * GET resolves creator-default-under-subscriber-override and says which one you are looking at, so
 * the editor knows whether "Reset" means anything. PUT stores the subscriber's list; an empty list
 * clears the override rather than storing an empty one.
 */
toolRoutes.get("/:id/loop-presets", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return c.json(await readLoopPresets(c.env, instanceId, session.uid));
});

toolRoutes.put("/:id/loop-presets", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { presets?: unknown };
	const saved = await writeLoopPresets(c.env, instanceId, session.uid, body.presets);
	if (!saved) throw new HttpError(404, "instance not found");
	return c.json(saved);
});

toolRoutes.get("/:id/loop", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return c.json({ runs: await listLoopRuns(c.env, session.uid, instanceId) });
});

toolRoutes.get("/:id/loop/:runId", async (c) => {
	const session = await requireUser(c);
	await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const run = await getLoopRun(c.env, session.uid, c.req.param("runId"));
	if (!run) throw new HttpError(404, "loop run not found");
	return c.json(run);
});

toolRoutes.post("/:id/loop/:runId/cancel", async (c) => {
	const session = await requireUser(c);
	await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	// Cooperative: the flag is read at the top of the next iteration so the in-flight step
	// finishes and its spend settles. A hard kill would strand a budget reservation.
	const ok = await requestCancel(c.env, session.uid, c.req.param("runId"));
	if (!ok) throw new HttpError(404, "no running loop with that id");
	return c.json({ ok: true, status: "cancelling" });
});

/**
 * Agent-to-agent delegation (#159) — hand a goal to a subordinate's brain.
 *
 * Scoped to the SUPERVISOR. The configured graph decides who may drive whom: delegating to an
 * instance that is not your subordinate is a 403, which is what stops the supervision graph from
 * being merely advisory. Depth comes from the graph and the budget is inherited, so neither can
 * be understated by the caller.
 */
toolRoutes.post("/:id/delegate", async (c) => {
	const session = await requireUser(c);
	const supervisorInstanceId = c.req.param("id");
	await requireOwnedInstance(c.env, supervisorInstanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as {
		subordinateInstanceId?: string;
		objective?: string;
		maxIterations?: number;
		budgetId?: string;
		parentTraceId?: string;
	};
	const res = await delegateToInstance(c.env, {
		userId: session.uid,
		supervisorInstanceId,
		subordinateInstanceId: String(body.subordinateInstanceId ?? ""),
		objective: String(body.objective ?? ""),
		maxIterations: body.maxIterations,
		budgetId: body.budgetId ?? null,
		parentTraceId: body.parentTraceId ?? null,
	});
	if (!res.ok) throw new HttpError(res.status as 400, res.error);
	return c.json({ runId: res.runId, budgetId: res.budgetId, depth: res.depth, status: "running" }, 201);
});
