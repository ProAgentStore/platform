/**
 * Hold NEW work while a deferred runner update waits for an idle window (#1483).
 *
 * A manual `runner_update` that finds the machine busy is deferred: the runner re-looks every few seconds and installs
 * once nothing is mid-turn (#859). Nothing stopped NEW work arriving meanwhile, so on 2026-11-04 two fresh coding sessions
 * were admitted inside the lease and the next idle window never came — the update expired twice, still on the old release.
 *
 * The decision made here, explicitly and bounded:
 *
 *  - ONLY a request that would START work is refused: a new coding session, a local browser / apply / artifact run.
 *    Everything already running is untouched — its messages, captures, reads, ends and resumes go through. No session is
 *    stopped, and nothing is re-routed: a refused start is a 503 the cloud already treats as "retry shortly".
 *  - The hold lasts exactly as long as the deferred lease (at most {@link MAX_DEFERRED_UPDATE_LEASE_MS}, five minutes),
 *    so a stuck or abandoned update can only ever delay new work by that long. When the lease lapses the hold lifts on its
 *    own and the work is admitted again.
 *  - A start for a session that is ALREADY alive is not new work (it re-attaches), so it passes.
 *
 * The refusal says what it is — an update waiting on running work, and until when — instead of a generic "draining", which
 * is reserved for the final instant between the last idle look and the restart.
 */
import type { DeferredUpdateLease } from "./self-update.js";
import { deferredUpdateLeaseActive } from "./self-update.js";

/** The local-runtime routes that begin work rather than act on work already running. */
export const NEW_WORK_ROUTES: readonly string[] = ["/coding/start", "/local-browser/run", "/local-apply/run", "/local-artifact/run"];

export interface HoldInput {
	/** The pending deferred update, or null when none is waiting. */
	lease: DeferredUpdateLease | null;
	method: string;
	path: string;
	body?: unknown;
	/** Ids of coding sessions that are alive right now, when known. `null` = could not be read. */
	liveSessions: () => Promise<ReadonlySet<string> | null>;
	now?: number;
}

const bare = (path: string): string => path.split("?")[0].replace(/\/+$/, "");

/** Does this request begin work (as opposed to act on, or read, work already running)? */
export function startsNewWork(method: string, path: string): boolean {
	return method.toUpperCase() === "POST" && NEW_WORK_ROUTES.includes(bare(path));
}

/**
 * Why this request must wait for the pending update, or null to admit it. Never throws: a session look that fails holds a
 * coding start (a refusal is retryable; an admission would prolong the very wait being ended).
 */
export async function holdForPendingUpdate(input: HoldInput): Promise<string | null> {
	const { lease, method, path, body } = input;
	const now = input.now ?? Date.now();
	if (!lease || !deferredUpdateLeaseActive(lease, now) || !startsNewWork(method, path)) return null;
	if (bare(path) === "/coding/start") {
		const sessionId = body && typeof body === "object" ? (body as { sessionId?: unknown }).sessionId : undefined;
		if (typeof sessionId === "string") {
			const live = await input.liveSessions().catch(() => null);
			if (live?.has(sessionId)) return null; // re-attaching a session that is already running is not new work
		}
	}
	const seconds = Math.max(1, Math.ceil((lease.expiresAt - now) / 1000));
	return `A runner update is waiting for running work to finish, so new work is not started on this machine for up to ${seconds}s. Running sessions are untouched. Retry shortly.`;
}
