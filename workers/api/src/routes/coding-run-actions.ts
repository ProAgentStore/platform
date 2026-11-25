/**
 * The owner's two deliberate endings for a coding run (#1709, a slice of #1670).
 *
 *   POST /:instanceId/coding/runs/:runId/abandon                 the run is over: clear its questions, stop it, and keep it from resuming
 *   GET  /:instanceId/coding/repos/:repoId/worktrees/discard     preview what discarding would remove (a read; changes nothing)
 *   POST /:instanceId/coding/repos/:repoId/worktrees/discard     remove ONE run's isolated worktree on the machine that holds it
 *   GET  /:instanceId/coding/repos/:repoId/worktrees/publish     preview what publishing a run the owner ended by hand would do (#1717)
 *   POST /:instanceId/coding/repos/:repoId/worktrees/publish     publish it: the same read-back and direct-or-PR choice as an automatic run end
 *
 * Both are owner actions behind `requireOwned`; neither is in the agent tool registry, so no agent can reach them. The abandon is the
 * cloud's (`lib/run-abandon.ts`). The discard is the runner's `discardWorktree({authorized:true})` — the authorization IS this route — and
 * follows the branch and stash mutations' contract: the machine is NAMED, it previews unless `dry_run` is exactly `false`, executing needs
 * the `expected_head` the preview returned, and a refusal the machine reports as a value is a 409 with the whole receipt.
 */
import type { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { callBranchRunner } from "../lib/branch-actions.js";
import { getRepo, getSession } from "../lib/coding-store.js";
import { ownerPublishRun } from "../lib/isolated-run.js";
import { getRunnerConn } from "../lib/runner-client.js";
import { strategyForRunner } from "../lib/checkout-strategy.js";
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

	/**
	 * The owner's publish of an isolated run that ended by hand (#1717). Preview is a read; executing needs the `expected_head` the preview returned.
	 * Owner only (`requireOwned`), and in no agent tool registry. Only a repository that STORED an isolated preset is ever published: nothing here
	 * migrates a direct-to-main repository to anything, and the direct-or-PR choice is the stored one, exactly as at an automatic run end.
	 */
	const publish = async (c: Parameters<typeof requireOwned>[0], input: { node?: string; sessionId?: string; dryRun: boolean; head?: string }) => {
		const { uid, instanceId } = await requireOwned(c);
		if (!input.node) throw new HttpError(400, "runner_node is required: name the machine that holds the worktree (list_runner_nodes)");
		if (!input.sessionId) throw new HttpError(400, "session_id is required: the session whose isolated run to publish");
		const runId = SESSION_UUID.exec(input.sessionId)?.[1];
		if (!runId) throw new HttpError(400, "session_id is not a session id (csess_<uuid>)");
		const repoId = c.req.param("repoId") ?? "";
		const [session, repo] = await Promise.all([getSession(c.env, instanceId, uid, input.sessionId), getRepo(c.env, instanceId, uid, repoId).catch(() => null)]);
		if (!session || session.repoId !== repoId || !repo) throw new HttpError(404, "Session not found on this repo");
		if (!strategyForRunner(repo.strategy)) throw new HttpError(409, `${repo.name} is not set to an isolated checkout, so there is no run worktree to publish. Nothing was changed.`);
		if (!input.dryRun && !(input.head && SHA.test(input.head))) throw new HttpError(400, "expected_head is required to execute: preview first and pass the head it returned");
		const expect = repo.strategy === "isolated-pr" ? "pr" : "direct";
		if (input.dryRun) {
			const out = await callBranchRunner<{ isolated?: boolean; ok?: boolean }>(c.env, { instanceId, userId: uid, repoId, path: "/coding/worktree-publish-owner", body: { sessionId: input.sessionId, expect, dryRun: true }, node: input.node, mutating: false });
			if (!out.ok) return c.json(out, out.reason === "no_repo" ? 404 : out.reason === "unreachable" ? 503 : out.reason === "unconfirmed" ? 502 : out.reason === "failed" ? 500 : 422);
			if (out.result?.isolated === false) return c.json({ ...out, error: "That machine holds no managed worktree for this run; nothing to publish." }, 404);
			if (out.result?.ok === false) return c.json(out, 409);
			return c.json(out);
		}
		const conn = await getRunnerConn(c.env, instanceId, uid, input.node).catch(() => null);
		if (!conn) return c.json({ ok: false, reason: "unreachable", outcome: "not-started", machine: input.node, error: `The machine ${input.node} has no live runner connection, so nothing was published.` }, 503);
		// What the PR is titled from: the session's latest run, when it had one (best effort — a missing row only means a generic title).
		const last = await c.env.DB.prepare("SELECT run_id, objective FROM agent_loop_runs WHERE session_id = ?1 AND instance_id = ?2 AND user_id = ?3 ORDER BY started_at DESC LIMIT 1").bind(input.sessionId, instanceId, uid).first<{ run_id: string; objective: string | null }>().catch(() => null);
		const outcome = await ownerPublishRun(c.env, conn, { instanceId, userId: uid, sessionId: input.sessionId, repo, runId: last?.run_id ?? null, expectedHead: input.head ?? "", objective: last?.objective ?? undefined });
		if (!outcome) return c.json({ ok: false, reason: "no_worktree", error: "That machine holds no managed worktree for this run, or its runner is too old to publish one; nothing was changed." }, 404);
		return c.json({ ok: outcome.published, machine: conn.runnerNode ?? input.node, ...outcome }, outcome.published ? 200 : 409);
	};

	codingRoutes.get("/:instanceId/coding/repos/:repoId/worktrees/publish", (c) => publish(c, { node: str(c.req.query("runner_node")), sessionId: str(c.req.query("session_id")), dryRun: true }));

	codingRoutes.post("/:instanceId/coding/repos/:repoId/worktrees/publish", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		return publish(c, { node: str(body.runner_node), sessionId: str(body.session_id), dryRun: body.dry_run !== false, head: str(body.expected_head) });
	});
}
