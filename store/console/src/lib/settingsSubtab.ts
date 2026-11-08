/**
 * URL state for Settings' second-level navigation (#1589).
 *
 * Like Knowledge (`knowledgeSubtab.ts`), Settings keeps its sub-tab in `?subtab=` rather than a
 * third path segment: `instanceRoute.ts` reads the splat positionally as `<tab>/<sessionId>`, so
 * `settings/browser` would be taken for a session id. Knowledge and Settings share the key name
 * harmlessly, because `InstanceDetail.setTab` drops the query when the top-level tab changes.
 *
 * Pure: imports nothing from React or `surfaces.tsx` (only `browserScreenshots.ts`), so the server's
 * link-parity test can import it too.
 */
import { takesBrowserScreenshots } from "./browserScreenshots";

/** In bar order. The first is the default and the fallback. */
export const SETTINGS_SUBTABS = ["agent", "browser", "automation", "notifications", "instructions", "general"] as const;

export type SettingsSubtab = (typeof SETTINGS_SUBTABS)[number];

export const SETTINGS_SUBTAB_LABELS: Record<SettingsSubtab, string> = {
	agent: "Agent",
	browser: "Browser",
	automation: "Automation",
	notifications: "Notifications",
	instructions: "Instructions",
	general: "General",
};

export const DEFAULT_SETTINGS_SUBTAB: SettingsSubtab = "agent";

/** The capability inputs `surfaces.tsx` already hands to SettingsTab. Never a slug. */
export interface SettingsSubtabCaps {
	runtime?: string | null;
	surfaces?: readonly string[];
}

/** Browser holds the browser agent's controls: a local browser runs them, or any browser run takes screenshots. */
export function showsSettingsSubtab(caps: SettingsSubtabCaps, id: SettingsSubtab): boolean {
	if (id === "browser") return caps.runtime === "local_browser" || takesBrowserScreenshots(caps);
	return true;
}

export function visibleSettingsSubtabs(caps: SettingsSubtabCaps): SettingsSubtab[] {
	return SETTINGS_SUBTABS.filter((id) => showsSettingsSubtab(caps, id));
}

/** The sub-tab a URL opens. No param, an unknown value, or one not shown for this instance opens Agent. */
export function settingsSubtabFromSearch(search: URLSearchParams, caps: SettingsSubtabCaps): SettingsSubtab {
	const value = search.get("subtab");
	const match = SETTINGS_SUBTABS.find((id) => id === value);
	return match && showsSettingsSubtab(caps, match) ? match : DEFAULT_SETTINGS_SUBTAB;
}

/** Keep unrelated query state (`focus=`) while changing only the selected sub-tab. */
export function searchWithSettingsSubtab(search: URLSearchParams, subtab: SettingsSubtab): URLSearchParams {
	const next = new URLSearchParams(search);
	next.set("subtab", subtab);
	return next;
}
