/**
 * The Coder's self-diagnosis surface (#305): what the platform thinks is true, checked against
 * what the machine reports, with the disagreements named.
 *
 * Split out of `routes/coding.ts` because it is the one part of the file that READS the whole
 * control plane rather than acting on a piece of it — runtime row, live relay, sessions, repos,
 * engine presets — and then reconciles it (#139/#275: an active D1 row a reachable runner isn't
 * tracking is a genuine orphan and gets closed here).
 *
 * It is also the page a user opens when everything else is broken, which is why nothing in it may
 * throw on bad data: a corrupt JSON column degrades to a default rather than 500ing the only
 * screen that could explain why.
 *
 * Registered from the position the block occupied in `coding.ts` — Hono matches in
 * registration ORDER, which `coding.contract.test.ts` pins.
 */
import type { Context, Hono } from "hono";
import { callRunner, getRunnerConn, relayConnected, READ_TIMEOUT_MS } from "../lib/runner-client.js";
import { githubAppConfigured } from "../lib/github-app.js";
import { engineAuthFor, engineAuthReport, readEngines, type EngineAuthResolved } from "../lib/coding-engines.js";
import { codingRunsForSessions, type CodingRunFact } from "../lib/board-runs.js";
import { refusingEngineIssue } from "../lib/coding-run-state.js";
import { listRepos, listSessions, reconcileOrphanedSessions } from "../lib/coding-store.js";
import { relayNameForInstance } from "../lib/runtime-nodes.js";
import { getDefaultRunnerConn, requireOwned } from "./coding-shared.js";
import type { Env } from "../types.js";

/** Parse a stored JSON column, falling back on corrupt/missing data instead of throwing —
 *  a malformed row must never 500 a whole route (esp. the diagnostics page users open to
 *  self-diagnose a broken runner). */
function parseJsonOr<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

async function closeCodingSessions(c: Context<{ Bindings: Env }>) {
	const { uid, instanceId } = await requireOwned(c);
	const conn = await getDefaultRunnerConn(c.env, instanceId, uid);
	if (!conn) return c.json({ error: "Runner not connected", runnerConnected: false }, 502);
	// Legacy runner path on purpose — an older runner has no /coding/close-sessions, and this
	// is the only endpoint that ever did the useful work.
	const result = await callRunner(conn, "/coding/kill-tmux", {}, { timeoutMs: READ_TIMEOUT_MS });
	return c.json(result);
}

export function registerDiagnosticsRoutes(codingRoutes: Hono<{ Bindings: Env }>) {
	/**
	 * Close every tracked coding session on the runner.
	 *
	 * `close-sessions` is the real name; `kill-tmux` remains as a deprecated alias because
	 * renaming a route buys nothing when nothing calls it, and an older console might (#247). The
	 * runner endpoint keeps its legacy path for the same version-skew reason.
	 */
	codingRoutes.post("/:instanceId/coding/close-sessions", async (c) => closeCodingSessions(c));
	codingRoutes.post("/:instanceId/coding/kill-tmux", async (c) => closeCodingSessions(c));

	/** List directories on the runner (for remote browsing). */
	codingRoutes.get("/:instanceId/coding/browse", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const conn = await getDefaultRunnerConn(c.env, instanceId, uid);
		if (!conn) return c.json({ error: "Runner not connected" }, 502);
		const dir = c.req.query("dir") || "~";
		const result = await callRunner(conn, "/coding/browse", { dir }, { timeoutMs: READ_TIMEOUT_MS });
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
			capabilities: parseJsonOr(runtimeRow?.capabilities, [] as unknown),
			runnerVersion: runtimeRow?.runner_version ?? null,
			runnerNode: runtimeRow?.runner_node ?? null,
			lastSeenAt: runtimeRow?.last_seen_at ?? null,
			registeredAt: runtimeRow?.created_at ?? null,
		};

		// 2. Live runner probe
		//
		// Live-checked since #532: this used to resolve off the registration row alone, so the
		// transparency view — the screen a user opens BECAUSE something is wrong — described a
		// machine that had been off for days as a connection, then reported the two failed commands
		// as if the machine had answered badly. `reachable` is still what the commands actually did;
		// what changed is that a dead machine no longer gets asked.
		const conn = await getRunnerConn(env, instanceId, uid, runtimeRow?.runner_node ?? null);
		let runnerHealth: unknown = null;
		let runnerDiag: unknown = null;
		let runnerReachable = false;
		// Named from the ROW, not the connection: the relay name is the thing you go and look at
		// when there is no connection, so it must survive the case that has none.
		const relayName = runtimeRow ? relayNameForInstance(instanceId, runtimeRow.runner_node ?? null) : null;
		if (conn) {
			try {
				runnerHealth = await callRunner<unknown>(conn, "/health", undefined, { timeoutMs: READ_TIMEOUT_MS });
				runnerReachable = true;
			} catch (e) {
				runnerHealth = { error: e instanceof Error ? e.message : String(e) };
			}
			try {
				runnerDiag = await callRunner<unknown>(conn, "/coding/diagnostics", undefined, { timeoutMs: READ_TIMEOUT_MS });
			} catch (e) {
				runnerDiag = { error: e instanceof Error ? e.message : String(e) };
			}
		}
		const relayIsConnected = await relayConnected(env, instanceId, runtimeRow?.runner_node ?? null);
		const effectivelyReachable = runnerReachable;

		(runner as Record<string, unknown>).reachable = effectivelyReachable;
		(runner as Record<string, unknown>).health = runnerHealth;

		// 3. D1 sessions + repos + the engine presets (needed to name each session's sign-in MODE,
		//    which is half of the auth report — the runner supplies the other half).
		const [dbSessions, dbRepos, { engines: diagEngines }] = await Promise.all([
			listSessions(env, instanceId, uid),
			listRepos(env, instanceId, uid),
			readEngines(env, instanceId, uid),
		]);

		// 3b. What the RUNS behind those sessions are doing (#593). The runner can only report that
		// a process is alive; whether it is WORKING is the run's own record, and `engine_limit` is
		// already a first-class park reason there (#541). Without this join the one failure mode
		// where the machine is healthy and the work is stopped is invisible to the tool named for
		// stuck sessions.
		const runsBySession = await codingRunsForSessions(
			env,
			instanceId,
			uid,
			dbSessions.filter((s) => s.status === "active").map((s) => s.id),
		).catch(() => new Map<string, CodingRunFact[]>());
		/** The newest run on a session, which is the one whose park is current. */
		const latestRunFor = (sessionId: string): CodingRunFact | undefined =>
			[...(runsBySession.get(sessionId) ?? [])].sort((a, b) => b.at - a.at)[0];

		// 4. Cross-reference D1 active sessions vs runner's tracked sessions
		const trackedIds = new Set<string>();
		// No tmux fields (#247): the coding engine spawns a child process, so the old
		// orphanedTmux/tmuxTotal/pagsTmuxTotal figures described something that could never exist
		// for these sessions. `engineLabel` replaces `tmuxSession`, which only ever looked like a
		// tmux target a user could attach to.
		const diagData = runnerDiag as { tracked?: Array<{ sessionId: string; alive: boolean; runState: string; paneLines: number; clientType: string; workDir: string; engineLabel: string; takeover: boolean; authResolved?: EngineAuthResolved }> } | null;
		if (diagData?.tracked) {
			for (const t of diagData.tracked) trackedIds.add(t.sessionId);
		}

		// Self-heal (#139): the runner is confirmed reachable, so any D1-`active` session it
		// isn't tracking is a genuine orphan (runner restart / machine reboot left the tmux
		// gone). Mark those ended so they stop showing as active forever and can't be reused
		// as dead sessions — instead of only detecting them and telling the user to kill each
		// by hand. Grace-windowed inside the store so a just-spawned session isn't reaped.
		let reconciled = new Set<string>();
		if (effectivelyReachable) {
			reconciled = new Set(await reconcileOrphanedSessions(env, instanceId, uid, trackedIds).catch(() => []));
		}

		const sessions = dbSessions.map((s) => {
			// Reflect a just-reconciled orphan as ended (D1 was updated above).
			if (reconciled.has(s.id)) {
				const repo = dbRepos.find((r) => r.id === s.repoId);
				return {
					id: s.id, repoId: s.repoId, repoName: repo?.name ?? s.repoId,
					status: "ended" as const, clientType: s.clientType,
					launchCommand: s.launchCommand ?? null, engineLabel: s.tmuxSession ?? null,
					// A reconciled orphan has no live process, so the outcome is genuinely unknown —
					// report the mode with resolved:null rather than omitting the field and making
					// the shape differ between branches.
					auth: engineAuthReport(engineAuthFor(diagEngines, s.launchCommand), null),
					startedAt: s.startedAt, endedAt: new Date().toISOString(), live: null,
					issue: null, reconciled: true,
				};
			}
			return mapDiagSession(s);
		});

		function mapDiagSession(s: (typeof dbSessions)[number]) {
			const tracked = diagData?.tracked?.find((t) => t.sessionId === s.id);
			const repo = dbRepos.find((r) => r.id === s.repoId);
			return {
				id: s.id,
				repoId: s.repoId,
				repoName: repo?.name ?? s.repoId,
				status: s.status,
				clientType: s.clientType,
				launchCommand: s.launchCommand ?? null,
				// Setting vs outcome, per session (#248) — the same pairing /capture reports, so the
				// diagnostics list answers "which of my sessions is billing per token?" at a glance.
				auth: engineAuthReport(engineAuthFor(diagEngines, s.launchCommand), tracked?.authResolved ?? null),
				// The D1 column is still called tmux_session (renaming it is a table rewrite for a
				// cosmetic gain); what it holds is an engine label. Surfaced honestly.
				engineLabel: s.tmuxSession ?? null,
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
		}

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
				urls: r.urls ?? null,
				activeSessions: activeSessions.length,
				issue: r.cloneStatus === "error" ? `clone failed: ${r.cloneError || "unknown error"}`
					: r.cloneStatus === "missing_url" ? "no clone URL and no local path"
					// #405 — the machine looked at this local path and it is not usable. Reported
					// here too: "the agent answers about a repo that isn't there" is exactly the
					// symptom someone opens this panel to explain.
					: r.cloneStatus === "needs_attention" ? r.cloneError || "the local path is not usable"
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
		} else if (runtimeRow.status === "offline" && !relayIsConnected) {
			issues.push({ severity: "error", message: "Runner status is offline", fix: "Restart `pags up` to reconnect" });
		} else if (!effectivelyReachable) {
			issues.push({ severity: "error", message: "Runner registered but not reachable", fix: "Restart `pags up` to reconnect" });
		}

		for (const s of sessions) {
			if (s.issue) issues.push({ severity: "warn", message: `Session ${s.id.slice(-8)} (${s.repoName}): ${s.issue}`, fix: s.issue.startsWith("orphaned") ? "Kill the session and start a new one" : "Restart the session from ⚙" });
			// An engine that is up and REFUSING (#593) — the case every rule above misses, because
			// every rule above is about the machine rather than the work.
			if (s.status === "active") {
				const refusal = refusingEngineIssue({
					sessionLabel: `${s.id.slice(-8)} (${s.repoName})`,
					alive: s.live?.alive === true,
					run: latestRunFor(s.id),
				});
				if (refusal) issues.push(refusal);
			}
		}
		for (const r of repos) {
			if (r.issue)
				issues.push({
					severity: "warn",
					message: `Repo "${r.name}": ${r.issue}`,
					fix:
						r.cloneStatus === "error"
							? "Delete and re-add the repo, or fix the clone URL"
							: r.cloneStatus === "needs_attention"
								? "Point the repo at the real checkout (⚙ Repo settings), or delete it — the agent cannot read code that isn't there"
								: undefined,
				});
		}

		const activeSessions = sessions.filter((s) => s.status === "active");
		// "Healthy" has to mean able to work, not merely running (#593). A session whose run is
		// parked on the engine's own usage limit was counted here, so the summary read
		// `healthySessions: 1, issueCount: 0` for an engine that had refused every instruction for
		// hours — the two numbers a reader checks first, both wrong in the same direction.
		const healthySessions = activeSessions.filter(
			(s) => s.live?.alive && !refusingEngineIssue({ sessionLabel: s.id, alive: true, run: latestRunFor(s.id) }),
		);

		return c.json({
			summary: {
				runnerOnline: effectivelyReachable,
				runnerStatus: runner.status,
				relayConnected: relayIsConnected,
				relayName,
				totalRepos: repos.length,
				totalSessions: sessions.length,
				activeSessions: activeSessions.length,
				healthySessions: healthySessions.length,
				issueCount: issues.filter((i) => i.severity === "error" || i.severity === "warn").length,
			},
			runner,
			relay: { connected: relayIsConnected, relayName, runnerNode: runtimeRow?.runner_node ?? null },
			// `tmux: {...}` is gone (#247). Every figure in it described something that cannot exist
			// for a coding session: pagsTmuxTotal was structurally 0, and tmuxTotal counted the
			// user's own unrelated tmux sessions. `engine.trackedSessions` is the honest version —
			// how many engine processes the runner is actually tracking.
			engine: diagData ? { trackedSessions: diagData.tracked?.length ?? 0 } : null,
			sessions,
			repos,
			githubApp,
			issues,
		});
	});
}
