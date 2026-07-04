import { runUserWorkersAi } from "./user-ai.js";
import { getProfile, upsertProfile, PROFILE_FIELDS, type Profile } from "./profile.js";
import type { Env } from "../types.js";

/** Base64-encode bytes in chunks (avoids call-stack limits on large PDFs). */
function bytesToBase64(bytes: Uint8Array): string {
	let bin = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
	return btoa(bin);
}

const SAVE_RESUME_TOOL = {
	type: "function" as const,
	function: {
		name: "save_resume",
		description: "Save the candidate's details extracted from their résumé.",
		parameters: {
			type: "object",
			properties: {
				firstName: { type: "string" },
				lastName: { type: "string" },
				email: { type: "string" },
				phone: { type: "string" },
				city: { type: "string" },
				state: { type: "string", description: "state / region / province" },
				country: { type: "string" },
				postalCode: { type: "string" },
				linkedin: { type: "string", description: "full LinkedIn URL" },
				website: { type: "string", description: "portfolio / personal website URL" },
				workAuthorization: { type: "string", description: "citizenship / visa / right-to-work status EXACTLY as stated on the résumé, including the country (e.g. 'Australian Citizen')" },
				salaryExpectation: { type: "string" },
				summaryText: { type: "string", description: "a concise plain-text summary of the résumé — experience, key skills, education — 150-500 words, for a searchable knowledge base" },
			},
			required: [],
		},
	},
};

/**
 * Parse an uploaded résumé (PDF) with the user's BYOK Claude and seed BOTH data
 * planes: pre-fill the structured Profile's EMPTY fields (never clobber values the
 * user edited), and add a text summary to the instance KB (which vectorizes it for
 * chat/RAG). Best-effort — runs after the upload response (waitUntil); any failure
 * (no key, non-PDF, provider error) is swallowed so the upload itself is unaffected.
 */
export async function parseResumeIntoProfile(env: Env, instanceId: string, userId: string, bytes: Uint8Array, mime: string): Promise<void> {
	// Claude reads PDFs natively; skip other formats (docx/txt) for now.
	if (mime !== "application/pdf") return;

	let res: { tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }> };
	try {
		res = (await runUserWorkersAi(env, userId, "claude-sonnet-4-6", {
			messages: [
				{ role: "system", content: "You extract a candidate's résumé into structured fields. Copy values EXACTLY as written — do NOT infer, translate, or invent. Leave a field blank if it isn't clearly stated. Call save_resume exactly once." },
				{
					role: "user",
					content: [
						{ type: "document", source: { type: "base64", media_type: "application/pdf", data: bytesToBase64(bytes) } },
						{ type: "text", text: "Extract this candidate's details and a summary from the résumé." },
					],
				},
			],
			tools: [SAVE_RESUME_TOOL],
			maxTokens: 2000,
			timeoutMs: 60_000,
		})) as { tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }> };
	} catch {
		return; // no BYOK key / provider error / unreadable PDF → silently skip
	}

	const call = res.tool_calls?.find((t) => t.name === "save_resume");
	if (!call) return;
	const a = call.arguments || {};
	const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

	// Fill ONLY empty standard Profile fields — never overwrite what the user set.
	const existing = await getProfile(env, userId);
	const merged: Profile = { ...existing };
	let changed = false;
	for (const f of PROFILE_FIELDS) {
		const v = str(a[f.key]);
		if (v && !str(existing[f.key])) { merged[f.key] = v; changed = true; }
	}
	if (changed) await upsertProfile(env, userId, merged);

	// Seed the vector KB with a searchable summary (the instance DO vectorizes it).
	const summary = str(a.summaryText);
	if (summary) {
		const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
		await stub
			.fetch(new Request("https://agent/knowledge", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "Résumé (parsed)", content: summary }),
			}))
			.catch(() => undefined);
	}
}
