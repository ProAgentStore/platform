/** Durable, owner-scoped recovery requests for a missing per-instance grant (#1009). */
import type { Env } from "../types.js";
import { instancePermissionsLink } from "./console-links.js";
import { stableStringify } from "./stable-json.js";
import type { RegistryToolCtx, ToolDef } from "./connectors/types.js";

export type PermissionRequestStatus = "pending" | "approved" | "claimed" | "denied" | "expired" | "revoked" | "cancelled" | "stale" | "resumed" | "failed" | "uncertain";
export interface PermissionBlocker { requestId: string; controlLink: string; currentScope: string | null; requestedScope: string; reason: string; resource: string | null; operation: string; }
export interface PermissionRequest {
	id: string; instanceId: string; userId: string; control: string; connector: string | null; resourceId: string | null; requestedScope: string; currentScope: string | null;
	operationKind: string; operationFingerprint: string; continuationRef: string; reason: string; status: PermissionRequestStatus; expiresAt: string;
}
export interface CreatePermissionRequest { instanceId: string; userId: string; control: string; connector?: string | null; resourceId?: string | null; requestedScope: string; currentScope?: string | null; operationKind: string; operationFingerprint: string; continuationRef: string; reason: string; expiresAt?: string; }
const activeSql = "status IN ('pending','approved','claimed')";

/**
 * A secret-safe identity for the exact retry payload.  It deliberately covers every argument
 * (including any resource selector) without retaining raw arguments in the permission tables.
 * Stable JSON makes a caller rebuilding the same object in a different key order the same call.
 */
export async function permissionOperationFingerprint(operation: string, args: Record<string, unknown>): Promise<string> {
	const bytes = new TextEncoder().encode(`${operation}:${stableStringify(args)}`);
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A displayable resource only where the connector gives us a non-secret, validated identity. */
export function permissionResourceId(connector: string, args: Record<string, unknown>): string | null {
	if (connector !== "github" || typeof args.repo !== "string") return null;
	const repo=args.repo.trim();
	return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) ? repo : null;
}
const asRequest = (r: Record<string, unknown>): PermissionRequest => ({
	id: String(r.id), instanceId: String(r.instance_id), userId: String(r.user_id), control: String(r.control), connector: r.connector ? String(r.connector) : null, resourceId: r.resource_id ? String(r.resource_id) : null,
	requestedScope: String(r.requested_scope), currentScope: r.current_scope ? String(r.current_scope) : null, operationKind: String(r.operation_kind), operationFingerprint: String(r.operation_fingerprint), continuationRef: String(r.continuation_ref), reason: String(r.reason ?? ""), status: String(r.status) as PermissionRequestStatus, expiresAt: String(r.expires_at),
});
export async function auditPermissionRequest(env: Env, req: Pick<PermissionRequest,"id"|"instanceId"|"userId">, event: string, detail: Record<string, unknown> = {}): Promise<void> {
	await env.DB.prepare("INSERT INTO instance_permission_request_events (id,request_id,instance_id,user_id,event,detail) VALUES (?1,?2,?3,?4,?5,?6)").bind(crypto.randomUUID(),req.id,req.instanceId,req.userId,event,JSON.stringify(detail)).run();
}
export async function getRequest(env: Env, id: string, instanceId: string, userId: string): Promise<PermissionRequest | null> {
	const r = await env.DB.prepare("SELECT * FROM instance_permission_requests WHERE id=?1 AND instance_id=?2 AND user_id=?3").bind(id,instanceId,userId).first<Record<string,unknown>>(); return r ? asRequest(r) : null;
}
export async function listRequests(env: Env, instanceId: string, userId: string): Promise<PermissionRequest[]> {
	const r = await env.DB.prepare("SELECT * FROM instance_permission_requests WHERE instance_id=?1 AND user_id=?2 ORDER BY created_at DESC").bind(instanceId,userId).all<Record<string,unknown>>(); return (r.results ?? []).map(asRequest);
}
export async function createOrReuseRequest(env: Env, x: CreatePermissionRequest): Promise<{request: PermissionRequest; reused: boolean}> {
	const find = () => env.DB.prepare(`SELECT * FROM instance_permission_requests WHERE instance_id=?1 AND user_id=?2 AND control=?3 AND ifnull(connector,'')=ifnull(?4,'') AND ifnull(resource_id,'')=ifnull(?5,'') AND requested_scope=?6 AND operation_fingerprint=?7 AND ${activeSql} LIMIT 1`).bind(x.instanceId,x.userId,x.control,x.connector ?? null,x.resourceId ?? null,x.requestedScope,x.operationFingerprint).first<Record<string,unknown>>();
	const existing = await find(); if (existing) { const request=asRequest(existing); await auditPermissionRequest(env,request,"request.reused"); return {request,reused:true}; }
	const id=crypto.randomUUID(), expires=x.expiresAt ?? new Date(Date.now()+30*60_000).toISOString();
	try { await env.DB.prepare("INSERT INTO instance_permission_requests (id,instance_id,user_id,control,connector,resource_id,requested_scope,current_scope,operation_kind,operation_fingerprint,continuation_ref,reason,expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)").bind(id,x.instanceId,x.userId,x.control,x.connector ?? null,x.resourceId ?? null,x.requestedScope,x.currentScope ?? null,x.operationKind,x.operationFingerprint,x.continuationRef,x.reason,expires).run(); }
	catch { const raced=await find(); if (raced) return {request:asRequest(raced),reused:true}; throw new Error("Permission request could not be created"); }
	const request=(await getRequest(env,id,x.instanceId,x.userId))!; await auditPermissionRequest(env,request,"request.created"); return {request,reused:false};
}
export async function transitionRequest(env: Env, req: PermissionRequest, from: PermissionRequestStatus, to: PermissionRequestStatus, event: string): Promise<boolean> {
	const result=await env.DB.prepare("UPDATE instance_permission_requests SET status=?1, decided_at=CASE WHEN ?1 IN ('approved','denied','cancelled','expired') THEN datetime('now') ELSE decided_at END, resume_claimed_at=CASE WHEN ?1='claimed' THEN datetime('now') ELSE resume_claimed_at END, updated_at=datetime('now') WHERE id=?2 AND instance_id=?3 AND user_id=?4 AND status=?5").bind(to,req.id,req.instanceId,req.userId,from).run();
	if ((result.meta.changes ?? 0)!==1) return false; await auditPermissionRequest(env,req,event); return true;
}
export const denyRequest=(env:Env,req:PermissionRequest)=>transitionRequest(env,req,"pending","denied","request.denied");
/** Cancelling a claimed-but-unconsumed continuation prevents any later dispatch. */
export async function cancelRequest(env: Env, req: PermissionRequest): Promise<boolean> {
	const result=await env.DB.prepare("UPDATE instance_permission_requests SET status='cancelled', decided_at=datetime('now'), updated_at=datetime('now') WHERE id=?1 AND instance_id=?2 AND user_id=?3 AND status IN ('pending','claimed')").bind(req.id,req.instanceId,req.userId).run();
	if ((result.meta.changes ?? 0)!==1) return false; await auditPermissionRequest(env,req,"request.cancelled"); return true;
}
/** Expiry/revocation/staleness are fail-closed terminal outcomes until the continuation is consumed. */
async function invalidateActiveRequest(env: Env, req: PermissionRequest, to: "expired" | "revoked" | "stale", event: string): Promise<boolean> {
	const result=await env.DB.prepare("UPDATE instance_permission_requests SET status=?1, decided_at=datetime('now'), updated_at=datetime('now') WHERE id=?2 AND instance_id=?3 AND user_id=?4 AND status IN ('pending','approved','claimed')").bind(to,req.id,req.instanceId,req.userId).run();
	if ((result.meta.changes ?? 0)!==1) return false; await auditPermissionRequest(env,req,event); return true;
}
export const expireRequest=(env:Env,req:PermissionRequest)=>invalidateActiveRequest(env,req,"expired","request.expired");
/** Called by a consent revocation path or continuation consumer before any dispatch. */
export const revokeRequest=(env:Env,req:PermissionRequest)=>invalidateActiveRequest(env,req,"revoked","grant.revoked");
/** Marks a request whose referenced operation no longer has the identity that was approved. */
export const staleRequest=(env:Env,req:PermissionRequest)=>invalidateActiveRequest(env,req,"stale","continuation.stale");
/** A one-time continuation claim; the owner route verifies the grant before issuing this state. */
export const claimApprovedRequest=(env:Env,req:PermissionRequest)=>transitionRequest(env,req,"approved","claimed","continuation.claimed");
/** Atomically consumes the verified claim before the normal dispatcher sees the retry. */
export const consumeClaimedRequest=(env:Env,req:PermissionRequest)=>transitionRequest(env,req,"claimed","resumed","continuation.dispatch_claimed");
/** A post-claim dispatch result is never replayed: its external effect may be unknowable. */
export const markUncertainRequest=(env:Env,req:PermissionRequest)=>transitionRequest(env,req,"resumed","uncertain","continuation.uncertain");
/** A grant that vanished between the final live read and dispatch is terminal, not retryable. */
export const markRevokedAfterConsume=(env:Env,req:PermissionRequest)=>transitionRequest(env,req,"resumed","revoked","grant.revoked_during_continuation");
export function permissionBlocker(req: PermissionRequest): PermissionBlocker { return {requestId:req.id,controlLink:instancePermissionsLink(req.instanceId,req.id),currentScope:req.currentScope,requestedScope:req.requestedScope,reason:req.reason,resource:req.resourceId,operation:req.operationKind}; }

/**
 * Persist and notify about a missing write grant. Kept out of the central dispatcher so that it
 * remains a policy gate, not another ever-growing notification implementation.
 */
export async function recoverMissingWritePermission(name: string, ctx: RegistryToolCtx, tool: ToolDef, instanceId: string, input: Record<string, unknown>, label: string): Promise<{ name: string; content: string; success: false; blocker?: PermissionBlocker }> {
	if (!ctx.userId || !tool.connector) return { name, content: `Writing via the ${label} connector isn't permitted for this agent.`, success: false };
	const fingerprint = await permissionOperationFingerprint(name, input);
	let created: Awaited<ReturnType<typeof createOrReuseRequest>>;
	try {
		created = await createOrReuseRequest(ctx.env, { instanceId, userId: ctx.userId, control: "connector_consent", connector: tool.connector, resourceId: permissionResourceId(tool.connector,input), requestedScope: "write", currentScope: null, operationKind: name, operationFingerprint: fingerprint, continuationRef: fingerprint, reason: `${name} needs write access for ${label}.` });
	} catch {
		// A recovery-record failure is a refusal, never a fall-through to an external write.
		return { name, content: `Writing via the ${label} connector isn't permitted for this agent. Enable write access for ${label} in the instance's Connections settings, then try again.`, success: false };
	}
	const blocker = permissionBlocker(created.request);
	if (!created.reused) {
		const { requestOwnerAttention } = await import("./owner-attention.js");
		const { notifyUser } = await import("../routes/push.js");
		try {
			let observedPush: "sent" | "muted" | "deduped" | "unavailable" = "unavailable";
			const outcome = await requestOwnerAttention(ctx.env, { event:"approval_required", userId:ctx.userId, instanceId, subject:{kind:"permission-request",instanceId,requestId:created.request.id}, about:{kind:"permission-request",id:created.request.id,state:"pending"}, title:`Permission needed: ${label} write access`, body:`${name} is blocked until you explicitly grant the minimum write scope.`, notificationType:"permission" }, {
				notify: async (env, userId, type, title, body, url, opts) => { observedPush = await notifyUser(env, userId, type, title, body, url, opts); },
				pushed: async () => observedPush,
			});
			await auditPermissionRequest(ctx.env,created.request,"notification.outcome",{outcome:outcome.push});
		} catch {
			await auditPermissionRequest(ctx.env,created.request,"notification.outcome",{outcome:"unavailable"}).catch(() => undefined);
		}
	}
	return { name, content: `Writing via the ${label} connector needs your explicit permission. Open the verified Permissions & Connections control: ${instancePermissionsLink(instanceId, created.request.id)}`, success:false, blocker };
}
