/** Auxiliary reads have no retained application pause to resume. Save permission, never restart a fill. */
import type { Env } from "../types.js";
import { HttpError } from "./auth.js";
import { browserWebsiteBlock, type BrowserWebsiteBlock } from "./browser-website-access.js";
import { websiteAccessForInstance } from "./browser-settings-dispatch.js";
import { ensureWebsiteAccessRequest } from "./website-access.js";

export interface AuxiliaryWebsiteBlocked {
	state: "blocked";
	error: string;
	websiteAccess: BrowserWebsiteBlock;
	questionUrl?: string;
	requestId?: string;
}

/** A compatibility refusal is actionable, not evidence of a disconnected runner. */
export function auxiliaryRuntimeFailure(error: unknown): null {
	if (error instanceof Error && /^(Website access requires CLI|Saved website access settings are invalid)/.test(error.message)) throw new HttpError(409, error.message);
	return null;
}

export async function auxiliaryWebsiteAccess(env: Env, uid: string, instanceId: string, purpose: "preflight" | "sign_in" | "reconciliation", identity: string, receipt: unknown): Promise<AuxiliaryWebsiteBlocked | null> {
	const access = browserWebsiteBlock(receipt);
	if (!access) return null;
	if (access.decision === "deny") return { state: "blocked", websiteAccess: access, error: `Website access is denied by this agent's settings: ${access.hostname}. This browser operation stopped.` };
	const policy = await websiteAccessForInstance(env, uid, instanceId);
	if (policy?.mode !== "ask_once") return { state: "blocked", websiteAccess: access, error: "Website permission changed while this browser operation was running. It stopped; explicitly retry the browser operation under the current settings." };
	if (policy.domains.includes(access.hostname) || policy.rememberedDomains?.includes(access.hostname)) return { state: "blocked", websiteAccess: access, error: "Website permission is saved. Explicitly retry this browser operation; no application was restarted or submitted." };
	if (policy.deniedDomains?.includes(access.hostname)) return { state: "blocked", websiteAccess: { ...access, decision: "deny" }, error: `Website access is denied for this agent: ${access.hostname}. This browser operation stopped.` };
	// URLs can contain private query values. Keep only an opaque deterministic identity in the ledger.
	const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	const subjectId = `browser-${purpose}:${hash}`;
	const request = await ensureWebsiteAccessRequest(env, { userId: uid, instanceId, subjectKind: "connector", subjectId, hostname: access.hostname, pauseKey: subjectId });
	return { state: "blocked", websiteAccess: access, questionUrl: request.questionUrl, requestId: request.id, error: `Website permission is required. Answer ${request.questionUrl}, then explicitly retry this browser operation. No application was restarted or submitted.` };
}
