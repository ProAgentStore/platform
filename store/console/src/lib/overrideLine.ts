/**
 * Settings → General: the Voice and Translation rows (#1599). Each is one line that follows the
 * account unless this agent overrides it. One pure decision over the server's `hasOverride` and
 * the local `revealed` flag (kept separate: revealing writes nothing, the first field change does).
 */

/** Whether the row's fetch landed; `failed` is also listed in the settings-load-failed banner. */
export type OverrideLoad = "loading" | "failed" | "loaded";

/**
 * - `loading` / `failed`: `Checking…` / `Couldn't check`, no action (the banner owns Retry).
 * - `line`: follows the account; action "Override for this agent". Also the state after clearing
 *   an override (server true -> false, revealed reset to false).
 * - `revealed`: the form with Cancel; nothing written yet.
 * - `overridden`: the form with "Use account default" (the DELETE); no Cancel.
 */
export type OverrideState = "loading" | "failed" | "line" | "revealed" | "overridden";

export function overrideState(input: { load: OverrideLoad; hasOverride: boolean; revealed: boolean }): OverrideState {
	if (input.load !== "loaded") return input.load;
	if (input.hasOverride) return "overridden";
	return input.revealed ? "revealed" : "line";
}

/** The text of the line for the states that have no form; `summary` is the existing effective-value text. */
export function overrideLineText(name: "Voice" | "Translation", state: "loading" | "failed" | "line", summary: string): string {
	if (state === "loading") return `${name}: Checking…`;
	if (state === "failed") return `${name}: Couldn't check`;
	return `${name}: follows your account (${summary})`;
}

export const OVERRIDE_ACTION = "Override for this agent";
export const PREFERENCES_LINK = "Change in Preferences";
export const USE_ACCOUNT_DEFAULT = "Use account default";
