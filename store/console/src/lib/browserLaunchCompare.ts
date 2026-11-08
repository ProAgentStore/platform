/**
 * Does the browser setting that applies now differ from what the runner last reported launching? (#1590)
 *
 * Saved settings apply on the NEXT launch, so a difference is expected after a change; the Browser tab
 * says so and links to the receipt in Activity. Null fields in `effective` mean "runner default", which a
 * launch has already resolved to a concrete value, so a null is never a difference.
 */
import type { BrowserSettings } from "./browserSettings";

export interface LaunchFacts {
	engine: string;
	mode: string;
	profilePolicy: string;
}

export function launchDiffersFromSettings(effective: Pick<BrowserSettings, "engine" | "mode" | "profile">, launch: LaunchFacts | null | undefined): boolean {
	if (!launch) return false;
	return (
		(effective.engine !== null && effective.engine !== launch.engine) ||
		(effective.mode !== null && effective.mode !== launch.mode) ||
		(effective.profile !== null && effective.profile !== launch.profilePolicy)
	);
}
