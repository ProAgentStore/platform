/**
 * URL state and ordering for Activity's History area (#1590).
 *
 * History (loop runs, takeovers, last browser launch, secure inputs, delivery log) renders above the
 * timeline on every `/activity` visit. `?view=history` only scrolls to and focuses it, `&panel=<id>` one
 * panel, `&takeover=<id>` the takeovers panel with that row highlighted. Query state, like Knowledge's
 * and Settings' `?subtab=`: the splat is read as `<tab>/<sessionId>`, so `activity/history` would be a session id.
 *
 * Pure: imports nothing from React, so a test (and the ordering below) drives the real thing.
 */
import { type BrowserTakeover, siteConsentHost } from "./browserTakeovers";
import { takesBrowserScreenshots } from "./browserScreenshots";
import type { LeadVerification } from "./gmailScout";

/**
 * Every panel History knows, in display order.
 */
export const HISTORY_PANELS = ["loop-runs", "takeovers", "verifications", "browser-launch", "secure-inputs", "deliveries", "finder"] as const;

export type HistoryPanelId = (typeof HISTORY_PANELS)[number];

export interface ActivityView {
	/** The URL asked for History: scroll to it and focus it. */
	focusHistory: boolean;
	panel: HistoryPanelId | null;
	/** A takeover id to highlight in the takeovers panel. */
	takeover: string | null;
}

export function activityViewFromSearch(search: URLSearchParams): ActivityView {
	const takeover = search.get("takeover") || null;
	const asked = HISTORY_PANELS.find((id) => id === search.get("panel")) ?? null;
	const panel = takeover ? "takeovers" : asked;
	return { focusHistory: search.get("view") === "history" || panel !== null, panel, takeover };
}

/** The capability inputs `surfaces.tsx` already hands every tab. Never a slug. */
export interface HistoryCaps {
	runtime?: string | null;
	surfaces?: readonly string[];
	/** The server's Gmail Scout verdict (`Instance.sourceMode`): a Scout's verification queue is on its Scans tab (#1591). */
	sourceMode?: string | null;
	/** The server's Original Finder verdict (#1616). */
	originalFinder?: boolean;
}

/** Takeovers exist for a local browser; the launch receipt for any agent that runs a browser. The rest are for every agent. */
export function showsHistoryPanel(caps: HistoryCaps, id: HistoryPanelId): boolean {
	if (id === "takeovers") return caps.runtime === "local_browser";
	if (id === "verifications") return caps.runtime === "local_browser" && caps.sourceMode !== "gmail";
	if (id === "finder") return caps.originalFinder === true;
	if (id === "browser-launch") return takesBrowserScreenshots(caps);
	return true;
}

export interface PanelNeed {
	id: HistoryPanelId;
	needsOwner: boolean;
}

/** Panel order: a panel holding something that needs the owner moves ahead of those that do not, each group keeping `HISTORY_PANELS` order. */
export function orderPanels(panels: readonly PanelNeed[]): HistoryPanelId[] {
	const rank = (p: PanelNeed) => HISTORY_PANELS.indexOf(p.id) + (p.needsOwner ? 0 : HISTORY_PANELS.length);
	return [...panels].sort((a, b) => rank(a) - rank(b)).map((p) => p.id);
}

/** `GET …/loop`, as far as History's one-liner reads it. */
export interface LoopRunsResponse {
	runs?: Array<{ status: string }>;
}

/** An autonomous run that stopped for the owner (`needs_human`): the one a person has to act on. */
export function runNeedsOwner(run: { status: string }): boolean {
	return run.status === "needs_human";
}

/** Within a panel: rows that need the owner first, then today's order. Stable. */
export function needingFirst<T>(rows: readonly T[], needsOwner: (row: T) => boolean): T[] {
	return [...rows.filter(needsOwner), ...rows.filter((r) => !needsOwner(r))];
}

/** What one panel reports upward once it has loaded (or failed), so the area can order and empty itself. */
export interface PanelReport {
	status: "loading" | "ready" | "failed";
	rows: number;
	needsOwner: boolean;
}

/** The empty-History line shows only once every shown panel has answered and none has anything to say (a failed one does). */
export function historyIsEmpty(reports: readonly PanelReport[]): boolean {
	return reports.every((r) => r.status === "ready" && r.rows === 0);
}

/** The host a lead's verification opens, as the server keys its site-consent request (`hostOf` in `job-lead-browser-verification.ts`). Null for a URL that does not parse. */
export function verificationHost(v: Pick<LeadVerification, "canonicalUrl">): string | null {
	try {
		return new URL(v.canonicalUrl).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * The live site-consent takeover a verification is waiting on (#1604). A lead needs the owner when it is `awaiting` and a live
 * `manual` takeover's subject is `site-consent:<host of its canonicalUrl>`: takeovers are keyed by host, leads by id.
 */
export function verificationTakeover(v: LeadVerification, takeovers: readonly BrowserTakeover[]): BrowserTakeover | null {
	if (v.state !== "awaiting") return null;
	const host = verificationHost(v);
	return host ? (takeovers.find((t) => siteConsentHost(t) === host) ?? null) : null;
}

/** Verifications needing the owner first, then the server's order. */
export function orderVerifications(leads: readonly LeadVerification[], takeovers: readonly BrowserTakeover[]): LeadVerification[] {
	return needingFirst(leads, (v) => verificationTakeover(v, takeovers) !== null);
}
