// The Coding tab's Loop, once it stopped being the thing that RUNS the loop (#374).
//
// ── What it was ──
//
// `use-coding-loop.ts` self-scheduled with `setTimeout`: read `/capture`, ask `/loop-decide` for
// the next instruction, and relay it verbatim to `…/coding/sessions/:id/message` — the route
// documented "manual drive, no brain". It was not a manual drive. The decision came from BYOK
// Claude, cloud-side, up to fifty times, chaining issue after issue in issues-mode. An autonomous
// driver wearing the human-typing path's clothes, which put it on the far side of every guard the
// platform has for autonomous drivers: merge authority (#314) is resolved in the Pilot and screens
// only the Pilot's own instructions; the one-driver-per-engine claim (#208) guards `/run`,
// `drive_claude` and the coding driver but deliberately NOT `/message`, because a human
// interjecting must always get through; and the delegation budget (#184) is opened by `POST /loop`,
// which the browser Loop never called.
//
// ── What it is ──
//
// The button starts a server-driven run (`POST /loop` → `loopDriverFor` → the coding driver → the
// Pilot) and the hook WATCHES `/loop/:runId`, the same shape the Assistant tab has had since #158.
// The gates are not reimplemented here; the decision simply happens where they already run.
//
// What is LEFT to decide is what the Co-pilot thread says and, in issues-mode, whether an issue may
// be struck off — and both are now read off a run row rather than off a `/loop-decide` reply, so
// they live in a pure module instead of inside a hook where no test can reach them.

/** The bits of `GET /v1/instances/:id/loop/:runId` this tab reads. */
export interface LoopRunSnapshot {
	/** `running` while it goes; anything else is terminal. */
	status: string;
	/** Why it ended (`done`, `failed`, `max_iterations`, `cancelled`, …). Absent while running. */
	stopReason?: string | null;
	detail?: string | null;
	iteration?: number;
	/** The SERVER's verdict on the run (`runHealth`, `routes/tools.ts` `withHealth`) — read it, never derive it (#930). */
	health?: string | null;
	/** What a parked run waits for, in the server's words. Present only when parked. */
	waitNote?: string | null;
}

/** How a parked or stalled run shows on a live loop watcher (#930). */
export interface LoopWatchBadge {
	tone: "waiting" | "stalled";
	/** The one word that fits beside the Stop control. */
	word: "Waiting" | "Stalled";
	/** The full sentence, for the tooltip and the screen reader. */
	title: string;
}

/** The chip's colours per tone — one table for both watchers, so the two tabs cannot drift. */
export const LOOP_WATCH_BADGE_CLASS: Record<LoopWatchBadge["tone"], string> = {
	waiting: "border-warning bg-warning-soft text-warning",
	stalled: "border-danger bg-danger-soft text-danger",
};

/**
 * What a live loop watcher says about a run that is NOT simply working — or null when it is.
 *
 * Both watchers (the Assistant tab's Loop button and this tab's) showed only an iteration counter,
 * so a run the platform had classified as parked or stalled looked exactly like one at work: the
 * number just stopped moving (#930). The verdict is the server's (`health`), quoted, never derived
 * from `status` — `running` covers a working, a parked AND a dead run since migration 0127 (#589).
 *
 * The ONE copy of these sentences: the console's `activityLabel` (store/console/src/lib/workInFlight.ts)
 * delegates here, because the console depends on this package and not the other way round.
 *
 * `null` for `working`, `ended`, or no verdict at all: an older server or a cached payload must not
 * be rendered as a liveness it never stated.
 */
export function loopWatchBadge(run: { health?: unknown; waitNote?: string | null } | null | undefined): LoopWatchBadge | null {
	if (run?.health === "waiting") {
		// The server's sentence names WHAT it waits for. No resume time is promised in the fallback:
		// a HUMAN handoff's deadline is when the run gives up, not when it resumes (#591/#596).
		const title = run.waitNote ? `Waiting — ${run.waitNote}` : "Waiting — deliberately parked, not stalled";
		return { tone: "waiting", word: "Waiting", title };
	}
	if (run?.health === "stalled") {
		return { tone: "stalled", word: "Stalled", title: "Stalled — nothing has ticked for a while; this run may have died" };
	}
	return null;
}

/** Has the run reached a terminal state? The one status the watcher must not treat as an ending. */
export function loopRunEnded(run: { status: string }): boolean {
	return run.status !== "running";
}

/**
 * The line the thread gets when a run ends.
 *
 * `stopReason` is preferred over `status` because it is the one that distinguishes the endings a
 * human cares about: `failed` and `max_iterations` both carry status `failed`, and reporting the
 * status would tell someone their objective was impossible when it merely ran out of steps.
 */
export function loopOutcomeNotice(run: LoopRunSnapshot): string {
	const head = loopEndLabel(run.stopReason || run.status);
	const detail = (run.detail || "").trim();
	return detail ? `${head}: ${detail}` : `${head}.`;
}

/**
 * The end of a run in words (#929 finding 16). The notice used to print the raw reason —
 * "Loop stopped (max_iterations)" — which is accurate and says nothing to an owner about whether
 * to raise the cap, top up a key or sign in. One map, used by this tab and the Assistant's.
 */
const LOOP_END_LABEL: Record<string, string> = {
	done: "Loop complete",
	completed: "Loop complete",
	max_iterations: "Loop hit its step limit",
	no_progress: "Loop stopped — it was repeating itself",
	budget: "Loop hit its spend limit",
	engine_limit: "Loop stopped — the coding CLI hit its usage limit",
	provider_credit: "Loop stopped — the Anthropic API key has no balance",
	engine_auth: "Loop stopped — the coding CLI needs you to sign in",
	interrupted: "Loop was cut off by the platform",
	escalated: "Loop needs you",
	needs_human: "Loop needs you",
	cancelled: "Loop stopped by you",
	failed: "Loop failed",
};

/** {@link LOOP_END_LABEL}, with the raw reason kept for one this map does not know yet. */
export function loopEndLabel(reason: string | null | undefined): string {
	return LOOP_END_LABEL[reason ?? ""] ?? `Loop stopped (${reason || "unknown"})`;
}

/**
 * Issues-mode: may this issue be struck off and the next one proposed?
 *
 * ONLY on a clean finish, which is the rule the browser loop had (`decision === "done"` advanced;
 * escalate/failed left the issue open so you could retry it). Worth keeping literally, because the
 * new vocabulary has more ways to not-finish than the old one did: `max_iterations`, `budget`,
 * `no_progress` and `cancelled` are all runs that touched the issue without resolving it, and
 * excluding it on any of them would quietly walk the backlog leaving half-done work behind.
 */
export function issueWasHandled(run: LoopRunSnapshot): boolean {
	return run.stopReason === "done";
}

export interface LoopStart {
	/** Which executor the server dispatched to (#210) — absent when it did not say. */
	driver?: string | null;
	objective: string;
	maxIterations: number;
}

/**
 * The "it started" line.
 *
 * It says the run is on the server, because that is the whole difference and it changes what the
 * user may do next: closing the tab used to kill the objective and now does not.
 *
 * It also names the driver when it is NOT the coding one. On this tab that would mean the agent
 * declares no `CODING_SESSION` workflow, so its Loop is looping its chat while the user watches a
 * terminal that will never move — a silence that reads exactly like a broken button.
 */
export function loopStartNotice({ driver, objective, maxIterations }: LoopStart): string {
	const goal = objective.trim();
	const short = goal.length > 120 ? `${goal.slice(0, 120)}…` : goal;
	return driver && driver !== "coding"
		? `Loop started: ${short}\n\nThis agent's Loop drives its chat rather than the engine, so the terminal will stay quiet. Up to ${maxIterations} steps.`
		: `Loop started: ${short}\n\nIt runs on the server — you can close this tab. Up to ${maxIterations} steps.`;
}

/** A failed START is always this tab's to report — no server ever saw the run. */
export function loopStartFailureNotice(err: unknown): string {
	return engineSigninRefusal(err) ?? `Couldn't start the loop: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * A start refused because the coding CLI is not signed in (#929 finding 15) — `409 {needsReauth}`,
 * read off the SDK's `ApiError.body`. The server's sentence is written for MCP callers and sends
 * them to `continue_instance_run`; a person needs to know where the sign-in button is. Null for
 * any other error, so the caller keeps its own wording.
 */
export function engineSigninRefusal(err: unknown): string | null {
	const body = (err as { body?: unknown } | null)?.body as Record<string, unknown> | undefined;
	if (body?.needsReauth !== true) return null;
	return "Couldn't start the loop: the coding CLI on your machine isn't signed in, so nothing ran. Open the session in the Coding tab and use \"Open sign-in on my runner\", then start the loop again.";
}

/**
 * Stop was pressed while the start was still in flight, and the cancel that was supposed to undo
 * it FAILED (#291).
 *
 * This is the one ending in `startWith` that had no words, because its error was swallowed. The
 * sequence is: the POST returns a real run, the user has meanwhile pressed Stop, so the code
 * cancels the run it just created — the comment there says why in as many words, that flipping a
 * local flag instead "would leave it driving the engine with nothing watching it". The cancel IS
 * that mitigation, so swallowing its failure produces precisely the state the mitigation exists to
 * prevent, and produces it silently: `runId` is never set, the watcher never starts, the Stop
 * button and the iteration counter never appear — while a Pilot edits the repo and spends the
 * user's tokens against an objective they withdrew.
 *
 * So the failure is not "the stop didn't take". It is that the run becomes UNREACHABLE from the
 * only screen that can stop it. The caller's answer is therefore to adopt the run back into the
 * watcher rather than return, and this is the line that explains why a loop the user cancelled is
 * on screen and still running.
 */
export function loopRaceCancelFailureNotice(err: unknown): string {
	const detail = err instanceof Error ? err.message : String(err);
	return `You pressed Stop while the loop was starting, and it couldn't be cancelled — it's running. ${detail}\n\nIt's being watched again below, so press Stop to try once more.`.trim();
}

/**
 * What holds a repo when a loop start was refused as busy (#931).
 *
 * The refusal names the holder (`routes/tools.ts` → `describeBusyHolder`, #886), but the console
 * showed only the sentence — written for AGENTS, telling them to "stop it first with stop_work",
 * a tool the console has no button for. A human reading it had no way to see the run, let alone
 * stop it. This reads the holder out of the refusal so the page can link to it.
 */
export interface BusyHold {
	/** The run working the repo now, when the platform recorded one. */
	run: { runId: string; objective: string; startedAt: number; sessionId: string | null } | null;
	/** A start for this repo that is still being set up — nothing to open yet. */
	pendingStart: { objective: string | null; ageMs: number } | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * The holder named by a busy refusal, or null when the error is not one.
 *
 * Reads `err.body` — the SDK's `ApiError` keeps the refusal's whole answer — structurally, so a
 * plain `Error` (or an older SDK) simply yields null and the caller falls back to the message.
 */
export function busyHoldFrom(err: unknown): BusyHold | null {
	const body = (err as { body?: unknown } | null)?.body as Record<string, unknown> | undefined;
	if (body?.reason !== "busy") return null;
	const a = body.activeRun as Record<string, unknown> | null | undefined;
	const runId = str(a?.runId);
	const run = runId
		? { runId, objective: str(a?.objective) ?? "", startedAt: typeof a?.startedAt === "number" ? a.startedAt : 0, sessionId: str(a?.sessionId) }
		: null;
	const first = Array.isArray(body.inFlightStarts) ? (body.inFlightStarts[0] as Record<string, unknown> | undefined) : undefined;
	const pendingStart = !run && first ? { objective: str(first.objective), ageMs: typeof first.ageMs === "number" ? first.ageMs : 0 } : null;
	return run || pendingStart ? { run, pendingStart } : null;
}

/**
 * The in-router path to the blocking run's live view: its coding session (Co-pilot + terminal).
 * In-router, so the console's basename (`/console` on the apex, `/` on console.proagentstore.online)
 * is supplied by the router, never written here. Null when the run has no session to open.
 */
export function busyHoldLink(instanceId: string, hold: BusyHold): string | null {
	const sid = hold.run?.sessionId;
	return sid ? `/instances/${encodeURIComponent(instanceId)}/coding/${encodeURIComponent(sid)}` : null;
}

/** Where every open run of this agent is listed: Settings → Autonomous runs. */
export function busyHoldRunsLink(instanceId: string): string {
	return `/instances/${encodeURIComponent(instanceId)}/settings`;
}

/** The API call that stops the blocking run — the same cooperative cancel the Stop buttons use. */
export function busyHoldStopPath(instanceId: string, hold: BusyHold): string | null {
	return hold.run ? `/v1/instances/${encodeURIComponent(instanceId)}/loop/${encodeURIComponent(hold.run.runId)}/cancel` : null;
}

/** What the notice says once its Stop was accepted: cooperative, so the current step finishes first (#376). */
export const BUSY_HOLD_STOPPING = "Stop requested — the run's current step finishes first, then the repo is free. Start again once it has ended.";

/** "3 min" / "2 h" / "just now" — how long ago a run started, for the notice. */
function ago(ms: number): string {
	const m = Math.floor(ms / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m} min ago`;
	return `${Math.floor(m / 60)} h ago`;
}

/** The sentence the page shows instead of the agent-facing refusal. */
export function busyHoldNotice(hold: BusyHold, now: number = Date.now()): string {
	if (hold.run) {
		const what = hold.run.objective ? `“${hold.run.objective.length > 120 ? `${hold.run.objective.slice(0, 117)}…` : hold.run.objective}”` : "another run";
		const when = hold.run.startedAt ? ` (started ${ago(now - hold.run.startedAt)})` : "";
		return `This repo is already being worked on by ${what}${when}. Open it to watch it, or stop it before starting again.`;
	}
	const p = hold.pendingStart;
	const what = p?.objective ? ` for “${p.objective.length > 120 ? `${p.objective.slice(0, 117)}…` : p.objective}”` : "";
	return `Another start${what} is still being set up (requested ${ago(p?.ageMs ?? 0)}). Wait for it rather than starting again.`;
}

/**
 * What `POST /loop` answered, as one of the three things it can mean (#929 findings 9 and 10).
 *
 * Both start paths read `run.runId` and said "Loop started" — so a 202 (a start still being set up,
 * or an objective QUEUED behind a busy repo) became a run with no id and a watcher with nothing to
 * watch. `duplicate` marks the #925 guard handing back what was already queued or running.
 */
export type LoopStartAnswer =
	| { kind: "started"; runId: string; driver?: string; duplicate: boolean }
	| { kind: "queued"; entryId: string | null; duplicate: boolean }
	| { kind: "pending" };

export function readLoopStart(body: unknown): LoopStartAnswer {
	const b = (body ?? {}) as Record<string, unknown>;
	const duplicate = typeof b.duplicate_of === "string" && b.duplicate_of !== "";
	if (b.queued === true) return { kind: "queued", entryId: str((b.entry as Record<string, unknown> | undefined)?.id), duplicate };
	const runId = str(b.runId);
	if (runId) return { kind: "started", runId, driver: str(b.driver) ?? undefined, duplicate };
	return { kind: "pending" };
}

/** The line for a start that was queued rather than run. */
export function loopQueuedNotice(a: Extract<LoopStartAnswer, { kind: "queued" }>): string {
	return a.duplicate
		? "That objective is already queued for this repo — nothing new was added."
		: "Queued — it starts on its own when the run holding this repo ends. It is listed under Settings → Autonomous runs, where you can cancel it.";
}

/** The line for a start the platform has not confirmed yet (a 202 with a receipt, #886). */
export const LOOP_START_PENDING =
	"The start reached the platform but isn't confirmed yet. It will appear under Settings → Autonomous runs; if no run appears, start it again with the same objective — the same start is picked up, never doubled.";

/**
 * The request key for a start (#929 finding 10): REUSED only while the last start with exactly these
 * arguments is unconfirmed, so a retry replays it instead of starting a second run; fresh otherwise,
 * because a replayed key returns the old answer — a finished run's — instead of starting a new one.
 */
export function loopRequestKey(last: { args: string; requestId: string } | null, args: string): { args: string; requestId: string } {
	return last && last.args === args ? last : { args, requestId: crypto.randomUUID() };
}

