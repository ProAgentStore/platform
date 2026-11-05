import { Blocked, prepareApplyDocuments } from "./documents.js";
import { fullArtifactPaths } from "./full-tools.js";
import { ownerFactSources, ownerFactsReceipt } from "./owner-facts.js";
import { preferencesSourceText, preferenceReceipt, projectPreferenceSources, validatePreferences } from "../instance-preferences.js";
import type { LocalApplyEvent, LocalApplyPreflightFailure, LocalApplyTaskEnvelope } from "./contract.js";

/** Created only around synchronous document reads, never around browser or model initialization. */
export class DocumentPreflightRefusal extends Blocked {
	readonly receipt: LocalApplyPreflightFailure;
	constructor(runId: string, refusal: Blocked & { reason: LocalApplyPreflightFailure["reason"] }) {
		super(refusal.reason, refusal.questions);
		this.receipt = { schemaVersion: 1, runId, phase: "documents", reason: refusal.reason };
	}
}

export function prepareApplySources(e: LocalApplyTaskEnvelope, dir: string, home: string, now: number, emit: (event: Omit<LocalApplyEvent, "at">) => void) {
	let prepared: ReturnType<typeof prepareApplyDocuments>;
	try { prepared = prepareApplyDocuments(e, dir, home, emit); }
	catch (error) {
		if (error instanceof Blocked && (error.reason === "source_unavailable" || error.reason === "artifact_changed")) throw new DocumentPreflightRefusal(e.runId, error as Blocked & { reason: LocalApplyPreflightFailure["reason"] });
		throw error;
	}
	const preferences = validatePreferences(e.instancePreferences, e.instanceId, now);
	const blocks = e.policy.toolAccess === "full" ? [...prepared.blocks, ...(preferences ? [{ label: "instance_preferences", text: preferencesSourceText(preferences) }] : [])] : projectPreferenceSources(prepared.blocks, preferences);
	const artifactPath = e.policy.toolAccess === "full" ? fullArtifactPaths(prepared.artifactPath, e.artifacts, dir) : prepared.artifactPath;
	if (e.policy.toolAccess === "full") blocks.push({ label: "approved_document_paths", text: JSON.stringify(e.artifacts.map(({ kind }) => ({ kind, ...artifactPath(kind) }))) });
	if (preferences) emit({ type: "source.read", detail: preferenceReceipt(preferences) });
	for (const a of e.ownerAnswers ?? []) blocks.push({ label: "owner answers", text: `Q: ${a.question}\nA: ${a.answer}`, answerText: a.answer, answerQuestion: a.question });
	blocks.push(...ownerFactSources(e.ownerFacts));
	if (e.ownerFacts) emit({ type: "source.read", detail: ownerFactsReceipt(e.ownerFacts) });
	return { blocks, artifactPath };
}
