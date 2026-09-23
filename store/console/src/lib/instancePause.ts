/**
 * The Pause / Resume control's words (#825).
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
	action: "pause" | "resume";
}

const PAUSED: PausePanel = {
	title: "Paused",
	statement:
		"This agent is paused: no new runs can start, and its scheduled work, inbound webhooks and teamwork deliveries are all held. Nothing has been lost — the subscription, documents, repos and history are exactly as they were. Resuming lets it start work again; it does not restart the runs the pause stopped.",
	button: "Resume this agent",
	action: "resume",
};

const ACTIVE: PausePanel = {
	title: "Pause",
	statement:
		"Stop this agent for now without unsubscribing. New runs are blocked, anything in flight is asked to stop, and its scheduled work, inbound webhooks and teamwork deliveries are held. You can still chat with it — everything is kept, and Resume puts it straight back.",
	button: "Pause this agent",
	action: "pause",
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
 * What `POST /v1/instances/:id/{pause,resume}` answers.
 *
 * Named rather than declared inline at the call: `check-console-types.mjs` ratchets every
 * anonymous shape a console API call declares, and naming one is the only direction that ratchet
 * moves. (Do not write the generic-call form out in a comment here — that guard's scanner reads
 * block comments, so demonstrating the pattern it forbids IS a finding.)
 */
export interface PauseResponse {
	success?: boolean;
	/** The status that now holds — read from the RESPONSE, never assumed from which button was pressed. */
	status?: string;
	/** Runs ASKED to stop. Each ends at the top of its next iteration; this is not a kill count. */
	runsAskedToStop?: number;
	/** False when the state already held — a retry or a double-click, not a failure. */
	changed?: boolean;
}

/**
 * The instance roster INCLUDING paused instances (#826).
 *
 * `GET /v1/instances/my/instances` omits paused instances by default, because they clutter the
 * working views (dashboard, nav, voice roster). A paused instance is still the owner's, though, so
 * every caller that looks up ONE instance, counts what the owner has, or decides "Open" vs
 * "Subscribe" must use this — otherwise a paused instance's page reads as missing and its Resume
 * control becomes unreachable.
 */
export const MY_INSTANCES_WITH_PAUSED = "/v1/instances/my/instances?includePaused=1";
