/**
 * Blocked → asked → explicitly granted → verified → the exact operation resumed ONCE (#1009).
 *
 * `instance-permission-requests.ts` is the store: the request row, its lifecycle transitions and its
 * audit trail. This module is the flow on top of it, for every per-instance control an owner can
 * grant at the moment a call is refused:
 *
 *   connector_consent  write consent for one connector            (`tool.scope === "write"` gate)
 *   tool_enabled       a declared tool the owner switched off     (`disabled_by_owner`)
 *
 * Not here, on purpose: a creator's declaration (`not_declared`) — no owner action grants it — and
 * the Gmail permission (`needs_permission`). Its one tool, `find_confirmation_link`, is not a
 * registry tool and is never offered to the model without the permission, so no call is ever refused
 * for it: there is no blocked operation to resume, and a request for one would be a dead button.
 *
 * ── Why the platform resumes, not the caller
 *
 * The first slice kept only a fingerprint of the blocked call, so the owner-only `/resume` route
 * needed the ORIGINAL caller to send the arguments again — and no caller could: a chat turn has
 * ended by the time a phone buzzes, and MCP is deliberately not allowed to approve or resume. The
 * owner approved, the grant was verified, and the blocked work never ran. The arguments are now kept
 * as an envelope-encrypted continuation (≤64 KiB), and approval resumes the operation itself. The
 * ciphertext is wiped the moment the request is consumed or ends in any terminal state.
 *
 * The grant, verification, resume and expiry half is lib/instance-permission-resume.ts — split so
 * that this half, which `runRegistryTool` imports, reaches neither the tool policy nor the registry
 * (an import cycle the graph guard forbids).
 *
 * ── What a resume re-checks, every time
 *
 * The request is still `claimed` (approved + verified) and unexpired; the instance is active; the
 * run that was blocked, if one was, has not stopped since; the arguments still match the fingerprint
 * the owner approved; the tool still exists, validates and is allowed by the instance's policy; and
 * the grant is LIVE and covers exactly this operation. Only then is the claim consumed — atomically,
 * so a duplicate tap cannot dispatch twice — and the call made through the ordinary dispatcher, which
 * still applies an `ask` consent's independent per-call approval. A failed write is never replayed:
 * a call with no external effect is `failed`, one that may have had one is `uncertain`.
 */
import type { Env } from "../types.js";
import type { RegistryToolCtx, ToolDef } from "./connectors/types.js";
import { decryptKey, encryptKey } from "./crypto.js";
import {
	auditPermissionRequest,
	createOrReuseRequest,
	type PermissionBlocker,
	type PermissionRequest,
	permissionBlocker,
	permissionOperationFingerprint,
	permissionResourceId,
} from "./instance-permission-requests.js";

export type PermissionControl = "connector_consent" | "tool_enabled";

/** The largest continuation kept. A bigger call still gets its request; the resume then needs its caller. */
export const CONTINUATION_MAX_BYTES = 64 * 1024;

// ── The continuation ────────────────────────────────────────────────────────

const fromBlob = (v: unknown): Uint8Array | null => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : Array.isArray(v) ? new Uint8Array(v as number[]) : null);

/** Seal the exact arguments under the platform key, or null (no key, or over the cap): never plaintext. */
async function sealContinuation(env: Env, args: Record<string, unknown>): Promise<{ ciphertext: Uint8Array; dek: Uint8Array; iv: Uint8Array } | null> {
	if (!env.KEY_ENCRYPTION_KEY) return null;
	const json = JSON.stringify(args);
	if (new TextEncoder().encode(json).length > CONTINUATION_MAX_BYTES) return null;
	const sealed = await encryptKey(json, env.KEY_ENCRYPTION_KEY);
	return { ciphertext: sealed.ciphertext, dek: sealed.dekWrapped, iv: sealed.iv };
}

export async function openContinuation(env: Env, req: PermissionRequest): Promise<Record<string, unknown> | null> {
	if (!env.KEY_ENCRYPTION_KEY) return null;
	const row = await env.DB.prepare("SELECT continuation_ciphertext AS c, continuation_dek AS d, continuation_iv AS i FROM instance_permission_requests WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
		.bind(req.id, req.instanceId, req.userId)
		.first<{ c: unknown; d: unknown; i: unknown }>();
	const [c, d, i] = [fromBlob(row?.c), fromBlob(row?.d), fromBlob(row?.i)];
	if (!c || !d || !i) return null;
	const parsed = JSON.parse(await decryptKey(c, d, i, env.KEY_ENCRYPTION_KEY)) as unknown;
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

export async function wipeContinuation(env: Env, requestId: string): Promise<void> {
	await env.DB.prepare("UPDATE instance_permission_requests SET continuation_ciphertext = NULL, continuation_dek = NULL, continuation_iv = NULL WHERE id = ?1").bind(requestId).run();
}

// ── Asking ──────────────────────────────────────────────────────────────────

export interface BlockedOperation {
	instanceId: string;
	userId: string;
	control: PermissionControl;
	/** The connector a consent is for; null for a tool switch or the email permission. */
	connector: string | null;
	/** The least scope that unblocks THIS operation: `write`, `enabled`, `read`. */
	requestedScope: string;
	operation: string;
	args: Record<string, unknown>;
	reason: string;
	/** The push title's subject, e.g. "github write access". */
	label: string;
	/** The run this call belongs to, if any — a resume is refused once that run has stopped. */
	originRunId?: string | null;
}

/** What the model (and an MCP caller) gets back: structured, so no navigation is ever guessed (#517). */
export interface PermissionRecovery {
	content: string;
	blocker: PermissionBlocker;
}

/**
 * Create (or reuse) the owner's request for one blocked operation, keep its sealed continuation, and
 * ask the owner — once per request, again only if the last attempt could not reach them. Never
 * grants anything. A request that cannot be recorded returns null, and the caller refuses as before.
 */
export async function requestPermissionForBlockedOperation(env: Env, op: BlockedOperation): Promise<PermissionRecovery | null> {
	const fingerprint = await permissionOperationFingerprint(op.operation, op.args);
	let created: Awaited<ReturnType<typeof createOrReuseRequest>>;
	try {
		created = await createOrReuseRequest(env, {
			instanceId: op.instanceId,
			userId: op.userId,
			control: op.control,
			connector: op.connector,
			resourceId: op.connector ? permissionResourceId(op.connector, op.args) : null,
			requestedScope: op.requestedScope,
			currentScope: null,
			operationKind: op.operation,
			operationFingerprint: fingerprint,
			continuationRef: fingerprint,
			reason: op.reason,
		});
	} catch {
		return null;
	}
	const request = created.request;
	if (!created.reused) {
		const sealed = await sealContinuation(env, op.args).catch(() => null);
		await env.DB.prepare("UPDATE instance_permission_requests SET continuation_ciphertext = ?2, continuation_dek = ?3, continuation_iv = ?4, origin_run_id = ?5 WHERE id = ?1")
			.bind(request.id, sealed?.ciphertext ?? null, sealed?.dek ?? null, sealed?.iv ?? null, op.originRunId ?? null)
			.run()
			.catch(() => undefined);
		await auditPermissionRequest(env, request, "continuation.sealed", { stored: !!sealed });
	}
	// Ask on a new request, and again on a reused one whose last ask reached nobody (an offline
	// device, no subscription) — the reconnect case. A delivered ask is never repeated: a second
	// failure of the same call must not buzz the owner twice.
	if (!created.reused || (await lastNotificationOutcome(env, request.id)) === "unavailable") await notifyOwner(env, request, op);
	const blocker = permissionBlocker(request);
	return { content: `${op.operation} is blocked until you ${remedyFor(op.control, op.label)}. Open the verified control: ${blocker.controlLink}`, blocker };
}

function remedyFor(control: PermissionControl, label: string): string {
	return control === "tool_enabled" ? `switch ${label} back on for this instance` : `grant ${label} for this instance`;
}

async function lastNotificationOutcome(env: Env, requestId: string): Promise<string | null> {
	const row = await env.DB.prepare("SELECT detail FROM instance_permission_request_events WHERE request_id = ?1 AND event = 'notification.outcome' ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(requestId).first<{ detail: string }>();
	return row ? ((JSON.parse(row.detail) as { outcome?: string }).outcome ?? null) : null;
}

async function notifyOwner(env: Env, request: PermissionRequest, op: BlockedOperation): Promise<void> {
	try {
		const { requestOwnerAttention } = await import("./owner-attention.js");
		const { notifyUser } = await import("../routes/push.js");
		let observedPush: "sent" | "muted" | "deduped" | "unavailable" = "unavailable";
		const outcome = await requestOwnerAttention(
			env,
			{
				event: "approval_required",
				userId: op.userId,
				instanceId: op.instanceId,
				subject: { kind: "permission-request", instanceId: op.instanceId, requestId: request.id },
				about: { kind: "permission-request", id: request.id, state: "pending" },
				title: `Permission needed: ${op.label}`,
				body: `${op.operation} is blocked until you explicitly ${remedyFor(op.control, op.label)}.`,
				notificationType: "permission",
			},
			{
				notify: async (e, userId, type, title, body, url, opts) => {
					observedPush = await notifyUser(e, userId, type, title, body, url, opts);
				},
				pushed: async () => observedPush,
			},
		);
		await auditPermissionRequest(env, request, "notification.outcome", { outcome: outcome.push });
	} catch {
		await auditPermissionRequest(env, request, "notification.outcome", { outcome: "unavailable" }).catch(() => undefined);
	}
}

/** The missing-write-consent path of `runRegistryTool`, through the shared ask. */
export async function recoverMissingWritePermission(name: string, ctx: RegistryToolCtx, tool: ToolDef, instanceId: string, input: Record<string, unknown>, label: string): Promise<{ name: string; content: string; success: false; blocker?: PermissionBlocker }> {
	const refused = `Writing via the ${label} connector isn't permitted for this agent. Enable write access for ${label} in the instance's Connections settings, then try again.`;
	if (!ctx.userId || !tool.connector) return { name, content: refused, success: false };
	const asked = await requestPermissionForBlockedOperation(ctx.env, {
		instanceId,
		userId: ctx.userId,
		control: "connector_consent",
		connector: tool.connector,
		requestedScope: "write",
		operation: name,
		args: input,
		reason: `${name} needs write access for ${label}.`,
		label: `${label} write access`,
		originRunId: ctx.traceId ?? null,
	});
	// A recovery-record failure is a refusal, never a fall-through to an external write.
	return asked ? { name, content: asked.content, success: false, blocker: asked.blocker } : { name, content: refused, success: false };
}

/**
 * A policy refusal an OWNER can lift — a declared tool they switched off — becomes a request through
 * the same ask. Anything else returns null: `not_declared` is the creator's to grant, never the
 * owner's, and a button for it could never work.
 */
export async function recoverPolicyRefusal(env: Env, x: { instanceId: string; userId: string; operation: string; reason: string; args: Record<string, unknown> }): Promise<PermissionRecovery | null> {
	if (x.reason === "disabled_by_owner") {
		return requestPermissionForBlockedOperation(env, { instanceId: x.instanceId, userId: x.userId, control: "tool_enabled", connector: null, requestedScope: "enabled", operation: x.operation, args: x.args, reason: `${x.operation} is switched off for this instance.`, label: x.operation });
	}
	return null;
}
