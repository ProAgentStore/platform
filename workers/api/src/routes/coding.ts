import { Hono, type Context } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { callRunner, getRunnerConn } from "../lib/runner-client.js";
import { githubAppConfigured, installationTokenForOwner } from "../lib/github-app.js";
import { listIssues, readIssue } from "../lib/github-issues.js";
import { runUserWorkersAi } from "../lib/user-ai.js";
import { appendTimeline, clearChat, contextForCopilot, lastTerminal, loadChat, loadTimeline } from "../lib/coding-timeline.js";
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
			// The exact CLI command for this session's engine (Claude default, or a
			// user-configured Codex/Grok/custom). The runner spawns it.
			command: session.launchCommand || undefined,
		});
		await updateRepoClone(env, repo.id, { cloneStatus: "ready", cloneError: null });
		return true;
	} catch (e) {
		const msg = e instanceof Error ? e.message.slice(0, 300) : String(e);
		await updateRepoClone(env, repo.id, { cloneStatus: "error", cloneError: msg });
		return false;
	}
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

/** Command wrappers to skip when finding the real engine binary in a launch command. */
const COMMAND_LAUNCHERS = new Set(["npx", "bunx", "pnpm", "yarn", "npm", "bun", "env", "exec", "dlx", "run", "sudo", "time"]);

/**
 * Derive the engine client type from a launch command's real binary — skipping
 * `FOO=bar` env prefixes and wrappers like `npx`/`bunx`/`env`. This decides whether
 * the runner uses the structured Claude engine (claude) or runs the CLI raw (else).
 * An unknown binary maps to "codex" so it runs RAW, not mis-driven as Claude.
 */
export function deriveClientType(command: string): CodingClientType {
	for (const t of command.trim().split(/\s+/)) {
		if (!t || t.includes("=") || t.startsWith("-")) continue;
		const base = (t.split("/").pop() || "").toLowerCase();
		if (COMMAND_LAUNCHERS.has(base)) continue;
		if (base === "claude" || base.startsWith("claude")) return "claude";
		if (base.startsWith("gemini")) return "gemini";
		if (base.startsWith("grok")) return "grok";
		if (base.startsWith("codex")) return "codex";
		return "codex"; // an unknown binary → run it raw (NOT as Claude stream-json)
	}
	return "claude";
}

/** An engine preset = a named CLI launch command the user can pick per session. */
export interface CodingEngine {
	id: string;
	label: string;
	command: string;
}

/**
 * The default engine presets, seeded when an instance has none. Claude is the
 * first-class engine (structured stream-json); the others run as a real CLI the
 * user configures. Users edit these (add flags, keys, models, more engines) and
 * the per-session choice picks one.
 */
const DEFAULT_ENGINES: CodingEngine[] = [
	{ id: "claude", label: "Claude Code", command: "claude --dangerously-skip-permissions" },
	{ id: "gemini", label: "Gemini CLI", command: "gemini" },
	{ id: "codex", label: "Codex", command: "codex" },
	{ id: "grok", label: "Grok", command: "grok" },
];

/** Read the instance's engine presets (seeded defaults when unset). */
async function readEngines(env: Env, instanceId: string, userId: string): Promise<{ engines: CodingEngine[]; defaultEngineId: string }> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ config: string }>();
	let cfg: { codingEngines?: CodingEngine[]; defaultEngineId?: string } = {};
	try {
		cfg = JSON.parse(row?.config || "{}");
	} catch {
		/* fall through to defaults */
	}
	// Only keep well-formed presets (a hand-edited config must not crash resolveEngine).
	const valid = Array.isArray(cfg.codingEngines)
		? cfg.codingEngines.filter((e) => e && typeof e.id === "string" && typeof e.label === "string" && typeof e.command === "string")
		: [];
	const engines = valid.length ? valid : DEFAULT_ENGINES;
	const defaultEngineId = cfg.defaultEngineId && engines.some((e) => e.id === cfg.defaultEngineId) ? cfg.defaultEngineId : engines[0].id;
	return { engines, defaultEngineId };
}

/** The launch command + derived client type for an engine id (falls back to the default engine). */
async function resolveEngine(env: Env, instanceId: string, userId: string, engineId: unknown): Promise<{ command: string; clientType: CodingClientType }> {
	const { engines, defaultEngineId } = await readEngines(env, instanceId, userId);
	const eng = engines.find((e) => e.id === engineId) ?? engines.find((e) => e.id === defaultEngineId) ?? engines[0];
	// Derive the client type from the command's real binary, so the runner knows
	// whether to use the structured Claude engine or run the CLI raw.
	return { command: eng.command, clientType: deriveClientType(eng.command) };
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
	const repoId = c.req.param("repoId");
	// End any active sessions on the runner before deleting from DB
	const sessions = await listSessions(c.env, instanceId, uid);
	const conn = await getRunnerConn(c.env, instanceId, uid);
	for (const s of sessions.filter((s) => s.repoId === repoId && s.status === "active")) {
		if (conn) await callRunner(conn, "/coding/end", { sessionId: s.id }).catch(() => undefined);
	}
	const ok = await deleteRepo(c.env, instanceId, uid, repoId);
	if (!ok) throw new HttpError(404, "Repo not found");
	return c.json({ ok: true });
});

/** Get/set per-repo instructions (injected into the co-pilot + Overseer prompts). */
codingRoutes.get("/:instanceId/coding/repos/:repoId/instructions", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
	if (!repo) throw new HttpError(404, "Repo not found");
	return c.json({ instructions: repo.instructions || "" });
});

codingRoutes.put("/:instanceId/coding/repos/:repoId/instructions", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repoId = c.req.param("repoId");
	const body = await c.req.json<{ instructions?: string }>();
	const instructions = String(body.instructions || "").slice(0, 5000);
	await c.env.DB.prepare(
		"UPDATE coding_repos SET instructions = ?1, updated_at = datetime('now') WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4",
	)
		.bind(instructions, repoId, instanceId, uid)
		.run();
	return c.json({ instructions });
});

/**
 * Latest GitHub Actions run for a repo — so the console can show build/deploy
 * status (running / failed / live) independently of the agent. OPTIONAL: returns
 * { available:false } for local repos, non-GitHub repos, or when the GitHub App
 * isn't installed — so it never breaks anything.
 */
codingRoutes.get("/:instanceId/coding/repos/:repoId/deployment", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
	if (!repo) throw new HttpError(404, "Repo not found");
	const full = repo.githubRepo;
	if (!full || !full.includes("/") || !githubAppConfigured(c.env)) return c.json({ available: false });
	const owner = full.split("/")[0];
	const token = await installationTokenForOwner(c.env, uid, owner).catch(() => null);
	if (!token) return c.json({ available: false });
	try {
		const res = await fetch(`https://api.github.com/repos/${full}/actions/runs?per_page=1`, {
			headers: {
				Authorization: `token ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "proagentstore-coding/1.0",
			},
		});
		if (!res.ok) return c.json({ available: false });
		const data = (await res.json()) as { workflow_runs?: Array<Record<string, unknown>> };
		const run = data.workflow_runs?.[0];
		if (!run) return c.json({ available: true, run: null });
		return c.json({
			available: true,
			run: {
				status: run.status, // queued | in_progress | completed
				conclusion: run.conclusion ?? null, // success | failure | cancelled | null
				name: run.name ?? "",
				runNumber: run.run_number ?? null,
				url: run.html_url ?? "",
				branch: run.head_branch ?? "",
				sha: typeof run.head_sha === "string" ? run.head_sha.slice(0, 7) : "",
				updatedAt: run.updated_at ?? "",
			},
		});
	} catch {
		return c.json({ available: false });
	}
});

/**
 * GitHub issues for a repo (read-only, cloud→GitHub — works on any runner). Public
 * repos work unauthenticated; private repos need the GitHub App installed for the owner.
 * 400 for local-only repos (no `github_repo`); the Issues panel hides in that case.
 */
codingRoutes.get("/:instanceId/coding/repos/:repoId/issues", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
	if (!repo) throw new HttpError(404, "Repo not found");
	if (!repo.githubRepo || !repo.githubRepo.includes("/")) {
		return c.json({ error: "This repo isn't connected to GitHub — add it by owner/repo or a GitHub URL to use issues." }, 400);
	}
	const state = c.req.query("state");
	const labels = c.req.query("labels") || undefined;
	const issues = await listIssues(c.env, uid, repo.githubRepo, {
		state: state === "closed" || state === "all" ? state : "open",
		labels,
	});
	return c.json({ repo: repo.githubRepo, issues });
});

codingRoutes.get("/:instanceId/coding/repos/:repoId/issues/:number", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
	if (!repo) throw new HttpError(404, "Repo not found");
	if (!repo.githubRepo || !repo.githubRepo.includes("/")) {
		return c.json({ error: "This repo isn't connected to GitHub." }, 400);
	}
	const number = Number.parseInt(c.req.param("number"), 10);
	if (!Number.isFinite(number)) return c.json({ error: "Invalid issue number" }, 400);
	const issue = await readIssue(c.env, uid, repo.githubRepo, number);
	if (!issue) throw new HttpError(404, "Issue not found");
	return c.json({ issue });
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

/** The engine presets (CLI launch commands) the user can start sessions with. */
codingRoutes.get("/:instanceId/coding/engines", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	return c.json(await readEngines(c.env, instanceId, uid));
});

/** Save the engine presets + default. Each = { id, label, command }. */
codingRoutes.put("/:instanceId/coding/engines", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const body = (await c.req.json().catch(() => ({}))) as { engines?: unknown; defaultEngineId?: unknown };
	const raw = Array.isArray(body.engines) ? body.engines : [];
	// Sanitize: id (slug), label, command are all required; cap the count + lengths.
	const seen = new Set<string>();
	const engines: CodingEngine[] = [];
	for (const e of raw.slice(0, 12) as Array<Record<string, unknown>>) {
		const label = String(e.label ?? "").trim().slice(0, 60);
		const command = String(e.command ?? "").trim().slice(0, 400);
		if (!label || !command) continue;
		let id = String(e.id ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
		if (!id) id = label.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "engine";
		while (seen.has(id)) id = `${id}-2`;
		seen.add(id);
		engines.push({ id, label, command });
	}
	if (!engines.length) throw new HttpError(400, "At least one engine with a label and command is required.");
	const defaultEngineId = engines.some((e) => e.id === body.defaultEngineId) ? String(body.defaultEngineId) : engines[0].id;
	const row = await c.env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, uid).first<{ config: string }>();
	let cfg: Record<string, unknown> = {};
	try {
		cfg = JSON.parse(row?.config || "{}");
	} catch {
		/* overwrite a corrupt config */
	}
	cfg.codingEngines = engines;
	cfg.defaultEngineId = defaultEngineId;
	await c.env.DB.prepare("UPDATE agent_instances SET config = ?1, updated_at = datetime('now') WHERE id = ?2 AND user_id = ?3")
		.bind(JSON.stringify(cfg), instanceId, uid)
		.run();
	return c.json({ engines, defaultEngineId });
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

	// Resolve which engine to launch: the chosen preset (engineId), else the repo's
	// remembered default, else the instance default engine.
	const { command, clientType } = await resolveEngine(c.env, instanceId, uid, body.engineId ?? body.clientType ?? repo.defaultClient);
	let session: CodingSessionRecord;
	try {
		session = await createSession(c.env, instanceId, uid, {
			repoId,
			clientType,
			launchCommand: command,
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

/** Persist a system/status message to the coding timeline (loop events, errors). */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/system-message", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const { content } = await c.req.json<{ content: string }>();
	if (!content || typeof content !== "string") return c.json({ error: "content required" }, 400);
	await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "system", content: content.slice(0, 2000) });
	return c.json({ ok: true });
});

/**
 * Co-pilot: read the live terminal and give the user a SHORT summary of what's
 * happening + what's needed from them, or answer a follow-up question. Uses the
 * user's BYOK Claude. The user reads this instead of the raw terminal.
 */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/explain", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	// Verify the session belongs to this instance/user BEFORE touching its timeline —
	// the timeline helpers are scoped by sessionId alone.
	if (!(await getSession(c.env, instanceId, uid, sessionId))) throw new HttpError(404, "Session not found");
	const body = (await c.req.json().catch(() => ({}))) as { question?: string; finished?: boolean; persist?: boolean };
	const question = typeof body.question === "string" ? body.question.trim() : "";
	const finished = body.finished === true;
	// The client's finish-watcher passes persist:false — the durable server watch
	// workflow already persists the finish summary, so persisting here too would
	// show a DUPLICATE bubble in the thread.
	const persist = body.persist !== false;

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
	// Inject instance + repo instructions into the co-pilot prompt.
	const session = await getSession(c.env, instanceId, uid, sessionId);
	const repo = session ? await getRepo(c.env, instanceId, uid, session.repoId) : null;
	const instanceInstructions = await readSpecialInstructions(c.env, instanceId, uid);
	const repoInstructions = repo?.instructions;
	const combined = [instanceInstructions, repoInstructions].filter(Boolean).join("\n\n") || undefined;
	// Pass the runner connection + workDir so a substantive question can READ the real code
	// (read_file/git_diff/…) to ground its answer. Omitted for the auto-summary path (no
	// question) and when the runner is offline (conn null) → cheap terminal-only single shot.
	const reply = (await copilotSummary(c.env, uid, {
		question,
		memory,
		pane,
		finished,
		specialInstructions: combined,
		conn: conn ?? undefined,
		sessionId,
		workDir: repo?.workdir ?? undefined,
		githubRepo: repo?.githubRepo ?? undefined,
	})) || "(no response)";
	// Don't persist a transient "runner offline / session hasn't started" auto-summary
	// — it's only true at this moment, and once the runner attaches it lingers at the
	// top of the thread as stale, confusing history. Show it live, but only save real
	// replies (an answer to a question, or a summary of an actual live terminal).
	const offlineAutoSummary = !question && !pane.trim();
	if (!offlineAutoSummary && persist) {
		await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_assistant", content: reply });
	}
	return c.json({ reply });
});

/**
 * Send an instruction to the repo's Claude (drive the CLI) + spin up the finish
 * watcher (deduped). Shared by the Agent endpoint's delegate path. Returns an ack.
 */
async function driveClaude(
	c: Context<{ Bindings: Env }>,
	instanceId: string,
	uid: string,
	sessionId: string,
	instruction: string,
	summary?: string,
): Promise<{ delegated: boolean; reply: string }> {
	const conn = await getRunnerConn(c.env, instanceId, uid);
	if (!conn) return { delegated: false, reply: "No coding runner connected — start it with: pags up" };
	// NOTE: don't log a `command` turn here — the chat_assistant "On it — I asked
	// Claude to: …" already records it; a command entry would show a 3rd duplicate
	// bubble in the thread (loadChat surfaces commands as your turns).
	const act = () => callRunner(conn, "/coding/act", { sessionId, action: { kind: "message", text: instruction } }).catch(() => null);
	let snap = await act();
	const session = await getSession(c.env, instanceId, uid, sessionId);
	const repo = session ? await getRepo(c.env, instanceId, uid, session.repoId) : null;
	if (snap === null && session && repo) {
		await startSessionOnRunner(c.env, instanceId, uid, session, repo); // reattach a session lost to a runner restart
		snap = await act();
	}
	// Finish watcher (one per send: stamp the session so only the latest notifies).
	const watchId = `cw-${sessionId}-${Date.now()}`;
	await c.env.DB.prepare("UPDATE coding_sessions SET watch_workflow_id = ?1 WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4")
		.bind(watchId, sessionId, instanceId, uid)
		.run()
		.catch(() => undefined);
	await c.env.CODING_SESSION.create({
		id: watchId,
		params: { instanceId, userId: uid, sessionId, repoId: repo?.id ?? "", mode: "watch", watchId, goal: { objective: instruction, repo: repo?.name ?? "your repo", clientType: session?.clientType ?? "claude" } },
	}).catch(async () => {
		// The finish-watcher failed to start — tell the user so the missing completion
		// summary isn't a silent "did it even work?".
		await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "system", content: "(Couldn't start the progress watcher — I won't auto-report when this finishes; ask me for an update.)" }).catch(() => undefined);
	});
	// Show the user a plain-language summary, NOT the raw (often long/technical)
	// instruction we sent to the CLI.
	const reply = summary ? `On it — ${summary}` : "On it — working on that now.";
	await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_assistant", content: reply }).catch(() => undefined);
	return { delegated: true, reply };
}

/**
 * The Agent chat (Step 1 of #3): ONE input that either answers from the terminal +
 * history, or DELEGATES to Claude Code via the `drive_claude` tool — the LLM
 * decides. `@claude`/`/run` forces delegation. This tool-loop is the reusable core
 * the cross-repo Overseer (#9) will lift to global scope.
 */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/agent", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	// Verify the session belongs to this instance/user before touching its timeline.
	if (!(await getSession(c.env, instanceId, uid, sessionId))) throw new HttpError(404, "Session not found");
	const body = (await c.req.json().catch(() => ({}))) as { message?: string; audioKey?: string };
	const raw = String(body.message ?? "").trim();
	if (!raw) return c.json({ error: "message is required" }, 400);
	// A voice-dictated turn carries the R2 id of its saved recording so it can be
	// replayed (double-tap). Persisted with the turn.
	await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_user", content: raw, audioKey: body.audioKey }).catch(() => undefined);

	// Explicit force-delegate.
	if (/^(@claude|\/run)\b/i.test(raw)) {
		const cleaned = raw.replace(/^(@claude|\/run)\s*/i, "").trim() || raw;
		return c.json(await driveClaude(c, instanceId, uid, sessionId, cleaned));
	}

	// Otherwise: one tool-enabled call — answer from context OR call drive_claude.
	const conn = await getRunnerConn(c.env, instanceId, uid);
	let pane = "";
	if (conn) {
		const snap = (await callRunner(conn, "/coding/capture", { sessionId }).catch(() => null)) as { pane?: string } | null;
		pane = snap?.pane ?? "";
	}
	const memory = await contextForCopilot(c.env, sessionId);
	const system =
		"You are the co-pilot for an AI coding agent working in the user's repo. TWO rules:\n" +
		"1. If the user wants something DONE → call the `drive_claude` tool with ONE clear instruction. Don't do the work yourself.\n" +
		"2. If the user is ASKING (status, what happened, is it done) → answer FROM the terminal + session memory below.\n\n" +
		"STYLE: Talk to a NON-TECHNICAL user by default. Say WHAT was done and WHETHER it worked — never list filenames, commands, or code unless the user explicitly asks for details. " +
		"Wrong: 'Fixed overflow in PuzzleSets.tsx line 99'. Right: 'Fixed the horizontal scroll on the puzzle page.' " +
		"Only get technical when the user asks to elaborate, show code, or be more detailed.\n" +
		"Keep it to 1-2 sentences. Never pad. After delegating, say 'On it' + what you asked the agent to do in plain English.";
	const userMsg = `User: ${raw}\n\nSESSION MEMORY (recent):\n${memory || "(none)"}\n\nTERMINAL (recent):\n${pane.slice(-6000) || "(no live terminal)"}`;
	const tools = [
		{
			type: "function",
			function: {
				name: "drive_claude",
				description: "Delegate an action to Claude Code running in the repo (it edits files, runs commands). Use for any request to DO work.",
				parameters: { type: "object", properties: {
					instruction: { type: "string", description: "A single clear instruction for Claude Code — technical detail (file names, commands) is fine HERE; the CLI needs it." },
					summary: { type: "string", description: "A plain, NON-TECHNICAL one-line summary of what you asked, for the user. No file names, commands, or code. e.g. 'swapping the food field for a milk-type picker'." },
				}, required: ["instruction", "summary"] },
			},
		},
	];
	const res = (await runUserWorkersAi(c.env, uid, "claude-sonnet-4-6", {
		messages: [{ role: "system", content: system }, { role: "user", content: userMsg }],
		tools,
		maxTokens: 700,
	}).catch(() => ({ response: "" }))) as { response?: string; tool_calls?: Array<{ name: string; arguments?: Record<string, unknown> }> };
	const call = res.tool_calls?.find((t) => t.name === "drive_claude");
	const instruction = call && typeof call.arguments?.instruction === "string" ? (call.arguments.instruction as string).trim() : "";
	const summary = call && typeof call.arguments?.summary === "string" ? (call.arguments.summary as string).trim() : "";
	if (instruction) return c.json(await driveClaude(c, instanceId, uid, sessionId, instruction, summary || undefined));
	const reply = res.response || "(no response)";
	await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_assistant", content: reply }).catch(() => undefined);
	return c.json({ delegated: false, reply });
});

/**
 * The cross-repo Overseer (#9, Step 2): ONE agent across ALL the user's repos. It
 * reads each repo's recent activity (global context) and either answers about
 * everything, or delegates an action to a SPECIFIC repo's Claude via
 * drive_claude(repoId, instruction). Same tool-loop as /agent, lifted to global
 * scope. Text-first; the continuous-voice layer comes later.
 */
codingRoutes.post("/:instanceId/coding/overseer", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const body = (await c.req.json().catch(() => ({}))) as { message?: string };
	const raw = String(body.message ?? "").trim();
	if (!raw) return c.json({ error: "message is required" }, 400);

	// Global context: every repo, whether it has a live session, and its recent activity.
	const repos = await listRepos(c.env, instanceId, uid);
	const repoById = new Map(repos.map((r) => [r.id, r] as const));
	const blocks: string[] = [];
	for (const r of repos) {
		const active = await getActiveSessionForRepo(c.env, instanceId, uid, r.id);
		let recent = "(no live session)";
		if (active) {
			const term = await lastTerminal(c.env, active.id).catch(() => null);
			recent = term ? term.slice(-700) : "(session live, nothing captured yet)";
		}
		const repoRules = r.instructions ? `\nRepo instructions: ${r.instructions}` : "";
		blocks.push(`### REPO "${r.name}" (id: ${r.id})${active ? " — LIVE" : ""}${repoRules}\n${recent}`);
	}
	const context = blocks.join("\n\n").slice(0, 16000) || "(no repos yet)";

	// Inject the user's Special Instructions (if any) into the Overseer prompt
	const userInstructions = await readSpecialInstructions(c.env, instanceId, uid);
	const system =
		"You are the Overseer — ONE agent across ALL of the user's coding repos. You hold the global picture below (each repo + its recent activity). Decide:\n" +
		"- If the user ASKS about status / what's happening / what finished / which needs them → answer concisely from the context, comparing across repos when relevant.\n" +
		"- If the user wants something DONE in a specific repo → call drive_claude with that repo's id + ONE clear instruction. Infer the repo from their words; if genuinely ambiguous, ask which.\n" +
		"Plain language, tight. You can only drive repos that have a LIVE session." +
		(userInstructions ? `\n\nUSER SPECIAL INSTRUCTIONS (follow these):\n${userInstructions}` : "");
	const userMsg = `User: ${raw}\n\nALL REPOS (recent activity):\n${context}`;
	const tools = [
		{
			type: "function",
			function: {
				name: "drive_claude",
				description: "Delegate an action to a SPECIFIC repo's Claude Code (it edits files, runs commands). Only works for repos with a LIVE session.",
				parameters: { type: "object", properties: { repoId: { type: "string" }, instruction: { type: "string" } }, required: ["repoId", "instruction"] },
			},
		},
	];
	const res = (await runUserWorkersAi(c.env, uid, "claude-sonnet-4-6", {
		messages: [{ role: "system", content: system }, { role: "user", content: userMsg }],
		tools,
		maxTokens: 800,
	}).catch(() => ({ response: "" }))) as { response?: string; tool_calls?: Array<{ name: string; arguments?: Record<string, unknown> }> };

	const call = res.tool_calls?.find((t) => t.name === "drive_claude");
	const repoId = call && typeof call.arguments?.repoId === "string" ? (call.arguments.repoId as string) : "";
	const instruction = call && typeof call.arguments?.instruction === "string" ? (call.arguments.instruction as string).trim() : "";
	if (repoId && instruction) {
		const active = await getActiveSessionForRepo(c.env, instanceId, uid, repoId);
		const repoName = repoById.get(repoId)?.name ?? "that repo";
		if (!active) return c.json({ delegated: false, reply: `${repoName} has no live session — open it (or tap Start) first, then I can drive it.` });
		const r = await driveClaude(c, instanceId, uid, active.id, instruction);
		return c.json({ delegated: true, repoId, reply: `${repoName}: ${r.reply}` });
	}
	return c.json({ delegated: false, reply: res.response || "(no response)" });
});

/** Load a session's persisted conversation (so the console restores it on open). */
codingRoutes.get("/:instanceId/coding/sessions/:sessionId/timeline", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
	if (!session) throw new HttpError(404, "Session not found");
	// ?full=1 → include the full typed timeline (chat + terminal snapshots + brain
	// decisions + commands + outcomes) so the whole session can be copied as JSON.
	if (c.req.query("full") === "1") {
		return c.json({ chat: await loadChat(c.env, session.id), timeline: await loadTimeline(c.env, session.id) });
	}
	return c.json({ chat: await loadChat(c.env, session.id) });
});

/** Clear a session's conversation thread (keeps the activity log). */
codingRoutes.delete("/:instanceId/coding/sessions/:sessionId/timeline", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
	if (!session) throw new HttpError(404, "Session not found");
	await clearChat(c.env, session.id, uid, instanceId);
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
		// Log the user's clean text first…
		await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: fromChat ? "chat_user" : "command", content: action.text }).catch(() => undefined);
		// …then prepend the combined rules (instance Special Instructions + per-repo
		// Rules) before sending to the CLI. Manual sends bypass the autonomous brain
		// (which injects rules into its own prompt), so without this the CLI never sees
		// them. This makes the rules bind the CLI no matter how it's driven.
		const session = await getSession(c.env, instanceId, uid, sessionId);
		const repo = session ? await getRepo(c.env, instanceId, uid, session.repoId) : null;
		const combined = [await readSpecialInstructions(c.env, instanceId, uid), repo?.instructions].filter(Boolean).join("\n\n");
		if (combined) action.text = `[Project rules — follow these for everything you do:\n${combined}\n]\n\n${action.text}`;
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
		}).catch(async () => {
			await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "system", content: "(Couldn't start the progress watcher — I won't auto-report when this finishes; ask me for an update.)" }).catch(() => undefined);
		});
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

	const instanceInstructions = await readSpecialInstructions(c.env, instanceId, uid);
	const repoInstructions = repo.instructions;
	const combined = [instanceInstructions, repoInstructions].filter(Boolean).join("\n\n");
	const goal: CodingGoal = {
		objective,
		repo: repo.name,
		clientType: session.clientType,
		specialInstructions: combined || undefined,
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

/**
 * Diagnostics: restart a session's CLI process on the runner (kill + relaunch
 * with the SAME session id, keeping the D1 row). For recovering a wedged engine
 * without losing the session/timeline.
 */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/restart", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
	if (!session) throw new HttpError(404, "Session not found");
	if (session.status !== "active") return c.json({ ok: false, error: "session has ended" }, 409);
	const repo = await getRepo(c.env, instanceId, uid, session.repoId);
	if (!repo) throw new HttpError(404, "Repo not found");
	const conn = await getRunnerConn(c.env, instanceId, uid);
	if (!conn) return c.json({ ok: false, runnerConnected: false });
	await callRunner(conn, "/coding/end", { sessionId: session.id }).catch(() => undefined);
	const started = await startSessionOnRunner(c.env, instanceId, uid, session, repo);
	if (!started) {
		// Re-read the repo to get the clone error
		const freshRepo = await getRepo(c.env, instanceId, uid, session.repoId);
		return c.json({ ok: false, runnerConnected: true, error: freshRepo?.cloneError || "Failed to start session on runner" });
	}
	return c.json({ ok: true, runnerConnected: true });
});

/** Kill tmux sessions on the runner (orphaned, specific, or all pags-*). */
codingRoutes.post("/:instanceId/coding/kill-tmux", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const conn = await getRunnerConn(c.env, instanceId, uid);
	if (!conn) return c.json({ error: "Runner not connected", runnerConnected: false }, 502);
	const body = await c.req.json<{ sessions?: string[]; orphansOnly?: boolean }>();
	const result = await callRunner(conn, "/coding/kill-tmux", body);
	return c.json(result);
});

/** List directories on the runner (for remote browsing). */
codingRoutes.get("/:instanceId/coding/browse", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const conn = await getRunnerConn(c.env, instanceId, uid);
	if (!conn) return c.json({ error: "Runner not connected" }, 502);
	const dir = c.req.query("dir") || "~";
	const result = await callRunner(conn, "/coding/browse", { dir });
	return c.json(result);
});

/**
 * Full diagnostics: runner, tmux, sessions, repos, GitHub, detected issues.
 * The console's transparency view — everything the user needs to self-diagnose.
 */
codingRoutes.get("/:instanceId/coding/diagnostics", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const env = c.env;

	// 1. Runner connection (D1 row)
	const runtimeRow = await env.DB.prepare(
		"SELECT endpoint_url, capabilities, runner_version, runner_node, status, last_seen_at, placement, created_at, updated_at FROM instance_runtimes WHERE instance_id = ?1 AND user_id = ?2",
	).bind(instanceId, uid).first<{
		endpoint_url: string | null; capabilities: string | null; runner_version: string | null;
		runner_node: string | null; status: string | null; last_seen_at: string | null;
		placement: string | null; created_at: string | null; updated_at: string | null;
	}>();

	const runner: Record<string, unknown> = {
		registered: !!runtimeRow,
		status: runtimeRow?.status ?? "unregistered",
		endpointUrl: runtimeRow?.endpoint_url ?? null,
		placement: runtimeRow?.placement ?? null,
		capabilities: runtimeRow?.capabilities ? JSON.parse(runtimeRow.capabilities) : [],
		runnerVersion: runtimeRow?.runner_version ?? null,
		runnerNode: runtimeRow?.runner_node ?? null,
		lastSeenAt: runtimeRow?.last_seen_at ?? null,
		registeredAt: runtimeRow?.created_at ?? null,
	};

	// 2. Live runner probe
	const conn = await getRunnerConn(env, instanceId, uid);
	let runnerHealth: unknown = null;
	let runnerDiag: unknown = null;
	let runnerReachable = false;
	if (conn) {
		try {
			runnerHealth = await callRunner<unknown>(conn, "/health", undefined);
			runnerReachable = true;
		} catch (e) {
			runnerHealth = { error: e instanceof Error ? e.message : String(e) };
		}
		try {
			runnerDiag = await callRunner<unknown>(conn, "/coding/diagnostics", undefined);
		} catch (e) {
			runnerDiag = { error: e instanceof Error ? e.message : String(e) };
		}
	}
	// Check relay status
	let relayConnected = false;
	if (env.RELAY) {
		try {
			const stub = env.RELAY.get(env.RELAY.idFromName(instanceId));
			const relayRes = await stub.fetch(new Request("https://relay/status"));
			const relayData = await relayRes.json().catch(() => ({})) as { connected?: boolean };
			relayConnected = relayData.connected === true;
		} catch { /* relay probe failed */ }
	}
	// Runner is effectively reachable if either the direct probe worked OR the relay is connected
	const effectivelyReachable = runnerReachable || relayConnected;

	(runner as Record<string, unknown>).reachable = effectivelyReachable;
	(runner as Record<string, unknown>).health = runnerHealth;

	// 3. D1 sessions + repos
	const [dbSessions, dbRepos] = await Promise.all([
		listSessions(env, instanceId, uid),
		listRepos(env, instanceId, uid),
	]);

	// 4. Cross-reference D1 active sessions vs runner's tracked sessions
	const trackedIds = new Set<string>();
	const diagData = runnerDiag as { tracked?: Array<{ sessionId: string; alive: boolean; runState: string; paneLines: number; clientType: string; workDir: string; tmuxSession: string; takeover: boolean }>; orphanedTmux?: string[]; tmuxTotal?: number; pagsTmuxTotal?: number } | null;
	if (diagData?.tracked) {
		for (const t of diagData.tracked) trackedIds.add(t.sessionId);
	}

	const sessions = dbSessions.map((s) => {
		const tracked = diagData?.tracked?.find((t) => t.sessionId === s.id);
		const repo = dbRepos.find((r) => r.id === s.repoId);
		return {
			id: s.id,
			repoId: s.repoId,
			repoName: repo?.name ?? s.repoId,
			status: s.status,
			clientType: s.clientType,
			launchCommand: s.launchCommand ?? null,
			tmuxSession: s.tmuxSession ?? null,
			startedAt: s.startedAt,
			endedAt: s.endedAt ?? null,
			// Live state from the runner (null if runner is offline or session not tracked)
			live: tracked ? {
				alive: tracked.alive,
				runState: tracked.runState,
				paneLines: tracked.paneLines,
				workDir: tracked.workDir,
				underTakeover: tracked.takeover,
			} : null,
			// Issue detection
			issue: s.status === "active" && !tracked
				? (effectivelyReachable ? "orphaned: D1 says active but runner has no tmux for it" : "unknown: runner offline")
				: s.status === "active" && tracked && !tracked.alive
					? "dead: tracked but CLI process exited"
					: null,
		};
	});

	const repos = dbRepos.map((r) => {
		const activeSessions = sessions.filter((s) => s.repoId === r.id && s.status === "active");
		return {
			id: r.id,
			name: r.name,
			githubRepo: r.githubRepo ?? null,
			cloneUrl: r.cloneUrl ?? null,
			branch: r.branch,
			workdir: r.workdir ?? null,
			cloneStatus: r.cloneStatus,
			cloneError: r.cloneError ?? null,
			defaultClient: r.defaultClient,
			urls: r.urls ?? null,
			activeSessions: activeSessions.length,
			issue: r.cloneStatus === "error" ? `clone failed: ${r.cloneError || "unknown error"}`
				: r.cloneStatus === "missing_url" ? "no clone URL and no local path"
				: null,
		};
	});

	// 5. GitHub App status
	const githubApp = {
		configured: githubAppConfigured(env),
	};

	// 6. Auto-detected issues
	const issues: Array<{ severity: "error" | "warn" | "info"; message: string; fix?: string }> = [];

	if (!runtimeRow) {
		issues.push({ severity: "error", message: "No runner registered for this instance", fix: "Run `pags up` to connect your machine" });
	} else if (runtimeRow.status === "offline" && !relayConnected) {
		issues.push({ severity: "error", message: "Runner status is offline", fix: "Restart `pags up` to reconnect" });
	} else if (!effectivelyReachable) {
		issues.push({ severity: "error", message: "Runner registered but not reachable", fix: "Restart `pags up` to reconnect" });
	}

	for (const s of sessions) {
		if (s.issue) issues.push({ severity: "warn", message: `Session ${s.id.slice(-8)} (${s.repoName}): ${s.issue}`, fix: s.issue.startsWith("orphaned") ? "Kill the session and start a new one" : "Restart the session from ⚙" });
	}
	for (const r of repos) {
		if (r.issue) issues.push({ severity: "warn", message: `Repo "${r.name}": ${r.issue}`, fix: r.cloneStatus === "error" ? "Delete and re-add the repo, or fix the clone URL" : undefined });
	}

	if (diagData?.orphanedTmux?.length) {
		issues.push({ severity: "info", message: `${diagData.orphanedTmux.length} orphaned tmux session(s): ${diagData.orphanedTmux.join(", ")}`, fix: "Use the 'Kill orphaned' button in the tmux section above" });
	}

	const activeSessions = sessions.filter((s) => s.status === "active");
	const healthySessions = activeSessions.filter((s) => s.live?.alive);

	return c.json({
		summary: {
			runnerOnline: effectivelyReachable,
			runnerStatus: runner.status,
			relayConnected,
			totalRepos: repos.length,
			totalSessions: sessions.length,
			activeSessions: activeSessions.length,
			healthySessions: healthySessions.length,
			issueCount: issues.filter((i) => i.severity === "error" || i.severity === "warn").length,
		},
		runner,
		relay: { connected: relayConnected },
		tmux: diagData ? {
			trackedSessions: diagData.tracked?.length ?? 0,
			orphanedSessions: diagData.orphanedTmux ?? [],
			tmuxTotal: diagData.tmuxTotal ?? 0,
			pagsTmuxTotal: diagData.pagsTmuxTotal ?? 0,
		} : null,
		sessions,
		repos,
		githubApp,
		issues,
	});
});
