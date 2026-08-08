import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { connectorConstraintsForInstance } from "../lib/agent-capabilities.js";
import { patchInstanceConfig } from "../lib/instance-config.js";
import {
	CONNECTOR_CONSTRAINTS,
	MAX_BOUND_LENGTH,
	SURFACE_DEFAULTS,
	boundTargetRefusal,
	parseSurfaceOptions,
	serializeSurfaceOptions,
} from "../lib/surface-options.js";
import { readInstanceConfig } from "./instances-apply.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * The terminal-target BINDING (#402) — which single terminal this instance drives.
 *
 * The creator declares the CEILING (`capabilities.surfaceOptions.terminal.backends` and
 * `targets: "single"`); this is the other half of the split the platform already draws, and it is
 * modelled on `/runner-node` rather than invented: that the agent uses a machine is the creator's
 * declaration, WHICH machine is the subscriber's. Same here for the pane.
 *
 * The binding is stored where the merge already reads it — `agent_instances.config.surfaceOptions`
 * — so nothing new has to be resolved at dispatch: `connectorConstraintsForInstance` narrows the
 * creator's ceiling by this exact object, and `runRegistryTool` enforces the result. This route
 * writes a value; it is not where the boundary lives, which is the point of #402. Refusing an
 * out-of-scope target here is a courtesy to whoever is typing, and it is asserted at the
 * dispatcher too, because a config written by anything other than this handler must still be safe.
 */
export function registerTerminalBindingRoutes(router: Hono<{ Bindings: Env }>): void {
	/**
	 * What is bound, and what may be bound.
	 *
	 * Returns the EFFECTIVE constraint, not the raw instance config: `targets`/`backends` come from
	 * the agent, `boundTarget` from this instance, and a caller needs all three to know whether a
	 * binding is required at all (`targets: "single"`) and which backends it may name.
	 */
	router.get("/:instanceId/terminal-target", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const spec = await connectorConstraintsForInstance(c.env, instanceId, session.uid, CONNECTOR);
		return c.json(bindingBody(spec));
	});

	/**
	 * Bind (or clear, with an empty/null value) the one terminal target this instance drives.
	 *
	 * The value is stored as typed rather than canonicalised. A bare `main` and a prefixed
	 * `tmux:main` name the same pane and the gate accepts either against either, so rewriting the
	 * owner's input would only make the stored config disagree with what they set.
	 */
	router.put("/:instanceId/terminal-target", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { target?: unknown };
		const target = typeof body.target === "string" ? body.target.trim().slice(0, MAX_BOUND_LENGTH) : "";

		// Refuse a target outside the agent's own ceiling BEFORE writing it. Silently dropping it
		// on the read path (which the merge does, deliberately) would leave the console showing an
		// empty binding after a save that reported success.
		const ceiling = await connectorConstraintsForInstance(c.env, instanceId, session.uid, CONNECTOR);
		const refusal = target ? boundTargetRefusal(CONNECTOR, FIELD, target, ceiling) : null;
		if (refusal) return c.json({ error: refusal }, 400);

		// Read-merge-write of the ONE `surfaceOptions` key. `patchInstanceConfig` addresses a
		// top-level key, so the merge is here; two writers of DIFFERENT keys still both land, which
		// is the loss #231 was about. Round-tripped through the parser so a hand-edited config
		// cannot survive a save with values outside the closed vocabulary.
		const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
		const map = parseSurfaceOptions(cfg.surfaceOptions);
		const entry = map[CONNECTOR] ?? { ...SURFACE_DEFAULTS };
		const constraints = { ...(entry.constraints ?? {}) };
		if (target) constraints[BIND_FIELD] = target;
		else delete constraints[BIND_FIELD];
		map[CONNECTOR] = { ...entry, constraints };
		await patchInstanceConfig(c.env, instanceId, session.uid, "surfaceOptions", serializeSurfaceOptions(map));

		// Answer with the resolved reading, the way `/behaviour` does: the console replaces its
		// state from this, and an echo of the request would hide a value the ceiling dropped.
		const spec = await connectorConstraintsForInstance(c.env, instanceId, session.uid, CONNECTOR);
		return c.json(bindingBody(spec));
	});
}

const CONNECTOR = "terminal";
const FIELD = "targets";
const BIND_FIELD = "boundTarget";

/** The one response shape both verbs answer with. */
function bindingBody(spec: Record<string, string[] | string> | undefined) {
	const def = CONNECTOR_CONSTRAINTS[CONNECTOR]?.[FIELD];
	const bound = def?.kind === "binding" ? spec?.[def.bindField] : undefined;
	const backends = spec?.backends;
	return {
		target: typeof bound === "string" && bound ? bound : null,
		// `many` is the default and is never stored, so an absent field IS `many` — reported
		// explicitly rather than as an omission, because the caller's question is "must I bind one".
		targets: spec?.[FIELD] === "single" ? "single" : "many",
		// null (not []) when the agent declares no ceiling: an empty list would read as
		// "no backend is allowed", which is the opposite of what an absent ceiling means.
		backends: Array.isArray(backends) && backends.length ? backends : null,
	};
}
