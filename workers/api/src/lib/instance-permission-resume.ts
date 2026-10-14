/**
 * The grant, verification, resume and expiry half of the #1009 flow — see the header of
 * lib/instance-permission-recovery.ts for the whole design and what every resume re-checks. Split
 * out because this half needs the tool policy and the registry, and the registry imports the other.
 */
import type { Env } from "../types.js";
import {
	auditPermissionRequest,
	cancelRequest,
	claimApprovedRequest,
	consumeClaimedRequest,
	expireRequest,
	getRequest,
	markRevokedAfterConsume,
	markUncertainRequest,
	type PermissionBlocker,
	type PermissionRequest,
	permissionBlocker,
	permissionOperationFingerprint,
	revokeRequest,
	staleRequest,
	transitionRequest,
} from "./instance-permission-requests.js";
import { openContinuation, wipeContinuation } from "./instance-permission-recovery.js";

// ── Granting and verifying ──────────────────────────────────────────────────

/** Is the grant this request asked for LIVE right now, and does it cover exactly this operation? */
export async function verifyGrant(env: Env, req: PermissionRequest): Promise<{ ok: true; mode?: string } | { ok: false; why: "revoked" | "insufficient" }> {
	const { instanceToolPolicy } = await import("./instance-tool-policy.js");
	const policy = await instanceToolPolicy(env, req.instanceId, req.userId);
	const entry = policy.find((t) => t.name === req.operationKind);
	if (req.control === "connector_consent") {
		const { consentModeFor } = await import("./connector-consent.js");
		const mode = req.connector ? await consentModeFor(env, req.instanceId, req.connector, "write") : null;
		if (!mode) return { ok: false, why: "revoked" };
		// The consent must be for the connector this very tool writes through.
		if (entry?.connector !== req.connector || !entry?.allowed) return { ok: false, why: "insufficient" };
		return { ok: true, mode };
	}
	if (!entry?.allowed) return { ok: false, why: entry?.reason === "disabled_by_owner" ? "revoked" : "insufficient" };
	return { ok: true };
}

/**
 * Write the grant the owner chose — only the one this request names — and read it back. Throws
 * nothing past its caller's audit: a grant that cannot be saved or verified is reported, not assumed.
 */
export async function grantRequested(env: Env, req: PermissionRequest, mode: "always" | "ask" | null): Promise<{ ok: true; mode?: string } | { ok: false; why: string }> {
	if (req.control === "connector_consent") {
		if (!req.connector || req.requestedScope !== "write" || !mode) return { ok: false, why: "Choose the explicit write-access mode: always or ask" };
		const { setConsent } = await import("./connector-consent.js");
		await setConsent(env, req.instanceId, req.userId, req.connector, "write", mode);
	} else if (req.control === "tool_enabled") {
		const { DISABLED_TOOLS_KEY, readDisabledTools } = await import("./instance-tool-policy.js");
		const { patchInstanceConfig } = await import("./instance-config.js");
		const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(req.instanceId, req.userId).first<{ config: string | null }>();
		const disabled = readDisabledTools(row?.config).filter((name) => name !== req.operationKind);
		await patchInstanceConfig(env, req.instanceId, req.userId, DISABLED_TOOLS_KEY, disabled);
	} else {
		return { ok: false, why: "This permission request cannot be approved by this control" };
	}
	const verified = await verifyGrant(env, req);
	return verified.ok ? verified : { ok: false, why: verified.why === "insufficient" ? "The saved grant does not cover the blocked operation" : "The requested grant could not be verified" };
}

/** Approve: claim the decision, write the grant, verify it, then resume the exact operation once. */
export async function approveAndResume(env: Env, req: PermissionRequest, mode: "always" | "ask" | null): Promise<{ status: number; body: Record<string, unknown> }> {
	if (req.status !== "pending") return { status: 409, body: { error: `Permission request is ${req.status}`, request: { id: req.id, status: req.status } } };
	if (Date.parse(req.expiresAt) <= Date.now()) {
		await expireRequest(env, req);
		await wipeContinuation(env, req.id);
		return { status: 409, body: { error: "Permission request expired", request: { id: req.id, status: "expired" } } };
	}
	// A paused or cancelled instance's blocked work is not resumed (see resumeBlockedOperation), so
	// approving here would write a grant for an operation that can no longer run. Decide that BEFORE
	// anything is written: the request ends `cancelled`, nothing is granted, and the owner is told why.
	const instance = await env.DB.prepare("SELECT status FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(req.instanceId, req.userId).first<{ status: string }>();
	if (instance?.status !== "active") {
		const instanceStatus = instance?.status ?? "missing";
		await cancelRequest(env, req);
		await wipeContinuation(env, req.id);
		await auditPermissionRequest(env, req, "request.instance_inactive", { instanceStatus });
		return { status: 409, body: { error: `This instance is ${instanceStatus}, so nothing was granted and its blocked operation will not run. Resume the instance and repeat the action if you still want it.`, request: { id: req.id, status: "cancelled" }, instanceStatus } };
	}
	if (req.control === "connector_consent" && !mode) return { status: 400, body: { error: "Choose the explicit write-access mode: always or ask" } };
	// Claim the owner's decision before writing anything: a duplicate tap fails here, so it can
	// neither write a second grant nor start a second resume.
	if (!(await transitionRequest(env, req, "pending", "approved", "request.approval_claimed"))) return { status: 409, body: { error: "Permission request changed before approval" } };
	const granted = await grantRequested(env, req, mode).catch((): { ok: false; why: string } => ({ ok: false, why: "The requested grant could not be saved" }));
	const current = (await getRequest(env, req.id, req.instanceId, req.userId)) ?? req;
	if (!granted.ok) {
		await staleRequest(env, current);
		await wipeContinuation(env, req.id);
		await auditPermissionRequest(env, req, "grant.verification_failed");
		return { status: 409, body: { error: granted.why } };
	}
	if (!(await claimApprovedRequest(env, current))) return { status: 409, body: { error: "Permission request was already claimed" } };
	await auditPermissionRequest(env, req, "grant.verified", { scope: req.requestedScope, ...(granted.mode ? { mode: granted.mode } : {}) });
	const resumed = await resumeBlockedOperation(env, { requestId: req.id, instanceId: req.instanceId, userId: req.userId });
	// No kept continuation (no key, or over the cap): the grant stands verified and claimed, and the
	// original caller resumes it with its exact arguments through the owner-only resume route.
	const resume = resumed.status === "needs_arguments" ? { status: "claimed", resume: { method: "POST", path: `/v1/instances/${req.instanceId}/permission-requests/${req.id}/resume` } } : {};
	const { httpStatus, ...outcome } = resumed;
	return { status: resumed.status === "needs_arguments" ? 200 : httpStatus, body: { requestId: req.id, verifiedScope: req.requestedScope, ...(granted.mode ? { mode: granted.mode } : {}), ...outcome, ...resume } };
}

// ── Resuming ────────────────────────────────────────────────────────────────

export type ResumeOutcome = {
	httpStatus: number;
	/** `resumed` · `awaiting_call_approval` · `needs_arguments` · `failed` · `uncertain` · `revoked` · `insufficient` · `stale` · `expired` · `refused` */
	status: string;
	detail?: string;
	blocker?: PermissionBlocker;
	result?: { success: boolean; content: string };
};

/**
 * Resume the exact blocked operation once. `args` is the caller's payload when one was sent (it must
 * match the approved fingerprint); otherwise the sealed continuation is used.
 */
export async function resumeBlockedOperation(env: Env, input: { requestId: string; instanceId: string; userId: string; operation?: string; args?: Record<string, unknown> | null }): Promise<ResumeOutcome> {
	const req = await getRequest(env, input.requestId, input.instanceId, input.userId);
	if (!req) return { httpStatus: 404, status: "refused", detail: "Permission request not found" };
	const end = async (status: ResumeOutcome["status"], httpStatus: number, detail: string, extra: Partial<ResumeOutcome> = {}): Promise<ResumeOutcome> => {
		await wipeContinuation(env, req.id);
		return { httpStatus, status, detail, ...extra };
	};
	if (req.status !== "claimed") return { httpStatus: 409, status: "refused", detail: `Permission request is ${req.status}` };
	if (!Number.isFinite(Date.parse(req.expiresAt)) || Date.parse(req.expiresAt) <= Date.now()) {
		await expireRequest(env, req);
		return end("expired", 409, "Permission request expired");
	}
	const instance = await env.DB.prepare("SELECT status, config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(req.instanceId, req.userId).first<{ status: string; config: string | null }>();
	if (instance?.status !== "active") {
		await cancelRequest(env, req);
		return end("cancelled", 409, "This instance is stopped; its blocked operation will not be resumed");
	}
	const origin = await env.DB.prepare("SELECT r.status FROM instance_permission_requests p JOIN agent_loop_runs r ON r.run_id = p.origin_run_id WHERE p.id = ?1").bind(req.id).first<{ status: string }>();
	if (origin && origin.status !== "running") {
		await staleRequest(env, req);
		return end("stale", 409, "The run this operation belonged to has stopped, so it will not be resumed behind your back — start it again if you still want it");
	}
	if (input.operation !== undefined && input.operation !== req.operationKind) return { httpStatus: 409, status: "refused", detail: "Resume arguments do not match the blocked operation" };
	const args = input.args ?? (await openContinuation(env, req).catch(() => null));
	if (!args) return { httpStatus: 409, status: "needs_arguments", detail: "The grant is verified, but this operation's arguments were not kept; its original caller must resume it with them" };
	const fingerprint = await permissionOperationFingerprint(req.operationKind, args);
	if (fingerprint !== req.operationFingerprint || fingerprint !== req.continuationRef) return { httpStatus: 409, status: "refused", detail: "Resume arguments do not match the blocked operation" };
	const { getRegistryTool, runRegistryTool } = await import("./tool-registry.js");
	const { validateAgainstSchema } = await import("./json-schema-validate.js");
	const tool = getRegistryTool(req.operationKind);
	if (!tool) {
		await staleRequest(env, req);
		return end("stale", 409, "The blocked tool is no longer available");
	}
	const invalid = validateAgainstSchema(tool.jsonSchema, args);
	if (invalid) return { httpStatus: 400, status: "refused", detail: invalid };
	const live = await verifyGrant(env, req);
	if (!live.ok) {
		await revokeRequest(env, req);
		return end(live.why, 403, live.why === "revoked" ? "The verified grant is no longer active" : "The current grant does not cover this exact operation", { blocker: permissionBlocker(req) });
	}
	// Consume BEFORE dispatch: a second tap or a concurrent resume loses here and dispatches nothing.
	if (!(await consumeClaimedRequest(env, req))) return { httpStatus: 409, status: "refused", detail: "Permission request was already consumed" };
	await wipeContinuation(env, req.id);
	const consumed = (await getRequest(env, req.id, req.instanceId, req.userId)) ?? req;
	let result: { success: boolean; content: string; blocker?: unknown };
	try {
		// No preApprovedTicketId: an `ask` consent re-enters its own per-call approval. A grant never
		// approves an old call on its own.
		result = await runRegistryTool(req.operationKind, { env, userId: req.userId, instanceId: req.instanceId, turn: { author: "owner", explicit: true } }, args);
	} catch {
		await markUncertainRequest(env, consumed);
		return { httpStatus: 503, status: "uncertain", detail: "The resumed operation's outcome is uncertain and will not be retried" };
	}
	if (!result.success) {
		if (result.blocker) {
			await markRevokedAfterConsume(env, consumed);
			return { httpStatus: 403, status: "revoked", detail: "The grant was withdrawn as the operation started; nothing was run", blocker: permissionBlocker(req) };
		}
		// A call with no possible external effect failed cleanly; one that might have written is uncertain.
		const harmless = tool.mutates === false;
		if (harmless) await transitionRequest(env, consumed, "resumed", "failed", "continuation.failed");
		else await markUncertainRequest(env, consumed);
		return { httpStatus: 409, status: harmless ? "failed" : "uncertain", detail: harmless ? "The resumed operation failed and was not retried" : "The resumed operation reported a failure after it may have written; it will not be retried", result: { success: false, content: result.content } };
	}
	const queued = live.mode === "ask";
	await auditPermissionRequest(env, req, queued ? "continuation.queued_for_call_approval" : "continuation.dispatched", { operation: req.operationKind });
	return { httpStatus: 200, status: queued ? "awaiting_call_approval" : "resumed", result: { success: true, content: result.content } };
}

// ── Expiry ──────────────────────────────────────────────────────────────────

/**
 * Move every still-open request past its expiry to `expired`, with an event and its continuation
 * wiped. Never touches a decided or consumed request. Bounded per tick; the next tick takes the rest.
 */
export async function sweepExpiredPermissionRequests(env: Env, now: number = Date.now()): Promise<number> {
	const { results } = await env.DB.prepare(
		"SELECT id, instance_id, user_id FROM instance_permission_requests WHERE status IN ('pending','approved','claimed') AND expires_at < ?1 ORDER BY expires_at LIMIT 200",
	)
		.bind(new Date(now).toISOString())
		.all<{ id: string; instance_id: string; user_id: string }>();
	let expired = 0;
	for (const r of results ?? []) {
		const req = await getRequest(env, r.id, r.instance_id, r.user_id);
		if (req && (await expireRequest(env, req))) {
			await wipeContinuation(env, req.id);
			expired++;
		}
	}
	return expired;
}
