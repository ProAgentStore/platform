// Which session — if any — does the Coding tab open by itself?
//
// This runs at most ONCE per mount, and getting it wrong is loud in both directions: open the
// wrong one and the user is yanked into a terminal they did not ask for (the tab used to attach
// to whichever active session happened to be first in the list); open nothing when there IS an
// obvious answer and a one-repo agent shows an "Open session" button on the tab whose entire
// purpose is to show that session.
//
// It was three branches inside a `useEffect`, so the only way to ask "what does a deep link to an
// ENDED session do?" was to mount the component with a router and a fetch stub.
//
// ── The rule, and why each branch is what it is
//
// A deep link wins outright and is NOT filtered by status: the URL names one session, and #257's
// history read means an ended session still has a transcript worth landing on. The other two
// branches want a session you can type into, so they take `active` only.
//
// A single-repo agent has nothing to disambiguate — its live session is the tab. (This was
// briefly disabled, back when opening a session took over the whole page and buried Issues and
// Builds behind a back arrow; the solo layout removed that reason.)
//
// With several repos, "which one was I in" is a real question, so the last one is remembered in
// localStorage — but only honoured while it still has something running. Otherwise: nothing, and
// the tab lands on the repo list.

import type { CodingRepo, CodingSession } from "./types";

/**
 * The one session you can type into for a repo. There is at most one — the API reuses the live
 * one (`getActiveSessionForRepo`) rather than opening a second.
 */
export function activeSessionFor(sessions: CodingSession[], repoId: string): CodingSession | undefined {
	return sessions.find((s) => s.repoId === repoId && s.status === "active");
}

/**
 * Which repo is this session in?
 *
 * By the session's OWN `repoId`, which every row carries. It used to be answered the long way
 * round — find the repo whose *active* session has this id — which returns nothing for a session
 * that has ended, and the header then fell back to printing the raw repo UUID where the repo's
 * name goes. That is reachable: a deep link opens a session in whatever state it is in (#257 made
 * an ended session worth landing on), and the platform ends sessions by itself constantly.
 */
export function repoForSession(repos: CodingRepo[], session: CodingSession | null): CodingRepo | null {
	if (!session) return null;
	return repos.find((r) => r.id === session.repoId) ?? null;
}

export interface AutoOpenInput {
	sessions: CodingSession[];
	/** The `:sessionId` splat from the URL, when the tab was deep-linked. */
	initialSessionId?: string;
	/** `capabilities.surfaceOptions.coding.repos === "single"`. */
	singleRepo?: boolean;
	/** `localStorage` — the repo this instance was last worked in. */
	lastRepoId?: string | null;
	/** Arrived on a `?builds=` deep link (a deploy notification) — the Builds view is the destination. */
	buildsDeepLink?: boolean;
}

export function pickAutoOpenSession({
	sessions,
	initialSessionId,
	singleRepo = false,
	lastRepoId = null,
	buildsDeepLink = false,
}: AutoOpenInput): CodingSession | null {
	if (!sessions.length) return null;
	// A deploy notification opens that repo's Builds (#897). Restoring the last session here
	// navigated to `/coding/:sessionId` — dropping `?builds=` — and replaced the page it promised.
	if (buildsDeepLink && !initialSessionId) return null;
	// A named session, in whatever state it is in. An ended one still has its transcript.
	if (initialSessionId) return sessions.find((s) => s.id === initialSessionId) ?? null;
	if (singleRepo) return sessions.find((s) => s.status === "active") ?? null;
	if (!lastRepoId) return null;
	return sessions.find((s) => s.repoId === lastRepoId && s.status === "active") ?? null;
}

/**
 * Was this tab opened on a link to a session that no longer exists (#894)? Only a SUCCESSFUL load
 * may say so — the session list is every session the instance has (`listSessions` is unbounded),
 * so absence from it is a fact, while absence from a failed load (`loaded: false`) is not.
 */
export function deepLinkedSessionGone(sessions: readonly CodingSession[], initialSessionId: string | undefined, loaded: boolean): boolean {
	return loaded && !!initialSessionId && !sessions.some((s) => s.id === initialSessionId);
}

