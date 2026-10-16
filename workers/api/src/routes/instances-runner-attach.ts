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
 *
 * `attached` is TRANSPORT only (#1032): the relay holds this agent's socket. `health` is the `/health`
 * probe run through that socket right after, and `remedy` the next step when it failed — an attach
 * once answered `attached: true` for a runner whose health never came back.
 *
 * #1114: an instance no runner would attach — paused, canceled, or an agent with no local runtime
 * (`attachBlocker`, the CLI's own eligibility rule) — is answered before any machine is asked, and the reason used to arrive after the window had answered "not yet confirmed". A window
 * that expires now answers from the attach's own progress (`cause`), and every attempt and outcome is
 * recorded (`lib/runner-attach-report.ts`).
 */
import type { Hono } from "hono";
import { withinConfirmationWindow } from "../lib/confirmation-window.js";
import { HttpError, requireUser } from "../lib/auth.js";
import { setRunnerNodePin } from "../lib/runner-node-pin.js";
import { type AttachCause, attachBlocker, heartbeatContext, newAttachProgress, recordAttach, windowExpiredCause } from "../lib/runner-attach-report.js";
import { attachedOnMachine, attachOnRepin, attachAgentOnNode } from "../lib/runner-repin.js";
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

type Recorded = { attached?: boolean; unconfirmed?: true; cause?: AttachCause; detail?: string; machineAtLastHeartbeat?: unknown; stale?: unknown };
/** Record what an attach settled to (#1114) — chained onto the operation, so it lands after the window too. */
function recorded<T extends Recorded>(env: Env, base: { instanceId: string; userId: string; node: string; via: "pin" | "force_attach"; forced: boolean }, startedAt: number, operation: Promise<T>): Promise<T> {
	return operation.then(async (r) => {
		await recordAttach(env, {
			...base,
			outcome: r.attached ? "attached" : r.unconfirmed ? "unconfirmed" : "not_attached",
			...(r.attached ? {} : { cause: r.cause ?? "runner_timeout", detail: r.detail }),
			durationMs: Date.now() - startedAt,
			context: { ...(r.machineAtLastHeartbeat ? { machineAtLastHeartbeat: r.machineAtLastHeartbeat } : {}), ...(r.stale ? { stale: r.stale } : {}) },
		});
		return r;
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
		const base = { instanceId, userId: session.uid, node: to, via: "pin" as const, forced: false };
		// No runner would take it — paused, canceled, or no local runtime (#1114): the pin is saved,
		// nothing is asked to attach, and the answer says why.
		const blocked = await attachBlocker(c.env, instanceId, session.uid);
		if (blocked) {
			c.executionCtx.waitUntil(recordAttach(c.env, { ...base, outcome: "not_attached", ...blocked, durationMs: 0 }));
			return c.json({ runnerNode: to, attachment: { node: to, attached: false, ...blocked } });
		}
		const startedAt = Date.now();
		const progress = newAttachProgress(startedAt);
		const attachment = await withinConfirmationWindow(
			recorded(c.env, base, startedAt, attachSettled(attachOnRepin(c.env, instanceId, session.uid, to, { progress }), to, (why) => `The pin to ${to} is saved, but whether it attached there could not be confirmed (${why}). Call instance_runner_node to check current placement before retrying.`)),
			async () => (await attachedOnMachine(c.env, instanceId, session.uid, to).catch(() => false))
				// Attached already — what is still open is only the OLD machine letting go, which a frozen one can take the whole window to not do (#922).
				? { node: to, attached: true, unconfirmed: true as const, detail: `Attached on ${to}. Whether every other machine has let it go is not yet confirmed — each drops it on its own poll, since the pin moved; instance_runner_node shows where it is attached.` }
				: await windowAnswer(c.env, base, progress, `The pin to ${to} is saved. `),
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
		const forced = body.force !== false;
		const base = { instanceId, userId: session.uid, node, via: "force_attach" as const, forced };
		// No runner would take it — paused, canceled, or no local runtime (#1114): nothing is asked — 409 with the reason.
		const blocked = await attachBlocker(c.env, instanceId, session.uid);
		if (blocked) {
			c.executionCtx.waitUntil(recordAttach(c.env, { ...base, outcome: "not_attached", ...blocked, durationMs: 0 }));
			return c.json({ node, attached: false, ...blocked, error: blocked.detail }, 409);
		}
		const startedAt = Date.now();
		const progress = newAttachProgress(startedAt);
		const attachment = await withinConfirmationWindow(
			recorded(c.env, base, startedAt, attachSettled(attachAgentOnNode(c.env, instanceId, session.uid, node, { force: forced, progress }), node, (why) => `The attach request on ${node} could not be confirmed (${why}). Call instance_runner_node to check whether this agent is attached before retrying force_runner_attach.`)),
			async () => (await attachedOnMachine(c.env, instanceId, session.uid, node).catch(() => false))
				? { node, attached: true, transport: "attached" as const, health: { state: "not_attempted" as const, error: "The attach outlived this request's window, so the runner's health was not checked here. Run coding_diagnostics before relying on it." } }
				: await windowAnswer(c.env, base, progress, ""),
			(operation) => c.executionCtx.waitUntil(operation),
		);
		return c.json(attachment);
	});
}

/**
 * The answer when the confirmation window expires before the attach settles (#1114): the measured
 * cause from how far the attach got, the machine's last heartbeat beside a timeout as context, and an
 * activity/error record of the unconfirmed attempt. The settled outcome is recorded again when it lands.
 */
async function windowAnswer(env: Env, base: { instanceId: string; userId: string; node: string; via: "pin" | "force_attach"; forced: boolean }, progress: ReturnType<typeof newAttachProgress>, prefix: string) {
	const now = Date.now();
	const { cause, detail } = windowExpiredCause(progress, base.node, now);
	const heartbeat = cause === "runner_timeout" ? await heartbeatContext(env, base.userId, [base.node], now) : null;
	const answer = { node: base.node, attached: false, unconfirmed: true as const, cause, phase: progress.phase, detail: `${prefix}${detail}`, ...(heartbeat ? { machineAtLastHeartbeat: heartbeat } : {}) };
	await recordAttach(env, { ...base, outcome: "unconfirmed", cause, detail: answer.detail, durationMs: now - progress.startedAt, ...(heartbeat ? { context: { machineAtLastHeartbeat: heartbeat } } : {}) });
	return answer;
}
