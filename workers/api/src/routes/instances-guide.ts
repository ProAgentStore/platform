import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { buildConnectionGuide, type ConnectionGuideResponse, type GuideRepoRow, type GuideToolRow } from "../lib/connection-guide.js";
import { listRepos } from "../lib/coding-store.js";
import { instanceToolPolicy, projectToolListing } from "../lib/instance-tool-policy.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * The per-instance connection guide (#772).
 *
 * One route, one read, nothing stored. `lib/connection-guide.ts` holds the whole rendering
 * decision as a pure function; this module's only job is to fetch what that function needs and
 * hand it over — the same split `instances-behaviour.ts` makes with `lib/agent-behaviour.ts`.
 *
 * The tool list comes from `instanceToolPolicy` + `projectToolListing`, which is exactly what
 * `GET /v1/instances/:id/tools` calls (`routes/tools.ts:145`). That is deliberate and load-bearing:
 * a guide that enumerated the registry itself would be a second answer to "what may this instance
 * run", and the second answer is the one that drifts out of agreement with the gate.
 */
export function registerGuideRoutes(router: Hono<{ Bindings: Env }>): void {
	/**
	 * GET /v1/instances/:instanceId/connection-guide
	 *
	 * Returns `{ guide }` — Markdown, ready to paste into another assistant's system instructions.
	 * JSON rather than `text/plain` because every other route on this router is JSON and the MCP
	 * proxy's `authedCall` parses one; the plain-text contract #772 asks for is honoured at the
	 * surfaces that render it, which unwrap `guide` and hand over the string untouched.
	 *
	 * Owner-scoped twice over, matching the operator-manual routes: `requireOwnedInstance` 404s a
	 * foreign id, and every subsequent read is `user_id`-scoped in its own right.
	 */
	router.get("/:instanceId/connection-guide", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const instance = await requireOwnedInstance(c.env, instanceId, session.uid);

		// The agent's own identity + this subscriber's chosen display name. One join rather than
		// two reads; `displayName` is the name the subscriber picked (#450) and falls back to the
		// agent's, which is what every other surface shows.
		const meta = await c.env.DB.prepare(
			`SELECT a.name AS agent_name, a.slug AS slug, i.operator_manual AS operator_manual
			   FROM agent_instances i JOIN agents a ON a.id = i.agent_id
			  WHERE i.id = ?1 AND i.user_id = ?2`,
		)
			.bind(instanceId, session.uid)
			.first<{ agent_name: string | null; slug: string | null; operator_manual: string | null }>();

		let displayName = "";
		let rules = "";
		try {
			const cfg = JSON.parse(instance.config || "{}") as Record<string, unknown>;
			if (typeof cfg.displayName === "string") displayName = cfg.displayName;
			if (typeof cfg.specialInstructions === "string") rules = cfg.specialInstructions;
		} catch {
			// A malformed config blob costs the name and the rules, not the guide. Every other
			// section is still true, and a 500 here would make the debugging document unavailable
			// exactly when something about the instance is already wrong.
		}

		const capabilities = await capabilitiesForInstance(c.env, instanceId, session.uid);

		// `allowedOnly` — the guide answers "what can I call", where the listing route answers the
		// wider "what can this agent do, and what can't it, and why". Rendering the not-declared
		// rows here would be ~38% of a payload (base.ts:52-98) spent on tools the reader cannot use.
		// `schemas` — the field names ARE the deliverable; without them the guide restates the
		// discovery problem #772 is about.
		const policy = await instanceToolPolicy(c.env, instance.id, session.uid, instance.config);
		const tools = projectToolListing(policy, { allowedOnly: true, schemas: true }) as GuideToolRow[];

		// Repos are a coding-surface fact; an agent with none simply has none, and `listRepos`
		// answers that with an empty array rather than an error.
		const repos = (await listRepos(c.env, instanceId, session.uid)) as GuideRepoRow[];

		const guide = buildConnectionGuide({
			instanceId,
			instanceName: displayName || meta?.agent_name || instanceId,
			agentSlug: meta?.slug || "unknown",
			surfaces: capabilities?.surfaces ?? [],
			runtime: capabilities?.runtime ?? null,
			tools,
			repos,
			manual: meta?.operator_manual ?? "",
			rules,
		});

		// Typed at the boundary so the console's mirrored declaration is compared against a real
		// producer type rather than against a comment (`store/console/src/lib/types.test.ts`).
		const body: ConnectionGuideResponse = { guide };
		return c.json(body);
	});
}
