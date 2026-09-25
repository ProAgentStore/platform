/**
 * Which drivers can measure engine spend — and how the ones that cannot are RECORDED (#348).
 *
 * `recordEngineUsage` is fed from exactly one source: the stream-json `result` event that
 * `headless.ts` reads off a Claude Code child process. Every other way the platform drives a
 * coding CLI produces no ledger row at all, and a missing row on a page that shows dollars reads
 * as zero dollars. A tmux-driven Claude Code session and an idle account therefore look identical,
 * which is how "tmux is cheaper" became a conclusion somebody was about to draw from #249's A/B.
 * It is not cheaper. It is invisible. The transport does not change what is sent to the API.
 *
 * ── THE RULE ──
 *
 * A zero you did not measure is a lie; an absence you did measure is data. The platform has now
 * applied it three times — #294 keeps `succeeded` / `FAILED` / `not observed` apart, #263 keeps
 * `unsupported` and `unreadable` unmerged, #313 refuses to coalesce a missing day to zero — and
 * this is the same shape a fourth time.
 *
 * ── WHAT IS NOT DONE HERE, DELIBERATELY ──
 *
 * No cost figure is parsed out of a terminal pane. A pane carries rendered text, and a dollar
 * amount scraped from it would be a guess wearing a measurement's clothes — precisely the move
 * this codebase has repeatedly refused. The pane's FOREGROUND COMMAND is different in kind: tmux
 * reports `#{pane_current_command}` as a fact, and it is used only to make the recorded absence
 * more specific, never to make it disappear. When it cannot be read, the observation still stands.
 *
 * Metering is a property of the (driver, engine) PAIR, not of the engine. Claude Code is measured
 * under the Pilot and unmeasured through a pane — same binary, same repo, same spend.
 */
import { logEvent } from "./events.js";
import type { UnmeteredUsageSummary } from "./usage-shape.js";
import type { Env } from "../types.js";
import { expectedEngineInvocationMode } from "./coding-engines.js";

/**
 * How the platform is driving the CLI.
 *
 *  headless — the runner spawns it as a child process and reads its stdout (`headless.ts`).
 *  terminal — the tmux / kitty / iTerm2 connector types into a pane a human also uses.
 */
export type EngineDriver = "headless" | "terminal";

export interface MeteringVerdict {
	metered: boolean;
	/** One plain sentence, fit to print on a page or hand to a model. Never a number. */
	reason: string;
}

/**
 * Binaries that are AI coding CLIs — a pane running one of these is spending tokens.
 *
 * A CLOSED list, and its failure mode is asymmetric on purpose: an unlisted CLI is not claimed to
 * be free, it is simply recorded as an unmetered drive with an unrecognised command. Membership
 * can only ever make a recorded absence MORE specific, so a stale list costs detail, never truth.
 */
const AI_CLI_COMMANDS = new Set([
	"claude",
	"claude-code",
	"codex",
	"grok",
	"aider",
	"gemini",
	"cursor-agent",
	"opencode",
	"goose",
	"amp",
	"crush",
]);

/**
 * Engines that end a turn with a structured event carrying token counts.
 *
 * Claude Code also reports a cost estimate. Codex reports token counts through `exec --json` but
 * no dollar figure on the observed 0.151.0 schema, so its cost source stays absent.
 */
const STRUCTURED_ENGINES = new Set(["claude", "claude-code", "codex"]);

/**
 * The bare binary name behind whatever the runner reported.
 *
 * A pane's foreground command arrives as anything from `claude` to `/opt/homebrew/bin/claude` to
 * `node`. Path and arguments are stripped; the result is lowercased. Returns "" for a value that
 * carries no name at all — which the caller must treat as UNKNOWN, never as "nothing was running".
 */
export function normalizePaneCommand(raw: string | null | undefined): string {
	const s = String(raw ?? "").trim();
	if (!s) return "";
	const first = s.split(/\s+/)[0] ?? "";
	const base = first.split("/").pop() ?? "";
	// A pure version number is not a program name (#498). Claude Code rewrites its argv, so
	// `#{pane_current_command}` answered `2.1.226` for a pane running it — and the trace then read
	// "pane running 2.1.226", naming a version as if it were a program. Returning "" routes it to
	// the honest branch instead: the pane's command could not be read. The runner now asks the
	// process tree for the real `comm` first, so this is the residue, not the common case.
	if (/^v?\d+(\.\d+)+$/.test(base)) return "";
	return base.toLowerCase().slice(0, 60);
}

/** True when the reported command is a known AI coding CLI. False also covers "unknown". */
export function isAiCli(raw: string | null | undefined): boolean {
	return AI_CLI_COMMANDS.has(normalizePaneCommand(raw));
}

/**
 * Can spend from this (driver, engine) pair reach the ledger?
 *
 * The reason string is the product here. "unmetered: true" is not something a Usage page can
 * print; a sentence saying which part of the pipeline drops the number is.
 *
 * `launchCommand` is the third input the verdict genuinely depends on, and only for Codex: it
 * reports tokens under `exec --json` and says nothing at all under any other subcommand, so the
 * engine NAME alone cannot answer the question for it. Absent (an older session row that never
 * recorded one) reads as the default invocation, which is structured — the same answer this
 * function gave before the argument existed, so nothing reclassifies retroactively.
 */
export function classifyEngineMetering(driver: EngineDriver, engine?: string | null, launchCommand?: string | null): MeteringVerdict {
	const name = normalizePaneCommand(engine);
	if (driver === "terminal") {
		// Note the engine is IRRELEVANT to the verdict here. A pane holds rendered characters, so
		// even Claude Code's own usage record — which exists, on stdout — never crosses the relay.
		return {
			metered: false,
			reason: name
				? `A terminal pane carries rendered output only, so ${name}'s token usage never reaches the platform.`
				: "A terminal pane carries rendered output only, so any CLI's token usage inside it never reaches the platform.",
		};
	}
	if (STRUCTURED_ENGINES.has(name)) {
		if (name === "codex") {
			// The one engine whose answer the name cannot carry: `codex exec --json` emits per-turn
			// tokens, `codex` under any other subcommand emits prose. Same binary, opposite verdict.
			if (expectedEngineInvocationMode("codex", launchCommand) === "raw") {
				return { metered: false, reason: "This Codex session is not launched as `exec --json`, so it ends a turn with plain stdout and reports no token counts." };
			}
			return { metered: true, reason: "Codex exec --json reports each turn's tokens; the observed schema does not report a dollar cost." };
		}
		return { metered: true, reason: "Claude Code reports each turn's tokens and cost, and that figure is recorded as measured." };
	}
	return {
		metered: false,
		reason: name
			? `${name} ends a turn with plain stdout and reports no token counts, so its spend cannot be measured.`
			: "This engine reports no token counts, so its spend cannot be measured.",
	};
}

// ---------------------------------------------------------------------------
// Recording the absence
// ---------------------------------------------------------------------------

/** One drive through an unmetered path, as the connector observed it. */
export interface UnmeteredObservation {
	driver: EngineDriver;
	/** The terminal target driven, e.g. `tmux:main`. */
	target: string;
	/**
	 * The pane's foreground command as the runner read it.
	 *
	 * `null` (or absent) means UNREADABLE — an older runner, or a backend with no way to ask. It is
	 * emphatically NOT "no AI CLI was running": a pane whose foreground command reads `zsh` may
	 * have run a `claude -p` that finished between two of our reads. Following #263, unreadable and
	 * observed-not-an-AI-CLI are kept apart and neither is allowed to mean "nothing was spent".
	 */
	activeCommand?: string | null;
}

export interface UnmeteredContext {
	userId: string;
	instanceId: string;
	traceId?: string | null;
	/** ms epoch; injected by tests. */
	now?: number;
}

/** UTC "YYYY-MM-DD" for a ms-epoch timestamp. */
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The trace row's key for an unmetered drive.
 *
 * Deliberately COARSE: one row per instance, target, day and whether an AI CLI was seen. A Loop
 * driving a pane calls `terminal_send_keys` hundreds of times an hour, and hundreds of identical
 * "this was not measured" rows would bury the trace they share with everything else the agent did
 * while telling a reader nothing the first row did not. The resulting count is therefore
 * "drives on distinct target-days", which is what the Usage page says it is — not a call count.
 *
 * The `ai` suffix means a pane that starts as a shell and later runs Claude Code still gets its
 * own, more specific row rather than being swallowed by the first one.
 */
export function unmeteredRowId(instanceId: string, day: string, target: string, aiCli: boolean): string {
	return `unmetered:${instanceId}:${day}:${target}:${aiCli ? "ai" : "unknown"}`.slice(0, 300);
}

/** The sentence written into the trace. States what was driven and what is missing. */
export function describeUnmetered(obs: UnmeteredObservation): string {
	const cmd = normalizePaneCommand(obs.activeCommand);
	if (isAiCli(obs.activeCommand)) {
		return `Drove ${cmd} in ${obs.target} — its token spend is NOT measured and is missing from your usage total.`;
	}
	// A PANE is a terminal-driver notion. Opening the headless row (#556) made these two sentences
	// reachable for a child process the platform spawned itself, where "the pane's command could
	// not be read" would describe machinery that is not there — and a record whose wording implies
	// the wrong mechanism sends the reader to the wrong file, which is the cost this whole module
	// exists to avoid. Unreachable in practice today (a session's `clientType` is always one of the
	// four the cloud derives, all of them AI CLIs, so the branch above takes every headless drive),
	// which is exactly why it would have gone unnoticed.
	const where = obs.driver === "headless" ? "the engine did not name itself" : "the pane's command could not be read";
	if (!cmd) {
		return `Drove ${obs.target} — ${where}, so any AI CLI spend inside it is NOT measured.`;
	}
	const running = obs.driver === "headless" ? `running ${cmd}` : `pane running ${cmd}`;
	return `Drove ${obs.target} (${running}) — any AI CLI spend inside it is NOT measured.`;
}

/**
 * Write one "this was not measured" observation to the unified trace.
 *
 * ── NO NEW TABLE ──
 *
 * `agent_events` (0038), same as #294's consequential acts and for the same reason: the record is
 * visible in `GET /v1/instances/:id/trace` and the MCP `agent_trace` tool from the first write,
 * with nothing new to teach anybody. It is explicitly NOT an `ai_usage` row — a row in the ledger
 * would have to carry a cost, and the only honest cost here is one nobody knows.
 *
 * Best-effort, like every other recorder: instrumentation must never break the path it observes.
 */
export async function recordUnmeteredEngineActivity(
	env: Env,
	ctx: UnmeteredContext,
	obs: UnmeteredObservation,
): Promise<void> {
	if (!ctx.userId || !ctx.instanceId || !obs.target) return;
	const now = typeof ctx.now === "number" ? ctx.now : Date.now();
	const aiCli = isAiCli(obs.activeCommand);
	await logEvent(env, {
		id: unmeteredRowId(ctx.instanceId, dayOf(now), obs.target, aiCli),
		source: obs.driver,
		event: "usage.unmetered",
		// `info`, not `warn`. In this trace `warn` means "a human should look at THIS ONE", and a
		// per-drive warning on a path that runs continuously would drown the acts #294 made loud.
		// The place a human is meant to notice this is the Usage page, where the total is.
		level: "info",
		userId: ctx.userId,
		instanceId: ctx.instanceId,
		traceId: ctx.traceId || null,
		message: describeUnmetered(obs),
		context: {
			driver: obs.driver,
			target: obs.target,
			// The command as READ, plus the fact of whether it could be read at all. The two can
			// disagree — a runner that reported a value carrying no NAME (a rewritten argv, #498)
			// is `readable: true` with a null command, which is exactly what happened.
			paneCommand: normalizePaneCommand(obs.activeCommand) || null,
			paneCommandReadable: obs.activeCommand != null,
			aiCli,
			metered: false,
		},
		ts: now,
	});
}

/**
 * The connector-side one-liner: note that this drive went through an unmetered path.
 *
 * Structurally typed rather than taking a `RegistryToolCtx` so this module stays outside the
 * connector import graph, and tolerant of a ctx missing a user or instance (a tool can be invoked
 * without one) — there is nothing to attribute then, so it records nothing rather than a row
 * belonging to nobody. Never throws: a tool call must not fail because its footnote did.
 */
export async function noteUnmeteredDrive(
	env: Env,
	ctx: { userId?: string; instanceId?: string; traceId?: string },
	obs: { driver: EngineDriver; target: string; activeCommand?: unknown },
): Promise<void> {
	if (!ctx.userId || !ctx.instanceId) return;
	try {
		await recordUnmeteredEngineActivity(
			env,
			{ userId: ctx.userId, instanceId: ctx.instanceId, traceId: ctx.traceId ?? null },
			{
				driver: obs.driver,
				target: obs.target,
				// Anything that is not a string is UNREADABLE, including the `undefined` an older
				// runner sends. Coercing it to "" would claim we looked and saw nothing running.
				activeCommand: typeof obs.activeCommand === "string" ? obs.activeCommand : null,
			},
		);
	} catch {
		/* observability, never load-bearing */
	}
}

/**
 * The other row of the 2x2: a HEADLESS drive of an engine that reports no token counts (#556).
 *
 * #348 built the classifier over both axes and then wired the recorder to one of them — the two
 * terminal connectors, where the reported problem was. That left the cell the classifier is most
 * needed for: under `terminal` the verdict is a CONSTANT (a pane carries rendered characters, so
 * nothing is measurable whatever runs in it), which is exactly why those six sites could call
 * `noteUnmeteredDrive` unconditionally and never consult `classifyEngineMetering` at all. Under
 * `headless` the verdict VARIES by engine — Claude Code and Codex report structured turns,
 * grok/gemini still end a turn with plain stdout — so this is the one place a call is
 * load-bearing rather than decorative.
 * That is the whole reason the function had no production caller: not a call site that turned out
 * to be hard, just the one row of the table nobody wired.
 *
 * Called from the DRIVE sites, not from the capture drain. The drain is a 3s poll and a poll is
 * not a drive: recording one would claim spend on an idle session somebody merely has open, which
 * is the same class of overclaim `describeUnmetered` refuses when it declines to read a quiet pane
 * as "nothing was spent". The terminal half records on `run`/`send`/`send_message` for the same
 * reason, and the row id's day granularity means one drive covers the day either way — including
 * a Pilot handoff, whose forty subsequent instructions collapse into the row its `/run` opened.
 *
 * A metered pair records nothing at all: `ai_usage` already carries the measured figure, and a
 * "this was not measured" row beside a measurement would be false.
 */
export async function noteUnmeteredHeadlessDrive(
	env: Env,
	ctx: { userId?: string; instanceId?: string; traceId?: string },
	session: { id: string; clientType?: string | null; launchCommand?: string | null },
): Promise<void> {
	// Through the classifier, not around it (#556). The invocation-mode refinement this guard needs
	// lives INSIDE `classifyEngineMetering` now, so there is still exactly one place that answers
	// "can this reach the ledger". Asking `expectedEngineInvocationMode` directly also had to route
	// the engine name through `asClient`, which falls back to "claude" for anything outside its
	// four-name list — so aider, opencode, goose, amp, crush and cursor-agent all read as structured
	// and recorded nothing, which is the same silence #556 was opened about.
	if (classifyEngineMetering("headless", session.clientType, session.launchCommand).metered) return;
	await noteUnmeteredDrive(env, ctx, {
		// The runner's own `engineLabel` shape (`<engine>:<session id>`), rebuilt from the two
		// fields the cloud holds so the trace names the same thing both sides call it.
		target: `${normalizePaneCommand(session.clientType) || "engine"}:${session.id}`,
		driver: "headless",
		// The engine is a CHILD PROCESS this platform spawned, so unlike a pane's foreground
		// command this is not an observation that can fail — we chose the binary. It is passed so
		// `isAiCli` can recognise it and the row lands as `aiCli: true`, which is what separates
		// "an AI CLI ran unmeasured" from "we could not see what was in there".
		activeCommand: session.clientType,
	});
}

// ---------------------------------------------------------------------------
// Reading it back for the Usage page
// ---------------------------------------------------------------------------

/**
 * What the Usage total leaves out, as a measured quantity.
 *
 * Declared in `usage-shape.ts` (#608) because it is part of the `/v1/usage` body the console
 * reads, and that file is the one declaration of it. Re-exported here, where it is computed.
 */
export type { UnmeteredUsageSummary } from "./usage-shape.js";

/** The trace's opportunistic retention (lib/events.ts). A count cannot outrun it. */
export const UNMETERED_WINDOW_MAX_DAYS = 14;

export const emptyUnmeteredSummary = (windowDays: number): UnmeteredUsageSummary => ({
	drives: 0,
	aiCliDrives: 0,
	instances: 0,
	lastAt: null,
	windowDays,
});

/**
 * Count the unmetered drives behind a user's usage figures.
 *
 * Returns an empty summary on any failure — this decorates a page, it must never fail one. An
 * empty summary here means "nothing recorded", which is the same claim the page already makes
 * unconditionally in prose ("the terminal connector is not measured"), so a read failure degrades
 * to the weaker true statement rather than to a false one.
 */
export async function unmeteredUsageSummary(
	env: Env,
	userId: string,
	opts: { rangeDays?: number; now?: number } = {},
): Promise<UnmeteredUsageSummary> {
	const windowDays = Math.max(1, Math.min(UNMETERED_WINDOW_MAX_DAYS, Math.floor(opts.rangeDays ?? UNMETERED_WINDOW_MAX_DAYS)));
	const now = typeof opts.now === "number" ? opts.now : Date.now();
	try {
		const since = now - windowDays * 86_400_000;
		const row = await env.DB.prepare(
			`SELECT COUNT(*) AS drives,
			        COUNT(DISTINCT instance_id) AS instances,
			        MAX(ts) AS last_at,
			        SUM(CASE WHEN context LIKE '%"aiCli":true%' THEN 1 ELSE 0 END) AS ai_drives
			   FROM agent_events
			  WHERE user_id = ?1 AND event = 'usage.unmetered' AND ts >= ?2`,
		)
			.bind(userId, since)
			.first<{ drives: number; instances: number; last_at: number | null; ai_drives: number | null }>();
		const drives = Math.max(0, Number(row?.drives ?? 0));
		if (!drives) return emptyUnmeteredSummary(windowDays);
		return {
			drives,
			aiCliDrives: Math.max(0, Number(row?.ai_drives ?? 0)),
			instances: Math.max(0, Number(row?.instances ?? 0)),
			lastAt: row?.last_at != null ? Number(row.last_at) : null,
			windowDays,
		};
	} catch {
		return emptyUnmeteredSummary(windowDays);
	}
}
