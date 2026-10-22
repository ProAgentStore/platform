// Release notes are a coding-agent integration (#1286): the platform posts one note per coder run that ships, and only the coding
// workflow produces that run. Eligibility comes from the instance's RESOLVED, declared capabilities — the same convention the console
// uses for its Coding tab (`surfaces` includes "coding") plus the workflow binding — never from a name or slug, so a renamed coder
// stays eligible and a chat agent called "Coder" does not.
//
// Nothing stored is touched by this: an ineligible instance keeps whatever grants and settings it already has; they are just not
// readable, writable or testable through the release-notes surface, and say so.
import { HttpError } from "./auth.js";
import { type AgentCapabilities, capabilitiesForInstance } from "./agent-capabilities.js";
import type { Env } from "../types.js";

export function releaseNotesEligible(caps: Pick<AgentCapabilities, "surfaces" | "workflow"> | null | undefined): boolean {
	return !!caps && (caps.surfaces.includes("coding") || caps.workflow === "CODING_SESSION");
}

export const RELEASE_NOTES_UNSUPPORTED = "Release notes are a coding-agent feature: this agent does not declare the coding capability, so it has no release notes to configure, grant a channel for or test. Ordinary Discord and Slack access is unaffected.";

/** Throws 422 with the explicit unsupported-feature reason unless the owner's instance is a coder. */
export async function requireReleaseNotesEligible(env: Env, instanceId: string, userId: string): Promise<void> {
	if (!releaseNotesEligible(await capabilitiesForInstance(env, instanceId, userId))) throw new HttpError(422, RELEASE_NOTES_UNSUPPORTED);
}
