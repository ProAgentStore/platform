/**
 * The three BRAINS that sit over a coding session (#305) — Co-pilot, Agent chat, Overseer.
 *
 * Split out of `routes/coding.ts` because they are the only routes here that call a MODEL, and
 * they share the machinery that goes with that: a prompt built from the user's rules + the
 * session's own memory, a `drive_claude` tool the model may call, and the delegation path that
 * turns such a call into an observable board task driven by the durable Pilot.
 *
 * Everything else on the coding surface is a control command with a deterministic answer. Having
 * the model-driven third of the file separate is what makes "which of these can invent an
 * action?" a question you can answer by looking at one module.
 *
 * Registered from the position the block occupied in `coding.ts` — Hono matches in
 * registration ORDER, which `coding.contract.test.ts` pins.
 */
import type { Context, Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { callRunner, READ_TIMEOUT_MS, type RunnerConn } from "../lib/runner-client.js";
import { resolveCloneCredential } from "../lib/git-credentials.js";
import { openBudget } from "../lib/delegation-budget-store.js";
import { runUserWorkersAi } from "../lib/user-ai.js";
import { appendTimeline, contextForCopilot, lastTerminal } from "../lib/coding-timeline.js";
import { terminalSnapshotChanged, terminalSnapshotContent } from "../lib/terminal-snapshot.js";
import { copilotSummary } from "../lib/coding-copilot.js";
import { claimSessionDriver, getActiveSessionForRepo, getRepo, getSession, listRepos, releaseSessionDriver, touchSessionActivity } from "../lib/coding-store.js";
import { mirrorRuntimeTask } from "./instances-runtime.js";
import { agentCapabilities } from "../lib/agent-capabilities.js";
import { optionsFor } from "../lib/surface-options.js";
import { logEvent } from "../lib/events.js";
import { delegationTaskRecord } from "../lib/delegation.js";
import { noteUnmeteredHeadlessDrive } from "../lib/engine-metering.js";
import { isExecutableTarget, parseDelegationTarget, targetId, unsupportedTargetReason, type DelegationTarget } from "../lib/delegate-target.js";
import { ensureSessionForChat, startSessionOnRunner } from "../lib/coding-session-open.js";
import type { CodingGoal } from "../lib/coding-loop.js";
import { getSessionRunnerConn, readSpecialInstructions, requireOwned } from "./coding-shared.js";
import type { Env } from "../types.js";

/**
 * Send an instruction to the repo's Claude (drive the CLI) + spin up the finish
 * watcher (deduped). Shared by the Agent endpoint's delegate path. Returns an ack.
 *
 * `author` is who WROTE `instruction`, and it is a PARAMETER rather than a constant because this
 * one helper carries turns from both kinds of author (#505). The `@claude`/`/run` path hands it
 * the OWNER's own words with the prefix stripped; the delegate path hands it a sentence the Agent
 * chat's model composed after reading the terminal. Labelling both would be the same defect
 * inverted — a machine label on a turn a person typed — so the caller that knows says, and the
 * other says nothing. Unstated renders as nothing on the runner; see
 * `packages/browser-runner/src/coding/turn-author.ts`.
 *
 * (The cross-repo Overseer does NOT come through here: `delegateToTarget` hands its objective to
 * the durable Pilot, which labels itself at `lib/coding-loop.ts`.)
 */
async function driveClaude(
	c: Context<{ Bindings: Env }>,
	instanceId: string,
	uid: string,
	sessionId: string,
	instruction: string,
	summary?: string,
	author?: "pilot",
): Promise<{ delegated: boolean; reply: string }> {
	const session = await getSession(c.env, instanceId, uid, sessionId);
	if (!session) return { delegated: false, reply: "Coding session not found." };
	await touchSessionActivity(c.env, instanceId, uid, sessionId);
	const conn0 = await getSessionRunnerConn(c.env, instanceId, uid, session);
	if (!conn0) return { delegated: false, reply: "No coding runner connected — start it with: pags up" };
	let conn: RunnerConn = conn0;
	// NOTE: don't log a `command` turn here — the chat_assistant "On it — I asked
	// Claude to: …" already records it; a command entry would show a 3rd duplicate
	// bubble in the thread (loadChat surfaces commands as your turns).
	//
	// The Engine receives every turn as `role: "user"` and cannot tell a machine driver from a
	// person, which is how a run came to report a decision back to the owner as his own (#505).
	// `author` is passed through from the caller — see the docstring. Held by
	// `lib/turn-author-callsites.test.ts`.
	const act = () => callRunner(conn, "/coding/act", { sessionId, action: { kind: "message", text: instruction, author } }).catch(() => null);
	let snap = await act();
	const repo = session ? await getRepo(c.env, instanceId, uid, session.repoId) : null;
	if (snap === null && session && repo) {
		// Reattach a session lost to a runner restart — and on a machine SWITCH this relocates
		// the session to the live machine and returns THAT connection, so retry there (the
		// captured `conn` still points at the old, now-dead machine).
		const relocated = (await startSessionOnRunner(c.env, instanceId, uid, session, repo)).conn;
		if (relocated) conn = relocated;
		snap = await act();
	}
	// A headless drive of an engine that reports no token counts is unmetered, and the absence is
	// recorded rather than left to read as zero (#556). Same rule #348 applied to the terminal
	// driver; this is the other row of its 2x2.
	if (snap !== null) await noteUnmeteredHeadlessDrive(c.env, { userId: uid, instanceId, traceId: sessionId }, session);
	// Finish watcher (one per send: stamp the session so only the latest notifies).
	const watchId = `cw-${sessionId}-${Date.now()}`;
	// A lost stamp does not cost a watcher, it MIS-ATTRIBUTES one: the column still names the
	// previous send, so this watcher stands down as superseded and the stale one reports the
	// earlier instruction as finished. Treat it exactly like a watcher that failed to start.
	const stamped = await c.env.DB.prepare("UPDATE coding_sessions SET watch_workflow_id = ?1 WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4")
		.bind(watchId, sessionId, instanceId, uid)
		.run()
		.then(() => true, () => false);
	// The finish-watcher failed to start — tell the user so the missing completion
	// summary isn't a silent "did it even work?".
	const noWatcher = () =>
		appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "system", content: "(Couldn't start the progress watcher — I won't auto-report when this finishes; ask me for an update.)" }).catch(() => undefined);
	if (!stamped) await noWatcher();
	else
		await c.env.CODING_SESSION.create({
			id: watchId,
			params: { instanceId, userId: uid, sessionId, repoId: repo?.id ?? "", runnerNode: session.runnerNode ?? null, mode: "watch", watchId, goal: { objective: instruction, repo: repo?.name ?? "your repo", clientType: session?.clientType ?? "claude" } },
		}).catch(noWatcher);
	// Show the user a plain-language summary, NOT the raw (often long/technical)
	// instruction we sent to the CLI.
	const reply = summary ? `On it — ${summary}` : "On it — working on that now.";
	await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_assistant", content: reply }).catch(() => undefined);
	return { delegated: true, reply };
}

/**
 * Delegate a GOAL to the durable Pilot (#155). Unlike `driveClaude` (a one-shot instruction +
 * a finish-watcher), this hands the objective to the autonomous CodingSessionWorkflow — which
 * owns the snapshot→decide→act loop and stuck/needs_input escalation — and records an
 * OBSERVABLE board task so the delegation is trackable (board card + trace + session thread),
 * not a line buried in one repo's thread. Attributed as an agent action on the user's behalf,
 * never as a user turn. The Pilot flips the task to completed/failed at its terminal state.
 */
type DelegationOutcome =
	| { ok: true; taskId: string; reply: string; label: string }
	| { ok: false; reply: string };

async function delegateToTarget(
	c: Context<{ Bindings: Env }>,
	instanceId: string,
	uid: string,
	target: DelegationTarget,
	objective: string,
): Promise<DelegationOutcome> {
	// Refuse a parsed-but-not-runnable target explicitly (#156). Silently doing nothing would
	// leave a board card that looks delegated and never moves.
	if (!isExecutableTarget(target)) return { ok: false, reply: unsupportedTargetReason(target) };
	// Only `repo` is executable today (guarded above). Resolving the target HERE rather than in
	// the caller is the point of the change: a second target kind slots in without the route
	// learning anything about it.
	const repoId = targetId(target);
	const repo = await getRepo(c.env, instanceId, uid, repoId);
	const targetLabel = repo?.name ?? "that repo";
	if (!repo) return { ok: false, reply: `${targetLabel} is not a repo on this agent.` };
	// A SESSION-NEEDING path, so it ensures one (#408). It used to refuse with "open it (or tap
	// Start) first" — the Overseer, whose entire job is to act across repos on the user's behalf,
	// telling the user to go and press a button in a tab they may not have open, for a session the
	// platform is better placed to open than they are. `ensureSessionForChat` rather than
	// `ensureActiveSession` because the connectivity gate has to come FIRST: without a runner this
	// must answer with the runner diagnosis and write no row at all, and that ordering already
	// exists here rather than being copied (#407).
	const ensured = await ensureSessionForChat(c.env, instanceId, uid, repo);
	if (!ensured.ok) return { ok: false, reply: ensured.message };
	const session = ensured.session;

	// Single-flight BEFORE anything observable is written (#208). This is the third path that
	// starts a Pilot on a real session, and it was the one still left open: the claim went on
	// `/sessions/:id/run` only, so `drive_claude` could put a SECOND Pilot on a pane a first was
	// already typing into. Claimed first so a refusal doesn't leave a board card + trace event
	// announcing work that never started.
	const driverId = crypto.randomUUID();
	if (!(await claimSessionDriver(c.env, instanceId, uid, session.id, driverId))) {
		return { ok: false, reply: `${targetLabel} is already being worked on — let the current run finish, or stop it first.` };
	}

	const taskId = `deleg-${crypto.randomUUID()}`;
	const now = new Date().toISOString();
	const label = objective.length > 120 ? `${objective.slice(0, 117)}…` : objective;
	// 1) Observable board task (running), attributed to the Overseer on the user's behalf.
	// The claim above is ordered "so a refusal doesn't leave a board card announcing work that
	// never started" — this is the mirror failure, and it was silent: no card, but the Pilot starts
	// anyway and the thread below states "tracking on the board" as fact. That leaves a real run
	// spending the user's tokens with nothing to observe or stop it from. Refuse instead, and give
	// the claim back so the next attempt isn't told the repo is already being worked on.
	const carded = await mirrorRuntimeTask(c.env, instanceId, uid, delegationTaskRecord({ id: taskId, targetLabel: repo.name, objective, status: "running", now })).then(() => true, () => false);
	if (!carded) {
		await releaseSessionDriver(c.env, instanceId, uid, session.id, driverId).catch(() => undefined);
		return { ok: false, reply: `I couldn't put ${targetLabel} on the board, so I haven't started — you'd have had no way to watch or stop it. Try again.` };
	}
	// 2) Unified trace + the target session thread (visible, as an agent action).
	await logEvent(c.env, { source: "coding", event: "delegate", message: `Overseer → ${repo.name}: ${label}`, userId: uid, instanceId, traceId: taskId }).catch(() => undefined);
	await appendTimeline(c.env, { sessionId: session.id, instanceId, userId: uid, type: "chat_assistant", content: `On it — delegated to ${repo.name}: ${label} (tracking on the board)` }).catch(() => undefined);
	// 3) Hand the GOAL to the durable Pilot (objective mode owns the loop + escalation).
	const instanceInstructions = await readSpecialInstructions(c.env, instanceId, uid);
	const combined = [instanceInstructions, repo.instructions].filter(Boolean).join("\n\n");
	const goal: CodingGoal = { objective, repo: repo.name, clientType: session.clientType, specialInstructions: combined || undefined };
	// One credential seam for every provider (#221) — see lib/git-credentials.ts.
	const credential = await resolveCloneCredential(c.env, uid, repo).catch(() => null);
	// A pool, like every other autonomous entry point (#184, #502). This one is started by the
	// OVERSEER — a model deciding to delegate — so it is the least supervised of the three, and it
	// reached the Pilot with no `budgetId`, which is the value the Pilot's `decide` checks before
	// it will reserve anything at all. Depth 0: the Overseer opens the tree.
	const budget = await openBudget(c.env, uid, instanceId);
	await c.env.CODING_SESSION.create({
		params: {
			instanceId, userId: uid, sessionId: session.id, repoId: repo.id,
			runnerNode: session.runnerNode ?? null, cloneUrl: repo.cloneUrl ?? undefined,
			branch: repo.branch || undefined, token: credential?.token, tokenUsername: credential?.username, goal, boardTaskId: taskId,
			driverId,
			budgetId: budget.id,
			depth: 0,
		},
	});
	// The Overseer's delegation is a headless drive too, and it is the one nobody is watching
	// (#556) — the Pilot it just started will act against this engine repeatedly from inside the
	// Workflow, and the day-coarse row covers all of it from here.
	await noteUnmeteredHeadlessDrive(c.env, { userId: uid, instanceId, traceId: taskId }, session);
	// The notice is only set when THIS call opened the session (#407/#408), and it is news the
	// user has to have: a child process just appeared on their machine, and whether it kept the
	// previous conversation decides whether the objective above needed the context it carries.
	const opened = ensured.opened && ensured.notice ? ` ${ensured.notice}` : "";
	return { ok: true, taskId, label: targetLabel, reply: `On it — delegated to ${repo.name}; track it on the board.${opened}` };
}

/**
 * Does this agent declare the Co-pilot off? Same shape as `overseerDisabled`, and for the same
 * reason: the difference between the legacy Coder and a configurable one must be DATA, not a fork
 * of the code. The legacy `coder` declares nothing and keeps its Co-pilot untouched.
 */
async function copilotDisabled(env: Env, instanceId: string): Promise<boolean> {
	const row = await env.DB.prepare(
		`SELECT a.slug AS slug, a.category AS category, a.config AS config
		   FROM agent_instances i JOIN agents a ON a.id = i.agent_id
		  WHERE i.id = ?1`,
	)
		.bind(instanceId)
		.first<{ slug: string | null; category: string | null; config: string | null }>()
		.catch(() => null);
	if (!row) return false; // unknown shape → behave as before, never lock an agent out by accident
	return optionsFor(agentCapabilities(row), "coding")?.copilot === false;
}

/**
 * Is the in-agent Overseer switched off for this instance?
 *
 * True when the coding surface declares `drive:false` — the agent does not drive engines itself,
 * so a cross-repo driver on top of it is the duplicated hierarchy #154 removes.
 */
async function overseerDisabled(env: Env, instanceId: string): Promise<boolean> {
	const row = await env.DB.prepare(
		`SELECT a.slug AS slug, a.category AS category, a.config AS config
		   FROM agent_instances i JOIN agents a ON a.id = i.agent_id
		  WHERE i.id = ?1`,
	)
		.bind(instanceId)
		.first<{ slug: string | null; category: string | null; config: string | null }>()
		.catch(() => null);
	if (!row) return false; // unknown shape → behave as before, never lock an agent out by accident
	return optionsFor(agentCapabilities(row), "coding")?.drive === false;
}

export function registerCopilotRoutes(codingRoutes: Hono<{ Bindings: Env }>) {
	/**
	 * Co-pilot: read the live terminal and give the user a SHORT summary of what's
	 * happening + what's needed from them, or answer a follow-up question. Uses the
	 * user's BYOK Claude. The user reads this instead of the raw terminal.
	 */
	codingRoutes.post("/:instanceId/coding/sessions/:sessionId/explain", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		// An agent that declares `coding.copilot: false` has ONE conversation — its Assistant, which
		// carries the repo/terminal read tools from the registry. Its UI is gone; the route is closed
		// too, so a stale client can't resurrect a second brain the agent doesn't declare.
		if (await copilotDisabled(c.env, instanceId)) {
			throw new HttpError(404, "This agent has a single chat — ask its Assistant instead.");
		}
		const sessionId = c.req.param("sessionId");
		// Verify the session belongs to this instance/user BEFORE touching its timeline —
		// the timeline helpers are scoped by sessionId alone.
		const session = await getSession(c.env, instanceId, uid, sessionId);
		if (!session) throw new HttpError(404, "Session not found");
		await touchSessionActivity(c.env, instanceId, uid, sessionId);
		const body = (await c.req.json().catch(() => ({}))) as { question?: string; finished?: boolean; persist?: boolean };
		const question = typeof body.question === "string" ? body.question.trim() : "";
		const finished = body.finished === true;
		// The client's finish-watcher passes persist:false — the durable server watch
		// workflow already persists the finish summary, so persisting here too would
		// show a DUPLICATE bubble in the thread.
		const persist = body.persist !== false;

		// Capture the current terminal.
		const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
		let pane = "";
		if (conn) {
			const snap = (await callRunner(conn, "/coding/capture", { sessionId }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null)) as { pane?: string } | null;
			pane = snap?.pane ?? "";
		}

		// Persist the user's question and a terminal snapshot (if it changed) so the
		// session has a durable, continuous history.
		if (question) await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_user", content: question });
		// Same constant, same compare, as `/capture` and the watch workflow (#466) — the three
		// writers used to disagree about the cap (8,000 here, 12,000 in `coding-watch.ts`) AND
		// compare the untruncated pane against the stored tail, so the dedup could not fire.
		const stored = terminalSnapshotContent(pane);
		if (stored) {
			const last = await lastTerminal(c.env, sessionId);
			if (terminalSnapshotChanged(pane, last)) {
				await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "terminal", content: stored });
			}
		}

		// Continuity: feed the recent persisted timeline (prior chat, what the agent
		// did, outcomes) so the co-pilot remembers the session, not just this moment.
		const memory = await contextForCopilot(c.env, sessionId);
		// Inject instance + repo instructions into the co-pilot prompt.
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
			repo: repo ?? undefined,
			instanceId,
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
	 * The Agent chat (Step 1 of #3): ONE input that either answers from the terminal +
	 * history, or DELEGATES to Claude Code via the `drive_claude` tool — the LLM
	 * decides. `@claude`/`/run` forces delegation. This tool-loop is the reusable core
	 * the cross-repo Overseer (#9) will lift to global scope.
	 */
	codingRoutes.post("/:instanceId/coding/sessions/:sessionId/agent", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const sessionId = c.req.param("sessionId");
		// Verify the session belongs to this instance/user before touching its timeline.
		const session = await getSession(c.env, instanceId, uid, sessionId);
		if (!session) throw new HttpError(404, "Session not found");
		await touchSessionActivity(c.env, instanceId, uid, sessionId);
		const body = (await c.req.json().catch(() => ({}))) as { message?: string; audioKey?: string };
		const raw = String(body.message ?? "").trim();
		if (!raw) return c.json({ error: "message is required" }, 400);
		// A voice-dictated turn carries the R2 id of its saved recording so it can be
		// replayed (double-tap). Persisted with the turn.
		await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_user", content: raw, audioKey: body.audioKey }).catch(() => undefined);

		// Explicit force-delegate. NO author: `cleaned` is the owner's own message with the
		// `@claude`/`/run` prefix stripped — a person typed these words, and stamping them `"pilot"`
		// would be #505's defect pointed the other way (#505).
		if (/^(@claude|\/run)\b/i.test(raw)) {
			const cleaned = raw.replace(/^(@claude|\/run)\s*/i, "").trim() || raw;
			return c.json(await driveClaude(c, instanceId, uid, sessionId, cleaned));
		}

		// Otherwise: one tool-enabled call — answer from context OR call drive_claude.
		const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
		let pane = "";
		if (conn) {
			const snap = (await callRunner(conn, "/coding/capture", { sessionId }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null)) as { pane?: string } | null;
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
		}, { kind: "overseer", instanceId }).catch(() => ({ response: "" }))) as { response?: string; tool_calls?: Array<{ name: string; arguments?: Record<string, unknown> }> };
		const call = res.tool_calls?.find((t) => t.name === "drive_claude");
		const instruction = call && typeof call.arguments?.instruction === "string" ? (call.arguments.instruction as string).trim() : "";
		const summary = call && typeof call.arguments?.summary === "string" ? (call.arguments.summary as string).trim() : "";
		// `"pilot"`: `instruction` is a sentence the model above composed after reading the terminal —
		// the owner asked for an outcome, not for these words (#505).
		if (instruction) return c.json(await driveClaude(c, instanceId, uid, sessionId, instruction, summary || undefined, "pilot"));
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
		// The Overseer is the IN-AGENT cross-repo coordinator — it reads every repo on the instance
		// and delegates into their engines via `drive_claude`. That is exactly the layer the platform
		// supervision graph replaces, so an agent that declares `drive:false` (a Repo Coder: one repo,
		// driven BY its Lead) must not carry it. Its UI is already gone; the route stayed reachable,
		// which is the whole second layer still hanging off a leaf agent.
		if (await overseerDisabled(c.env, instanceId)) {
			throw new HttpError(403, "This agent doesn't coordinate across repos — its supervisor does. Give the goal to the Lead instead.");
		}
		const body = (await c.req.json().catch(() => ({}))) as { message?: string };
		const raw = String(body.message ?? "").trim();
		if (!raw) return c.json({ error: "message is required" }, 400);

		// Global context: every repo, whether it has a live session, and its recent activity.
		// No repo-id index here: #156 moved resolution into parseDelegationTarget/delegateToTarget,
		// which own the refusal cases. The map this route used to build went unread after that.
		const repos = await listRepos(c.env, instanceId, uid);
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
		}, { kind: "overseer", instanceId }).catch(() => ({ response: "" }))) as { response?: string; tool_calls?: Array<{ name: string; arguments?: Record<string, unknown> }> };

		const call = res.tool_calls?.find((t) => t.name === "drive_claude");
		// #156: the tool still speaks `repoId`, but the route no longer does — it hands an
		// addressable TARGET to the delegate path, which owns resolution and the refusal cases.
		const target = call ? parseDelegationTarget(call.arguments ?? {}) : null;
		const instruction = call && typeof call.arguments?.instruction === "string" ? (call.arguments.instruction as string).trim() : "";
		if (target && instruction) {
			// #155: delegate the GOAL to the durable Pilot + record an observable board task,
			// instead of a fire-and-forget one-shot with no follow-through.
			const r = await delegateToTarget(c, instanceId, uid, target, instruction);
			if (!r.ok) return c.json({ delegated: false, reply: r.reply });
			return c.json({ delegated: true, repoId: targetId(target), taskId: r.taskId, reply: `${r.label}: ${r.reply}` });
		}
		return c.json({ delegated: false, reply: res.response || "(no response)" });
	});
}
