// Restore the last visited top-level screen on load (#161). We persist only the top-level
// nav section (never a deep detail route like /instances/:id, which may no longer exist), and
// fall back to Instances for a first-time visitor or an unknown/stale stored value.

const LAST_ROUTE_KEY = "console:lastRoute";

/** The top-level nav sections we remember + restore. Deep routes normalize to their section. */
export const TOP_LEVEL_ROUTES = ["instances", "agents", "browse", "terminals", "usage", "profile", "notifications"] as const;
type TopLevelRoute = (typeof TOP_LEVEL_ROUTES)[number];

const DEFAULT_ROUTE: TopLevelRoute = "instances";

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
		/* storage disabled (private mode) — restore just falls back to the default */
	}
}

/** The route to send "/" (and unknown paths) to: the last remembered top-level section,
 *  else Instances. Validated against the known set so a stale value can't route nowhere. */
export function resolveDefaultRoute(): TopLevelRoute {
	try {
		const v = localStorage.getItem(LAST_ROUTE_KEY);
		if (isTopLevel(v)) return v;
	} catch {
		/* ignore */
	}
	return DEFAULT_ROUTE;
}
