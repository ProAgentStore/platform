/**
 * `POST /v1/instances/:id/runner-attach` — the remote `pags up --force`, for ONE agent (#856).
 *
 * An agent whose socket went stale — a frozen or duplicate runner holding its relay slot, or a runner
 * that lost a 4409 and blocked it — could only be brought back by a person running `pags up --force`
 * at the machine, which is exactly what operating a fleet over MCP cannot do. This asks the machine
 * the agent is pinned to (or the one named) to take it now: the stale socket is cleared from the
 * agent's slot, and the machine's `pags up` is told, over a socket that answers there, to attach this
 * agent and take its slot over. The pin is not changed — that is `PUT …/runner-node`'s job.
 *
 * `force` defaults to true: this is the explicit takeover. Answers what actually happened, from the
 * relay's view, with the specific reason when it could not attach.
 */
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { attachAgentOnNode } from "../lib/runner-repin.js";
import { normalizeRunnerNode, readInstanceRunnerNode } from "../lib/runtime-nodes.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

export function registerRunnerAttachRoutes(router: Hono<{ Bindings: Env }>): void {
	router.post("/:instanceId/runner-attach", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { runnerNode?: unknown; force?: unknown };
		const node = normalizeRunnerNode(body.runnerNode) || (await readInstanceRunnerNode(c.env, instanceId, session.uid).catch(() => ""));
		if (!node) throw new HttpError(400, "This agent is not pinned to a machine — name one with runnerNode (see instance_runner_node's `nodes`), or pin it with set_instance_runner_node.");
		const attachment = await attachAgentOnNode(c.env, instanceId, session.uid, node, { force: body.force !== false });
		return c.json(attachment);
	});
}
