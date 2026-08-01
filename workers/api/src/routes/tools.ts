import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import { getRegistryTool, registryTools, runRegistryTool, type JsonSchema } from "../lib/tool-registry.js";
import { listConsents, revokeConsent, setConsent } from "../lib/connector-consent.js";
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

/** GET /v1/instances/:id/tools — connector tools callable on this instance + schemas. */
toolRoutes.get("/:id/tools", async (c) => {
	const session = await requireUser(c);
	await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const tools = registryTools().map((t) => ({
		name: t.name,
		connector: t.connector,
		scope: t.scope,
		description: t.description,
		jsonSchema: t.jsonSchema,
	}));
	return c.json({ tools });
});

/** POST /v1/instances/:id/tools/:name — invoke a connector tool (body = its input args). */
toolRoutes.post("/:id/tools/:name", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const name = c.req.param("name");
	const tool = getRegistryTool(name);
	if (!tool) throw new HttpError(404, `Unknown tool: ${name}`);
	const input = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const invalid = validateAgainstSchema(tool.jsonSchema, input);
	if (invalid) throw new HttpError(400, invalid);
	const result = await runRegistryTool(name, { env: c.env, userId: session.uid, instanceId }, input);
	return c.json(result);
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
	if (body.enabled) await setConsent(c.env, instanceId, session.uid, connector, "write");
	else await revokeConsent(c.env, instanceId, connector, "write");
	return c.json({ ok: true, connector, scope: "write", enabled: !!body.enabled });
});
