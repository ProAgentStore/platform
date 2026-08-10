import type { Context, Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { connectorConstraintsForInstance } from "../lib/agent-capabilities.js";
import { patchInstanceConfig } from "../lib/instance-config.js";
import {
	CONNECTOR_CONSTRAINTS,
	MAX_BOUND_LENGTH,
	SURFACE_DEFAULTS,
	type BindingConstraintDef,
	type ConstraintSpec,
	boundTargetRefusal,
	parseSurfaceOptions,
	serializeSurfaceOptions,
} from "../lib/surface-options.js";
import { readInstanceConfig } from "./instances-apply.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * The subscriber's half of a capability ceiling — which single resource this instance drives (#402).
 *
 * The creator declares the CEILING (`capabilities.surfaceOptions.<connector>.<field>`); this is the
 * other half of the split the platform already draws, and it is modelled on `/runner-node` rather
 * than invented: that the agent uses a machine is the creator's declaration, WHICH machine is the
 * subscriber's. Same here for the pane.
 *
 * The binding is stored where the merge already reads it — `agent_instances.config.surfaceOptions`
 * — so nothing new has to be resolved at dispatch: `connectorConstraintsForInstance` narrows the
 * creator's ceiling by this exact object, and `runRegistryTool` enforces the result. This route
 * writes a value; it is not where the boundary lives, which is the point of #402. Refusing an
 * out-of-scope target here is a courtesy to whoever is typing, and it is asserted at the
 * dispatcher too, because a config written by anything other than this handler must still be safe.
 *
 * ── One handler pair, one mount per binding field (#447)
 *
 * `tmux` became the second connector with a binding, and the handler body was already
 * connector-agnostic. It is PARAMETERISED rather than copied: the read-merge-write of the one
 * `surfaceOptions` key inside `binding().write` is the part that must not exist twice, since two
 * copies are how the two get to disagree about which sibling keys survive a save (#231).
 *
 * The MOUNTS stay literal strings even though the path is in the vocabulary, and that is not
 * duplication for its own sake: `scripts/openapi-coverage.mjs` finds routes by statically scanning
 * for a quoted path argument to a `.get`/`.put` call, so a loop over the table would delete this
 * whole surface from the drift check and turn its spec entries into phantoms.
 * `instances.contract.test.ts` closes the gap the other way — it derives the mounted paths from the
 * registered router and asserts them against `bindRoute`, so the table and the mounts cannot drift
 * apart silently.
 *
 * (That scan is purely textual, so a comment quoting a call with a literal path registers as a
 * route. Describing the pattern instead of spelling it is deliberate — the first draft of this
 * paragraph put a phantom `GET /v1/instances/…` into the drift report.)
 */
export function registerConnectorBindingRoutes(router: Hono<{ Bindings: Env }>): void {
	const terminal = binding("terminal", "targets");
	const tmux = binding("tmux", "sessions");
	router.get("/:instanceId/terminal-target", terminal.read);
	router.put("/:instanceId/terminal-target", terminal.write);
	router.get("/:instanceId/tmux-session", tmux.read);
	router.put("/:instanceId/tmux-session", tmux.write);
}

/** One connector's binding field, resolved from the closed vocabulary at module load. */
function bindingDef(connector: string, field: string): BindingConstraintDef {
	const def = CONNECTOR_CONSTRAINTS[connector]?.[field];
	if (def?.kind !== "binding") throw new Error(`No binding field \`${connector}.${field}\` in CONNECTOR_CONSTRAINTS.`);
	return def;
}

/** The GET/PUT pair for one binding field. */
function binding(connector: string, field: string) {
	const def = bindingDef(connector, field);
	return {
		/**
		 * What is bound, and what may be bound.
		 *
		 * Returns the EFFECTIVE constraint, not the raw instance config: the cardinality and any
		 * value ceiling come from the agent, the bound identity from this instance, and a caller
		 * needs all of them to know whether a binding is required at all (`single`) and what it may
		 * name.
		 */
		read: async (c: Context<{ Bindings: Env }, "/:instanceId">) => {
			const session = await requireUser(c);
			const instanceId = c.req.param("instanceId");
			await requireOwnedInstance(c.env, instanceId, session.uid);
			const spec = await connectorConstraintsForInstance(c.env, instanceId, session.uid, connector);
			return c.json(bindingBody(field, def, spec));
		},

		/**
		 * Bind (or clear, with an empty/null value) the one resource this instance drives.
		 *
		 * The value is stored as typed rather than canonicalised. For `terminal` a bare `main` and a
		 * prefixed `tmux:main` name the same pane and the gate accepts either against either, so
		 * rewriting the owner's input would only make the stored config disagree with what they set.
		 */
		write: async (c: Context<{ Bindings: Env }, "/:instanceId">) => {
			const session = await requireUser(c);
			const instanceId = c.req.param("instanceId");
			await requireOwnedInstance(c.env, instanceId, session.uid);
			const body = (await c.req.json().catch(() => ({}))) as { target?: unknown; session?: unknown };
			const raw = body[def.arg as "target" | "session"];
			const value = typeof raw === "string" ? raw.trim().slice(0, MAX_BOUND_LENGTH) : "";

			// Refuse a value outside the agent's own ceiling BEFORE writing it. Silently dropping it
			// on the read path (which the merge does, deliberately) would leave the console showing an
			// empty binding after a save that reported success. A connector with no VALUE ceiling —
			// `tmux`, single-valued by construction — has nothing to be outside of, and
			// `boundTargetRefusal` correctly answers null for it rather than inventing a rule.
			const ceiling = await connectorConstraintsForInstance(c.env, instanceId, session.uid, connector);
			const refusal = value ? boundTargetRefusal(connector, field, value, ceiling) : null;
			if (refusal) return c.json({ error: refusal }, 400);

			// Read-merge-write of the ONE `surfaceOptions` key. `patchInstanceConfig` addresses a
			// top-level key, so the merge is here; two writers of DIFFERENT keys still both land, which
			// is the loss #231 was about. Round-tripped through the parser so a hand-edited config
			// cannot survive a save with values outside the closed vocabulary.
			const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
			const map = parseSurfaceOptions(cfg.surfaceOptions);
			const entry = map[connector] ?? { ...SURFACE_DEFAULTS };
			const constraints = { ...(entry.constraints ?? {}) };
			if (value) constraints[def.bindField] = value;
			else delete constraints[def.bindField];
			map[connector] = { ...entry, constraints };
			await patchInstanceConfig(c.env, instanceId, session.uid, "surfaceOptions", serializeSurfaceOptions(map));

			// Answer with the resolved reading, the way `/behaviour` does: the console replaces its
			// state from this, and an echo of the request would hide a value the ceiling dropped.
			const spec = await connectorConstraintsForInstance(c.env, instanceId, session.uid, connector);
			return c.json(bindingBody(field, def, spec));
		},
	};
}

/**
 * The one response shape every binding route answers with, keyed off the VOCABULARY.
 *
 * Every key is derived: the bound identity is named by the argument it fills (`target`, `session`),
 * the cardinality by the field (`targets`, `sessions`), and the value ceiling by the field the
 * binding sits inside (`backends`) — omitted entirely for a connector that has none, because a
 * `backends: null` on a tmux binding would describe a ceiling that does not exist rather than one
 * that is unset. `terminal`'s body is byte-identical to what it answered before #447.
 */
function bindingBody(field: string, def: BindingConstraintDef, spec: ConstraintSpec | undefined) {
	const bound = spec?.[def.bindField];
	const within = def.withinField ? spec?.[def.withinField] : undefined;
	return {
		[def.arg]: typeof bound === "string" && bound ? bound : null,
		// `many` is the default and is never stored, so an absent field IS `many` — reported
		// explicitly rather than as an omission, because the caller's question is "must I bind one".
		[field]: spec?.[field] === "single" ? "single" : "many",
		// null (not []) when the agent declares no ceiling: an empty list would read as
		// "no backend is allowed", which is the opposite of what an absent ceiling means.
		...(def.withinField ? { [def.withinField]: Array.isArray(within) && within.length ? within : null } : {}),
	} as Record<string, unknown>;
}
