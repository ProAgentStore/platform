/**
 * Every link into the console that this Worker hands a user — one module, so there is one place
 * to check (#344).
 *
 * ── Why they are collected here
 *
 * A notification's click target is a string built in a Worker; the routes it has to agree with
 * are JSX in a React app. Nothing connected the two, and by the time anyone looked, two of the
 * eight producers were wrong — the "🙋 Coder needs you" tap (`coding/repos/<id>/summary`, whose
 * last two segments the page drops on the floor) and the agent-loop's "your agent needs you"
 * (`/console/#/instances/<id>`, a hash path on a BrowserRouter). Neither 404s; both quietly land
 * on the wrong screen, which is why reading found them and use never did.
 *
 * `console-links.test.ts` asserts EVERY function exported here against the console's own route
 * table (`store/console/src/lib/routes.ts`) — including the splat grammar the router does not
 * police — and forbids a `/console/…` literal anywhere else under `workers/api/src`, so a new
 * producer has to come through here and is covered the moment it is written.
 *
 * ── The rule these targets follow (#338)
 *
 * Link the thing that exists BEFORE the event, during it, and after it. A notification fires at
 * the moment something changes; if its target only exists during that moment, the tap that comes
 * four hours later has nowhere to go.
 */

const BASE = "/console";

/** The console root — restores whichever top-level screen the user left off on. */
export function consoleHomeLink(): string {
	return `${BASE}/`;
}

/** Account-level settings: candidate Profile, API keys, billing. */
export function profileLink(): string {
	return `${BASE}/profile`;
}

/** An instance with no tab named — `InstanceDetail` opens the Assistant. */
export function instanceLink(instanceId: string): string {
	return `${BASE}/instances/${encodeURIComponent(instanceId)}`;
}

/** The instance's Board: runtime tasks and application records, including anything needing you. */
export function instanceBoardLink(instanceId: string): string {
	return `${instanceLink(instanceId)}/board`;
}

/**
 * One run — `RunDetail`, the page that holds the takeover overlay and the needs-input box (#349).
 *
 * The handoff notifications used to point at the Board. That resolves, so it was never #344's
 * class of broken link — it was one step short: the Board shows a card saying the run is waiting
 * on you, and every control that ANSWERS the wait (live remote control, "Resume — I've done it",
 * the input field for a value the agent refuses to invent) is on the run itself. A notification
 * that asks for help should land on the control that provides it, which is the same reasoning
 * that chose the coding session over the repo list.
 *
 * Satisfies the #338 rule: the `instance_runtime_tasks` row is written when the task is created,
 * before the workflow can block on anything, and it outlives the run — so the link works before
 * the handoff, while it waits, and after it has resolved. A task that has since been deleted
 * degrades to the run page's own "no longer exists" state with a way back to the Board, rather
 * than erroring.
 */
export function instanceRunLink(instanceId: string, taskId: string): string {
	return `${instanceLink(instanceId)}/tasks/${encodeURIComponent(taskId)}`;
}

/** The instance's Knowledge surface: documents, memory, files, credentials, rules. */
export function instanceKnowledgeLink(instanceId: string): string {
	return `${instanceLink(instanceId)}/knowledge`;
}

/**
 * A coding session — the Co-pilot/Terminal view for one run.
 *
 * Satisfies the #338 rule: the `coding_sessions` row is written by `POST /coding/sessions` before
 * the workflow is ever dispatched, `listSessions` returns it whatever its status, and it outlives
 * the run. So the same link works before the Pilot blocks, while it waits, and after it has
 * finished — and it is the page where a human answers, since resolving a handoff is a message
 * sent to that session. Without a session id (or if the id no longer resolves) the Coding tab
 * falls back to the repo list, which is a real page rather than a broken one.
 */
export function codingSessionLink(instanceId: string, sessionId?: string): string {
	const coding = `${instanceLink(instanceId)}/coding`;
	return sessionId ? `${coding}/${encodeURIComponent(sessionId)}` : coding;
}

/**
 * The Coding tab's Builds view for one repo (#338): a deploy's run history.
 *
 * There is no per-deploy page in the product and there cannot be one that is ready at
 * notification time — the only per-run artifact is GitHub's own, which is exactly the
 * cross-origin URL a service worker cannot navigate an open tab to.
 */
export function codingBuildsLink(instanceId: string, repoId: string): string {
	return `${instanceLink(instanceId)}/coding?builds=${encodeURIComponent(repoId)}`;
}
