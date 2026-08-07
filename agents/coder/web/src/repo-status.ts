// What the Coding tab TELLS YOU a repo is doing.
//
// Three surfaces answered this independently, from the same two signals:
//
//   - the repo row's phrase       (`repoLabel` in CodingTab)  — "Working... / Ready / Runner offline / Active"
//   - the open session's badge    (`AgentStatusBadge`)        — "Working / Idle / Error"
//   - the terminal poll's rate    (`terminalBusy`)            — full rate vs. the passive tier
//
// Each read `repoStatuses[repoId]` (the runner's own `runState`) and `runnerOnline`, and each
// reconciled them slightly differently. That is the same shape as the bug ./engine-busy.ts was
// written for — five call sites each spelling out the busy predicate, one of them wrong — one
// level up: not "what does `responding` mean" but "what wins when the two signals disagree".
//
// One reconciliation, three renderings. The intermediate `RepoState` is the point: a test can
// name the state without knowing the wording, and the wording can change without moving the rule.
//
// ── The disagreement this fixed
//
// `GET …/sessions/:id/capture` answers `{ runState: "idle", runnerConnected: false }` when no
// runner is connected (routes/coding.ts — there is no engine to ask, so it reports the engine as
// idle). The poll stored `"idle"` for that repo, and the row's phrase consulted `runnerOnline`
// only on the branch where the repo had NO active session. So a repo with a live session on a
// machine that had gone away read **"Ready"**, with a green dot, directly underneath ReposList's
// "Your machine isn't connected. Start the runner: pags up" banner — which reads off the SAME
// `runnerOnline` value. Two statements from one signal, contradicting each other on one screen.
//
// An offline machine now outranks a non-busy state everywhere. It does NOT outrank a busy one:
// `runState` comes from a capture that just succeeded, while `relay.connected` is polled on its
// own 10s timer, so a genuinely working engine must not be reported offline by a stale tick.

import { type EngineRunState, isEngineBusy } from "./engine-busy";

/** `true` connected · `false` not · `null` no answer yet — see ./runner-online. */
export type RunnerOnline = boolean | null;

/**
 * What a repo IS, once the runner's `runState` and the machine's reachability are reconciled.
 *
 * `active` is the honest gap between "there is a session" and "the poll has reported on it": the
 * repo-status poll is disabled while a session is open, and on the landing view the first tick is
 * 3s away. Calling that `ready` would claim knowledge the tab does not have.
 */
export type RepoState = "working" | "offline" | "active" | "ready";

export interface RepoSignals {
	/** `repoStatuses[repoId]` — the runner's `runState`; undefined before the first poll. */
	state?: EngineRunState | null;
	/** Instance-wide reachability, from ./runner-online. */
	runnerOnline: RunnerOnline;
	/** Does this repo have a session in `active` status? */
	hasActiveSession: boolean;
}

export function resolveRepoState({ state, runnerOnline, hasActiveSession }: RepoSignals): RepoState {
	// A runState may never outlive the session that produced it — the same rule ./runner-online
	// applies to a capture's connectivity verdict, and for the same reason. `repoStatuses` is
	// only rewritten while at least one session is active (the poll returns early otherwise), so
	// the last state of a finished run stays in the map indefinitely. Reading it here would
	// leave a repo saying "Working..." forever after its engine stopped existing.
	if (!hasActiveSession) return runnerOnline === false ? "offline" : "ready";
	// A turn in progress outranks everything. The state came from a capture that just answered;
	// `runnerOnline` may be up to 10s stale, and reporting a working engine as offline would be
	// the same class of lie in the other direction.
	if (isEngineBusy(state)) return "working";
	// `=== false`, never falsy. `null` means "not answered yet", and treating it as offline is how
	// the tab would flash "run pags up" at someone whose runner is fine, on every first paint.
	if (runnerOnline === false || state === "offline") return "offline";
	// A session exists and nothing has reported on it yet.
	if (state !== "idle") return "active";
	return "ready";
}

const REPO_LABEL: Record<RepoState, string> = {
	working: "Working...",
	offline: "Runner offline",
	active: "Active",
	ready: "Ready",
};

/** The phrase under a repo's name in the list (and beside the solo agent's title). */
export function repoStatusLabel(signals: RepoSignals): string {
	return REPO_LABEL[resolveRepoState(signals)];
}

export interface SessionBadge {
	label: string;
	/** Drives the colour + the spinner. `idle` covers both `ready` and the not-yet-reported `active`. */
	tone: "working" | "error" | "idle";
}

const BADGE: Record<RepoState, SessionBadge> = {
	working: { label: "Working", tone: "working" },
	offline: { label: "Error", tone: "error" },
	active: { label: "Idle", tone: "idle" },
	ready: { label: "Idle", tone: "idle" },
};

/** The open session's badge in the header (CODER-005). */
export function sessionBadge(state: RepoState): SessionBadge {
	return BADGE[state];
}

/**
 * Should the open session's terminal poll run at full rate?
 *
 * Deliberately WIDER than the engine's own `runState`. A send that has not been acknowledged yet
 * and a running Loop both mean output is imminent, and waiting out a slow tick before the pane
 * starts moving reads as a hang. This is the heaviest sustained poll in the app — the whole pane,
 * every 1.5s, over the relay to the user's laptop — so the width is a decision, not an accident.
 */
export function terminalPollBusy({
	state,
	sending,
	looping,
}: {
	state: RepoState;
	/** An instruction is in flight and its reply has not landed. */
	sending: boolean;
	/** The Loop is driving this session. */
	looping: boolean;
}): boolean {
	return state === "working" || sending || looping;
}
