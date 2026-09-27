/**
 * `GET /v1/instances/:id/runner-setup` — the setup checklist for a coding agent that runs on the
 * owner's own machine (#868): install and sign in to the CLI, `pags up`, the GitHub App, a bound
 * repository, the engine's sign-in — each with a live verdict. See `lib/runner-setup.ts`.
 *
 * Coding agents only: the GitHub, repository and engine steps mean nothing for a browser agent, and
 * a checklist that can never be `ready` is worse than a clear refusal.
 */
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { runnerSetupChecklist } from "../lib/runner-setup.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

export function registerRunnerSetupRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/runner-setup", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const caps = await capabilitiesForInstance(c.env, instanceId, session.uid);
		if (caps?.runtime !== "coding") throw new HttpError(409, "This agent does not run on a local coding runner, so it has no runner setup checklist.");
		return c.json({ instanceId, ...(await runnerSetupChecklist(c.env, instanceId, session.uid)) });
	});
}
