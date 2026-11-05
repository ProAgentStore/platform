import { createHash } from "node:crypto";
import { RunnerInputError } from "../errors.js";
import type { LocalApplyOwnerFacts } from "./contract.js";
import type { SourceBlock } from "./engine.js";

/** Validate the supplied snapshot without interpreting any field or question wording. */
export function parseOwnerFacts(raw: unknown, scope: Pick<LocalApplyOwnerFacts, "instanceId" | "applicationId" | "runId">): LocalApplyOwnerFacts | undefined {
	if (raw === undefined) return undefined;
	const bad = () => new RunnerInputError("Current owner facts have invalid content, revision or run binding.");
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad();
	const value = raw as LocalApplyOwnerFacts;
	if (value.schemaVersion !== 1 || value.source !== "account_profile" || value.instanceId !== scope.instanceId || value.applicationId !== scope.applicationId || value.runId !== scope.runId || typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))) throw bad();
	for (const fields of [value.identity, value.savedAnswers]) {
		if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.entries(fields).some(([key, text]) => !key || typeof text !== "string")) throw bad();
	}
	const bytes = JSON.stringify({ identity: value.identity, savedAnswers: value.savedAnswers });
	if (Buffer.byteLength(bytes) > 64 * 1024 || value.revision !== createHash("sha256").update(bytes).digest("hex")) throw bad();
	return { schemaVersion: 1, source: "account_profile", ...scope, capturedAt: value.capturedAt, revision: value.revision, identity: { ...value.identity }, savedAnswers: { ...value.savedAnswers } };
}

export function ownerFactSources(facts: LocalApplyOwnerFacts | undefined): SourceBlock[] {
	if (!facts) return [];
	const provenance = { source: facts.source, capturedAt: facts.capturedAt, revision: facts.revision, instanceId: facts.instanceId, applicationId: facts.applicationId, runId: facts.runId };
	return [
		{ label: "current_owner_identity", text: JSON.stringify({ ...provenance, meaning: "Current account identity snapshot. Capture time is not individual fact confirmation time. Assess current identity corrections against historical tailoring documents without altering approved document bytes.", facts: facts.identity }) },
		{ label: "saved_account_answers", text: JSON.stringify({ ...provenance, meaning: "Saved account answers, retained verbatim. Legacy storage does not record each answer's confirmation time or job scope. Assess applicability; do not blindly reuse an answer about another job. Current instance preferences remain the source of job preferences. A genuinely unresolved material conflict still needs clarification.", answers: facts.savedAnswers }) },
	];
}

export const ownerFactsReceipt = (facts: LocalApplyOwnerFacts) => ({ role: "current_owner_facts", path: `account_profile/${facts.instanceId}/${facts.applicationId}/${facts.runId}@${facts.capturedAt}`, sha256: facts.revision, count: Object.keys(facts.identity).length + Object.keys(facts.savedAnswers).length });
