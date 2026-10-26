/**
 * The Disable / Enable control's words (#825, #1383).
 *
 * "Disabled" IS the paused state (`status = 'paused'`): the control used to be called Pause and Resume, and #1383 gave the same state a
 * name owners reach for, a recorded reason, and a list of its own (`pages/Disabled.tsx`). The server's routes are `/disable` and `/enable`;
 * `/pause` and `/resume` still exist for callers that never asked for a record.
 *
 * A module rather than inline JSX for the reason `unsubscribeScope.ts` next door is one: this
 * panel states what a lifecycle control WILL DO, and that sentence is the thing most worth
 * testing and least worth re-deriving. The two are neighbours on the Settings page on purpose —
 * one reversible, one not — and the pair only reads correctly if each says which it is.
 *
 * ── Why pause needs no confirmation dialog and cancel does
 *
 * `unsubscribeScope` builds a `confirm` string because cancelling is irreversible and its blast
 * radius is not obvious from the button (it can retire a subscription shared with sibling
 * instances). Pausing keeps everything and is undone by the button that replaces it, so a
 * confirmation would be ceremony — and ceremony on the safe control is what teaches people to
 * click through the dialog on the dangerous one.
 */

export interface PausePanel {
	/** Heading for the card. */
	title: string;
	/** What the control will do, in the words an owner needs before pressing it. */
	statement: string;
	/** The button label. */
	button: string;
	/** `POST /v1/instances/:id/<action>` — the route half, so the caller does not re-derive it. */
	action: "disable" | "enable";
}

const PAUSED: PausePanel = {
	title: "Disabled",
	statement:
		"This agent is disabled: it is hidden from your lists, no new runs or queued objectives can start, and its scheduled work, inbound webhooks and teamwork deliveries are all held. Nothing has been lost — the subscription, documents, repos, queue, schedules and pinned machine are all kept exactly as they were. Enabling it restores them; it does not restart runs the disable stopped.",
	button: "Enable this agent",
	action: "enable",
};

const ACTIVE: PausePanel = {
	title: "Disable",
	statement:
		"Switch this agent off without unsubscribing. It is hidden from your lists, new runs are blocked, anything in flight is asked to stop, and its scheduled work, inbound webhooks and teamwork deliveries are held. Everything is kept — the subscription, documents, repos, queue and history — and you can still chat with it to find out what went wrong. You can enable it again at any time from here or from the Disabled page.",
	button: "Disable this agent",
	action: "disable",
};

/**
 * Which half of the toggle to render.
 *
 * Takes the status STRING rather than a boolean so the caller passes the server's own value
 * through instead of deciding what "paused" means on the way — the console and the API agreeing
 * on one word is the whole reason `agent_instances.status` is the per-instance authority.
 * Anything that is not `paused` shows the pause half, including a status this build has not been
 * taught: offering the reversible control on an unfamiliar state is the safe direction to be
 * wrong in, and the server refuses what it cannot do.
 */
export function pausePanel(status: string | null | undefined): PausePanel {
	return status === "paused" ? PAUSED : ACTIVE;
}

/** Is this instance paused right now? The one comparison, so no caller re-spells the literal. */
export function isPaused(status: string | null | undefined): boolean {
	return status === "paused";
}

/**
 * What `POST /v1/instances/:id/{disable,enable}` (and pause/resume) answers.
 *
 * Named rather than declared inline at the call: `check-console-types.mjs` ratchets every
 * anonymous shape a console API call declares, and naming one is the only direction that ratchet
 * moves. (Do not write the generic-call form out in a comment here — that guard's scanner reads
 * block comments, so demonstrating the pattern it forbids IS a finding.)
 */
/** When, by whom (a verified account id) and why an instance was disabled. Each part is null on an instance paused without a record. */
export interface DisabledRecord {
	at: string | null;
	by: string | null;
	reason: string | null;
}

/** One line for a disabled instance's record: "Disabled 2026-10-27 by you — duplicate", with only the parts that are known. */
export function describeDisabled(record: DisabledRecord | null | undefined, me?: string | null): string {
	if (!record || (!record.at && !record.by && !record.reason)) return "Disabled — no record of when, by whom or why (it was paused, which records none).";
	const when = record.at ? ` ${record.at.slice(0, 10)}` : "";
	const who = record.by ? ` by ${me && record.by === me ? "you" : "another session"}` : "";
	const why = record.reason ? ` — ${record.reason}` : "";
	return `Disabled${when}${who}${why}`;
}

/** The longest reason the server accepts; the input is bounded to match so a long one is stopped here, not by a 400. */
export const DISABLE_REASON_MAX = 500;

export interface PauseResponse {
	success?: boolean;
	/** The status that now holds — read from the RESPONSE, never assumed from which button was pressed. */
	status?: string;
	/** Runs ASKED to stop. Each ends at the top of its next iteration; this is not a kill count. */
	runsAskedToStop?: number;
	/** False when the state already held — a retry or a double-click, not a failure. */
	changed?: boolean;
	/** The record that now holds (disable) or null (enable). */
	disabled?: DisabledRecord | null;
}

/** One entry of `GET /v1/instances/my/disabled-instances`. */
export interface DisabledInstance {
	id: string;
	name: string | null;
	slug: string | null;
	repos: Array<{ name: string; githubRepo: string | null }>;
	pinnedMachine: { node: string; machineId: string | null } | null;
	disabled: DisabledRecord;
	lastActivityAt: string | null;
	lastRun: { runId: string; status: string; stopReason: string | null; startedAt: number; finishedAt: number | null } | null;
	queuedObjectives: number;
}

export interface DisabledInstancesResponse {
	asOf: number;
	total: number;
	truncated: boolean;
	instances: DisabledInstance[];
}

/** The Disabled list's endpoint. */
export const DISABLED_INSTANCES_PATH = "/v1/instances/my/disabled-instances";

/**
 * Roster endpoint for a view that must resolve a specific owned instance, including one paused
 * outside the default working list (#826).
 */
export const MY_INSTANCES_WITH_PAUSED = "/v1/instances/my/instances?includePaused=1";
