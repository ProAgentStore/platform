/**
 * Query-string deep links into a surface (#338).
 *
 * A notification's click target has to be a URL, and it has to be SAME-ORIGIN: an open tab is
 * moved with `WindowClient.navigate()`, which by spec cannot leave the origin. The deploy
 * watcher used to point at the GitHub Actions run instead, so the navigate rejected, the
 * service worker swallowed it, and clicking the notification with the console already open
 * just brought the tab forward and did nothing else.
 *
 * The route (`/instances/:id/coding`) is the stable parent — it exists long before any
 * particular build does — and the query says which view inside it to open. There is no
 * per-deploy page in the product to link at, and there cannot be one that is ready at
 * notification time: the only per-run artifact is GitHub's own, which is the thing we cannot
 * navigate to. Producer: `deployDeepLink` in workers/api/src/lib/deploy-watch.ts, which since
 * #344 builds the string through `lib/console-links.ts` — the one module a Worker may build a
 * console link in, so every one of them can be held against `routes.ts` by a test.
 */

/**
 * `?builds=<repoId>` — open the Coding surface on Builds, showing that repo's run history.
 *
 * Returns null when the parameter is absent or empty, which is every ordinary visit.
 */
export function deepLinkedBuildsRepo(search: string): string | null {
	try {
		const v = new URLSearchParams(search).get("builds");
		return v ? v : null;
	} catch {
		return null;
	}
}

/**
 * A stored notification URL as a router path, or null when it is not an in-app destination.
 *
 * The same link serves the service worker (which needs the full path from the origin, base
 * included) and the in-app list (which routes UNDER the basename, so the base must come off or
 * the navigation lands on `/console/console/…`). Producers all emit `/console/…`; stripping
 * that prefix rather than the live basename keeps the link working on the apex and on
 * console.proagentstore.online, where the app is mounted at `/`.
 *
 * Anything absolute (`https://…`) returns null — a notification predating #338 points at
 * GitHub, and the caller opens those in a new tab instead of routing to a page that isn't ours.
 */
export function notificationRoute(url?: string | null): string | null {
	if (!url?.startsWith("/")) return null;
	if (url === "/console" || url === "/console/") return "/";
	return url.startsWith("/console/") ? url.slice("/console".length) : url;
}
