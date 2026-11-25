/**
 * The owner's two deliberate endings for a coding run (#1709, a slice of #1670).
 *
 *   POST /:instanceId/coding/runs/:runId/abandon                 the run is over: clear its questions, stop it, and keep it from resuming
 *   GET  /:instanceId/coding/repos/:repoId/worktrees/discard     preview what discarding would remove (a read; changes nothing)
 *   POST /:instanceId/coding/repos/:repoId/worktrees/discard     remove ONE run's isolated worktree on the machine that holds it
 *
 * Both are owner actions behind `requireOwned`; neither is in the agent tool registry, so no agent can reach them. The abandon is the
 * cloud's (`lib/run-abandon.ts`). The discard is the runner's `discardWorktree({authorized:true})` — the authorization IS this route — and
 * follows the branch and stash mutations' contract: the machine is NAMED, it previews unless `dry_run` is exactly `false`, executing needs
 * the `expected_head` the preview returned, and a refusal the machine reports as a value is a 409 with the whole receipt.
 */
import type { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { callBranchRunner } from "../lib/branch-actions.js";
import { getSession } from "../lib/coding-store.js";
import { abandonRun } from "../lib/run-abandon.js";
import { requireOwned } from "./coding-shared.js";
import type { Env } from "../types.js";

const SESSION_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const SHA = /^[0-9a-f]{40}$/i;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function registerRunActionRoutes(codingRoutes: Hono<{ Bindings: Env }>) {
	codingRoutes.post("/:instanceId/coding/runs/:runId/abandon", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const out = await abandonRun(c.env, { userId: uid, instanceId, runId: c.req.param("runId") ?? "" });
		if (!out) throw new HttpError(404, "Run not found");
		return c.json({ ok: true, ...out });
	});

	/** One path for the preview (GET, a read) and the discard (POST): the tenant gate, the exact session, then the named machine. */
	const discard = async (c: Parameters<typeof requireOwned>[0], input: { node?: string; sessionId?: string; dryRun: boolean; head?: string }) => {
		const { uid, instanceId } = await requireOwned(c);
		if (!input.node) throw new HttpError(400, "runner_node is required: name the machine that holds the worktree (list_runner_nodes)");
		if (!input.sessionId) throw new HttpError(400, "session_id is required: the session whose isolated worktree to discard");
		const runId = SESSION_UUID.exec(input.sessionId)?.[1];
		if (!runId) throw new HttpError(400, "session_id is not a session id (csess_<uuid>)");
		const repoId = c.req.param("repoId") ?? "";
		const session = await getSession(c.env, instanceId, uid, input.sessionId);
		if (!session || session.repoId !== repoId) throw new HttpError(404, "Session not found on this repo");
		if (!input.dryRun && !(input.head && SHA.test(input.head))) throw new HttpError(400, "expected_head is required to execute: preview first and pass the head it returned");
		const out = await callBranchRunner<{ ok?: boolean; reason?: string }>(c.env, { instanceId, userId: uid, repoId, path: "/coding/worktree-discard", body: { runId, dryRun: input.dryRun, expectedHead: input.head }, node: input.node, mutating: !input.dryRun });
		if (!out.ok) return c.json(out, out.reason === "no_repo" ? 404 : out.reason === "unreachable" ? 503 : out.reason === "unconfirmed" ? 502 : out.reason === "failed" ? 500 : 422);
		if (out.result && out.result.ok === false) return c.json(out, 409);
		return c.json(out);
	};

	// The preview is a GET so a read-only caller can have it: it asks the machine what a discard would remove and changes nothing.
	codingRoutes.get("/:instanceId/coding/repos/:repoId/worktrees/discard", (c) => discard(c, { node: str(c.req.query("runner_node")), sessionId: str(c.req.query("session_id")), dryRun: true }));

	codingRoutes.post("/:instanceId/coding/repos/:repoId/worktrees/discard", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		return discard(c, { node: str(body.runner_node), sessionId: str(body.session_id), dryRun: body.dry_run !== false, head: str(body.expected_head) });
	});
}
