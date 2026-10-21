// The push for a held account change (#1268). One function so the wording — and what it must never contain — is in one place.
//
// The body is the redacted diff summary (secret-looking keys masked, long values marked when cut), and the link is the
// Preferences page that shows the exact change: the push asks the owner to look, it does not carry an approve button that
// could be tapped without reading.
import type { Env } from "../types.js";
import type { ChangeRequest } from "./account-change-requests.js";
import { recordEvent } from "./account-change-requests.js";
import { deepLinkFor } from "./console-links.js";
import type { DiffPreview } from "./approval-gate.js";

export const ACCOUNT_APPROVAL_NOTIFICATION = "account_approval";

export function approvalPushText(req: Pick<ChangeRequest, "targetDescription">, preview: Pick<DiffPreview, "label" | "summary">): { title: string; body: string } {
	return {
		title: `Approve: ${preview.label}`,
		body: `${req.targetDescription}. Nothing has changed yet. Open to review the exact change and approve or deny it.\n${preview.summary}`,
	};
}

export type PushOutcome = "sent" | "muted" | "deduped" | "unavailable";

/** Never throws: a change that is held and cannot be announced is still held — the owner finds it in Preferences. */
export async function notifyApprovalRequested(env: Env, req: ChangeRequest, preview: DiffPreview): Promise<PushOutcome> {
	let outcome: PushOutcome = "unavailable";
	try {
		const { notifyUser } = await import("../routes/push.js");
		const text = approvalPushText(req, preview);
		outcome = await notifyUser(env, req.userId, ACCOUNT_APPROVAL_NOTIFICATION, text.title, text.body, deepLinkFor({ kind: "account-approval", requestId: req.id }), { kind: "alert", key: `account-approval:${req.id}`, event: "approval_required" });
	} catch {
		outcome = "unavailable";
	}
	await recordEvent(env, req, "notification.outcome", "system", { outcome }).catch(() => undefined);
	return outcome;
}
