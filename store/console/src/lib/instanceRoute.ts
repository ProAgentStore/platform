/**
 * How `/instances/:id/*` is read — the receiving half of the grammar `lib/routes.ts` polices.
 *
 * ── Why this is its own module
 *
 * `routes.ts` already states, in prose and in a constant, what this page does with a splat:
 * "`splatParts[0]` is the tab and `splatParts[1]` is the session id. Anything further is
 * silently dropped." `checkConsoleLink` REJECTS links on the strength of that sentence — it is
 * the rule that caught `/instances/:id/coding/repos/:repoId/summary`, the "Coder needs you"
 * notification a Worker had been emitting into a route that quietly reinterpreted it as tab
 * `coding`, session `repos` (#344).
 *
 * But the sentence was a claim ABOUT a component, made in a module the component did not use.
 * Nothing executed the parse it described, so nothing could tell you if the two ever disagreed —
 * and a link checker that is wrong about its subject rejects good links and passes bad ones with
 * equal confidence. Pulling the parse out here is what lets a test drive the REAL one and hold
 * `checkConsoleLink`'s verdicts against it (`instanceRoute.test.ts`).
 *
 * Positional, and that is the point: the reason a 4-segment link "worked" is that React Router
 * matches `instances/:id/*` against any depth and this parser reads the first two segments of
 * whatever it is handed. Neither layer 404s. The grammar is the only thing that says no.
 */

/** Where an unrecognised or absent tab lands. Every instance has a chat surface. */
export const FALLBACK_TAB = "chat";

/** The splat, taken apart exactly as the page takes it apart. */
export interface InstanceSplat {
	/** First segment — the requested tab, before it is checked against the instance. */
	requestedTab: string;
	/** Second segment — e.g. a coding session id. */
	sessionId?: string;
	/**
	 * Everything past the second segment.
	 *
	 * Always empty in a correct link. It is returned rather than dropped so a test (and, one day,
	 * a dev-mode warning) can see the segments a link paid for and did not get — which is the
	 * whole of #344, expressed as data instead of as a comment.
	 */
	ignored: string[];
}

/** Split a splat into the parts this page reads. */
export function parseInstanceSplat(splat: string | undefined): InstanceSplat {
	// `filter(Boolean)` so a trailing or doubled slash cannot shift the positions — `coding/`
	// must mean the same tab as `coding`, and `//coding` must not resolve the tab to "".
	const parts = (splat ?? "").split("/").filter(Boolean);
	return { requestedTab: parts[0] ?? "", sessionId: parts[1] || undefined, ignored: parts.slice(2) };
}

/** The tab actually mounted, and the session id handed to it. */
export interface ResolvedInstanceRoute {
	tab: string;
	sessionId?: string;
}

/**
 * Resolve the splat against the surfaces THIS instance exposes.
 *
 * A deep link to `/coding` on an agent that has no coding surface must fall back to chat rather
 * than mount a tab whose data does not exist — the tab list is derived from declared
 * capabilities (`capabilities.surfaces` + the agent's own published surfaces), so a link is
 * always resolvable against one agent and not another.
 *
 * The session id is kept even when the tab falls back. It is inert to a surface that does not
 * read one, and dropping it would make a legitimate deep link degrade twice for one mistake.
 */
export function resolveInstanceRoute(splat: string | undefined, allowedTabs: Iterable<string>): ResolvedInstanceRoute {
	const { requestedTab, sessionId } = parseInstanceSplat(splat);
	const allowed = allowedTabs instanceof Set ? allowedTabs : new Set(allowedTabs);
	return { tab: allowed.has(requestedTab) ? requestedTab : FALLBACK_TAB, sessionId };
}
