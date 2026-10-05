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
import { withinConfirmationWindow } from "../lib/confirmation-window.js";
import { HttpError, requireUser } from "../lib/auth.js";
import { setRunnerNodePin } from "../lib/runner-node-pin.js";
import { attachOnRepin, attachAgentOnNode } from "../lib/runner-repin.js";
import { normalizeRunnerNode, readInstanceRunnerNode } from "../lib/runtime-nodes.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * An attach that THREW is reported as unconfirmed, never as a failed request (#885).
 *
 * By the time an attach runs, the request has done its part — the pin is saved (`PUT …/runner-node`),
 * or the machine has been asked (`POST …/runner-attach`) — and a throw from a relay or registry read
 * along the way says nothing about whether the machine took the agent. Rejected, the route used to
 * answer 500, and the caller told its user the move had failed while the pin had landed. So a throw
 * gets the same shape a slow machine gets, with the reason it could not be confirmed.
 */
function attachSettled<T>(operation: Promise<T>, node: string, detail: (reason: string) => string): Promise<T | { node: string; attached: false; unconfirmed: true; error: string; detail: string }> {
	return operation.catch((e: unknown) => {
		const reason = e instanceof Error ? e.message : String(e);
		return { node, attached: false as const, unconfirmed: true as const, error: reason, detail: detail(reason) };
	});
}

export function registerRunnerPinRoutes(router: Hono<{ Bindings: Env }>): void {
	/** Pin (or clear, with an empty/null value) the node this instance runs on.
	 *
	 *  The write itself lives in `lib/runner-node-pin.ts`, which records the change to the trace (#533).
	 *  It is there rather than here because this key decides whether every runner call routes anywhere,
	 *  and an audit a route remembers is one the next writer forgets — see that module's header. */
	router.put("/:instanceId/runner-node", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { runnerNode?: unknown };
		const { to } = await setRunnerNodePin(c.env, instanceId, session.uid, body.runnerNode, { via: "api" });
		if (!to) return c.json({ runnerNode: null });
		const attachment = await withinConfirmationWindow(
			attachSettled(attachOnRepin(c.env, instanceId, session.uid, to), to, (why) => `The pin to ${to} is saved, but whether it attached there could not be confirmed (${why}). Call instance_runner_node to check current placement before retrying.`),
			() => ({ node: to, attached: false, unconfirmed: true as const, detail: `The pin to ${to} is saved; attachment and release of other machines are not yet confirmed. Call instance_runner_node to check current placement.` }),
			(operation) => c.executionCtx.waitUntil(operation),
		);
		return c.json({ runnerNode: to, attachment });
	});

}

export function registerRunnerAttachRoutes(router: Hono<{ Bindings: Env }>): void {
	router.post("/:instanceId/runner-attach", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { runnerNode?: unknown; force?: unknown };
		const node = normalizeRunnerNode(body.runnerNode) || (await readInstanceRunnerNode(c.env, instanceId, session.uid).catch(() => ""));
		if (!node) throw new HttpError(400, "This agent is not pinned to a machine — name one with runnerNode (see instance_runner_node's `nodes`), or pin it with set_instance_runner_node.");
		const attachment = await withinConfirmationWindow(
			attachSettled(attachAgentOnNode(c.env, instanceId, session.uid, node, { force: body.force !== false }), node, (why) => `The attach request on ${node} could not be confirmed (${why}). Call instance_runner_node to check whether this agent is attached before retrying force_runner_attach.`),
			() => ({ node, attached: false, unconfirmed: true as const, detail: `The attach request on ${node} has not yet been confirmed. Call instance_runner_node to check whether this agent is attached before retrying force_runner_attach.` }),
			(operation) => c.executionCtx.waitUntil(operation),
		);
		return c.json(attachment);
	});
}
