import { runUserWorkersAi, UserAiCredentialsError } from "./user-ai.js";
import { getProfile, upsertProfile, PROFILE_FIELDS, type Profile } from "./profile.js";
import { logError } from "./error-log.js";
import { notifyUser } from "../routes/push.js";
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
	const link = `/console/instances/${instanceId}/knowledge`;
	// Claude reads PDFs natively; skip other formats (docx/txt) for now — but SAY so.
	if (mime !== "application/pdf") {
		await notifyUser(env, userId, "apply", "Résumé saved (not auto-filled)", "Auto-fill needs a PDF résumé. Your file is saved and will still be attached to applications — re-upload as PDF to auto-fill your Profile.", link).catch(() => undefined);
		return;
	}

	try {
		const res = (await runUserWorkersAi(env, userId, "claude-sonnet-4-6", {
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

		const call = res.tool_calls?.find((t) => t.name === "save_resume");
		if (!call) throw new Error("the résumé couldn't be read (the model returned no fields)");
		const a = call.arguments || {};
		const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

		// Fill ONLY empty standard Profile fields — never overwrite what the user set.
		const existing = await getProfile(env, userId);
		const merged: Profile = { ...existing };
		const filled: string[] = [];
		for (const f of PROFILE_FIELDS) {
			const v = str(a[f.key]);
			if (v && !str(existing[f.key])) { merged[f.key] = v; filled.push(f.label); }
		}
		if (filled.length) await upsertProfile(env, userId, merged);

		// Seed the vector KB with a searchable summary (the instance DO vectorizes it).
		const summary = str(a.summaryText);
		let kbAdded = false;
		let kbSearchable = true;
		if (summary) {
			const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
			// Dedup: remove any prior "Résumé (parsed)" doc so re-uploading doesn't pile up
			// stale copies (which pollute RAG and can silently hit the 20-doc cap).
			try {
				const listRes = await stub.fetch(new Request("https://agent/knowledge"));
				if (listRes.ok) {
					const { documents } = (await listRes.json()) as { documents: Array<{ id: string; title: string }> };
					for (const d of documents || []) {
						if (d.title === "Résumé (parsed)")
							await stub.fetch(new Request(`https://agent/knowledge/${encodeURIComponent(d.id)}`, { method: "DELETE" }));
					}
				}
			} catch {
				/* best-effort dedup — proceed with the add regardless */
			}

			const r = await stub.fetch(new Request("https://agent/knowledge", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "Résumé (parsed)", content: summary }),
			}));
			kbAdded = r.ok;
			if (r.ok) {
				const rb = (await r.json().catch(() => ({}))) as { vectorized?: boolean };
				kbSearchable = rb.vectorized !== false;
			}
		}

		// ALWAYS tell the user the outcome — never silent. Distinguish "added + searchable"
		// from "added but not searchable" (embedding failed) so a broken vector store shows.
		const parts: string[] = [];
		if (filled.length) parts.push(`filled ${filled.length} Profile field${filled.length > 1 ? "s" : ""} (${filled.slice(0, 4).join(", ")}${filled.length > 4 ? "…" : ""})`);
		if (kbAdded && kbSearchable) parts.push("added a searchable summary to your knowledge base");
		else if (kbAdded && !kbSearchable) parts.push("saved a résumé summary (⚠️ not searchable yet — embedding failed, will retry on next upload)");
		await notifyUser(env, userId, "apply", "✅ Résumé parsed",
			parts.length ? `We ${parts.join(" and ")}.` : "Nothing new to add — your Profile was already complete.",
			link).catch(() => undefined);
	} catch (e) {
		if (e instanceof UserAiCredentialsError) {
			await notifyUser(env, userId, "apply", "Résumé saved (not auto-filled)", "Add an Anthropic API key in Profile → API Keys, then re-upload, to auto-fill your Profile from your résumé.", "/console/profile").catch(() => undefined);
			return;
		}
		// A REAL failure: persist it to the error log AND alert the user (never silent).
		const msg = e instanceof Error ? e.message : String(e);
		await logError(env, { source: "resume-parse", userId, message: `résumé parse failed: ${msg}`.slice(0, 300), context: { instanceId } }).catch(() => undefined);
		await notifyUser(env, userId, "apply", "⚠️ Couldn’t parse your résumé", `${msg.slice(0, 140)} — your Profile is unchanged. Try a different PDF, or fill your Profile manually.`, link).catch(() => undefined);
	}
}
