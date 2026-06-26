import { Hono, type Context } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { callRunner, getRunnerConn } from "../lib/runner-client.js";
import { installationTokenForOwner } from "../lib/github-app.js";
import { runUserWorkersAi } from "../lib/user-ai.js";
import { appendTimeline, clearChat, contextForCopilot, lastTerminal, loadChat } from "../lib/coding-timeline.js";
import { copilotSummary } from "../lib/coding-copilot.js";
import {
	createRepo,
	createSession,
	deleteRepo,
	endSession,
	getActiveSessionForRepo,
	getRepo,
	getSession,
	listRepos,
	listSessions,
	updateRepo,
	updateRepoClone,
} from "../lib/coding-store.js";
import type { CodingActionKind, CodingGoal } from "../lib/coding-loop.js";
import type { CodingClientType, CodingRepo, CodingSessionRecord } from "../lib/coding-types.js";
import type { Env } from "../types.js";

/**
 * Ensure a session is live on the user's runner: clone the repo (idempotent on
 * the runner) and launch the CLI. Returns false if no runner is connected. Used
 * both when creating a session and when re-attaching an orphaned one (created
 * while the runner was offline, or after a runner restart).
 */
async function startSessionOnRunner(
	env: Env,
	instanceId: string,
	uid: string,
	session: CodingSessionRecord,
	repo: CodingRepo,
): Promise<boolean> {
	const conn = await getRunnerConn(env, instanceId, uid);
	if (!conn) return false;
	const owner = repo.githubRepo ? repo.githubRepo.split("/")[0] : "";
	const token = owner ? await installationTokenForOwner(env, uid, owner) : null;
	try {
		await callRunner(conn, "/coding/start", {
			sessionId: session.id,
			repoId: repo.id,
			// Local checkout → run in that dir (no clone). Else clone to a managed dir.
			workDir: repo.workdir || undefined,
			cloneUrl: repo.cloneUrl,
			branch: repo.branch || undefined,
			token: token ?? undefined,
			clientType: session.clientType,
		});
		await updateRepoClone(env, repo.id, { cloneStatus: "ready", cloneError: null });
	} catch (e) {
		await updateRepoClone(env, repo.id, {
			cloneStatus: "error",
			cloneError: e instanceof Error ? e.message.slice(0, 300) : String(e),
		});
	}
	return true;
}

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

/** "~/dev/stores/pags/platform" → "pags/platform" — a less generic default name. */
function lastTwoSegments(path: string): string {
	const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
	return parts.slice(-2).join("/");
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
	let githubRepo = typeof body.githubRepo === "string" ? body.githubRepo : undefined;
	const cloneUrl = typeof body.cloneUrl === "string" ? body.cloneUrl : undefined;
	// A local checkout the user already has on the runner machine — run there, no clone.
	const localPath = typeof body.localPath === "string" ? body.localPath.trim() : "";
	if (localPath) {
		const repo = await createRepo(c.env, instanceId, uid, {
			// A bare folder name ("platform") is ambiguous — default to the last two
			// path segments ("pags/platform"). Editable later either way.
			name: name || lastTwoSegments(localPath) || "repo",
			workdir: localPath,
			defaultClient: asClient(body.defaultClient),
		});
		return c.json({ repo }, 201);
	}
	// A clone URL alone is enough: derive owner/repo (for private-repo token
	// resolution) and a display name from it. Accept name OR github repo OR URL.
	if (!githubRepo && cloneUrl) {
		const m = cloneUrl.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
		if (m) githubRepo = m[1];
	}
	// Default to the full "owner/repo" — a bare repo name ("platform") is too
	// generic to tell projects apart. The user can rename it afterwards.
	const derivedName =
		name ||
		githubRepo ||
		(cloneUrl ? cloneUrl.replace(/\.git$/, "").replace(/\/$/, "").split("/").pop() : "");
	if (!derivedName && !cloneUrl) return c.json({ error: "a repo name or URL is required" }, 400);
	const repo = await createRepo(c.env, instanceId, uid, {
		name: derivedName || "repo",
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

/** Update a repo/project: rename and/or set its launch URLs (dev/staging/prod). */
codingRoutes.put("/:instanceId/coding/repos/:repoId", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const body = (await c.req.json().catch(() => ({}))) as {
		name?: string;
		urls?: { dev?: string; staging?: string; prod?: string };
	};
	const name = typeof body.name === "string" ? body.name.trim() : undefined;
	const hasUrls = body.urls !== undefined && typeof body.urls === "object";
	if (!name && !hasUrls) return c.json({ error: "name or urls is required" }, 400);
	const ok = await updateRepo(c.env, instanceId, uid, c.req.param("repoId"), {
		name: name || undefined,
		urls: hasUrls ? body.urls : undefined,
	});
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

	// One active session per repo — a second would share the repo's single working
	// directory and conflict (concurrent edits, git index races). Reuse the live one.
	const existing = await getActiveSessionForRepo(c.env, instanceId, uid, repoId);
	if (existing) {
		const runnerConnected = await startSessionOnRunner(c.env, instanceId, uid, existing, repo);
		return c.json({ session: existing, runnerConnected, reused: true }, 200);
	}

	const clientType = asClient(body.clientType ?? repo.defaultClient);
	let session: CodingSessionRecord;
	try {
		session = await createSession(c.env, instanceId, uid, {
			repoId,
			clientType,
			issueNumber: typeof body.issueNumber === "number" ? body.issueNumber : undefined,
			issueTitle: typeof body.issueTitle === "string" ? body.issueTitle : undefined,
		});
	} catch {
		// Lost a create race against the one-active-session-per-repo index — reuse
		// whoever won instead of erroring.
		const winner = await getActiveSessionForRepo(c.env, instanceId, uid, repoId);
		if (!winner) throw new HttpError(409, "Could not start a session — try again.");
		const runnerConnected = await startSessionOnRunner(c.env, instanceId, uid, winner, repo);
		return c.json({ session: winner, runnerConnected, reused: true }, 200);
	}

	const runnerConnected = await startSessionOnRunner(c.env, instanceId, uid, session, repo);
	return c.json({ session, runnerConnected }, 201);
});

/**
 * Re-attach an existing session to the runner — fixes an orphaned session
 * (created while the runner was offline) and lets the terminal reconnect after a
 * runner restart. Idempotent: the runner's start no-ops if the session is live.
 */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/start", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
	if (!session) throw new HttpError(404, "Session not found");
	if (session.status !== "active") return c.json({ ok: false, error: "session has ended" }, 409);
	const repo = await getRepo(c.env, instanceId, uid, session.repoId);
	if (!repo) throw new HttpError(404, "Repo not found");
	const runnerConnected = await startSessionOnRunner(c.env, instanceId, uid, session, repo);
	return c.json({ ok: runnerConnected, runnerConnected });
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

/**
 * Co-pilot: read the live terminal and give the user a SHORT summary of what's
 * happening + what's needed from them, or answer a follow-up question. Uses the
 * user's BYOK Claude. The user reads this instead of the raw terminal.
 */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/explain", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const body = (await c.req.json().catch(() => ({}))) as { question?: string };
	const question = typeof body.question === "string" ? body.question.trim() : "";

	// Capture the current terminal.
	const conn = await getRunnerConn(c.env, instanceId, uid);
	let pane = "";
	if (conn) {
		const snap = (await callRunner(conn, "/coding/capture", { sessionId }).catch(() => null)) as { pane?: string } | null;
		pane = snap?.pane ?? "";
	}

	// Persist the user's question and a terminal snapshot (if it changed) so the
	// session has a durable, continuous history.
	if (question) await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_user", content: question });
	if (pane.trim()) {
		const last = await lastTerminal(c.env, sessionId);
		if (pane.trim() !== (last ?? "").trim()) {
			await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "terminal", content: pane.slice(-8000) });
		}
	}

	// Continuity: feed the recent persisted timeline (prior chat, what the agent
	// did, outcomes) so the co-pilot remembers the session, not just this moment.
	const memory = await contextForCopilot(c.env, sessionId);
	const reply = (await copilotSummary(c.env, uid, { question, memory, pane })) || "(no response)";
	// Don't persist a transient "runner offline / session hasn't started" auto-summary
	// — it's only true at this moment, and once the runner attaches it lingers at the
	// top of the thread as stale, confusing history. Show it live, but only save real
	// replies (an answer to a question, or a summary of an actual live terminal).
	const offlineAutoSummary = !question && !pane.trim();
	if (!offlineAutoSummary) {
		await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_assistant", content: reply });
	}
	return c.json({ reply });
});

/** Load a session's persisted conversation (so the console restores it on open). */
codingRoutes.get("/:instanceId/coding/sessions/:sessionId/timeline", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
	if (!session) throw new HttpError(404, "Session not found");
	return c.json({ chat: await loadChat(c.env, session.id) });
});

/** Clear a session's conversation thread (keeps the activity log). */
codingRoutes.delete("/:instanceId/coding/sessions/:sessionId/timeline", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
	if (!session) throw new HttpError(404, "Session not found");
	await clearChat(c.env, session.id);
	return c.json({ ok: true });
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
	// `chat:true` = sent from the Agent chat (relay my words to Claude on my behalf),
	// so persist it as a chat turn (survives reload) — not just the raw command log.
	const fromChat = body.chat === true;
	const conn = await getRunnerConn(c.env, instanceId, uid);
	if (!conn) throw new HttpError(409, "No coding runner connected. Start it with: pags up");
	if (action.kind === "message" && action.text) {
		await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: fromChat ? "chat_user" : "command", content: action.text }).catch(() => undefined);
	}
	let snap = await callRunner(conn, "/coding/act", { sessionId, action }).catch(() => null);
	if (snap === null) {
		// The runner is online but lost the in-memory session (it restarted) — its
		// tmux pane usually survives, so reattach (CodingSession.start reconnects to
		// the live tmux, no new CLI) and retry once.
		const session = await getSession(c.env, instanceId, uid, sessionId);
		const repo = session ? await getRepo(c.env, instanceId, uid, session.repoId) : null;
		if (session && repo) await startSessionOnRunner(c.env, instanceId, uid, session, repo);
		snap = await callRunner(conn, "/coding/act", { sessionId, action }).catch(() => null);
	}
	if (snap === null) throw new HttpError(409, "This session isn't live on the runner — open it again (or run pags up).");

	// Drove the CLI with a real instruction → spin up a durable watcher that waits
	// for it to finish, then summarizes + notifies (reaches the user even if they
	// close the console). Each send supersedes the prior watcher: we stamp the
	// session with this watcher's id, and a watcher only notifies if it's still the
	// stamped one — so several sends can't fire several push notifications for one
	// completion.
	if (action.kind === "message" && action.text) {
		const session = await getSession(c.env, instanceId, uid, sessionId);
		const repo = session ? await getRepo(c.env, instanceId, uid, session.repoId) : null;
		const watchId = `cw-${sessionId}-${Date.now()}`;
		await c.env.DB.prepare(
			"UPDATE coding_sessions SET watch_workflow_id = ?1 WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4",
		)
			.bind(watchId, sessionId, instanceId, uid)
			.run()
			.catch(() => undefined);
		await c.env.CODING_SESSION.create({
			id: watchId,
			params: {
				instanceId,
				userId: uid,
				sessionId,
				repoId: repo?.id ?? "",
				mode: "watch",
				watchId,
				goal: { objective: action.text, repo: repo?.name ?? "your repo", clientType: session?.clientType ?? "claude" },
			},
		}).catch(() => undefined);
	}
	return c.json(snap as object);
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
