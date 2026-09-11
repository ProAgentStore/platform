// Where the console OPENS — the decision behind `/` and any unknown path (#161, #794).
//
// Two rules, applied in order:
//
//   RESTORE     the last visited top-level section, so a reload lands where you left off (#161).
//               Only the section is persisted, never a deep detail route like /instances/:id,
//               which may no longer exist by the time it is restored.
//   PRIORITISE  what the user actually HAS: Instances, then My Agents, then the Library (#794).
//               A returning user's own running work comes first; the Library is the right answer
//               for someone with nothing yet, not the default for someone with plenty.
//
// `browse` is the one section deliberately NOT restored to. It is where you go to START
// something rather than somewhere you live, and restoring it is exactly what #794 was filed
// about — a user with instances re-opening the console onto the public catalogue. Excluding it
// costs nothing else: this decision only runs for `/` and for unknown paths, so reloading
// /browse itself still stays on /browse.

const LAST_ROUTE_KEY = "console:lastRoute";

/** The top-level nav sections we remember + restore. Deep routes normalize to their section. */
export const TOP_LEVEL_ROUTES = ["instances", "agents", "browse", "terminals", "usage", "profile", "notifications"] as const;
export type TopLevelRoute = (typeof TOP_LEVEL_ROUTES)[number];

/** Where a landing decision lands when it cannot be made on evidence. Never `browse`. */
const DEFAULT_ROUTE: TopLevelRoute = "instances";

/** Discovery: a tab you can always reach, but only ever a LANDING route for a user who
 *  demonstrably has nothing — and never a route we restore to. See the header. */
const DISCOVERY_ROUTE: TopLevelRoute = "browse";

/**
 * What the user has, as far as the landing decision is concerned.
 *
 * `null` is not zero and must never be collapsed into it. Zero is a claim about the account —
 * "you have none, go and find something" — and acting on a wrongly-zero count sends a user with
 * fifty instances to the public catalogue. Null says nobody could look, which is the honest
 * answer when the request failed. Same distinction `instance-run-liveness.ts` draws for #791.
 */
export interface LandingCounts {
	/** How many instances this user has — or NULL when the count could not be read. */
	instances: number | null;
	/** How many agents this user has built — or NULL when the count could not be read. */
	agents: number | null;
}

function isTopLevel(v: string | null | undefined): v is TopLevelRoute {
	return !!v && (TOP_LEVEL_ROUTES as readonly string[]).includes(v);
}

/** The first path segment (the top-level section) of a pathname, or "" if none. */
export function topLevelSegment(pathname: string): string {
	return pathname.replace(/^\/+/, "").split("/")[0] ?? "";
}

/** Persist the current pathname's top-level section — but only if it's one we restore.
 *  Unknown / detail-only paths are ignored so we never store something un-restorable. */
export function rememberRoute(pathname: string): void {
	const seg = topLevelSegment(pathname);
	if (!isTopLevel(seg)) return;
	try {
		localStorage.setItem(LAST_ROUTE_KEY, seg);
	} catch {
		/* storage disabled (private mode) — landing just falls back to the priority rule */
	}
}

/** The stored section, validated against the known set so a stale value can't route nowhere.
 *  Null when nothing is stored, the value is unknown, or storage is unreadable. */
export function rememberedRoute(): TopLevelRoute | null {
	try {
		const v = localStorage.getItem(LAST_ROUTE_KEY);
		return isTopLevel(v) ? v : null;
	} catch {
		/* storage disabled (private mode) — treated as "nothing remembered" */
		return null;
	}
}

/**
 * The landing route that needs NO network — the remembered section, when we restore to it.
 *
 * NULL means the decision depends on what the user has, so the caller must go and look. That is
 * a cold start, or a remembered `browse`; every other reload answers from here and costs nothing.
 */
export function landingRouteFromMemory(): TopLevelRoute | null {
	const remembered = rememberedRoute();
	return remembered && remembered !== DISCOVERY_ROUTE ? remembered : null;
}

/**
 * Where to send `/` — the whole rule in one pure function, so it can be tested as a value.
 *
 * The priority is #794's, in its order: a remembered section beats everything (it is the user's
 * own most recent choice), then Instances, then My Agents, then the Library.
 */
export function landingRoute(remembered: TopLevelRoute | null, counts: LandingCounts): TopLevelRoute {
	if (remembered && remembered !== DISCOVERY_ROUTE) return remembered;
	if ((counts.instances ?? 0) > 0) return "instances";
	if ((counts.agents ?? 0) > 0) return "agents";
	// The Library — but only on counts that were actually READ. An unread count reaching here as
	// a zero is the one way this rule can send an established user to discovery, which is the
	// behaviour #794 exists to remove rather than to relocate.
	if (counts.instances === 0 && counts.agents === 0) return DISCOVERY_ROUTE;
	return DEFAULT_ROUTE;
}
