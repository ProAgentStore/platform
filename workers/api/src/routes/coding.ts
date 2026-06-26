import { Hono, type Context } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { callRunner, getRunnerConn } from "../lib/runner-client.js";
import { installationTokenForOwner } from "../lib/github-app.js";
import {
	createRepo,
	createSession,
	deleteRepo,
	endSession,
	getRepo,
	getSession,
	listRepos,
	listSessions,
	updateRepoClone,
} from "../lib/coding-store.js";
import type { CodingActionKind, CodingGoal } from "../lib/coding-loop.js";
import type { CodingClientType } from "../lib/coding-types.js";
import type { Env } from "../types.js";

/**
 * The coding-workspace control plane (the AgentCoder port). A workspace IS the
 * agent instance; these routes manage its repos + coding sessions and proxy the
 * brain-driven controls to the user's local runner. Mounted on `/v1/instances`.
 */
export const codingRoutes = new Hono<{ Bindings: Env }>();

const CLIENTS: CodingClientType[] = ["claude", "gemini", "codex", "grok"];
function asClient(v: unknown): CodingClientType {
	return CLIENTS.includes(v as CodingClientType) ? (v as CodingClientType) : "claude";
}

/** Confirm the caller owns the instance (the workspace). */
async function requireOwned(c: Context<{ Bindings: Env }>): Promise<{ uid: string; instanceId: string }> {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? "";
	const owned = await c.env.DB.prepare("SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, session.uid)
		.first();
	if (!owned) throw new HttpError(404, "Instance not found");
	return { uid: session.uid, instanceId };
}

/** The instance's Special Instructions (user rules) from its JSON config. */
async function readSpecialInstructions(env: Env, instanceId: string, userId: string): Promise<string | undefined> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ config: string }>();
	try {
		const cfg = JSON.parse(row?.config || "{}") as { specialInstructions?: string };
		return cfg.specialInstructions || undefined;
	} catch {
		return undefined;
	}
}

// ── Repos ────────────────────────────────────────────────────────────────

codingRoutes.get("/:instanceId/coding/repos", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	return c.json({ repos: await listRepos(c.env, instanceId, uid) });
});

codingRoutes.post("/:instanceId/coding/repos", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const name = String(body.name ?? "").trim();
	const githubRepo = typeof body.githubRepo === "string" ? body.githubRepo : undefined;
	const cloneUrl = typeof body.cloneUrl === "string" ? body.cloneUrl : undefined;
	if (!name && !githubRepo) return c.json({ error: "name or githubRepo is required" }, 400);
	const repo = await createRepo(c.env, instanceId, uid, {
		name: name || String(githubRepo).split("/").pop() || "repo",
		githubRepo,
		cloneUrl,
		branch: typeof body.branch === "string" ? body.branch : undefined,
		defaultClient: asClient(body.defaultClient),
	});
	return c.json({ repo }, 201);
});

codingRoutes.delete("/:instanceId/coding/repos/:repoId", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const ok = await deleteRepo(c.env, instanceId, uid, c.req.param("repoId"));
	if (!ok) throw new HttpError(404, "Repo not found");
	return c.json({ ok: true });
});

// ── Sessions ─────────────────────────────────────────────────────────────

codingRoutes.get("/:instanceId/coding/sessions", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	return c.json({ sessions: await listSessions(c.env, instanceId, uid) });
});

/** Create a coding session against a repo and start it on the runner (best-effort). */
codingRoutes.post("/:instanceId/coding/sessions", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const repoId = String(body.repoId ?? "");
	const repo = await getRepo(c.env, instanceId, uid, repoId);
	if (!repo) throw new HttpError(404, "Repo not found");
	const clientType = asClient(body.clientType ?? repo.defaultClient);
	const session = await createSession(c.env, instanceId, uid, {
		repoId,
		clientType,
		issueNumber: typeof body.issueNumber === "number" ? body.issueNumber : undefined,
		issueTitle: typeof body.issueTitle === "string" ? body.issueTitle : undefined,
	});

	const conn = await getRunnerConn(c.env, instanceId, uid);
	if (conn) {
		// Private repos need an installation token to clone; public ones don't.
		const owner = repo.githubRepo ? repo.githubRepo.split("/")[0] : "";
		const token = owner ? await installationTokenForOwner(c.env, uid, owner) : null;
		try {
			await callRunner(conn, "/coding/start", {
				sessionId: session.id,
				repoId,
				cloneUrl: repo.cloneUrl,
				branch: repo.branch || undefined,
				token: token ?? undefined,
				clientType,
			});
			// The clone happens on the runner during start — reflect the result in D1
			// so the repo badge stops saying "cloning" (and shows clone failures).
			await updateRepoClone(c.env, repoId, { cloneStatus: "ready", cloneError: null });
		} catch (e) {
			await updateRepoClone(c.env, repoId, {
				cloneStatus: "error",
				cloneError: e instanceof Error ? e.message.slice(0, 300) : String(e),
			});
		}
	}
	return c.json({ session, runnerConnected: Boolean(conn) }, 201);
});

/** The pane the console renders (polling fallback for the live terminal). */
codingRoutes.get("/:instanceId/coding/sessions/:sessionId/capture", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const conn = await getRunnerConn(c.env, instanceId, uid);
	if (!conn) return c.json({ pane: "", runState: "idle", alive: false, ready: false, runnerConnected: false });
	const snap = await callRunner(conn, "/coding/capture", { sessionId }).catch(() => null);
	if (!snap) return c.json({ pane: "", runState: "idle", alive: false, ready: false, runnerConnected: true });
	return c.json({ ...(snap as object), runnerConnected: true });
});

/** Send a message / keys straight to the CLI (manual drive, no brain). */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/message", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const action: CodingActionKind =
		typeof body.keys === "string"
			? { kind: "keys", keys: body.keys }
			: { kind: "message", text: String(body.text ?? "") };
	const conn = await getRunnerConn(c.env, instanceId, uid);
	if (!conn) throw new HttpError(409, "No coding runner connected. Start it with: pags up");
	try {
		const snap = await callRunner(conn, "/coding/act", { sessionId, action });
		return c.json(snap as object);
	} catch {
		// The runner is online but doesn't have this session live (e.g. it restarted).
		throw new HttpError(409, "This session isn't live on the runner — start it again.");
	}
});

/** Hand the session to the autonomous brain (the durable Workflow) with an objective. */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/run", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const session = await getSession(c.env, instanceId, uid, sessionId);
	if (!session) throw new HttpError(404, "Session not found");
	const repo = await getRepo(c.env, instanceId, uid, session.repoId);
	if (!repo) throw new HttpError(404, "Repo not found");
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const objective = String(body.objective ?? "").trim();
	if (!objective) return c.json({ error: "objective is required" }, 400);

	const goal: CodingGoal = {
		objective,
		repo: repo.name,
		clientType: session.clientType,
		specialInstructions: await readSpecialInstructions(c.env, instanceId, uid),
		dryRun: body.dryRun === true,
	};
	const owner = repo.githubRepo ? repo.githubRepo.split("/")[0] : "";
	const token = owner ? await installationTokenForOwner(c.env, uid, owner) : null;
	const wf = await c.env.CODING_SESSION.create({
		params: {
			instanceId,
			userId: uid,
			sessionId,
			repoId: repo.id,
			cloneUrl: repo.cloneUrl,
			branch: repo.branch || undefined,
			token: token ?? undefined,
			goal,
		},
	});
	return c.json({ workflowId: wf.id, sessionId });
});

/** Resolve a brain handoff: the human finished, so the workflow may resume. */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/resume", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const conn = await getRunnerConn(c.env, instanceId, uid);
	if (!conn) throw new HttpError(409, "No coding runner connected");
	await callRunner(conn, `/coding/takeover/${encodeURIComponent(sessionId)}/resolve`, {
		value: typeof body.value === "string" ? body.value : undefined,
	}).catch(() => undefined);
	return c.json({ ok: true });
});

/** End a session: stop the runner's tmux + close the D1 record. */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/end", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const conn = await getRunnerConn(c.env, instanceId, uid);
	if (conn) await callRunner(conn, "/coding/end", { sessionId }).catch(() => undefined);
	const ok = await endSession(c.env, instanceId, uid, sessionId);
	return c.json({ ok });
});
