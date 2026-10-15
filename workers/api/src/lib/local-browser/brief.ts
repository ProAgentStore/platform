import type { Env } from "../../types.js";
import { BRIEF_MAX_CHARS } from "./policy.js";

/**
 * Seeding a local-browser agent's saved brief from instance memory, ONCE and on the owner's request
 * (#1065).
 *
 * The brief that run `bf25a3d1` needed already existed as a memory entry the owner set
 * (`search_target`, `source: "user"`). Memory is not the run's source, though: a key is whatever a
 * chat happened to name it, and an entry the AGENT wrote can derive from page text an attacker
 * authored. So only an entry whose `source` is `"user"` may be copied, and only when the owner asks
 * (`briefFromMemory` on the settings PUT). After that the brief is the settings field, edited there.
 */

/** The memory key the Job Search Scout's chat has used for its owner's criteria; offered, never applied. */
export const BRIEF_MEMORY_KEY = "search_target";

interface MemoryEntry {
	key?: unknown;
	content?: unknown;
	source?: unknown;
}

async function readMemory(env: Env, instanceId: string): Promise<MemoryEntry[]> {
	// The caller has proved ownership of this instance; its DO holds only this instance's storage.
	const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
	const res = await stub.fetch(new Request("https://agent/memory"));
	if (!res.ok) throw new Error(`instance memory could not be read (${res.status})`);
	const body = (await res.json()) as { memory?: MemoryEntry[] };
	return Array.isArray(body.memory) ? body.memory : [];
}

/** The text of a USER-set memory entry, as a brief — or why it cannot be one. */
export async function briefFromMemory(env: Env, instanceId: string, key: string): Promise<{ brief: string } | { error: string }> {
	const entry = (await readMemory(env, instanceId)).find((m) => m.key === key);
	if (!entry) return { error: `This instance has no memory entry "${key}".` };
	if (entry.source !== "user") {
		return { error: `Memory entry "${key}" was not set by you (source: ${String(entry.source ?? "agent")}), so it cannot become the saved brief — an agent-written entry may come from page text. Type the brief instead.` };
	}
	const brief = typeof entry.content === "string" ? entry.content.trim() : "";
	if (!brief || brief.length > BRIEF_MAX_CHARS) return { error: `Memory entry "${key}" is empty or longer than ${BRIEF_MAX_CHARS} characters; type the brief instead.` };
	return { brief };
}

/** Is there a user-set entry the owner could adopt as the brief? Shown while none is saved. Read failure → none. */
export async function briefSuggestion(env: Env, instanceId: string): Promise<{ memoryKey: string; chars: number } | null> {
	try {
		const entry = (await readMemory(env, instanceId)).find((m) => m.key === BRIEF_MEMORY_KEY && m.source === "user");
		return entry && typeof entry.content === "string" && entry.content.trim() ? { memoryKey: BRIEF_MEMORY_KEY, chars: entry.content.trim().length } : null;
	} catch {
		return null;
	}
}
