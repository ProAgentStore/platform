/**
 * The GitHub Actions self-hosted runner on an agent's pinned machine (#1208, #1209; epic #1113).
 *
 *   POST /v1/instances/:id/actions-runner   `{ action: "install"|"remove", scope: {org}|{repo}, runnerGroup? }`
 *                                            → the machine's job; the registration token is minted and
 *                                            delivered inside the call and never stored
 *   GET  /v1/instances/:id/actions-runner   `?jobId=` → that job, and every runner on the machine
 *
 * Owner-only. The rules live in lib/actions-runner-provision.ts.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { actionsRunnerStatus, parseRunnerScope, startActionsRunner } from "../lib/actions-runner-provision.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

export const instanceActionsRunnerRoutes = new Hono<{ Bindings: Env }>();

instanceActionsRunnerRoutes.post("/:id/actions-runner", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
	const extra = Object.keys(body).filter((k) => !["action", "scope", "runnerGroup"].includes(k));
	if (extra.length) throw new HttpError(400, `Unknown field ${extra.map((k) => `\`${k}\``).join(", ")} — the fields are \`action\`, \`scope\` and \`runnerGroup\`.`);
	if (body.action !== "install" && body.action !== "remove") throw new HttpError(400, 'action must be "install" or "remove"');
	if (body.runnerGroup !== undefined && (typeof body.runnerGroup !== "string" || !/^[A-Za-z0-9 ._-]{1,100}$/.test(body.runnerGroup))) throw new HttpError(400, "runnerGroup must be a runner group name");
	const result = await startActionsRunner(c.env, { userId: session.uid, instanceId: instance.id, action: body.action, scope: parseRunnerScope(body.scope), runnerGroup: body.runnerGroup as string | undefined });
	return c.json(result, 202);
});

instanceActionsRunnerRoutes.get("/:id/actions-runner", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	return c.json(await actionsRunnerStatus(c.env, { userId: session.uid, instanceId: instance.id, jobId: c.req.query("jobId") || undefined }));
});
