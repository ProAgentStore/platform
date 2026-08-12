import { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { requirePro } from "../lib/billing.js";
import { callRunner, getBoundRunnerConn, relayConnected, READ_TIMEOUT_MS } from "../lib/runner-client.js";
import { resolveCloneCredential } from "../lib/git-credentials.js";
import {
	engineAuthFor,
	ENGINE_AUTHS,
	engineAuthReport,
	readEngines,
	resolveEngine,
	type CodingEngine,
	type EngineAuth,
	type EngineAuthResolved,
} from "../lib/coding-engines.js";
import { appendTimeline, clearChat, lastTerminalRow, loadChat, loadRepoTimeline, loadTerminalSnapshots, loadTimeline } from "../lib/coding-timeline.js";
import { shouldPersistSnapshot, terminalSnapshotContent } from "../lib/terminal-snapshot.js";
import { logError } from "../lib/error-log.js";
import {
	claimSessionDriver,
	createSession,
	endSession,
	getActiveSessionForRepo,
	getRepo,
	getSession,
	listSessions,
	touchSessionActivity,
} from "../lib/coding-store.js";
import { getRuntime, getRuntimeForNode, normalizeRunnerNode, mirrorRuntimeTask } from "./instances-runtime.js";
import { logEvent } from "../lib/events.js";
import { authPromptGuidance, detectAuthPrompt } from "../lib/engine-auth-prompt.js";
import { readInstanceRunnerNode } from "../lib/runtime-nodes.js";
import { recordEngineActs, sanitizeEngineActs } from "../lib/engine-acts.js";
import { sanitizeEngineUsage } from "../lib/engine-usage.js";
import { recordEngineUsage } from "../lib/usage.js";
import { continuityForNewSession, startSessionOnRunner } from "../lib/coding-session-open.js";
import type { CodingActionKind, CodingGoal } from "../lib/coding-loop.js";
import type { CodingSessionRecord } from "../lib/coding-types.js";
import type { Env } from "../types.js";
import { patchInstanceConfig, touchInstanceActivity } from "../lib/instance-config.js";
import { registerCopilotRoutes } from "./coding-brains.js";
import { registerDiagnosticsRoutes } from "./coding-diagnostics.js";
import { registerPullRoutes } from "./coding-pulls.js";
import { registerRepoRoutes } from "./coding-repos.js";
import { getSessionRunnerConn, readSpecialInstructions, requireOwned } from "./coding-shared.js";

// `startSessionOnRunner` moved to `lib/coding-session-open.ts` (#271): it was private to this
// module, which is why the autonomous delegation path could not open a session and had to 409
// instead. Same implementation, now reachable from both.

/**
 * The coding-workspace control plane (the AgentCoder port). A workspace IS the
 * agent instance; these routes manage its repos + coding sessions and proxy the
 * brain-driven controls to the user's local runner. Mounted on `/v1/instances`.
 *
 * ── The shape of this file after #305
 *
 * What is left HERE is the SESSION LIFECYCLE: open one, attach it to a machine, watch its
 * terminal, drive it, end it. Three neighbours were split out along the boundaries the
 * registrations already had, and each is called from the exact position its block occupied —
 * Hono matches in registration ORDER, so moving a block past a sibling pattern would be a
 * behaviour change even where the route SET is unchanged:
 *
 *   `coding-repos.ts`       what the agent is pointed at (repos, builds, issues, work mode)
 *   `coding-brains.ts`      the three routes that call a MODEL (Co-pilot, Agent chat, Overseer)
 *   `coding-diagnostics.ts` the reconcile-and-explain surface
 *   `coding-shared.ts`      the tenant gate + the four things all four modules need
 *
 * `coding.contract.test.ts` derives the route table, the registration order, and what each
 * module owns by DRIVING the registered handlers — so the split is evidenced rather than
 * described, and a route that loses its tenant gate moves in a pinned table.
 */
export const codingRoutes = new Hono<{ Bindings: Env }>();

// ── Repos ────────────────────────────────────────────────────────────────
registerRepoRoutes(codingRoutes);

// ── Pull requests (#401) ─────────────────────────────────────────────────
// Registered here, directly after the repo block, because that is where the surface it belongs to
// ends — Hono matches in registration ORDER and `coding.contract.test.ts` pins it.
registerPullRoutes(codingRoutes);

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

/** Save the engine presets + default. Each = { id, label, command, auth? }. */
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
		const auth = ENGINE_AUTHS.has(e.auth as EngineAuth) ? (e.auth as EngineAuth) : undefined;
		engines.push(auth && auth !== "auto" ? { id, label, command, auth } : { id, label, command });
	}
	if (!engines.length) throw new HttpError(400, "At least one engine with a label and command is required.");
	const defaultEngineId = engines.some((e) => e.id === body.defaultEngineId) ? String(body.defaultEngineId) : engines[0].id;
	// Two keys, two patches (#231) — still strictly better than one whole-blob write, which
	// could drop an unrelated key entirely rather than merely interleaving these two.
	await patchInstanceConfig(c.env, instanceId, uid, "codingEngines", engines);
	await patchInstanceConfig(c.env, instanceId, uid, "defaultEngineId", defaultEngineId);
	return c.json({ engines, defaultEngineId });
});

/** Create a coding session against a repo and start it on the runner (best-effort). */
codingRoutes.post("/:instanceId/coding/sessions", async (c) => {
	const { uid, instanceId, session: authSession } = await requireOwned(c);
	// Coding sessions run on the local runner — a Pro feature. Gate creation so the
	// console gets a clear 402 instead of a confusing runner-offline error.
	await requirePro(c.env, authSession);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const repoId = String(body.repoId ?? "");
	const repo = await getRepo(c.env, instanceId, uid, repoId);
	if (!repo) throw new HttpError(404, "Repo not found");

	// One active session per repo — a second would share the repo's single working
	// directory and conflict (concurrent edits, git index races). Reuse the live one.
	const existing = await getActiveSessionForRepo(c.env, instanceId, uid, repoId);
	if (existing) {
		const runnerConnected = (await startSessionOnRunner(c.env, instanceId, uid, existing, repo)).conn != null;
		return c.json({ session: existing, runnerConnected, reused: true }, 200);
	}

	// Resolve which engine to launch: the chosen preset (engineId), else the repo's
	// remembered default, else the instance default engine.
	const { command, clientType } = await resolveEngine(c.env, instanceId, uid, body.engineId ?? body.clientType ?? repo.defaultClient);
	// Which machine runs this session: an explicit request wins, else the instance's
	// node PIN (config.runnerNode) so the Coding tab honors "Runs on" exactly like chat/
	// apply do, else the legacy default runtime. A pinned/requested node that's offline is
	// a hard 409 (don't silently run on a different machine than the user chose).
	const requestedRunnerNode = normalizeRunnerNode(body.runnerNode) || await readInstanceRunnerNode(c.env, instanceId, uid).catch(() => "");
	const runtimeNow = requestedRunnerNode
		? await getRuntimeForNode(c.env, instanceId, uid, requestedRunnerNode)
		: await getRuntime(c.env, instanceId, uid);
	// Live check, not the DB `status` — that column isn't cleared when a runner drops, so a
	// pinned machine that closed its laptop still reads "registered" and the old guard passed,
	// stamping a session onto a dead node (silent `runnerConnected:false` instead of a clear 409).
	if (requestedRunnerNode) {
		const live = await relayConnected(c.env, instanceId, requestedRunnerNode).catch(() => false);
		if (!runtimeNow || !live) throw new HttpError(409, `Runner node is not connected: ${requestedRunnerNode}`);
	}
	// Stamp the owning machine so later commands route back to the same runner.
	let session: CodingSessionRecord;
	try {
		session = await createSession(c.env, instanceId, uid, {
			repoId,
			clientType,
			launchCommand: command,
			issueNumber: typeof body.issueNumber === "number" ? body.issueNumber : undefined,
			issueTitle: typeof body.issueTitle === "string" ? body.issueTitle : undefined,
			runnerNode: runtimeNow?.runner_node ?? null,
		});
	} catch {
		// Lost a create race against the one-active-session-per-repo index — reuse
		// whoever won instead of erroring.
		const winner = await getActiveSessionForRepo(c.env, instanceId, uid, repoId);
		if (!winner) throw new HttpError(409, "Could not start a session — try again.");
		const runnerConnected = (await startSessionOnRunner(c.env, instanceId, uid, winner, repo)).conn != null;
		return c.json({ session: winner, runnerConnected, reused: true }, 200);
	}

	// This route CREATES a session, so it decides continuity exactly like `ensureActiveSession`
	// does (#408). Both open paths must agree: a repo re-opened from the console and the same repo
	// re-opened by the agent's own tool would otherwise start with different memories.
	// `fresh: true` is the console's **Fresh** button and MCP's `coding_session_fresh`, both of
	// which end a session and open another in the same breath. Without the flag the policy would
	// resume the session they just ended — the one the user is trying to get away from.
	const continuity = await continuityForNewSession(c.env, instanceId, uid, repoId, clientType, { forceFresh: body.fresh === true });
	const started = await startSessionOnRunner(c.env, instanceId, uid, session, repo, { resumeFrom: continuity.resumeFrom });
	// Bump last_activity_at — starting a coding session is a real user-driven event.
	void touchInstanceActivity(c.env, instanceId, uid);
	return c.json({ session, runnerConnected: started.conn != null, resumed: started.resumed, continuity }, 201);
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
	await touchSessionActivity(c.env, instanceId, uid, session.id);
	const runnerConnected = (await startSessionOnRunner(c.env, instanceId, uid, session, repo)).conn != null;
	return c.json({ ok: runnerConnected, runnerConnected });
});

/** The pane the console renders (polling fallback for the live terminal). */
codingRoutes.get("/:instanceId/coding/sessions/:sessionId/capture", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const session = await getSession(c.env, instanceId, uid, sessionId);
	if (!session) throw new HttpError(404, "Session not found");
	// Somebody is watching this session (#275). The 3s poll is the strongest "a human has this
	// open" signal the platform has, and it is what keeps the idle reaper away from a session
	// anyone is actually looking at. Throttled to one write a minute inside the store.
	await touchSessionActivity(c.env, instanceId, uid, sessionId);
	const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
	if (!conn) return c.json({ pane: "", runState: "idle", alive: false, ready: false, runnerConnected: false });
	// `drainUsage` — this poll is the primary carrier for Engine spend (#267). It runs every 3s
	// per open session, so it is where the CLI's own per-turn cost report is collected. Only the
	// paths that actually write the ledger ask to drain; the other capture callers must not
	// consume records they would then discard.
	const snap = await callRunner(conn, "/coding/capture", { sessionId, drainUsage: true }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
	if (!snap) return c.json({ pane: "", runState: "idle", alive: false, ready: false, runnerConnected: true });
	// The SAME snapshot carries what the engine authenticated with, and it is the only place in
	// the system that knows: the credential is decided by a merge with the machine's own shell,
	// which happens on the runner. It was already being displayed further down this handler and
	// then thrown away (#346) — so a ledger row could say what a turn was WORTH but never who
	// pays, which is what let a money ceiling fire on a subscription (#343). Persist it here,
	// where the value and the observation are in hand together.
	const resolvedAuth = ((snap as { authResolved?: unknown }).authResolved ?? null) as EngineAuthResolved | null;
	await recordEngineUsage(
		c.env,
		{ userId: uid, sessionId, instanceId, authResolved: resolvedAuth },
		sanitizeEngineUsage((snap as { usage?: unknown }).usage),
	);
	// What the Engine actually DID (#294). The same drain carries it, so this poll records a merge
	// or a force-push whether or not a Pilot is driving — a human-driven session is exactly as
	// capable of merging to `main`, and leaving it out would make the record depend on who started
	// the work rather than on what was done.
	await recordEngineActs(
		c.env,
		{ userId: uid, sessionId, instanceId },
		sanitizeEngineActs((snap as { acts?: unknown }).acts),
	).catch(() => undefined);
	// An engine blocked on sign-in looks EXACTLY like a hung session: idle runState, a pane that
	// stops changing, no error anywhere. Surfacing it here means the console can say "sign in"
	// instead of the owner watching a dead terminal and concluding the platform is broken.
	const authPrompt = detectAuthPrompt(String((snap as { pane?: unknown }).pane ?? ""));

	// Persist the transcript. Until #275 the ONLY writer was /explain (the Co-pilot), so anyone
	// working in the Terminal view had nothing saved at all: the pane lived in the runner's memory
	// and died with `pags up`.
	//
	// The gate was an inline "idle AND changed" test, which optimised the case where nothing is
	// happening and failed the case where everything is — a session busy since it started never
	// reached it, so a 40-step Loop run persisted NOTHING and reopening the tab showed the empty
	// placeholder over an hour of real work (#432). It is now changed + (idle OR throttled), which
	// leaves idle behaviour identical and adds coverage during a run. The arithmetic and the
	// SQLite-timestamp parsing are in `lib/terminal-snapshot.ts`, tested.
	//
	// The dedup compares what will be STORED, not the raw pane (#466). It used to compare the
	// runner's full 64 KB pane against `lastTerminal`'s 8,000-char tail — unequal by construction,
	// so the gate never suppressed anything and an idle open session appended an identical 8 KB row
	// on every poll. Measured: 6,936 production rows holding 329 distinct panes.
	const pane = String((snap as { pane?: unknown }).pane ?? "");
	const runState = String((snap as { runState?: unknown }).runState ?? "");
	const stored = terminalSnapshotContent(pane);
	if (stored) {
		const last = await lastTerminalRow(c.env, sessionId);
		if (shouldPersistSnapshot({ pane, lastContent: last?.content ?? null, lastAt: last?.createdAt ?? null, runState, now: Date.now() })) {
			await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "terminal", content: stored }).catch(() => undefined);
		}
	}

	// Which credential this engine actually ran on, and what the engine actually is (#248). The
	// preset's SETTING is known here; only the runner can know the OUTCOME, because the merge with
	// the machine's own shell happens there — so pair the two and let `engineAuthReport` say when
	// they disagree. A runner too old to report `authResolved` yields null, i.e. "unknown", never
	// a restatement of the setting.
	const { engines } = await readEngines(c.env, instanceId, uid);
	const auth = engineAuthReport(engineAuthFor(engines, session.launchCommand), resolvedAuth);

	// `usage` is drained, so it appears on one poll in a hundred and is empty on the rest. Passing
	// that to the console would look like a field that flickers; it has been ledgered above and
	// belongs on the Usage page, not in the terminal payload.
	const { usage: _drained, acts: _drainedActs, ...paneSnap } = snap as Record<string, unknown>;
	return c.json({
		...paneSnap,
		runnerConnected: true,
		auth,
		...(authPrompt ? { authPrompt: { ...authPrompt, guidance: authPromptGuidance(authPrompt) } } : {}),
	});
});

/**
 * Relay an engine's sign-in into the RUNNER's browser (#coding-auth).
 *
 * Engine CLIs authenticate with a loopback redirect: a server on 127.0.0.1:PORT expecting a
 * browser on that machine. Mailing the URL to the owner's laptop cannot work — the redirect would
 * hit THEIR localhost, where nothing listens, and the same IP does not help because it is
 * literally 127.0.0.1 on the runner.
 *
 * So the page is opened in the browser that already runs on the runner, and handed to the human
 * through the takeover relay that solves reCAPTCHAs in the apply flow. The redirect then lands
 * exactly where the CLI is listening. No new runner capability: navigate + handoff + input all
 * exist already.
 */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/signin", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const session = await getSession(c.env, instanceId, uid, sessionId);
	if (!session) throw new HttpError(404, "Session not found");
	const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
	if (!conn) throw new HttpError(409, "No runner connected — start it with: pags up");

	// Re-read the pane rather than trusting a client-supplied URL: this navigates a real browser
	// on the owner's machine, so the destination must come from what the ENGINE actually printed.
	const snap = await callRunner<{ pane?: string }>(conn, "/coding/capture", { sessionId }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
	const prompt = detectAuthPrompt(String(snap?.pane ?? ""));
	if (!prompt) throw new HttpError(409, "This engine isn't waiting for a sign-in right now.");
	if (!prompt.url) {
		// A menu with no URL cannot be relayed by opening a link — the human has to drive the CLI
		// itself. Saying so beats a button that appears to do nothing.
		return c.json({ ok: false, kind: prompt.kind, guidance: authPromptGuidance(prompt), evidence: prompt.evidence }, 200);
	}

	const taskId = `signin-${sessionId}`;
	// Flat body with `action` as a STRING — the shape lib/connectors/browser.ts uses. A nested
	// {action:{kind,url}} silently does nothing, which is the worst possible failure here: the
	// button reports success and no page ever opens.
	const nav = await callRunner<{ ok?: boolean }>(conn, "/browser/act", { action: "navigate", url: prompt.url }).catch(() => null);
	if (!nav) throw new HttpError(502, "Couldn't open the sign-in page in the runner's browser.");
	// The board card MUST exist before the handoff. The runner's /browser/handoff registers the
	// takeover in memory and then does `const task = this.store.getTask(taskId); if (task) {…}` —
	// the whole `needs_human` status flip and the human_handoff_required event live inside that
	// `if`. With an invented taskId no such task existed, so none of it ran: the button reported
	// success, the console said "take over the browser to finish signing in", and the Board (which
	// surfaces takeovers from `needs_human` tasks) showed nothing at all. The sign-in page sat open
	// on a machine the user may not be at, with no surface to drive it — while `authPromptGuidance`
	// told them to "open the takeover view".
	// …and "MUST" has to mean it. Both of these were `.catch(() => undefined)` directly under that
	// paragraph, so the very failure it describes still shipped: card lost, `if (task)` false, no
	// needs_human flip, no board entry — and the route below still answered ok:true with
	// `authPromptGuidance` telling the owner to open a takeover view that does not exist.
	const carded = await mirrorRuntimeTask(c.env, instanceId, uid, {
		id: taskId,
		type: "engine.signin",
		status: "needs_human",
		title: "Sign in to the coding engine",
		subtitle: (() => { try { return new URL(prompt.url as string).host; } catch { return null; } })(),
		reasoning: authPromptGuidance(prompt),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}).then(() => true, () => false);
	if (!carded) throw new HttpError(502, "The sign-in page is open in the runner's browser, but the board card that drives the takeover couldn't be created. Try again.");
	await callRunner<{ ok: boolean }>(conn, "/browser/handoff", {
		taskId,
		label: "Engine sign-in",
		reason: "challenge",
	});

	await logEvent(c.env, {
		source: "coding",
		event: "signin_relay",
		message: `Opened engine sign-in for ${session.id} in the runner's browser`,
		userId: uid,
		instanceId,
		traceId: sessionId,
		context: { taskId, host: (() => { try { return new URL(prompt.url as string).host; } catch { return null; } })() },
	}).catch(() => undefined);

	return c.json({ ok: true, kind: prompt.kind, taskId, url: prompt.url, guidance: authPromptGuidance(prompt) }, 200);
});

/**
 * Aggregate live status for ALL of this instance's active coding sessions in ONE call —
 * status only (runState), no terminal panes — so the console can poll once instead of N
 * per-session /capture calls. Owner-scoped; bounded fan-out to the runner. (CODER-006, #82)
 */
codingRoutes.get("/:instanceId/coding/status", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessions = (await listSessions(c.env, instanceId, uid)).filter((s) => s.status === "active");
	// Resolve the runner the way every other route does. `relayConnected(…, null)` names the
	// RelayDO `instanceId` with no node suffix, but every runner since the relay handshake
	// connects with `?node=<hostname>` — so its DO is `${instanceId}:node:${hostname}` and the
	// bare-name DO has never had a socket. This field was therefore ALWAYS false, contradicting
	// the per-session `runnerConnected` values computed correctly just below it.
	const runnerConnected = !!(await getBoundRunnerConn(c.env, instanceId, uid).catch(() => null));
	const CONCURRENCY = 6;
	const out: Array<{ sessionId: string; repoId: string; runState: string; runnerConnected: boolean }> = [];
	for (let i = 0; i < sessions.length; i += CONCURRENCY) {
		const batch = sessions.slice(i, i + CONCURRENCY);
		const settled = await Promise.allSettled(
			batch.map(async (s) => {
				const conn = await getSessionRunnerConn(c.env, instanceId, uid, s);
				if (!conn) return { sessionId: s.id, repoId: s.repoId, runState: "idle", runnerConnected: false };
				const snap = await callRunner<{ runState?: string }>(conn, "/coding/capture", { sessionId: s.id }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
				return { sessionId: s.id, repoId: s.repoId, runState: snap?.runState || "idle", runnerConnected: true };
			}),
		);
		for (const r of settled) if (r.status === "fulfilled") out.push(r.value);
	}
	return c.json({ runnerConnected, sessions: out });
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

// ── The model-driven three: Co-pilot, Agent chat, Overseer ───────────────
registerCopilotRoutes(codingRoutes);

/** Load a session's persisted conversation (so the console restores it on open). */
codingRoutes.get("/:instanceId/coding/sessions/:sessionId/timeline", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
	if (!session) throw new HttpError(404, "Session not found");
	await touchSessionActivity(c.env, instanceId, uid, session.id);
	// ?terminal=1 → a PAGE of terminal snapshots, for the Terminal view's scrollback (#432).
	//
	// This is the read the console makes when a session opens, and it exists because `?full=1`
	// was being used for it: the whole typed timeline crossed the network so the client could
	// keep the last `terminal` row and throw the rest away. A long run at 8000 chars a snapshot
	// is a large payload for one visible pane, and there was no way to ask for the older ones.
	// `before` is an exclusive `seq` cursor, `limit` is bounded in the store, and `hasMore` says
	// whether "Load older" has anything to load.
	if (c.req.query("terminal") === "1") {
		const before = Number.parseInt(c.req.query("before") ?? "", 10);
		const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
		const page = await loadTerminalSnapshots(c.env, {
			sessionId: session.id,
			before: Number.isFinite(before) ? before : undefined,
			limit: Number.isFinite(limit) ? limit : undefined,
		});
		return c.json({ terminal: page.entries, hasMore: page.hasMore, oldestSeq: page.oldestSeq });
	}
	// ?full=1 → the full typed timeline (chat + terminal snapshots + brain decisions + commands
	// + outcomes). Kept unpaged on purpose: its one caller is the ⧉ "copy this session as JSON"
	// button, an explicit one-shot action where the whole thing IS what was asked for. The
	// console's session-open path no longer uses it.
	if (c.req.query("full") === "1") {
		return c.json({ chat: await loadChat(c.env, session.id), timeline: await loadTimeline(c.env, session.id) });
	}
	return c.json({ chat: await loadChat(c.env, session.id) });
});

/**
 * A REPO's whole history, across every session it has ever had (#257).
 *
 * The session-scoped route above answers "what happened in this session", which is only useful
 * while a session exists — and the platform ends them by itself constantly (the Pilot closes one
 * on every finished run; the reaper closes the rest on each `pags up` restart). This answers the
 * question the user actually asks, which is "what has happened in this repo", and it never 404s
 * for want of a live session.
 *
 * Lives with the other two timeline routes rather than in `coding-repos.ts` (#305): what it reads
 * is the SESSION transcript, and all three answer "what was said in this thread" off the same
 * `coding_timeline` store. The repo is the key it groups by, not the subject.
 */
codingRoutes.get("/:instanceId/coding/repos/:repoId/timeline", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
	if (!repo) throw new HttpError(404, "Repo not found");
	const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
	const timeline = await loadRepoTimeline(c.env, {
		instanceId,
		userId: uid,
		repoId: repo.id,
		limit: Number.isFinite(limit) ? limit : undefined,
	});
	return c.json({ timeline });
});

/** Clear a session's conversation thread (keeps the activity log). */
codingRoutes.delete("/:instanceId/coding/sessions/:sessionId/timeline", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
	if (!session) throw new HttpError(404, "Session not found");
	await clearChat(c.env, session.id, uid, instanceId);
	return c.json({ ok: true });
});

/** Send a message straight to the CLI (manual drive, no brain). Keystrokes are refused — see below. */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/message", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const session = await getSession(c.env, instanceId, uid, sessionId);
	if (!session) throw new HttpError(404, "Session not found");
	// A keystroke has never been deliverable here, and this route used to answer one with an
	// ordinary 200 and a fresh snapshot (#448). The engine is a child process with no PTY, so
	// `HeadlessSession.key()` only pushed a line into the transcript; a caller reading
	// `{status, pane}` had no reason to parse it, and "sent, nothing happened" was
	// indistinguishable from success. That cost a full 40-decision BYOK run once — the reasoning
	// is written out at `lib/coding-loop.ts` where `press_keys` was withdrawn from the brain's
	// tool list. The brain was fixed there; the HTTP boundary was not, and the boundary is where
	// the claim is made. Refusing HERE rather than only on the runner is deliberate: a published
	// `@proagentstore/cli` older than this change still accepts `{kind:"keys"}` and no-ops it, so
	// the cloud has to be the one that says no.
	//
	// AFTER `getSession` on purpose: the sibling routes (`resume`, `restart`) 404 an unknown
	// session first, and a 409 raised ahead of the lookup would invert that ordering.
	if (typeof body.keys === "string") {
		throw new HttpError(
			409,
			"This session has no terminal attached, so a keystroke can't be delivered — a human needs to answer the prompt. Phrase the answer as an instruction and send it as {\"text\": \"...\"} on this route, or restart the engine with POST /v1/instances/:id/coding/sessions/:sid/restart.",
		);
	}
	const action: CodingActionKind = { kind: "message", text: String(body.text ?? "") };
	// An empty instruction is not deliverable either (#504), for the same reason a keystroke isn't:
	// `session.input("")` writes an empty user turn to the engine's stdin, which flips the pane to
	// "thinking" and answers 200 with a snapshot — indistinguishable from having sent something. The
	// Pilot is guarded in `runCodingLoop`; this is the other door into `/coding/act`, and MCP's
	// `coding_session_message` passes its argument straight through it.
	if (!action.text.trim()) {
		throw new HttpError(400, "An instruction can't be empty — send the text you want the engine to act on.");
	}
	await touchSessionActivity(c.env, instanceId, uid, sessionId);
	// `chat:true` = sent from the Agent chat (relay my words to Claude on my behalf),
	// so persist it as a chat turn (survives reload) — not just the raw command log.
	const fromChat = body.chat === true;
	const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
	if (!conn) throw new HttpError(409, "No coding runner connected. Start it with: pags up");
	if (action.kind === "message" && action.text) {
		// Log the user's clean text first…
		await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: fromChat ? "chat_user" : "command", content: action.text }).catch(() => undefined);
		// …then prepend the combined rules (instance Special Instructions + per-repo
		// Rules) before sending to the CLI. Manual sends bypass the autonomous brain
		// (which injects rules into its own prompt), so without this the CLI never sees
		// them. This makes the rules bind the CLI no matter how it's driven.
		const repo = session ? await getRepo(c.env, instanceId, uid, session.repoId) : null;
		const combined = [await readSpecialInstructions(c.env, instanceId, uid), repo?.instructions].filter(Boolean).join("\n\n");
		if (combined) action.text = `[Project rules — follow these for everything you do:\n${combined}\n]\n\n${action.text}`;
	}
	let snap = await callRunner(conn, "/coding/act", { sessionId, action }).catch(() => null);
	if (snap === null) {
		// The runner is online but lost the in-memory session (it restarted) — its
		// tmux pane usually survives, so reattach (CodingSession.start reconnects to
		// the live tmux, no new CLI) and retry once. On a machine SWITCH, startSessionOnRunner
		// relocates the session and returns the LIVE machine's connection — retry on that, not
		// the captured `conn` (which points at the old, now-dead machine → 409).
		const fresh = await getSession(c.env, instanceId, uid, sessionId);
		const repo = fresh ? await getRepo(c.env, instanceId, uid, fresh.repoId) : null;
		const relocated = fresh && repo ? (await startSessionOnRunner(c.env, instanceId, uid, fresh, repo)).conn : null;
		snap = await callRunner(relocated ?? conn, "/coding/act", { sessionId, action }).catch(() => null);
	}
	if (snap === null) throw new HttpError(409, "This session isn't live on the runner — open it again (or run pags up).");

	// Drove the CLI with a real instruction → spin up a durable watcher that waits
	// for it to finish, then summarizes + notifies (reaches the user even if they
	// close the console). Each send supersedes the prior watcher: we stamp the
	// session with this watcher's id, and a watcher only notifies if it's still the
	// stamped one — so several sends can't fire several push notifications for one
	// completion.
	if (action.kind === "message" && action.text) {
		const repo = session ? await getRepo(c.env, instanceId, uid, session.repoId) : null;
		const watchId = `cw-${sessionId}-${Date.now()}`;
		// The stamp IS the supersession rule, so losing it inverts it: the column still holds the
		// PREVIOUS send's watchId, this watcher stands down as "superseded by a newer send", and the
		// stale one — still stamped — announces "✅ Coder finished" against the earlier instruction.
		// A wrong completion notice is worse than a missing one; start no watcher unless it can win.
		const stamped = await c.env.DB.prepare(
			"UPDATE coding_sessions SET watch_workflow_id = ?1 WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4",
		)
			.bind(watchId, sessionId, instanceId, uid)
			.run()
			.then(() => true, () => false);
		const noWatcher = () =>
			appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "system", content: "(Couldn't start the progress watcher — I won't auto-report when this finishes; ask me for an update.)" }).catch(() => undefined);
		if (!stamped) await noWatcher();
		else
			await c.env.CODING_SESSION.create({
				id: watchId,
				params: {
					instanceId,
					userId: uid,
					sessionId,
					repoId: repo?.id ?? "",
					runnerNode: session.runnerNode ?? null,
					mode: "watch",
					watchId,
					goal: { objective: action.text, repo: repo?.name ?? "your repo", clientType: session?.clientType ?? "claude" },
				},
			}).catch(noWatcher);
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

	// One driver per engine (#208). Claimed BEFORE the workflow is created, because the damage
	// isn't a duplicate row — it's two Pilots typing into the same tmux pane, each reasoning over
	// a terminal the other is also writing to. A 409 is the honest answer: the work IS already
	// running, and starting a second one would corrupt the first.
	const driverId = crypto.randomUUID();
	if (!(await claimSessionDriver(c.env, instanceId, uid, sessionId, driverId))) {
		throw new HttpError(409, "This session is already being driven — stop the current run before starting another.");
	}

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
	// One credential seam for every provider (#221) — see lib/git-credentials.ts.
	const credential = await resolveCloneCredential(c.env, uid, repo);
	const wf = await c.env.CODING_SESSION.create({
		params: {
			instanceId,
			userId: uid,
			sessionId,
			repoId: repo.id,
			runnerNode: session.runnerNode ?? null,
			cloneUrl: repo.cloneUrl,
			branch: repo.branch || undefined,
			token: credential?.token,
			tokenUsername: credential?.username,
			goal,
			driverId,
		},
	});
	return c.json({ workflowId: wf.id, sessionId });
});

/** Resolve a brain handoff: the human finished, so the workflow may resume. */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/resume", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const session = await getSession(c.env, instanceId, uid, sessionId);
	if (!session) throw new HttpError(404, "Session not found");
	const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
	if (!conn) throw new HttpError(409, "No coding runner connected");
	await touchSessionActivity(c.env, instanceId, uid, sessionId);
	// `body.value` is the human's answer to a blocked engine — a 2FA code, a field the agent could
	// not fill. Swallowing the delivery reported it landed and threw it away: the Pilot goes on
	// polling /coding/takeover-status, never sees `resolved`, and closes the run
	// "<reason> not resolved in time" — a run recorded as the HUMAN's timeout when the human did
	// answer. Same rule the ticket-cancel route states: don't report success for a call that failed.
	const delivered = await callRunner(conn, `/coding/takeover/${encodeURIComponent(sessionId)}/resolve`, {
		value: typeof body.value === "string" ? body.value : undefined,
	}).then(() => true, () => false);
	if (!delivered) throw new HttpError(502, "Couldn't hand your answer to the coding runner — it's still waiting. Try again.");
	return c.json({ ok: true });
});

/** End a session: stop the runner's tmux + close the D1 record. */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/end", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const session = await getSession(c.env, instanceId, uid, sessionId);
	const conn = session ? await getSessionRunnerConn(c.env, instanceId, uid, session) : null;
	// Ending returns whatever spend has not been drained yet (#267). The last turn of a session
	// routinely completes after the final capture poll, so without this the ledger would lose the
	// closing turn of EVERY session — a bias, not noise.
	// Stopping the engine is the POINT of ending a session; closing only the D1 row tidies the
	// database and leaves the child process running (`coding-session-sweeper` says exactly this).
	// The failure used to be swallowed into `null`, so the row flipped to `ended`, the route
	// answered `{ok:true}`, and an orphaned CLI kept editing the repo with its session id no
	// longer in `coding_sessions` — nothing could find it again. The row still has to close (a
	// session the user ended must stop claiming to be active), so: close it, but say so honestly
	// and durably rather than reporting a clean stop that did not happen.
	let stopError: string | null = null;
	const ended = conn
		? await callRunner<{ usage?: unknown; acts?: unknown }>(conn, "/coding/end", { sessionId }).catch((e) => {
				stopError = e instanceof Error ? e.message : String(e);
				return null;
			})
		: null;
	if (stopError) {
		await logError(c.env, {
			source: "coding",
			userId: uid,
			message: `Failed to stop the engine while ending session ${sessionId}: ${stopError}`,
			context: { instanceId, sessionId, runnerNode: session?.runnerNode ?? null },
		});
	}
	await recordEngineUsage(c.env, { userId: uid, sessionId, instanceId }, sanitizeEngineUsage(ended?.usage));
	// Same tail problem, sharper consequence (#294): a coding session very often ENDS with the
	// consequential act — push, open the PR, merge it — so acts drained only on capture would
	// systematically miss the last and most important one of every session.
	await recordEngineActs(c.env, { userId: uid, sessionId, instanceId }, sanitizeEngineActs(ended?.acts)).catch(() => undefined);
	const ok = await endSession(c.env, instanceId, uid, sessionId);
	return c.json(
		stopError
			? {
					ok,
					engineStopped: false,
					warning: `The session is closed, but the engine on ${session?.runnerNode || "your machine"} did not confirm it stopped — it may still be running. Check Diagnostics → Sessions, or \`ps\`, if the repo keeps changing.`,
				}
			: { ok },
	);
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
	const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
	if (!conn) return c.json({ ok: false, runnerConnected: false });
	await touchSessionActivity(c.env, instanceId, uid, session.id);
	// Restart is kill-then-relaunch under the SAME session id. Swallowing the kill meant a failed
	// stop still fell through to the relaunch, putting TWO engine processes on one working tree —
	// the exact race `coding/headless.ts` guards against, and the one restart exists to escape.
	// A wedged engine is recoverable; two engines writing the same checkout corrupts the work. So
	// a failed stop aborts the restart instead of doubling the problem.
	const stopFailed = await callRunner(conn, "/coding/end", { sessionId: session.id }).then(
		() => null,
		(e: unknown) => (e instanceof Error ? e.message : String(e)),
	);
	if (stopFailed) {
		await logError(c.env, {
			source: "coding",
			userId: uid,
			message: `Refused to restart session ${session.id}: the running engine did not stop (${stopFailed})`,
			context: { instanceId, sessionId: session.id, repoId: repo.id },
		});
		return c.json(
			{
				ok: false,
				runnerConnected: true,
				error: "Could not stop the running engine, so it was not relaunched — restarting anyway would leave two engines editing this repo at once. Try again, or end the session from Diagnostics → Sessions.",
			},
			409,
		);
	}
	const started = await startSessionOnRunner(c.env, instanceId, uid, session, repo);
	if (!started.conn) {
		// Re-read the repo to get the clone error
		const freshRepo = await getRepo(c.env, instanceId, uid, session.repoId);
		return c.json({ ok: false, runnerConnected: true, error: freshRepo?.cloneError || "Failed to start session on runner" });
	}
	return c.json({ ok: true, runnerConnected: true });
});

// ── Diagnostics: close-sessions / browse / the reconcile-and-explain view ─
registerDiagnosticsRoutes(codingRoutes);
