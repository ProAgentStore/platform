import type { Env } from "../types.js";
import { sha256Hex } from "../agent-storage-utils.js";
import { HttpError } from "./auth.js";
import { cliAtLeast } from "./runner-upgrade.js";
import { INSTANCE_PREFERENCES_KEY, INSTANCE_PREFERENCES_MIN_CLI, parsePreferenceDocument, type InstancePreferences } from "./instance-preferences-contract.js";

/** A task reads only its own instance's explicitly owner-set preference entry, fresh at dispatch. */
export async function instancePreferencesFor(env: Env, instanceId: string, userId: string, runnerVersion?: string | null, now = Date.now()): Promise<InstancePreferences | undefined> {
	const owned = await env.DB.prepare("SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first();
	if (!owned) throw new HttpError(404, "Candidate preference instance not found.");
	let memory: unknown;
	try {
		const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
		const response = await stub.fetch(new Request("https://agent/memory", { signal: AbortSignal.timeout(5000) }));
		if (!response.ok) throw new Error("unavailable");
		memory = (await response.json<{ memory?: unknown }>()).memory;
		if (!Array.isArray(memory)) throw new Error("invalid response");
	} catch { throw new HttpError(503, "This instance's candidate preference memory could not be read. No application work was dispatched; retry when memory is available."); }
	const matching = (memory as Array<Record<string, unknown>>).filter(entry => entry && entry.key === INSTANCE_PREFERENCES_KEY);
	if (!matching.length) return undefined;
	if (matching.length !== 1) throw new HttpError(409, "Candidate preference memory is ambiguous; keep one owner-set entry.");
	const entry = matching[0];
	if (entry.source !== "user" || entry.type !== "preference") throw new HttpError(409, "Candidate preference memory must be a preference explicitly set by its owner, not agent-written or summarized.");
	if (!cliAtLeast(runnerVersion, INSTANCE_PREFERENCES_MIN_CLI)) throw new HttpError(409, `Instance candidate preferences require CLI ${INSTANCE_PREFERENCES_MIN_CLI} or newer; update the runner before continuing.`);
	if (typeof entry.content !== "string" || new TextEncoder().encode(entry.content).byteLength > 8192) throw new HttpError(409, "Candidate preference memory must contain a complete version 1 document of at most 8 KiB.");
	let raw: unknown;
	try { raw = JSON.parse(entry.content); } catch { throw new HttpError(409, "Candidate preference memory must use the structured version 1 document; no facts were inferred from prose."); }
	const document = parsePreferenceDocument(raw, now);
	if ("error" in document) throw new HttpError(409, document.error);
	const timestamp = typeof entry.updatedAt === "number" ? new Date(entry.updatedAt) : null;
	const updatedAt = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : entry.updatedAt;
	if (typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))) throw new HttpError(409, "Candidate preference memory has no valid update receipt.");
	return { ...document, source: "user", instanceId, memoryKey: INSTANCE_PREFERENCES_KEY, memoryUpdatedAt: updatedAt, sha256: await sha256Hex(entry.content) };
}

/** Durable provenance without logging a candidate's answers. */
export const instancePreferenceReceipt = (preferences: InstancePreferences) => ({ role: "instance_preferences", path: `${preferences.instanceId}/${preferences.memoryKey}@${preferences.memoryUpdatedAt}`, sha256: preferences.sha256, count: preferences.facts.length });
