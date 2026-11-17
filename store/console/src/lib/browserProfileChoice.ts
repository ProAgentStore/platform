/**
 * The one browser-profile choice (#1601), held without rendering.
 *
 * Two stores decide the profile today: `browserProfile` (research settings: `isolated` | `default`) and `profile` (browser settings:
 * `persistent` | `ephemeral` | unset), plus the engine. The runner takes its MANAGED launch path when an engine or profile policy is
 * in force (`BrowserSessions.managed()`), and the owner's own profile is never used there.
 *
 * What the SAVED settings launch comes from the server, as #1603 provides it: `launchPath` (managed | legacy) and `effective.profile`
 * (the instance's value, else the agent's). The console does not recompute either from the engine and profile. It adds only what the
 * server cannot know: this instance's `browserProfile`, which on the managed path with no policy derives one (default -> kept,
 * isolated -> fresh) and on the legacy path is the only way to reach the owner's profile. Nothing is migrated: every saved pair reads
 * back as the launch it already produced (the table in #1601).
 */
import type { BrowserEngine, BrowserProfilePolicy } from "./browserSettings";

export type ResearchProfile = "isolated" | "default";
export type LaunchPath = "managed" | "legacy";
/** What a launch is: a throwaway profile, one the runner keeps for this agent, or (legacy path only) the owner's own. */
export type LaunchProfile = "fresh" | "kept" | "own";
/** The four choices. `default` is "use the agent's default" (nothing set on this instance). */
export type ProfileChoice = "fresh" | "kept" | "own" | "default";

export const CHOICE_ORDER: ProfileChoice[] = ["fresh", "kept", "own", "default"];

export const LAUNCH_LABELS: Record<LaunchProfile, string> = {
	fresh: "A fresh browser each time",
	kept: "A browser profile kept for this agent",
	own: "Your own browser profile, with your sign-ins",
};

/**
 * What is saved. `launchPath` and `effectiveProfile` are the server's (`GET /browser-settings`); `browserProfile` is the research
 * setting; the `instance*` / `agent*` values say where the settings came from, for the reasons shown to the owner.
 */
export interface ProfileInputs {
	browserProfile: ResearchProfile;
	launchPath: LaunchPath;
	effectiveProfile: BrowserProfilePolicy | null;
	instanceEngine: BrowserEngine | null;
	instanceProfile: BrowserProfilePolicy | null;
	agentEngine: BrowserEngine | null;
	agentProfile: BrowserProfilePolicy | null;
}

/**
 * What a launch does (the table in #1601): a profile policy decides; with none, the managed path derives one from `browserProfile`
 * and only the legacy path can reach the owner's profile. `launchPath` is the server's, not worked out here.
 */
export function launchFor(browserProfile: ResearchProfile, launchPath: LaunchPath, effectiveProfile: BrowserProfilePolicy | null): LaunchProfile {
	if (effectiveProfile === "ephemeral") return "fresh";
	if (effectiveProfile === "persistent") return "kept";
	if (launchPath === "managed") return browserProfile === "default" ? "kept" : "fresh";
	return browserProfile === "default" ? "own" : "fresh";
}

/** What the saved settings launch today, as the server reports the path and the effective policy. */
export function effectiveLaunch(i: ProfileInputs): LaunchProfile {
	return launchFor(i.browserProfile, i.launchPath, i.effectiveProfile);
}

/** The choice shown: what takes effect at launch, not what one store says. Nothing set on this instance reads as the agent's default. */
export function selectedChoice(i: ProfileInputs): ProfileChoice {
	if (i.instanceProfile === null && i.browserProfile === "isolated") return "default";
	return effectiveLaunch(i);
}

/**
 * What choice 4 would launch: this instance's overrides cleared (`isolated`, no policy of its own), so the agent's own policy decides.
 * With `isolated` the managed/legacy path makes no difference (no policy -> fresh either way), so this needs no path at all.
 */
export function defaultLaunch(i: ProfileInputs): LaunchProfile {
	return launchFor("isolated", "legacy", i.agentProfile);
}

/**
 * Why "your own browser profile" cannot be offered, or null. The runner's managed path never uses the owner's profile and skips the
 * consent check, so the choice is disabled with the reason instead of quietly becoming a profile kept by the runner.
 *
 * With no profile policy on this instance, choosing it changes nothing about the path, so the server's `launchPath` says whether it
 * would be managed. With a policy on this instance, choosing it CLEARS that policy first, and only the engine or the agent's own
 * policy can keep the path managed (the server cannot say what the path would be after that write, so the sources decide).
 */
export function ownProfileBlock(i: ProfileInputs): string | null {
	const managedAfter = i.instanceProfile === null ? i.launchPath === "managed" : !!(i.instanceEngine || i.agentEngine || i.agentProfile);
	if (!managedAfter) return null;
	if (i.instanceEngine) return "Your own browser profile cannot be used while a browser is chosen in Browser settings. Choose “Use runner default” for the browser there to use it.";
	return "Your own browser profile cannot be used while this agent’s default browser or profile applies. The agent sets it, so this choice is unavailable for this agent.";
}

/** The pair of values a choice writes. `profile` is browser settings' policy (null clears the instance's own). */
export function writesFor(choice: ProfileChoice): { browserProfile: ResearchProfile; profile: BrowserProfilePolicy | null } {
	switch (choice) {
		case "fresh": return { browserProfile: "isolated", profile: "ephemeral" };
		case "kept": return { browserProfile: "isolated", profile: "persistent" };
		case "own": return { browserProfile: "default", profile: null };
		case "default": return { browserProfile: "isolated", profile: null };
	}
}

/** The label of a choice, with the effective launch spelled out for the agent's default. */
export function choiceLabel(choice: ProfileChoice, i: ProfileInputs): string {
	if (choice === "default") return `Use the agent’s default (now: ${LAUNCH_LABELS[defaultLaunch(i)]})`;
	return LAUNCH_LABELS[choice];
}

/** The caveat choice 3 always carries: nothing tells the cloud whether the machine is set up for real-profile mode (#1601). */
export const OWN_PROFILE_CAVEAT = "Your real Chrome profile only on machines set up for it; on other machines this is a profile kept by the runner for this agent. It asks for your consent first.";

interface ProfileFields { engine: BrowserEngine | null; profile: BrowserProfilePolicy | null }
export interface ProfileView extends ProfileFields {
	agentDefaults: ProfileFields;
	effective: ProfileFields;
	launchPath: LaunchPath;
}

/**
 * Whether a `GET /browser-settings` body carries what the choice reads, including a `launchPath` this console understands. A body
 * without it (an older server, a proxy's empty answer, a path value it does not know) must show the control's own load failure, never
 * throw while rendering and take the whole Settings tab down, and never guess the launch.
 */
export function hasProfileFields(v: unknown): v is ProfileView {
	const o = v as Partial<Record<string, unknown>> | null;
	const has = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && "engine" in x && "profile" in x;
	return !!o && typeof o === "object" && has(o) && has(o.agentDefaults) && has(o.effective) && (o.launchPath === "managed" || o.launchPath === "legacy");
}
