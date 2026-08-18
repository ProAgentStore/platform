import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import { runHealthSentence } from "../state-vocabulary.js";
import { type InstanceToolsCtx, findInstanceForAgent } from "./shared.js";

/** Coding tools — the surface-gated system_status plus the always-on Agent Loop tools. */
export function registerCodingTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor, groups } = ctx;
	// Coding-only: hits /coding/diagnostics, so gate it to coding-surface agents (the same
	// endpoint coding_diagnostics gates). Otherwise a Repo-Chat/apply-only user sees a
	// coding tool that can't apply to their agent — the exact leak the registry closes.
	if (groups.has("coding")) {
		server.tool(
			"system_status",
			"Full diagnostics for a coding instance: runner connectivity, node name, tmux sessions, repos, issues. Use this to understand why sessions are offline or to check the runner's machine.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				instance_id: z.string().describe("Instance ID or slug"),
			},
			async ({ token, instance_id }) => {
				const sessionToken = tokenFor(token);
				if (!sessionToken) return authRequired();
				const inst = await findInstanceForAgent(env, sessionToken, instance_id);
				const id = inst?.id || instance_id;
				const data = await authedCall(
					`/v1/instances/${id}/coding/diagnostics`,
					sessionToken,
					{},
					env,
				);
				return jsonText(data);
			},
		);

		// ── The live feed (#581), which is also the finished-run audit (#527) ──
		//
		// Thirteen coding tools were registered and none of them read `coding_timeline`, the
		// append-only per-session record that the Pilot writes DURING a run. So the two questions
		// an owner most often has about an autonomous run — "what is it doing right now" and "what
		// did that run actually do" — were answerable only from the pane, and only by someone who
		// already knew a session id. #580 measured what that costs: a run whose engine died at step
		// 1 reported `running` for 4.35 hours and the truth existed nowhere else.
		//
		// ONE tool for both, because they differ only in whether you keep asking. `since_seq` makes
		// it a poll; omitting `session_id` resolves the newest active session, or — the half that
		// answers #527 — the most recently updated one when the run has already ended.
		//
		// Giving one tool both jobs is also what produced #674, and the fix is in the DEFAULT rather
		// than in a second tool. A page with no cursor used to be the OLDEST one; every instruction
		// in a run precedes every piece of output, so page 1 was `brain, brain, command` and the
		// owner reading it here concluded the engine's output was not recorded — while it sat one
		// page away, further away the more work the run had done. A caller who names no cursor now
		// gets the newest page, `before` walks back, and `since_seq` polls forward exactly as it did.
		// The two rejected alternatives (defaulting by session state; guaranteeing a `terminal` row
		// per page) are argued in `lib/coding-timeline.ts`'s header — the first has a race, because
		// the Pilot ends a session on every finished run and would re-point a live poll mid-loop.
		//
		// WHAT IT CARRIES, and what it still does not — stated here because the description is where
		// a model reads it. The first version of this comment said the tool was a NARRATIVE and "not
		// a structured tool-call log with arguments and results"; #581 AC7 closed that half, and the
		// reason it could be closed without a single new write is that the record was already there:
		// 883 of 914 production `terminal` rows carry the engine's own `⚙ <tool> <input>` /
		// `↳ <result>` framing, a mean of 12.05 calls per row, and this feed's 400-char tail was
		// cutting ~95% of them away. `engine-tool-calls.ts` parses them; a `terminal` event now
		// carries `toolCalls`.
		//
		// Whether a call SUCCEEDED was the half that record could not answer — the runner computed
		// `is_error` and wrote the result line without it. #597 welds the verdict onto the arrow, so
		// `ok` is now OBSERVED rather than derived (deriving it from the result text is the guess
		// `describeEngineAct` refuses on the same data, and stays refused). It is explicitly `null`
		// for a call still in flight and for every snapshot written by a runner predating the marker
		// — stated in the description, because a model told to check a key reads its ABSENCE as
		// fine, which is the inversion #594 named. A consequential act's verdict is still in
		// `agent_trace(source:"coding")`, which is also where an act is checked against the run that
		// made it.
		server.tool(
			"coding_timeline",
			"Read what a coding run is DOING, while it is still running — the objective it was given, each instruction sent to the engine, terminal snapshots and the outcome. Call it with no cursor and you get the NEWEST page (rows within a page always read oldest→newest), which is what you want when asking what a run just did or where it stopped. Poll it: pass the previous reply's `next_seq` as `since_seq` and you get only what is new, so nothing is re-delivered or skipped. Walk back through history with `before`: pass the previous reply's `oldest_seq`, and `has_more` says whether anything older still exists. Omit `session_id` and it picks the newest active session, or the most recent one if the run has ended — which is how you audit a finished run whose session coding_session_capture now answers with an empty pane. Read `run_state` with the events: no new events plus `thinking`/`responding` is a long step, no new events plus `idle`/`offline` is an engine that has stopped. Terminal snapshots carry `toolCalls` — every tool the engine called in that snapshot with its argument and its result — de-duplicated against the previous snapshot, so a poll returns only calls you have not seen; a `toolCallGap` says continuity was lost and some calls are missing. The snapshot's own text is also returned as a 400-character TAIL with `chars` giving the true length (that is where an engine error prints, which is not a tool call); for the whole pane use coding_session_capture on a LIVE session and coding_terminal on one that has ENDED — coding_terminal reads the same stored snapshots this feed tails, uncut. Each call carries `ok`: true or false is the engine's own verdict, and null means NOT OBSERVED — the call had no result yet, or the snapshot was written by a runner older than the outcome marker, so treat null as unknown and never as success; for a consequential act's verdict use agent_trace(source:\"coding\").",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				instance_id: z.string().describe("Instance ID or slug"),
				session_id: z.string().optional().describe("A specific coding session. Omit for the newest active one, else the most recently updated."),
				since_seq: z.number().int().min(0).optional().describe("Exclusive `seq` cursor — returns only events NEWER than it, oldest-first. Pass the previous reply's `nextSeq` to poll a live run. Cannot be combined with `before`."),
				before: z.number().int().min(1).optional().describe("Exclusive `seq` cursor for walking BACK — returns the page of events OLDER than it. Pass the previous reply's `oldestSeq`. Cannot be combined with `since_seq`."),
				limit: z.number().int().min(1).max(200).optional().describe("Events per page (default 40). Not the payload bound: a page also stops at a byte budget, and `hasMore` says so — raising this cannot make one call return more bytes."),
			},
			async ({ token, instance_id, session_id, since_seq, before, limit }) => {
				const sessionToken = tokenFor(token);
				if (!sessionToken) return authRequired();
				const denied = await requirePermission(safetyFor(token), "read", "coding_timeline", { instance_id, session_id });
				if (denied) return denied;
				const id = await resolveId(sessionToken, instance_id);
				const qs = new URLSearchParams();
				if (session_id) qs.set("session_id", session_id);
				if (since_seq !== undefined) qs.set("since", String(since_seq));
				if (before !== undefined) qs.set("before", String(before));
				if (limit !== undefined) qs.set("limit", String(limit));
				const path = `/v1/instances/${encodeURIComponent(id)}/coding/timeline${qs.toString() ? `?${qs.toString()}` : ""}`;
				// A page of terminal tails is machine-read data: this one measured 44,313 bytes
				// pretty-printed against 40,304 compact (#581). `jsonText` is compact for every tool
				// since #586 — the `{compact:true}` that used to be here is gone because the option
				// is gone, not because this tool stopped caring about the 4 KB.
				return jsonText(await authedCall(path, sessionToken, {}, env));
			},
		);

		// ── The pane itself, whole, after the run has ended (#699) ──
		//
		// `coding_timeline` above serves a `terminal` row as a 400-character TAIL, and that is right
		// for a feed: a page holds forty events under `FEED_BYTE_BUDGET`, and forty 8,000-character
		// panes do not fit in one MCP reply — five of them alone overflow a 64 KiB host limit. But it
		// meant the engine's own prose, the analysis between the tool calls, was reachable at 5% of
		// what D1 holds. Measured live on 2026-08-18: an ended session with 8 snapshots stores 64,000
		// characters and MCP could reach 3,200.
		//
		// `coding_session_capture` is not the missing reader and correctly cannot be: the pane is a
		// runner buffer, so an ENDED session answers with an empty one — verified on the same session,
		// 65,076 characters live at 09:04 and `pane:""` eight minutes later, while its 16,000 stored
		// characters never moved. The full text was reachable for eight minutes through a route MCP
		// does not call, and afterwards through no MCP tool at all.
		//
		// So this is a THIRD read, not a flag on either of the other two. A `full_text: true` on
		// `coding_timeline` would swing one tool's reply by 20x on a boolean, which is the shape #578
		// measured as a defect on `list_instance_tools`' opt-in path. Two tools, two bounds.
		//
		// BOUNDED BY ROWS, and the default is 1. `FEED_BYTE_BUDGET` cannot be reused here because a
		// byte budget must be free to cut a row, and a snapshot cut mid-line is a different answer
		// rather than a smaller one. The arithmetic behind the 1: a stored `terminal` row is hard
		// capped at `TERMINAL_SNAPSHOT_CHARS` = 8,000 by `snapshotForStore` — which is where the
		// production mean of 8,068 comes from, and the 12,000 max the corpus in
		// `lib/coding-timeline.ts` records is from rows written before that cap. So one row is ~8 KB of
		// the 64 KiB a host allows, and even a pathological pane of nothing but control characters (six
		// bytes each once JSON-escapes them to \u001b) is 48,000 B and still fits. At `limit: 2` that
		// worst case does not, which is why the default is one rather than two. `max(4)` is
		// the ceiling a caller may ask for: four realistic panes are ~33 KB, and `hasMore` plus
		// `before` carry the rest at no risk of a reply the host refuses whole.
		server.tool(
			"coding_terminal",
			"Read a coding session's terminal snapshots in FULL — the engine's own output, uncut. This is the tool for a run that has ENDED: coding_session_capture reads the live pane off the runner, so a finished session answers it with an empty pane, and coding_timeline serves the same snapshots as a 400-character tail (~5% of an 8,000-character pane) because a page of forty events cannot carry forty whole panes. Omit session_id and it resolves the same session coding_timeline would — the newest active one, or the most recently updated when the run has ended. One snapshot per call by default, newest first: pass the reply's `oldestSeq` back as `before` to walk into the history, and `hasMore` says whether anything older is left. Consecutive snapshots overlap heavily by design (each is the tail of the same scrolling pane), so read them newest-first and stop when you have what you need. For the run's narrative — objective, instructions, tool calls, outcome — read coding_timeline; this tool returns only the pane text.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				instance_id: z.string().describe("Instance ID or slug"),
				session_id: z.string().optional().describe("A specific coding session. Omit for the newest active one, else the most recently updated — the same rule coding_timeline uses."),
				before: z.number().int().min(1).optional().describe("Exclusive `seq` cursor for walking BACK through the stored snapshots. Pass the previous reply's `oldestSeq`."),
				limit: z.number().int().min(1).max(4).optional().describe("Snapshots per call (default 1). A snapshot is up to 8,000 characters and is never truncated, so this is the payload bound — 4 is the ceiling that still fits a calling host's 64 KiB limit."),
			},
			async ({ token, instance_id, session_id, before, limit }) => {
				const sessionToken = tokenFor(token);
				if (!sessionToken) return authRequired();
				const denied = await requirePermission(safetyFor(token), "read", "coding_terminal", { instance_id, session_id });
				if (denied) return denied;
				const id = await resolveId(sessionToken, instance_id);
				const qs = new URLSearchParams({ terminal: "1", limit: String(limit ?? 1) });
				if (session_id) qs.set("session_id", session_id);
				if (before !== undefined) qs.set("before", String(before));
				const path = `/v1/instances/${encodeURIComponent(id)}/coding/timeline?${qs.toString()}`;
				return jsonText(await authedCall(path, sessionToken, {}, env));
			},
		);
	}

	// ── Agent Loop tools ──
	//
	// These three drive the SERVER's durable loop (`POST /v1/instances/:id/loop` and the
	// `agent_loop_runs` row it creates) — the same runs `start_instance_loop` /
	// `check_instance_loop` / `stop_instance_loop` manage. They are not a separate mechanism.
	//
	// They used to be. `coding_loop_start` ran the entire loop INLINE in this Worker: a `/chat`
	// with the objective, then up to 49 more rounds of `/loop-decide` + `/chat`, all before the
	// tool returned. Neither of those endpoints touches the budget, so that was up to 50
	// unbudgeted BYOK Claude calls — no pool, no reservation, no account-ceiling check — on a
	// path that by definition has no human watching it (#502). #184 promised an admission check
	// at every autonomous entry point; this one never got it, and #374 had already closed the
	// identical escape for the browser Loop by routing it through `POST /loop`.
	//
	// Going through the durable path also buys, for free, everything the inline copy lacked: the
	// single-driver claim (#208) so two Loops cannot type into one engine, merge authority (#314),
	// a run row `stop_instance_loop`/`requestCancel` can actually act on, survival past this
	// request, and dispatch by the agent's DECLARED driver (#210) — so on a Coder this now drives
	// the Engine rather than talking to the chat about the repo.
	//
	// The return shape changed with it: start-and-poll, not a whole transcript. Holding an MCP
	// request open across 50 model calls was its own problem.

	server.tool(
		"coding_loop_start",
		"Give an agent an objective and let it work on it autonomously, on the server. Returns a run id immediately — poll it with coding_loop_status; the run keeps going after this call returns and after you disconnect. Durable and budgeted: its spend is drawn from a pool and stop_instance_loop / coding_loop_stop can end it. What it drives depends on the agent — a coding agent's engine, otherwise its chat. Same runs as start_instance_loop.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
			objective: z.string().describe("What the agent should accomplish"),
			max_iterations: z.number().int().min(1).max(50).optional().describe("Maximum loop iterations (default 10). The server clamps this to your account's loop ceiling."),
			dry_run: z.boolean().optional().describe("Report the run that would be started, and the spend it would commit, without starting it."),
		},
		async ({ token, instance_id, objective, max_iterations, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const maxIter = max_iterations ?? 10;
			// An autonomous run spends the instance's own model budget — runtime-scoped, gated by
			// MCP_READ_ONLY, and audited (was ungated).
			//
			// The gate runs BEFORE the instance is resolved (#328). Resolution is itself a
			// network call, so doing it first meant a caller the scope check was about to
			// refuse still made the server fetch on their behalf — and a dry run could not
			// honour its one promise of touching nothing.
			const denied = await requirePermission(safetyFor(token), "runtime", "coding_loop_start", { instance_id, max_iterations: maxIter });
			if (denied) return denied;
			if (dry_run) {
				// `max_iterations` is a spend commitment, and a model that defaults it to 50 has
				// no other way to find that out before the run starts.
				return dryRun(safetyFor(token), "coding_loop_start", "start an autonomous server-side run", { instance_id, max_iterations: maxIter }, {
					endpoint: `/v1/instances/${instance_id}/loop`,
					method: "POST",
					effect: `${instance_id} would work on this objective by itself, for up to ${maxIter} steps, and keep going after this call returns.`,
					objective,
					objectiveBytes: new TextEncoder().encode(objective).length,
					spend: `Each step spends the instance's own BYOK budget, drawn from a pool opened for the run. coding_loop_stop is the way to end it early.`,
					note: `instance_id is resolved against my_instances on the real call; this dry run does not resolve it, so a slug that does not exist still fails then.`,
				});
			}
			const id = await resolveId(sessionToken, instance_id);
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(id)}/loop`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ objective, maxIterations: maxIter }) },
				env,
			);
			// `authedCall` RETURNS a non-2xx as `{error}` rather than throwing, so reporting
			// without looking is how a refusal gets formatted as a started run.
			if ((data as { error?: string }).error) return jsonText(data);
			await audit(safetyFor(token), {
				tool: "coding_loop_start",
				action: "completed",
				input: { instance_id: id, objectiveBytes: new TextEncoder().encode(objective).length, maxIterations: maxIter },
				result: { runId: (data as { runId?: string }).runId ?? null, budgetId: (data as { budgetId?: string }).budgetId ?? null },
			});
			return jsonText(data);
		},
	);

	server.tool(
		"coding_loop_status",
		// Same caveat as `check_instance_loop`, and for the same measured reason (#580) — the two
		// tools call the SAME endpoint, so a warning on only one of them is a warning a caller can
		// miss by picking the other name. Read that registration's comment for why `health` is
		// quoted rather than re-derived, and for the inference this wording must not re-introduce.
		//
		// That "same caveat" was a comment, and a comment cannot keep two strings equal: both were
		// hand-written, and when `RunHealth` gained `ended` (#588) BOTH went stale, independently.
		// The vocabulary is now rendered from one constant into both, so there is one thing to
		// change and the test fails if either stops carrying it.
		`Check an autonomous run on an instance: status, the step it is on, why it stopped, and the budget pool it draws from. Omit run_id to list the instance's recent runs — most of them will be CLOSED, because this listing has no status filter. Reads the server's run record, so it is correct across reconnects and across clients. Read \`health\` first. ${runHealthSentence()} Do not derive one from \`lastAliveAt\` (the orchestrator's heartbeat) and \`lastProgressAt\` (the last actual advance), because a fresh heartbeat beside a stale advance is equally a long engine turn, a park and a stall. And none of it speaks for the ENGINE: for that read coding_timeline (\`run_state\` plus the events since your last poll) or coding_session_capture.`,
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
			run_id: z.string().optional().describe("A run id from coding_loop_start. Omit to list recent runs."),
		},
		async ({ token, instance_id, run_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "coding_loop_status", { instance_id, run_id });
			if (denied) return denied;
			const id = await resolveId(sessionToken, instance_id);
			const path = run_id
				? `/v1/instances/${encodeURIComponent(id)}/loop/${encodeURIComponent(run_id)}`
				: `/v1/instances/${encodeURIComponent(id)}/loop`;
			return jsonText(await authedCall(path, sessionToken, {}, env));
		},
	);

	// NO `dry_run`, for the same reason `stop_instance_loop` has none (#328): the answer is fully
	// determined by the run id, and the question worth asking first — "which run is that?" — is
	// answered better by `coding_loop_status`, a READ tool. Stopping is also the safe direction:
	// it is cooperative, the in-flight step settles its own spend, and a mistaken stop ends a run
	// early rather than committing anything.
	server.tool(
		"coding_loop_stop",
		"Ask an autonomous run on an instance to stop. Cooperative: the step in flight finishes and settles its spend. Omit run_id to stop the instance's most recent running run — call coding_loop_status first if you want to see which that is.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
			run_id: z.string().optional().describe("The run to stop. Omit to stop the most recent running one."),
		},
		async ({ token, instance_id, run_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "write", "coding_loop_stop", { instance_id, run_id });
			if (denied) return denied;
			const id = await resolveId(sessionToken, instance_id);

			let target = run_id;
			if (!target) {
				const listed = (await authedCall(`/v1/instances/${encodeURIComponent(id)}/loop`, sessionToken, {}, env)) as {
					runs?: Array<{ runId: string; status: string }>;
					error?: string;
				};
				if (listed.error) return jsonText(listed);
				// `listLoopRuns` orders by started_at DESC, so the first running row is the newest.
				target = listed.runs?.find((r) => r.status === "running")?.runId;
				if (!target) return text("No running loop on this instance.");
			}

			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(id)}/loop/${encodeURIComponent(target)}/cancel`,
				sessionToken,
				{ method: "POST" },
				env,
			);
			if ((data as { error?: string }).error) return jsonText(data);
			await audit(safetyFor(token), { tool: "coding_loop_stop", action: "completed", input: { instance_id: id, run_id: target }, result: { ok: true } });
			return jsonText({ ...(data as object), runId: target });
		},
	);

	/** Slug or id → the instance id the API routes expect. */
	async function resolveId(sessionToken: string, instanceId: string): Promise<string> {
		const inst = await findInstanceForAgent(env, sessionToken, instanceId);
		return inst?.id || instanceId;
	}
}
