import type { Env } from "../../types.js";
import { sha256Hex } from "../../agent-storage-utils.js";
import { HttpError } from "../auth.js";
import { getProfile, PROFILE_FIELDS } from "../profile.js";
import { cliAtLeast } from "../runner-upgrade.js";
import type { LocalApplyOwnerFacts } from "./contract.js";

export const OWNER_FACTS_MIN_CLI = "0.4.222";
const standard = new Set(PROFILE_FIELDS.map((field) => field.key));
// Explicit retired account settings, not question-wording classification.
const retired = new Set(["voiceRepeatWordsLegacy", "voiceMuteWordsLegacy", "voiceStopWordsLegacy", "voiceStopSpeechKeywordLegacy"]);
export type OwnerFactValues = Pick<LocalApplyOwnerFacts, "identity" | "savedAnswers">;

/** Read current account identity only; job preferences remain in instance memory. */
export async function readOwnerFactValues(env: Env, userId: string, runnerVersion?: string | null): Promise<OwnerFactValues | undefined> {
	const profile = await getProfile(env, userId);
	const identity: Record<string, string> = {};
	const savedAnswers: Record<string, string> = {};
	for (const field of PROFILE_FIELDS.filter((field) => field.group === "identity").sort((a, b) => a.key.localeCompare(b.key))) {
		if (typeof profile[field.key] === "string" && profile[field.key]?.trim()) identity[field.key] = profile[field.key] as string;
	}
	for (const key of Object.keys(profile).sort()) {
		if (!standard.has(key) && !retired.has(key) && typeof profile[key] === "string" && profile[key]?.trim()) savedAnswers[key] = profile[key] as string;
	}
	if (!Object.keys(identity).length && !Object.keys(savedAnswers).length) return undefined;
	if (!cliAtLeast(runnerVersion, OWNER_FACTS_MIN_CLI)) throw new HttpError(409, `Current account facts require CLI ${OWNER_FACTS_MIN_CLI} or newer; update the runner before filling. Historical documents were not substituted for current facts.`);
	const values = { identity, savedAnswers };
	if (new TextEncoder().encode(JSON.stringify(values)).byteLength > 64 * 1024) throw new HttpError(409, "Current account facts exceed the 64 KiB input limit. No application was dispatched; no answers were silently truncated.");
	return values;
}

/** A revision identifies exact source content; scope and capture time identify its delivery. */
export async function ownerFactsSnapshot(values: OwnerFactValues | undefined, scope: Pick<LocalApplyOwnerFacts, "instanceId" | "applicationId" | "runId">, now: number): Promise<LocalApplyOwnerFacts | undefined> {
	if (!values) return undefined;
	return { schemaVersion: 1, source: "account_profile", ...scope, capturedAt: new Date(now).toISOString(), revision: await sha256Hex(JSON.stringify(values)), ...values };
}

/** Audit only identity/counts, never the owner's actual facts. */
export const ownerFactsReceipt = (facts: LocalApplyOwnerFacts) => ({ role: "current_owner_facts", path: `account_profile/${facts.instanceId}/${facts.applicationId}/${facts.runId}@${facts.capturedAt}`, sha256: facts.revision, count: Object.keys(facts.identity).length + Object.keys(facts.savedAnswers).length });
