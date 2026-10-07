/**
 * The two BRAINS that sit over a coding session (#305) — the Co-pilot and its Agent chat.
 *
 * Split out of `routes/coding.ts` because they are the only routes here that call a MODEL, and
 * they share the machinery that goes with that: a prompt built from the user's rules + the
 * session's own memory, and a `drive_claude` tool the Agent chat's model may call.
 *
 * Everything else on the coding surface is a control command with a deterministic answer. Having
 * the model-driven part of the file separate is what makes "which of these can invent an
 * action?" a question you can answer by looking at one module.
 *
 * There was a third, the cross-repo Overseer (`POST /coding/overseer`). It was the legacy Coder's
 * in-agent coordinator, replaced by `coder-lead` + the supervision graph (0063), and removed with
 * that agent (#942).
 *
 * Registered from the position the block occupied in `coding.ts` — Hono matches in
 * registration ORDER, which `coding.contract.test.ts` pins.
 */
import type { Context, Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { callRunner, READ_TIMEOUT_MS, type RunnerConn } from "../lib/runner-client.js";
import { runUserWorkersAi } from "../lib/user-ai.js";
import { appendTimeline, contextForCopilot, lastTerminal } from "../lib/coding-timeline.js";
import { terminalSnapshotChanged, terminalSnapshotContent } from "../lib/terminal-snapshot.js";
import { copilotSummary, terminalTail } from "../lib/coding-copilot.js";
import { getRepo, getSession, touchSessionActivity } from "../lib/coding-store.js";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { optionsFor, type SurfaceSpec } from "../lib/surface-options.js";
import { noteUnmeteredHeadlessDrive } from "../lib/engine-metering.js";
import { startSessionOnRunner } from "../lib/coding-session-open.js";
import { getSessionRunnerConn, readSpecialInstructions, requireOwned } from "./coding-shared.js";
import { withTurnReplay } from "../lib/coding-turn-replay.js";
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
	// #693 slice 2: an engine with no memory of its own gets the platform's record with the turn.
	const action = await withTurnReplay(c.env, { instanceId, userId: uid, repoId: session.repoId, clientType: session.clientType }, { kind: "message", text: instruction, author });
	const act = () => callRunner(conn, "/coding/act", { sessionId, action }).catch(() => null);
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
 * The instance's declared coding options (`surfaceOptions.coding`), or null when it has no coding
 * surface or the row cannot be read. The difference between agents is DATA, not a fork of the
 * code: an agent that declares nothing gets `SURFACE_DEFAULTS` — the Co-pilot and drive on, which
 * is a decision recorded on #942, not an accident of the legacy Coder.
 */
async function codingOptions(env: Env, instanceId: string): Promise<SurfaceSpec | null> {
	const caps = await capabilitiesForInstance(env, instanceId);
	return caps ? optionsFor(caps, "coding") : null; // unknown shape → behave as before, never lock an agent out by accident
}

/** The refusal both Co-pilot routes give an agent that declares `coding.copilot: false`. */
const SINGLE_CHAT = "This agent has a single chat — ask its Assistant instead.";

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
		if ((await codingOptions(c.env, instanceId))?.copilot === false) throw new HttpError(404, SINGLE_CHAT);
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
	 * decides. `@claude`/`/run` forces delegation.
	 *
	 * It is the Co-pilot's own chat, so it is closed with the Co-pilot (`copilot:false`), exactly
	 * like `/explain` — until #942 it was the one Co-pilot route with no gate, so a Repo Coder's
	 * stale client could still reach `drive_claude`. And `drive_claude` DRIVES the engine, so an
	 * agent that declares `drive:false` keeps the chat but neither gets the tool nor the forced
	 * delegation.
	 */
	codingRoutes.post("/:instanceId/coding/sessions/:sessionId/agent", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const options = await codingOptions(c.env, instanceId);
		if (options?.copilot === false) throw new HttpError(404, SINGLE_CHAT);
		const mayDrive = options?.drive !== false;
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
			if (!mayDrive) throw new HttpError(403, "This agent doesn't drive its engine from chat — its supervisor does.");
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
		const rules = mayDrive
			? "You are the co-pilot for an AI coding agent working in the user's repo. TWO rules:\n" +
				"1. If the user wants something DONE → call the `drive_claude` tool with ONE clear instruction. Don't do the work yourself.\n" +
				"2. If the user is ASKING (status, what happened, is it done) → answer FROM the terminal + session memory below.\n\n"
			: "You are the co-pilot for an AI coding agent working in the user's repo. Answer FROM the terminal + session memory below. " +
				"You cannot send instructions to the coding CLI: if the user wants something DONE, say that its supervisor or the Loop does that.\n\n";
		const system =
			rules +
			"STYLE: Talk to a NON-TECHNICAL user by default. Say WHAT was done and WHETHER it worked — never list filenames, commands, or code unless the user explicitly asks for details. " +
			"Wrong: 'Fixed overflow in PuzzleSets.tsx line 99'. Right: 'Fixed the horizontal scroll on the puzzle page.' " +
			"Only get technical when the user asks to elaborate, show code, or be more detailed.\n" +
			"Keep it to 1-2 sentences. Never pad. After delegating, say 'On it' + what you asked the agent to do in plain English.";
		const userMsg = `User: ${raw}\n\nSESSION MEMORY (recent):\n${memory || "(none)"}\n\nTERMINAL (recent):\n${terminalTail(pane) || "(no live terminal)"}`;
		const tools = !mayDrive ? [] : [
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
			...(tools.length ? { tools } : {}),
			maxTokens: 700,
		}, {
			kind: "overseer",
			instanceId,
			traceId: sessionId,
			promptSource: "overseer",
			promptPhase: "repo_agent",
			promptSections: [
				{ label: "overseer.system", value: system },
				{ label: "overseer.user", value: raw },
				{ label: "overseer.memory", value: memory },
				{ label: "overseer.terminal", value: terminalTail(pane) },
				{ label: "overseer.tools", value: tools },
			],
		}).catch(() => ({ response: "" }))) as { response?: string; tool_calls?: Array<{ name: string; arguments?: Record<string, unknown> }> };
		const call = res.tool_calls?.find((t) => t.name === "drive_claude");
		const instruction = call && typeof call.arguments?.instruction === "string" ? (call.arguments.instruction as string).trim() : "";
		const summary = call && typeof call.arguments?.summary === "string" ? (call.arguments.summary as string).trim() : "";
		// `"pilot"`: `instruction` is a sentence the model above composed after reading the terminal —
		// the owner asked for an outcome, not for these words (#505).
		if (mayDrive && instruction) return c.json(await driveClaude(c, instanceId, uid, sessionId, instruction, summary || undefined, "pilot"));
		const reply = res.response || "(no response)";
		await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_assistant", content: reply }).catch(() => undefined);
		return c.json({ delegated: false, reply });
	});
}
