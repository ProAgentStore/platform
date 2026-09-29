import { listActiveRuns } from "./agent-loop-store.js";
import { DEFAULT_ENGINES, resolveEngine } from "./coding-engines.js";
import { endCodingSession } from "./coding-session-end.js";
import { continuityForNewSession, startSessionOnRunner } from "./coding-session-open.js";
import { createSession, getRepo } from "./coding-store.js";
import { parseAccountPreferences } from "./preferences.js";
import { callRunner, getRunnerConn, READ_TIMEOUT_MS } from "./runner-client.js";
import type { CodingClientType, CodingRepo, CodingSessionRecord } from "./coding-types.js";
import type { ApplyDefaultEngineItem, ApplyDefaultEngineResult, ApplyDefaultEngineSkipReason } from "./coding-default-engine-types.js";
import type { Env } from "../types.js";

interface ActiveSessionRow {
	id: string;
	instance_id: string;
	repo_id: string;
	user_id: string;
	client_type: string;
	status: string;
	tmux_session: string | null;
	runner_node: string | null;
	launch_command: string | null;
	issue_number: number | null;
	issue_title: string | null;
	started_at: string;
	ended_at: string | null;
	updated_at: string;
	instance_config: string | null;
	repo_name: string | null;
	driver_id: string | null;
}

interface ApplyDefaultEngineDeps {
	captureRunState?: (session: CodingSessionRecord) => Promise<{ runState: string | null; reachable: boolean }>;
	restartSession?: (args: { session: CodingSessionRecord; repo: CodingRepo; command: string; clientType: CodingClientType }) => Promise<{ ok: boolean; newSessionId?: string; reason?: ApplyDefaultEngineSkipReason }>;
}

const SKIP_REASONS: ApplyDefaultEngineSkipReason[] = ["already-default", "explicit-instance-default", "active-run", "offline", "busy", "unreadable", "stop-failed", "start-failed"];

function emptySkipped(): Record<ApplyDefaultEngineSkipReason, number> {
	return Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as Record<ApplyDefaultEngineSkipReason, number>;
}

function toSession(r: ActiveSessionRow): CodingSessionRecord {
	return {
		id: r.id,
		instanceId: r.instance_id,
		repoId: r.repo_id,
		userId: r.user_id,
		clientType: (["claude", "gemini", "codex", "grok"].includes(r.client_type) ? r.client_type : "claude") as CodingClientType,
		status: r.status as CodingSessionRecord["status"],
		tmuxSession: r.tmux_session ?? undefined,
		runnerNode: r.runner_node ?? null,
		launchCommand: r.launch_command ?? undefined,
		issueNumber: r.issue_number ?? undefined,
		issueTitle: r.issue_title ?? undefined,
		startedAt: r.started_at,
		endedAt: r.ended_at ?? undefined,
		updatedAt: r.updated_at,
	};
}

function explicitInstanceDefault(config: string | null): string | null {
	try {
		const cfg = JSON.parse(config || "{}") as Record<string, unknown>;
		return Object.hasOwn(cfg, "defaultEngineId") && typeof cfg.defaultEngineId === "string" ? cfg.defaultEngineId : null;
	} catch {
		return null;
	}
}

async function accountDefaultEngineId(env: Env, userId: string): Promise<string> {
	const row = await env.DB.prepare("SELECT preferences FROM users WHERE id = ?1")
		.bind(userId)
		.first<{ preferences: string | null }>();
	return parseAccountPreferences(row?.preferences).coding?.defaultEngineId ?? DEFAULT_ENGINES[0].id;
}

async function activeCodingSessions(env: Env, userId: string): Promise<ActiveSessionRow[]> {
	const res = await env.DB.prepare(
		`SELECT s.*, i.config AS instance_config, r.name AS repo_name, s.driver_id
		   FROM coding_sessions s
		   JOIN agent_instances i ON i.id = s.instance_id AND i.user_id = s.user_id
		   JOIN coding_repos r ON r.id = s.repo_id AND r.instance_id = s.instance_id AND r.user_id = s.user_id
		  WHERE s.user_id = ?1 AND s.status = 'active'
		  ORDER BY s.updated_at DESC`,
	)
		.bind(userId)
		.all<ActiveSessionRow>();
	return res.results ?? [];
}

async function defaultCapture(env: Env, session: CodingSessionRecord): Promise<{ runState: string | null; reachable: boolean }> {
	const conn = await getRunnerConn(env, session.instanceId, session.userId, session.runnerNode ?? null).catch(() => null);
	if (!conn) return { runState: null, reachable: false };
	const snap = await callRunner<{ runState?: unknown }>(conn, "/coding/capture", { sessionId: session.id }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
	if (!snap) return { runState: null, reachable: true };
	return { runState: typeof snap.runState === "string" ? snap.runState : null, reachable: true };
}

async function defaultRestart(
	env: Env,
	userId: string,
	{ session, repo, command, clientType }: { session: CodingSessionRecord; repo: CodingRepo; command: string; clientType: CodingClientType },
): Promise<{ ok: boolean; newSessionId?: string; reason?: ApplyDefaultEngineSkipReason }> {
	const ended = await endCodingSession(env, { instanceId: session.instanceId, userId, sessionId: session.id });
	if (ended.engineStopped === false) return { ok: false, reason: "stop-failed" };
	const next = await createSession(env, session.instanceId, userId, {
		repoId: session.repoId,
		clientType,
		launchCommand: command,
		issueNumber: session.issueNumber,
		issueTitle: session.issueTitle,
		runnerNode: session.runnerNode ?? null,
	});
	const continuity = await continuityForNewSession(env, session.instanceId, userId, repo.id, clientType);
	const started = await startSessionOnRunner(env, session.instanceId, userId, next, repo, { resumeFrom: continuity.resumeFrom, cleanSlate: continuity.seed === null });
	return started.conn ? { ok: true, newSessionId: next.id } : { ok: false, reason: "start-failed" };
}

export async function applyDefaultCodingEngineToIdle(
	env: Env,
	userId: string,
	deps: ApplyDefaultEngineDeps = {},
): Promise<ApplyDefaultEngineResult> {
	const defaultEngineId = await accountDefaultEngineId(env, userId);
	const result: ApplyDefaultEngineResult = { defaultEngineId, restarted: 0, skipped: emptySkipped(), items: [] };
	const capture = deps.captureRunState ?? ((session: CodingSessionRecord) => defaultCapture(env, session));
	const restart = deps.restartSession ?? ((args) => defaultRestart(env, userId, args));

	for (const row of await activeCodingSessions(env, userId)) {
		const session = toSession(row);
		const item: ApplyDefaultEngineItem = {
			instanceId: session.instanceId,
			repoId: session.repoId,
			sessionId: session.id,
			repoName: row.repo_name || session.repoId,
			from: session.launchCommand ?? null,
		};
		const skip = (reason: ApplyDefaultEngineSkipReason, extra: Partial<ApplyDefaultEngineItem> = {}) => {
			result.skipped[reason]++;
			result.items.push({ ...item, ...extra, reason });
		};

		const explicit = explicitInstanceDefault(row.instance_config);
		if (explicit && explicit !== defaultEngineId) {
			skip("explicit-instance-default");
			continue;
		}
		const desired = await resolveEngine(env, session.instanceId, userId, defaultEngineId);
		item.to = desired.command;
		if ((session.launchCommand || "").trim() === desired.command.trim()) {
			skip("already-default", { to: desired.command });
			continue;
		}
		if (row.driver_id || (await listActiveRuns(env, userId, session.instanceId)).some((r) => r.sessionId === session.id || !r.sessionId)) {
			skip("active-run", { to: desired.command });
			continue;
		}
		const state = await capture(session);
		if (!state.reachable) {
			skip("offline", { runState: state.runState, to: desired.command });
			continue;
		}
		if (state.runState !== "idle") {
			skip(state.runState ? "busy" : "unreadable", { runState: state.runState, to: desired.command });
			continue;
		}
		const restarted = await restart({ session, repo: (await getRepo(env, session.instanceId, userId, session.repoId))!, command: desired.command, clientType: desired.clientType });
		if (!restarted.ok) {
			skip(restarted.reason ?? "start-failed", { runState: state.runState, to: desired.command });
			continue;
		}
		result.restarted++;
		result.items.push({ ...item, runState: state.runState, to: desired.command, newSessionId: restarted.newSessionId });
	}
	return result;
}
