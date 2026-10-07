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

/** The notification feed — every row readable, each with its own link (#897). */
export function notificationsLink(): string {
	return `${BASE}/notifications`;
}

/**
 * The instance list — the one page that covers a notification about SEVERAL instances (#897). The
 * idle-sleep batch used to send no link at all when it spanned agents, and landed on the console home.
 */
export function instancesLink(): string {
	return `${BASE}/instances`;
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

/** A local browser research run (#946) — the Research tab, or one run on it. */
export function localBrowserRunLink(instanceId: string, runId?: string): string {
	const research = `${instanceLink(instanceId)}/research`;
	return runId ? `${research}/${encodeURIComponent(runId)}` : research;
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

/**
 * An agent's detail page — Knowledge, Settings, Analytics, and the creator's subscriber list.
 *
 * Used as the url on notifications delivered to an agent's creator: a "new subscriber" row
 * carries `agent_id` but no instance id (the subscriber's instance belongs to the subscriber,
 * not the creator), so the right destination is the agent itself (#622).
 *
 * Satisfies the #338 rule: the `agents` row exists long before any subscription and outlives
 * every subscriber's instance.
 */
export function agentLink(agentId: string): string {
	return `${BASE}/agents/${encodeURIComponent(agentId)}`;
}

/**
 * A pending secure input request — the page where the owner submits a credential or auth code (#908, #910).
 *
 * Unlike other console links, this returns a DIRECT navigation URL (not a notification link),
 * so it does NOT include the /console prefix. The agent returns this URL directly to the user
 * for them to click, and it must work on all deployments:
 * - console.proagentstore.online (basename "/") → /instances/...
 * - Other hosts (basename "/console") → /instances/... (React Router prepends basename)
 *
 * Satisfies the #338 rule: the `secure_input_requests` row is written when the agent calls the
 * tool, before it blocks on the input, and it outlives the request (until consumed or expired).
 * So the same link works when the request is created, while the owner is submitting, and
 * after the input has been consumed.
 */
export function secureInputLink(instanceId: string, requestId: string): string {
	return `/instances/${encodeURIComponent(instanceId)}/secure-inputs/${encodeURIComponent(requestId)}`;
}

/**
 * A waiting secure-input request as a NOTIFICATION link (#934): `secureInputLink` with the console
 * base, like every other notification target, so the service worker and the in-app list resolve it
 * on both hosts (#897).
 */
export function secureInputNotificationLink(instanceId: string, requestId: string): string {
	return `${BASE}${secureInputLink(instanceId, requestId)}`;
}

/** An instance's Settings tab — where its triggers, runner and connectors are configured. */
export function instanceSettingsLink(instanceId: string): string {
	return `${instanceLink(instanceId)}/settings`;
}

// ── Notification links (#894) ────────────────────────────────────────────────

/**
 * A link a notification may carry, and ONLY one built by {@link deepLinkFor} (#894).
 *
 * `notifyUser` takes this type, not `string`, so a producer cannot pass a hand-written path, a
 * GitHub URL, or nothing: it has to say WHAT the notification is about and let this module turn
 * that into the page. Forgetting is a compile error, which is the "hard error in dev" the issue asks
 * for; the runtime guard in `notifyUser` covers JavaScript that gets past the types.
 */
export type DeepLink = string & { readonly __notificationDeepLink: true };

/** What a notification is about — every subject a producer sends today, each with its page. */
export type NotificationSubject =
	/** One coding run's Co-pilot/Terminal — the page where a handoff is answered. */
	| { kind: "coding-session"; instanceId: string; sessionId: string }
	/** The instance's Coding tab (repo list) — no single session is the subject. */
	| { kind: "coding-tab"; instanceId: string }
	/** A coding CLI's sign-in: the run it blocks or unblocks when one is known (#897), else the Coding tab. */
	| { kind: "engine-sign-in"; instanceId: string; sessionId?: string | null }
	/** A repo's deploys / CI: the Coding tab's Builds view for that repo (#338). */
	| { kind: "builds"; instanceId: string; repoId: string }
	/** One runtime task (browser task, job application): `RunDetail`, with takeover and the answer box (#349). */
	| { kind: "task"; instanceId: string; taskId: string }
	/** A chat-driven run that needs the owner: the Assistant, where it is answered (#894 Q2 default). */
	| { kind: "assistant"; instanceId: string }
	/** A trigger (a scheduled run skipped): Settings, where triggers are configured. */
	| { kind: "triggers"; instanceId: string }
	/** The instance's Knowledge — where the résumé lives. */
	| { kind: "knowledge"; instanceId: string }
	/** One local browser research run (#946). */
	| { kind: "local-browser-run"; instanceId: string; runId: string }
	/** A secure-input request waiting for the owner (#934). */
	| { kind: "secure-input"; instanceId: string; requestId: string }
	/** An agent template — notifications to its creator (#622). */
	| { kind: "agent"; agentId: string }
	/** Several instances at once (#897): the instance list. */
	| { kind: "instances" }
	/** Account-level: the Profile (candidate profile, API keys). */
	| { kind: "profile" };

export type NotificationSubjectKind = NotificationSubject["kind"];

/** The page a notification about `subject` opens. Exhaustive: a new kind fails to compile until it has one. */
export function deepLinkFor(subject: NotificationSubject): DeepLink {
	const link = ((): string => {
		switch (subject.kind) {
			case "coding-session":
				return codingSessionLink(subject.instanceId, subject.sessionId);
			case "coding-tab":
				return codingSessionLink(subject.instanceId);
			case "engine-sign-in":
				return codingSessionLink(subject.instanceId, subject.sessionId ?? undefined);
			case "builds":
				return codingBuildsLink(subject.instanceId, subject.repoId);
			case "task":
				return instanceRunLink(subject.instanceId, subject.taskId);
			case "assistant":
				return instanceLink(subject.instanceId);
			case "triggers":
				return instanceSettingsLink(subject.instanceId);
			case "knowledge":
				return instanceKnowledgeLink(subject.instanceId);
			case "local-browser-run":
				return localBrowserRunLink(subject.instanceId, subject.runId);
			case "secure-input":
				return secureInputNotificationLink(subject.instanceId, subject.requestId);
			case "agent":
				return agentLink(subject.agentId);
			case "instances":
				return instancesLink();
			case "profile":
				return profileLink();
		}
	})();
	return link as DeepLink;
}
