/**
 * The coding-surface MCP tools — opening a repo's conversation, watching it, and driving it.
 *
 * ── Why this is its own file (#696)
 *
 * These ten registrations were inline in `index.ts`, which sat at 1168 lines against a 1169-line
 * ratchet (`scripts/check-file-size.mjs`, #302). #696 adds an eleventh, so the ratchet's own
 * instruction applies: split rather than raise. The move is mechanical — same tool names, same
 * schemas, same handlers, same `groups.has("coding")` gate — and the surface hash is taken over
 * `tools/list` sorted by name (`conformance.test.ts`), so a file move cannot move it.
 *
 * ── What #696 added, and why it needed a new NAME
 *
 * `resolveSessionContinuity` (#408) makes a re-opened conversation on a repo pick up where the
 * last one left off for four days. Over MCP that was unreachable: the only tool that could open
 * anything was `coding_session_fresh`, which hardcodes `fresh: true` — correctly, that is what it
 * is FOR — so every MCP open started cold, and `coding_session_message` answered "No active coding
 * session found." rather than waking the repo. The capability existed, was tested and shipped, and
 * was available from exactly one of its two entry points.
 *
 * The rejected alternative was an optional `fresh` boolean on `coding_session_fresh` defaulting to
 * false. #696 names it and refuses it: a tool whose name says "fresh" and whose default is "not
 * fresh" reads as a bug to every caller that does not read its schema, and a model choosing tools
 * by name would pick it for exactly the wrong reason.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, type McpEnv, jsonText, text } from "./http.js";
import { audit, requirePermission, type SafetyContext } from "./safety.js";
import { runStateSentence } from "./state-vocabulary.js";

type TokenResolver = (provided?: string) => string | null;
type SafetyResolver = (provided?: string) => SafetyContext;

/** A repo row as the repos listing returns it — only the two fields this file names. */
export interface CodingRepoRow {
	id: string;
	name?: string;
}

/** What `POST /coding/sessions` answers with. `continuity` is present only when this call
 *  OPENED a conversation; a reuse continues the one it is reusing and has no decision to report. */
export interface OpenConversationResult {
	session?: { id?: string };
	continuity?: { mode?: string; reason?: string };
	resumed?: boolean;
	/** The engine came up cold and was handed a brief built from the platform's record (#693). */
	seeded?: boolean;
	reused?: boolean;
	notice?: string;
	runnerConnected?: boolean;
	error?: string;
}

/**
 * Which repo an open is about, when the caller did not say.
 *
 * Pure, because the honest answer to "several repos and nothing running" is a QUESTION, and a
 * question is the part worth testing. Guessing here would open a conversation on a repo the caller
 * never named and then report success — the failure mode #696 is about, one layer down.
 */
export function resolveRepoForOpen(repos: CodingRepoRow[], repoId?: string): { repo: CodingRepoRow } | { ask: string } {
	if (repoId) return { repo: repos.find((r) => r.id === repoId) ?? { id: repoId } };
	if (repos.length === 1) return { repo: repos[0] };
	if (repos.length === 0) return { ask: "This agent has no repo attached yet — add one with coding_repo_add first." };
	const list = repos.map((r) => `${r.name || "(unnamed)"} (repo_id: ${r.id})`).join(", ");
	return { ask: `This agent has ${repos.length} repos and none of them is running, so I cannot tell which one you mean: ${list}. Say which with repo_id.` };
}

/** A repo's name for a sentence, falling back to its id rather than to nothing. */
export function repoLabel(repo: CodingRepoRow): string {
	return repo.name || repo.id;
}

/**
 * What just happened, said in the caller's vocabulary — a CONVERSATION on a repo, not a session
 * lifecycle (#695 is removing "session" as a word a user has to know; #257 and #408 went to
 * trouble to eliminate it).
 *
 * `continuity.reason` is quoted VERBATIM, which is the requirement in #696: the route already
 * computes the sentence, and re-deriving a second phrasing here is how the console and MCP end up
 * telling one user two different stories about the same open.
 *
 * `resumed` is the runner's own confirmation that the engine came up carrying the previous
 * conversation. A `resume` decision that the runner did not confirm is reported as the decision it
 * was, not as the outcome it hoped for — claiming continuity that did not happen is worse than the
 * cold start it papers over.
 *
 * `seeded` is the same kind of fact about the OTHER outcome (ADR 0005, #693): the engine came up
 * cold and was given a brief reconstructed from `coding_timeline`. It is said here for the reason
 * the reason string is quoted verbatim — the console says it too, and one open telling an MCP
 * caller and a console user two different stories is the failure this function exists to prevent.
 * It is phrased as a briefing, never as memory: the ADR forbids describing a reconstruction as
 * though the conversation survived.
 */
export function openConversationText(label: string, d: OpenConversationResult): string {
	const sid = d.session?.id ?? "(unknown)";
	const runner = d.runnerConnected === false ? "\nNo runner is connected — run `pags up` on the machine that holds this repo; nothing will run until it is." : "";
	// What the engine HAS, before what the server asked for: a confirmed brief is the answer to
	// "does it know what we were doing", and on a `resume` it means the machine could not honour the
	// request (an older `pags up`, or a session that moved machines) and fell back.
	//
	// Computed ABOVE the `reused` return since #738. It used to be appended only inside the two
	// `continuity` branches, so the two answers a RE-ATTACHED session actually produces — "reused",
	// and "no continuity decision" — were the two that dropped it. Those are precisely the answers
	// a relocated session gives, which made this the third surface silent on the one path the brief
	// exists for.
	const brief = d.seeded === true ? " It was given a brief of this repo's recent history, reconstructed from the platform's record — it knows what was going on, not the details." : "";
	// A reused session whose engine was relocated and briefed is NOT "already talking" in the sense
	// the caller will read that as. Say what the engine holds; the ADR forbids letting a
	// reconstruction pass for the conversation that was lost.
	if (d.reused) return `Already talking to ${label} — a conversation is open there (session_id ${sid}).${d.notice ? ` ${d.notice}` : ""}${brief}${runner}`;
	const reason = d.continuity?.reason;
	if (d.continuity?.mode === "resume") {
		if (d.resumed === true) return `Continuing this repo's previous conversation on ${label} — ${reason}. session_id ${sid}.${runner}`;
		return `Asked the engine to continue this repo's previous conversation on ${label}, and the runner did not confirm it came up with it — ${reason}.${brief} session_id ${sid}.${runner}`;
	}
	if (d.continuity?.mode === "fresh") return `Started a fresh conversation on ${label} — ${reason}.${brief} session_id ${sid}.${runner}`;
	// No decision was reported — which since #738 is the honest shape of a re-attach rather than an
	// older API, because a re-attach genuinely decides nothing. `seeded` still answers the question
	// the caller is asking, so it is said here too.
	return `Opened a conversation on ${label}, and the server reported no continuity decision — so whether it carries the previous one is not known.${brief} session_id ${sid}.${runner}`;
}

export function registerCodingSessionTools(
	server: McpServer,
	env: McpEnv,
	tokenFor: TokenResolver,
	safetyFor: SafetyResolver,
): void {
	/** Open a repo's conversation WITHOUT `fresh`, so #408's continuity policy decides. */
	const openConversation = (instance_id: string, sessionToken: string, repoId: string, engineId?: string) =>
		authedCall(
			`/v1/instances/${instance_id}/coding/sessions`,
			sessionToken,
			{
				method: "POST",
				// `engineId` is OMITTED when the caller did not name one, so the API falls through to
				// the INSTANCE default (`resolveEngine(…, null)`). `coding_session_fresh` next door
				// defaults to `"claude"`, which is the constant #549 measured burning an owner's
				// Claude limit after he had switched the instance to Codex — not a default to copy.
				body: JSON.stringify(engineId ? { repoId, engineId } : { repoId }),
			},
			env,
		) as Promise<OpenConversationResult>;

	/** The repos this instance has, for naming one or for asking which. */
	// `instance_id`, not `instanceId`: `repo-policies.test.ts` (#322) compares the set of repo
	// path literals across the MCP worker EXACTLY, so that nothing here can construct the per-repo
	// promotion route. A second spelling of the same collection path is a change to that set, and
	// the guard is worth more than the camelCase.
	const listRepos = async (instance_id: string, sessionToken: string): Promise<CodingRepoRow[]> => {
		const r = (await authedCall(`/v1/instances/${instance_id}/coding/repos`, sessionToken, {}, env)) as { repos?: CodingRepoRow[] };
		return r.repos || [];
	};

	server.tool(
		"coding_session_open",
		"Pick up work on a repo: opens its conversation and CONTINUES where the last one left off (the engine keeps the previous context for four days), which is what you want for a follow-up question or a second instruction on the same task. Says which conversation you got and why, verbatim from the server's own decision. Use coding_session_fresh instead when the point is to start clean. Omit repo_id when the agent has exactly one repo; with several it asks which rather than guessing.",
		{
			instance_id: z.string().describe("Instance ID"),
			repo_id: z.string().optional().describe("Repo to work on. Omit only when the agent has exactly one — with several, the call asks which instead of picking."),
			engine_id: z.string().optional().describe("Engine preset ID. Omit to use the instance's own default engine, which is the setting its owner controls."),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, repo_id, engine_id, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// Same gate as every other opener: this starts a CLI process on the user's machine.
			const denied = await requirePermission(safetyFor(token), "runtime", "coding_session_open", { instance_id, repo_id });
			if (denied) return denied;
			const resolved = resolveRepoForOpen(await listRepos(instance_id, sessionToken), repo_id);
			if ("ask" in resolved) return text(resolved.ask);
			const d = await openConversation(instance_id, sessionToken, resolved.repo.id, engine_id);
			if (d?.error) return text(`Error opening the conversation on ${repoLabel(resolved.repo)}: ${d.error}`);
			await audit(safetyFor(token), { tool: "coding_session_open", action: "completed", input: { instance_id, repoId: resolved.repo.id }, result: { sessionId: d.session?.id, mode: d.continuity?.mode } });
			return text(openConversationText(repoLabel(resolved.repo), d));
		},
	);

	server.tool(
		"coding_session_capture",
		// #527 measured this answering a real, finished, 6-minute run — 5 Pilot instructions and
		// a push to `main` — with `runState:"idle"` and `pane:""`, which is indistinguishable
		// from a session that never did anything. The pane is a live buffer on the runner and
		// there is nothing to capture once the session ends; the record that survives is
		// `coding_timeline`, so the description names the tool that reads it. #699 measured the half
		// that naming still left unreachable: `coding_timeline` serves a snapshot as a 400-character
		// tail, so the engine's own prose from a finished run was readable at 5% of what D1 holds.
		// `coding_terminal` reads those same stored snapshots whole, and is named here for exactly
		// the case this tool cannot answer.
		// The vocabulary is the API's `CODING_RUN_STATES`, not a restatement of it. What shipped
		// here for six weeks was "(idle/working/offline)": `working` is not a value any engine can
		// emit — the runner's union is `idle | thinking | responding` — and `offline` was, at the
		// time, produced only by the timeline route. `state-vocabulary.test.ts` measures this
		// sentence against the code that emits it, over every tool that publishes a state enum.
		`Capture the live terminal output from a coding session (what the CLI is showing right now), plus WHY it looks that way. ${runStateSentence()} Only the first three come from an engine — the rest mean nobody looked at one, so read \`runnerConnected\`, \`alive\` and \`ready\` alongside: a stopped engine, an absent machine and a failed probe are different problems with the same look. \`authPrompt\` means the engine is blocked on sign-in, which otherwise looks exactly like a hang. LIVE sessions only — the pane lives on the runner, so an ENDED session answers with an empty pane. That empty pane is not evidence the run did nothing: every snapshot taken while it ran is stored, and coding_terminal returns them in full for a session that has ended. To read what a run DID, use coding_timeline for the narrative and coding_terminal for the pane text; to find out whether the work is stuck, use coding_diagnostics.`,
		{
			instance_id: z.string().describe("Instance ID"),
			session_id: z.string().optional().describe("Session ID. If omitted, uses the first active session."),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, session_id, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const r = (await authedCall(`/v1/instances/${instance_id}/coding/sessions`, sessionToken, {}, env)) as { sessions?: Array<{ id: string; status: string }> };
			const sessions = r.sessions || [];
			const sid = session_id || sessions.find((s) => s.status === "active")?.id;
			if (!sid) return text("No active coding session found.");
			const d = (await authedCall(`/v1/instances/${instance_id}/coding/sessions/${sid}/capture`, sessionToken, {}, env)) as {
				runState?: string;
				pane?: string;
				runnerConnected?: boolean;
				alive?: boolean;
				ready?: boolean;
				authPrompt?: unknown;
			};
			// The siblings that make `runState` falsifiable (#593). The API answers `idle` on three
			// paths and disambiguates with exactly these, so a projection without them turns "the
			// engine is idle", "the machine is gone" and "the probe failed" into one answer.
			//
			// This was never a payload decision, though it read like one: `git log -L` puts the
			// three-field projection in the tool's ORIGINAL commit (d63333d, 2026-06-28, "read live
			// terminal output + run state"). `alive`/`ready`/`runnerConnected` were already on the
			// route two days earlier and simply were not carried; `authPrompt` arrived five weeks
			// later (2026-08-04) and nobody came back. The decisive evidence that size was not the
			// reason is that the projection KEPT `pane` — up to 64 KB — while dropping four
			// booleans.
			return jsonText({
				sessionId: sid,
				runState: d.runState,
				runnerConnected: d.runnerConnected,
				alive: d.alive,
				ready: d.ready,
				pane: d.pane,
				...(d.authPrompt ? { authPrompt: d.authPrompt } : {}),
			});
		},
	);

	server.tool(
		"coding_session_message",
		"Say something to the coding CLI working on a repo. If nothing is running there it WAKES the repo first — opening its conversation where the last one left off — so a follow-up instruction after a break just works. With several idle repos it asks which one you mean instead of picking.",
		{
			instance_id: z.string().describe("Instance ID"),
			session_id: z.string().optional().describe("Session ID. If omitted, uses the first active session — and if none is running, wakes the repo."),
			message: z.string().describe("Text to type into the CLI terminal"),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, session_id, message, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// SECURITY: typing into the CLI is code execution on the user's machine —
			// the most powerful action here. Gate it like every other mutating tool
			// (scope + MCP_READ_ONLY) and audit it; it was previously ungated.
			// The same gate covers the wake below: opening a conversation launches that process.
			const denied = await requirePermission(safetyFor(token), "runtime", "coding_session_message", { instance_id, session_id });
			if (denied) return denied;
			const r = (await authedCall(`/v1/instances/${instance_id}/coding/sessions`, sessionToken, {}, env)) as { sessions?: Array<{ id: string; status: string }> };
			const sessions = r.sessions || [];
			let sid = session_id || sessions.find((s) => s.status === "active")?.id;
			// WAKE THE REPO RATHER THAN REFUSE (#696). "No active coding session found." answered a
			// caller who asked to talk to an agent with a fact about our process lifecycle — and
			// after the idle reaper has run, that is the state a repo spends most of its life in.
			// Opening here goes through the SAME continuity policy the console uses, so the woken
			// conversation is the one the caller was in yesterday, not a cold start.
			let woke = "";
			if (!sid) {
				const resolved = resolveRepoForOpen(await listRepos(instance_id, sessionToken));
				// Several idle repos: the caller named a message, not a repo, and there is nothing
				// running to infer one from. Ask — opening the wrong repo would type someone's
				// instruction into the wrong checkout and report success.
				if ("ask" in resolved) return text(`${resolved.ask} Then send this again, or open it with coding_session_open.`);
				const opened = await openConversation(instance_id, sessionToken, resolved.repo.id);
				if (opened?.error) return text(`Error waking ${repoLabel(resolved.repo)}: ${opened.error}`);
				if (!opened.session?.id) return text(`Could not wake ${repoLabel(resolved.repo)} — the server opened no conversation, so nothing was sent.`);
				sid = opened.session.id;
				woke = `${openConversationText(repoLabel(resolved.repo), opened)}\n`;
			}
			const sent = (await authedCall(`/v1/instances/${instance_id}/coding/sessions/${sid}/message`, sessionToken, { method: "POST", body: JSON.stringify({ text: message }) }, env)) as { error?: string };
			// authedCall returns { error } on any non-2xx (runner offline, dead session) — do
			// NOT report "sent" for a command that never ran; this is code execution on the user's box.
			if (sent?.error) return text(`${woke}Error sending to session ${sid}: ${sent.error}`);
			await audit(safetyFor(token), { tool: "coding_session_message", action: "completed", input: { instance_id, session_id: sid, woke: woke !== "", messageBytes: new TextEncoder().encode(message).length } });
			return text(`${woke}Sent to session ${sid}: "${message}"`);
		},
	);

	server.tool(
		"coding_session_restart",
		"Restart the coding CLI session on the selected runner node. Use when the CLI is stuck or erroring.",
		{
			instance_id: z.string().describe("Instance ID"),
			session_id: z.string().optional().describe("Session ID. If omitted, uses the first active session."),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, session_id, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "runtime", "coding_session_restart", { instance_id, session_id });
			if (denied) return denied;
			const r = (await authedCall(`/v1/instances/${instance_id}/coding/sessions`, sessionToken, {}, env)) as { sessions?: Array<{ id: string; status: string }> };
			const sessions = r.sessions || [];
			const sid = session_id || sessions.find((s) => s.status === "active")?.id;
			if (!sid) return text("No active coding session found.");
			const restarted = (await authedCall(`/v1/instances/${instance_id}/coding/sessions/${sid}/restart`, sessionToken, { method: "POST" }, env)) as { error?: string };
			if (restarted?.error) return text(`Error restarting session ${sid}: ${restarted.error}`);
			await audit(safetyFor(token), { tool: "coding_session_restart", action: "completed", input: { instance_id, session_id: sid } });
			return text(`Session ${sid} restarted.`);
		},
	);

	server.tool(
		"coding_repos_list",
		"List all repos registered in a coding instance, with their status and active sessions.",
		{
			instance_id: z.string().describe("Instance ID"),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const r = (await authedCall(`/v1/instances/${instance_id}/coding/repos`, sessionToken, {}, env)) as { repos?: unknown[] };
			return jsonText(r.repos || []);
		},
	);

	server.tool(
		"coding_repo_add",
		"Add a repo to a coding instance. Accepts a local path (~/dev/...), GitHub owner/repo, or clone URL.",
		{
			instance_id: z.string().describe("Instance ID"),
			path: z.string().describe("Local path (~/dev/my-repo), owner/repo, or clone URL"),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, path, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "write", "coding_repo_add", { instance_id, path });
			if (denied) return denied;
			const body: Record<string, string> = {};
			if (path.startsWith("~") || path.startsWith("/")) body.localPath = path;
			else if (path.includes("://") || path.includes(".git")) body.cloneUrl = path;
			else if (path.includes("/")) { body.githubRepo = path; body.cloneUrl = `https://github.com/${path}.git`; }
			else body.name = path;
			const r = await authedCall(`/v1/instances/${instance_id}/coding/repos`, sessionToken, { method: "POST", body: JSON.stringify(body) }, env);
			await audit(safetyFor(token), { tool: "coding_repo_add", action: "completed", input: { instance_id, path } });
			return jsonText(r);
		},
	);

	server.tool(
		"coding_sessions_list",
		"List all coding sessions (active + ended) for an instance.",
		{
			instance_id: z.string().describe("Instance ID"),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const r = (await authedCall(`/v1/instances/${instance_id}/coding/sessions`, sessionToken, {}, env)) as { sessions?: unknown[] };
			return jsonText(r.sessions || []);
		},
	);

	server.tool(
		"coding_session_end",
		"End a coding session completely. Stops the CLI process/session on the runner.",
		{
			instance_id: z.string().describe("Instance ID"),
			session_id: z.string().optional().describe("Session ID. If omitted, uses the first active session."),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, session_id, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "runtime", "coding_session_end", { instance_id, session_id });
			if (denied) return denied;
			const r = (await authedCall(`/v1/instances/${instance_id}/coding/sessions`, sessionToken, {}, env)) as { sessions?: Array<{ id: string; status: string }> };
			const sid = session_id || (r.sessions || []).find((s) => s.status === "active")?.id;
			if (!sid) return text("No active coding session found.");
			const ended = (await authedCall(`/v1/instances/${instance_id}/coding/sessions/${sid}/end`, sessionToken, { method: "POST" }, env)) as { error?: string };
			if (ended?.error) return text(`Error ending session ${sid}: ${ended.error}`);
			await audit(safetyFor(token), { tool: "coding_session_end", action: "completed", input: { instance_id, session_id: sid } });
			return text(`Session ${sid} ended.`);
		},
	);

	server.tool(
		"coding_session_fresh",
		"End the current session and start a brand new one (clean state, no --resume). Fixes corrupted CLI state.",
		{
			instance_id: z.string().describe("Instance ID"),
			repo_id: z.string().optional().describe("Repo ID. If omitted, uses the repo of the first active session."),
			engine_id: z.string().optional().describe("Engine preset ID (default: claude)"),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, repo_id, engine_id, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "runtime", "coding_session_fresh", { instance_id, repo_id });
			if (denied) return denied;
			const r = (await authedCall(`/v1/instances/${instance_id}/coding/sessions`, sessionToken, {}, env)) as { sessions?: Array<{ id: string; status: string; repoId: string }> };
			const active = (r.sessions || []).find((s) => s.status === "active");
			const repoId = repo_id || active?.repoId;
			if (!repoId) return text("No repo specified and no active session to infer from.");
			if (active) await authedCall(`/v1/instances/${instance_id}/coding/sessions/${active.id}/end`, sessionToken, { method: "POST" }, env);
			// `fresh: true` (#408): a new session now CONTINUES the repo's recent conversation by
			// default, and the one this tool just ended is the most recent there is — so without the
			// flag, "clean state, no --resume" hands back the very state it was called to escape.
			const d = await authedCall(`/v1/instances/${instance_id}/coding/sessions`, sessionToken, { method: "POST", body: JSON.stringify({ repoId, engineId: engine_id || "claude", fresh: true }) }, env);
			await audit(safetyFor(token), { tool: "coding_session_fresh", action: "completed", input: { instance_id, repoId } });
			return jsonText(d);
		},
	);

	server.tool(
		"coding_overseer",
		"Ask the cross-repo Overseer agent. It sees all repos, their live sessions, and recent terminal output. Can answer questions and drive Claude Code on specific repos.",
		{
			instance_id: z.string().describe("Instance ID"),
			message: z.string().describe("Question or instruction for the Overseer"),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, message, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// The Overseer can drive Claude Code on any repo → runtime-scoped.
			const denied = await requirePermission(safetyFor(token), "runtime", "coding_overseer", { instance_id });
			if (denied) return denied;
			const d = (await authedCall(`/v1/instances/${instance_id}/coding/overseer`, sessionToken, { method: "POST", body: JSON.stringify({ message }) }, env)) as { reply?: string; error?: string };
			if (d?.error) return text(`Overseer error: ${d.error}`);
			await audit(safetyFor(token), { tool: "coding_overseer", action: "completed", input: { instance_id, messageBytes: new TextEncoder().encode(message).length } });
			return text(d.reply || "(no response)");
		},
	);

	server.tool(
		"coding_diagnostics",
		"Full diagnostics for a coding instance: runner connectivity, terminal sessions, repos, issues. Use to debug why sessions are offline or stuck.",
		{
			instance_id: z.string().describe("Instance ID"),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const d = await authedCall(`/v1/instances/${instance_id}/coding/diagnostics`, sessionToken, {}, env);
			return jsonText(d);
		},
	);
}
