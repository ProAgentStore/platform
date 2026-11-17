/**
 * The one browser-profile choice (#1601), held without rendering.
 *
 * Two stores decide the profile today: `browserProfile` (research settings: `isolated` | `default`) and
 * `profile` (browser settings: `persistent` | `ephemeral` | unset), plus the engine. The runner takes its MANAGED launch path
 * when an engine or profile policy is in force (`BrowserSessions.managed()`), and the owner's own profile is never used there.
 * This module reads what the saved settings actually launch (the table in #1601) and writes the pair the owner's choice means.
 * Nothing is migrated: the stores stay as they are, and every saved pair reads back as the launch it already produced.
 */
import type { BrowserEngine, BrowserProfilePolicy } from "./browserSettings";

export type ResearchProfile = "isolated" | "default";
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

/** What the saved settings say. `instance*` are this instance's own values; `agent*` the agent template's. */
export interface ProfileInputs {
	browserProfile: ResearchProfile;
	instanceEngine: BrowserEngine | null;
	instanceProfile: BrowserProfilePolicy | null;
	agentEngine: BrowserEngine | null;
	agentProfile: BrowserProfilePolicy | null;
}

const orElse = <T>(a: T | null, b: T | null): T | null => a ?? b;

/**
 * What a launch does for these effective values (the table in #1601). With a profile policy it is that policy; with only an
 * engine the managed path derives the policy from `browserProfile` (`default` -> kept, `isolated` -> fresh); with neither it is the
 * legacy path, where only `default` can reach the owner's profile.
 */
export function launchFor(browserProfile: ResearchProfile, engine: BrowserEngine | null, profile: BrowserProfilePolicy | null): LaunchProfile {
	if (profile === "ephemeral") return "fresh";
	if (profile === "persistent") return "kept";
	if (engine) return browserProfile === "default" ? "kept" : "fresh";
	return browserProfile === "default" ? "own" : "fresh";
}

/** What the saved settings launch today, whichever store says so. */
export function effectiveLaunch(i: ProfileInputs): LaunchProfile {
	return launchFor(i.browserProfile, orElse(i.instanceEngine, i.agentEngine), orElse(i.instanceProfile, i.agentProfile));
}

/** The choice shown: what takes effect at launch, not what any one store says. Nothing set on this instance reads as the agent's default. */
export function selectedChoice(i: ProfileInputs): ProfileChoice {
	if (i.instanceProfile === null && i.browserProfile === "isolated") return "default";
	return effectiveLaunch(i);
}

/** What choice 4 would launch: this instance's override cleared, the agent's own defaults and this instance's engine kept. */
export function defaultLaunch(i: ProfileInputs): LaunchProfile {
	return launchFor("isolated", orElse(i.instanceEngine, i.agentEngine), i.agentProfile);
}

/**
 * Why "your own browser profile" cannot be offered, or null. The runner's managed path (an engine, or a profile policy from the
 * agent) never uses the owner's profile and skips the consent check, so the choice is disabled with the reason instead of
 * quietly becoming a profile kept by the runner. This instance's OWN profile policy does not block it: choosing it clears that policy.
 */
export function ownProfileBlock(i: ProfileInputs): string | null {
	if (i.instanceEngine) return "Your own browser profile cannot be used while a browser is chosen in Browser settings. Choose “Use runner default” for the browser there to use it.";
	if (i.agentEngine || i.agentProfile) return "Your own browser profile cannot be used while this agent’s default browser or profile applies. The agent sets it, so this choice is unavailable for this agent.";
	return null;
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
