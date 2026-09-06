import type { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { requirePro } from "../lib/billing.js";
import { ENGINE_AUTHS, engineAuthFor, engineAuthReport, engineInvocationReport, readEngines, resolveEngine, reusedEngineNotice, type CodingEngine, type EngineAuth, type EngineAuthResolved } from "../lib/coding-engines.js";
import { resolveRunState } from "../lib/coding-run-state.js";
import { continuityForNewSession, startSessionOnRunner } from "../lib/coding-session-open.js";
import { createSession, getActiveSessionForRepo, getRepo, getSession, listSessions, touchSessionActivity } from "../lib/coding-store.js";
import { appendEngineUsageTimeline, appendTimeline, lastTerminalRow } from "../lib/coding-timeline.js";
import type { CodingSessionRecord } from "../lib/coding-types.js";
import { recordEngineActs, sanitizeEngineActs } from "../lib/engine-acts.js";
import { authPromptGuidance, detectAuthPrompt } from "../lib/engine-auth-prompt.js";
import { sanitizeEngineUsage } from "../lib/engine-usage.js";
import { logEvent } from "../lib/events.js";
import { patchInstanceConfig, touchInstanceActivity } from "../lib/instance-config.js";
import { READ_TIMEOUT_MS, callRunner, getBoundRunnerConn, relayConnected } from "../lib/runner-client.js";
import { readInstanceRunnerNode } from "../lib/runtime-nodes.js";
import { sessionAttachment } from "../lib/session-attachment.js";
import { shouldPersistSnapshot, terminalSnapshotContent } from "../lib/terminal-snapshot.js";
import { recordEngineUsage } from "../lib/usage.js";
import { getSessionRunnerConn, requireOwned } from "./coding-shared.js";
import { getRuntime, getRuntimeForNode, mirrorRuntimeTask, normalizeRunnerNode } from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * Opening a coding session, attaching it to a machine, and watching it (#775).
 *
 * The first half of what #305 left behind in `coding.ts`: everything that happens BEFORE a
 * session is being driven — list them, edit the engine presets, create one (or reuse the live
 * one for that repo), re-attach it after a runner restart, poll the terminal pane, answer an
 * engine sign-in prompt, and report the surface's status.
 *
 * `POST …/sessions/:sessionId/system-message` lives here rather than next to the other timeline
 * routes, and that is deliberate. It is registered BEFORE `registerCopilotRoutes`, and Hono
 * matches in registration order — `coding.contract.test.ts` pins that order by driving the
 * registered handlers. Moving it into `coding-timeline-routes.ts` would move it past three
 * sibling registrations, which is a behaviour change the pinned table would (correctly) reject.
 * Its callers are the session/loop machinery anyway, not the conversation reader.
 */
export function registerSessionOpenRoutes(codingRoutes: Hono<{ Bindings: Env }>): void {
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
			// The launch's FULL answer, not just whether a machine answered (#738): a re-attach can
			// relocate the session to whichever machine is live now, and the engine that comes up there
			// is cold and briefed (ADR 0005). Dropping `seeded` here is why the banner never appeared
			// on the one path #694 was written about. Reasoning: `lib/coding-session-open.ts`.
			const started = await startSessionOnRunner(c.env, instanceId, uid, existing, repo);
			// SAY it was reused, and which engine is running (#549 — reasoning in `reusedEngineNotice`).
			const notice = await reusedEngineNotice(c.env, instanceId, uid, repo.name, existing, body.engineId ?? body.clientType);
			return c.json({ session: existing, runnerConnected: started.conn != null, reused: true, notice, resumed: started.resumed, seeded: started.seeded }, 200);
		}

		// The preset the caller named, else the INSTANCE default. `repo.defaultClient` used to end this
		// chain; it is gone from both doors (#549 — the measurement is in `coding-session-open.ts`).
		const { command, clientType } = await resolveEngine(c.env, instanceId, uid, body.engineId ?? body.clientType);
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
			// Same as the reuse arm (#738): losing the race still ATTACHES, so it can still relocate.
			const started = await startSessionOnRunner(c.env, instanceId, uid, winner, repo);
			return c.json({ session: winner, runnerConnected: started.conn != null, reused: true, resumed: started.resumed, seeded: started.seeded }, 200);
		}

		// This route CREATES a session, so it decides continuity exactly like `ensureActiveSession`
		// does (#408). Both open paths must agree: a repo re-opened from the console and the same repo
		// re-opened by the agent's own tool would otherwise start with different memories.
		// `fresh: true` is the console's **Fresh** button and MCP's `coding_session_fresh`, both of
		// which end a session and open another in the same breath. Without the flag the policy would
		// resume the session they just ended — the one the user is trying to get away from.
		const continuity = await continuityForNewSession(c.env, instanceId, uid, repoId, clientType, { forceFresh: body.fresh === true });
		const started = await startSessionOnRunner(c.env, instanceId, uid, session, repo, { resumeFrom: continuity.resumeFrom, cleanSlate: continuity.seed === null });
		// Bump last_activity_at — starting a coding session is a real user-driven event.
		void touchInstanceActivity(c.env, instanceId, uid);
		return c.json({ session, runnerConnected: started.conn != null, resumed: started.resumed, seeded: started.seeded, continuity }, 201);
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
		// This route IS the re-attach, so it is the likeliest of the four to relocate — the console
		// calls it whenever the terminal reconnects, which is what a user does after moving machine.
		// It reported a bare boolean until #738.
		const started = await startSessionOnRunner(c.env, instanceId, uid, session, repo);
		const runnerConnected = started.conn != null;
		return c.json({ ok: runnerConnected, runnerConnected, resumed: started.resumed, seeded: started.seeded });
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
		// `offline`, not `idle` (#593). There is no engine to ask on this path, so reporting the engine
		// as idle states something nobody observed — and it is the reading that let a repo whose machine
		// had gone away render "Ready", in green, under the tab's own "run `pags up`" banner.
		if (!conn)
			return c.json({
				pane: "",
				runState: resolveRunState({ sessionActive: session.status === "active", runnerConnected: false }),
				alive: false,
				ready: false,
				runnerConnected: false,
				// WHY, not just whether (#537) — the sentence, and the reasoning behind it, live in
				// lib/session-attachment.ts. Best-effort: a diagnosis must never turn a 1.5s poll into a
				// 500, and the console keeps its previous wording when the field is absent.
				attachment: await sessionAttachment(c.env, instanceId, uid, session.runnerNode).catch(() => null),
			});
		// `drainUsage` — this poll is the primary carrier for Engine spend (#267). It runs every 3s
		// per open session, so it is where the CLI's own per-turn cost report is collected. Only the
		// paths that actually write the ledger ask to drain; the other capture callers must not
		// consume records they would then discard.
		const snap = await callRunner(conn, "/coding/capture", { sessionId, drainUsage: true }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
		// `unknown`, not `idle` (#593). The runner IS connected and did not answer — the probe failed,
		// which is a different fact from an engine sitting idle and must not be reported as one.
		if (!snap)
			return c.json({
				pane: "",
				runState: resolveRunState({ sessionActive: session.status === "active", runnerConnected: true }),
				alive: false,
				ready: false,
				runnerConnected: true,
			});
		// The SAME snapshot carries what the engine authenticated with, and it is the only place in
		// the system that knows: the credential is decided by a merge with the machine's own shell,
		// which happens on the runner. It was already being displayed further down this handler and
		// then thrown away (#346) — so a ledger row could say what a turn was WORTH but never who
		// pays, which is what let a money ceiling fire on a subscription (#343). Persist it here,
		// where the value and the observation are in hand together.
		const resolvedAuth = ((snap as { authResolved?: unknown }).authResolved ?? null) as EngineAuthResolved | null;
		const usageRecords = sanitizeEngineUsage((snap as { usage?: unknown }).usage);
		await recordEngineUsage(c.env, { userId: uid, sessionId, instanceId, authResolved: resolvedAuth }, usageRecords);
		await appendEngineUsageTimeline(c.env, { sessionId, instanceId, userId: uid }, usageRecords);
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
		const invocation = engineInvocationReport({
			clientType: session.clientType,
			launchCommand: session.launchCommand,
			runnerMode: (snap as { engineMode?: unknown }).engineMode,
		});

		// `usage` is drained, so it appears on one poll in a hundred and is empty on the rest. Passing
		// that to the console would look like a field that flickers; it has been ledgered above and
		// belongs on the Usage page, not in the terminal payload.
		const { usage: _drained, acts: _drainedActs, ...paneSnap } = snap as Record<string, unknown>;
		return c.json({
			...paneSnap,
			// AFTER the spread, deliberately: the runner's own word is normalised through the one
			// vocabulary rather than passed through (#593), so a value no engine can emit cannot reach a
			// client by riding the snapshot. An unrecognised word is `unknown`, never `idle`.
			runState: resolveRunState({
				sessionActive: session.status === "active",
				runnerConnected: true,
				engineRunState: (snap as { runState?: unknown }).runState,
			}),
			runnerConnected: true,
			auth,
			invocation,
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
}
