/**
 * The console's route table, as data a link can be checked against (#344).
 *
 * ── Why this exists
 *
 * A notification's click target is a STRING built in a Cloudflare Worker. The routes it has to
 * agree with are JSX in a React app. Nothing connected the two, so two links were found broken
 * by reading rather than by report:
 *
 *   /console/instances/:id/coding/repos/:repoId/summary   (#344) — the "Coder needs you" tap
 *   /console/#/instances/:id                              (#344) — hash routing on a BrowserRouter
 *
 * Neither 404s. That is the whole problem: `<Route path="*">` swallows anything unmatched into
 * the default screen, and `instances/:id/*` matches ANY splat — so both links "work" in the sense
 * that a page renders, and the user simply does not arrive where the notification promised. A
 * route-existence check alone would have passed both. What catches them is the splat GRAMMAR
 * below, which is the part the router does not police.
 *
 * Consumers: `checkConsoleLink` is asserted over every builder in
 * `workers/api/src/lib/console-links.ts` (that module is the only place a Worker builds one), and
 * `routes.test.ts` holds this table against `App.tsx` and `surfaces.tsx` so it cannot drift.
 */
import { notificationRoute } from "./deepLink";

/** Routes something may legitimately link AT, exactly as `App.tsx` declares them. */
export const CONSOLE_ROUTES = [
	"agents",
	"browse",
	"agents/new",
	"agents/:id",
	"agents/:id/:tab",
	"instances",
	"instances/:id/tasks/:taskId",
	"instances/:id/*",
	"dashboard",
	"tools",
	"terminals",
	"usage",
	"feedback",
	"preferences",
	"profile",
	"notifications",
] as const;

/**
 * The two `path="*"` fallbacks. Deliberately NOT linkable: they exist to rescue an unknown URL by
 * redirecting to the user's default screen, which is exactly the silent landing this guard is
 * about. A link that only matches these matches nothing.
 */
export const CONSOLE_CATCH_ALL_ROUTES = ["*", "/*"] as const;

/**
 * The first splat segment of `instances/:id/*` — the tab. Mirrors `SURFACE_IDS` in
 * `surfaces.tsx`, which cannot be imported here: this module is read by a Worker-side test and
 * that registry pulls in the whole React surface tree. `routes.test.ts` asserts the two are equal.
 */
export const INSTANCE_TABS = [
	"chat",
	"apply",
	"board",
	"repo",
	"coding",
	"tmux",
	"activity",
	"stats",
	"knowledge",
	"behaviour",
	"feedback",
	"indexing",
	"data",
	"settings",
] as const;

/**
 * How many splat segments `InstanceDetail` actually reads: `splatParts[0]` is the tab and
 * `splatParts[1]` is the session id. Anything further is silently dropped — which is precisely
 * how `coding/repos/<repoId>/summary` became "tab `coding`, session `repos`".
 */
const MAX_INSTANCE_SPLAT = 2;

export type LinkCheck = { ok: true; route: string } | { ok: false; reason: string };

/**
 * Would this link, tapped, land the user on the page it names?
 *
 * "Lands somewhere" is not the bar — the catch-all guarantees that. The bar is that every part of
 * the path is honoured by the component that receives it.
 */
export function checkConsoleLink(url: string): LinkCheck {
	if (!url) return { ok: false, reason: "empty link" };
	if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
		// A tap moves an already-open tab with `WindowClient.navigate()`, which by spec cannot
		// leave the origin — an absolute URL is silently swallowed there (#338).
		return { ok: false, reason: `"${url}" is not a same-origin path, so an open console tab cannot be navigated to it` };
	}
	if (!url.startsWith("/")) return { ok: false, reason: `"${url}" is not root-relative` };

	const [beforeHash, hash] = splitOnce(url, "#");
	if (hash) {
		return { ok: false, reason: `"${url}" uses a #fragment path — the console mounts a BrowserRouter, so everything after # is ignored` };
	}
	const [pathname] = splitOnce(beforeHash, "?");

	const routePath = notificationRoute(pathname);
	if (!routePath) return { ok: false, reason: `"${url}" is not an in-app console path` };

	const segments = routePath.split("/").filter(Boolean);
	// `<Route index>` — no `path`, so it is not in the table, but it is a real destination: the
	// bare console root restores whichever top-level screen the user left off on (#161).
	if (!segments.length) return { ok: true, route: "index" };
	const matched = CONSOLE_ROUTES.filter((r) => matchesPattern(r, segments));
	if (!matched.length) {
		return { ok: false, reason: `"${url}" matches no route — the "*" catch-all would send it to the default screen instead` };
	}
	// React Router ranks a static/param route above a splat, so an explicit route wins where both
	// match (`instances/:id/tasks/:taskId` over `instances/:id/*`).
	const route = matched.find((r) => !r.endsWith("*")) ?? matched[0];
	if (route !== "instances/:id/*") return { ok: true, route };

	const splat = segments.slice(2);
	if (!splat.length) return { ok: true, route }; // /instances/:id — InstanceDetail opens Assistant
	const [tab, , ...ignored] = splat;
	if (!(INSTANCE_TABS as readonly string[]).includes(tab)) {
		return { ok: false, reason: `"${tab}" is not an instance tab — InstanceDetail reads the first splat segment as the tab and falls back to Assistant` };
	}
	if (splat.length > MAX_INSTANCE_SPLAT) {
		return {
			ok: false,
			reason: `"${url}" carries ${splat.length} splat segments but InstanceDetail parses only <tab>/<sessionId>; ${ignored.map((s) => `"${s}"`).join(", ")} is ignored`,
		};
	}
	return { ok: true, route };
}

function splitOnce(s: string, sep: string): [string, string] {
	const i = s.indexOf(sep);
	return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

function matchesPattern(pattern: string, segments: string[]): boolean {
	const parts = pattern.split("/");
	if (parts[parts.length - 1] === "*") {
		const head = parts.slice(0, -1);
		return segments.length >= head.length && head.every((p, i) => segmentMatches(p, segments[i]));
	}
	return parts.length === segments.length && parts.every((p, i) => segmentMatches(p, segments[i]));
}

function segmentMatches(pattern: string, segment: string | undefined): boolean {
	if (!segment) return false;
	return pattern.startsWith(":") ? true : pattern === segment;
}
