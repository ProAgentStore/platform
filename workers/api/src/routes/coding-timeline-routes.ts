import type { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { getRepo, getSession, touchSessionActivity } from "../lib/coding-store.js";
import { clearChat, loadChat, loadRepoTimeline, loadTerminalSnapshots, loadTimeline } from "../lib/coding-timeline.js";
import { requireOwned } from "./coding-shared.js";
import type { Env } from "../types.js";

/**
 * Reading and clearing a coding session's persisted conversation (#775).
 *
 * Registered AFTER `registerCopilotRoutes` because that is the position the block occupied in
 * `coding.ts`; Hono matches in registration order and `coding.contract.test.ts` pins it.
 *
 * This is the session-SCOPED timeline. The instance-level cursored feed
 * (`…/coding/timeline`, no session id) is a different route with a different resolution rule and
 * lives in `coding-feed.ts` — see that file for why the two exist separately.
 */
export function registerTimelineRoutes(codingRoutes: Hono<{ Bindings: Env }>): void {
	/** Load a session's persisted conversation (so the console restores it on open). */
	codingRoutes.get("/:instanceId/coding/sessions/:sessionId/timeline", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
		if (!session) throw new HttpError(404, "Session not found");
		await touchSessionActivity(c.env, instanceId, uid, session.id);
		// ?terminal=1 → a PAGE of terminal snapshots, for the Terminal view's scrollback (#432).
		//
		// This is the read the console makes when a session opens, and it exists because `?full=1`
		// was being used for it: the whole typed timeline crossed the network so the client could
		// keep the last `terminal` row and throw the rest away. A long run at 8000 chars a snapshot
		// is a large payload for one visible pane, and there was no way to ask for the older ones.
		// `before` is an exclusive `seq` cursor, `limit` is bounded in the store, and `hasMore` says
		// whether "Load older" has anything to load. `after` is the same cursor the other way (#550):
		// the console keeps the page it last rendered, so its next load asks only for what was appended
		// since — an empty array rather than 41 KB on a session nobody has touched. The reply is then
		// `tail:true` + the delta, or the whole newest page (`tail:false`) when more was appended than
		// one page holds. Both cursors and the gap rule are in `loadTerminalSnapshots`, with the why.
		if (c.req.query("terminal") === "1") {
			const num = (q: string) => {
				const n = Number.parseInt(c.req.query(q) ?? "", 10);
				return Number.isFinite(n) ? n : undefined;
			};
			const page = await loadTerminalSnapshots(c.env, { sessionId: session.id, before: num("before"), after: num("after"), limit: num("limit") });
			return c.json({ terminal: page.entries, hasMore: page.hasMore, oldestSeq: page.oldestSeq, newestSeq: page.newestSeq, tail: page.tail });
		}
		// ?full=1 → the full typed timeline (chat + terminal snapshots + brain decisions + commands
		// + outcomes). Kept unpaged on purpose: its one caller is the ⧉ "copy this session as JSON"
		// button, an explicit one-shot action where the whole thing IS what was asked for. The
		// console's session-open path no longer uses it.
		if (c.req.query("full") === "1") {
			return c.json({ chat: await loadChat(c.env, session.id), timeline: await loadTimeline(c.env, session.id) });
		}
		return c.json({ chat: await loadChat(c.env, session.id) });
	});

	/**
	 * A REPO's whole history, across every session it has ever had (#257).
	 *
	 * The session-scoped route above answers "what happened in this session", which is only useful
	 * while a session exists — and the platform ends them by itself constantly (the Pilot closes one
	 * on every finished run; the reaper closes the rest on each `pags up` restart). This answers the
	 * question the user actually asks, which is "what has happened in this repo", and it never 404s
	 * for want of a live session.
	 *
	 * Lives with the other two timeline routes rather than in `coding-repos.ts` (#305): what it reads
	 * is the SESSION transcript, and all three answer "what was said in this thread" off the same
	 * `coding_timeline` store. The repo is the key it groups by, not the subject.
	 */
	codingRoutes.get("/:instanceId/coding/repos/:repoId/timeline", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
		if (!repo) throw new HttpError(404, "Repo not found");
		const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
		const timeline = await loadRepoTimeline(c.env, {
			instanceId,
			userId: uid,
			repoId: repo.id,
			limit: Number.isFinite(limit) ? limit : undefined,
		});
		return c.json({ timeline });
	});

	/** Clear a session's conversation thread (keeps the activity log). */
	codingRoutes.delete("/:instanceId/coding/sessions/:sessionId/timeline", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
		if (!session) throw new HttpError(404, "Session not found");
		await clearChat(c.env, session.id, uid, instanceId);
		return c.json({ ok: true });
	});
}
