/** Durable, owner-scoped recovery requests for a missing per-instance grant (#1009). */
import type { Env } from "../types.js";
import { instancePermissionsLink } from "./console-links.js";

export type PermissionRequestStatus = "pending" | "approved" | "claimed" | "denied" | "expired" | "revoked" | "cancelled" | "stale" | "resumed" | "failed" | "uncertain";
export interface PermissionBlocker { requestId: string; controlLink: string; currentScope: string | null; requestedScope: string; reason: string; resource: string | null; operation: string; }
export interface PermissionRequest {
	id: string; instanceId: string; userId: string; control: string; connector: string | null; resourceId: string | null; requestedScope: string; currentScope: string | null;
	operationKind: string; operationFingerprint: string; continuationRef: string; reason: string; status: PermissionRequestStatus; expiresAt: string;
}
export interface CreatePermissionRequest { instanceId: string; userId: string; control: string; connector?: string | null; resourceId?: string | null; requestedScope: string; currentScope?: string | null; operationKind: string; operationFingerprint: string; continuationRef: string; reason: string; expiresAt?: string; }
const activeSql = "status IN ('pending','approved','claimed')";
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
/** A request may be withdrawn while it has not yielded a continuation token. */
export const cancelRequest=(env:Env,req:PermissionRequest)=>transitionRequest(env,req,"pending","cancelled","request.cancelled");
/** Expiry/revocation/staleness are fail-closed terminal outcomes.  They deliberately never touch a claimed request. */
async function invalidateActiveRequest(env: Env, req: PermissionRequest, to: "expired" | "revoked" | "stale", event: string): Promise<boolean> {
	const result=await env.DB.prepare("UPDATE instance_permission_requests SET status=?1, decided_at=datetime('now'), updated_at=datetime('now') WHERE id=?2 AND instance_id=?3 AND user_id=?4 AND status IN ('pending','approved')").bind(to,req.id,req.instanceId,req.userId).run();
	if ((result.meta.changes ?? 0)!==1) return false; await auditPermissionRequest(env,req,event); return true;
}
export const expireRequest=(env:Env,req:PermissionRequest)=>invalidateActiveRequest(env,req,"expired","request.expired");
/** Called by a consent revocation path or continuation consumer before any dispatch. */
export const revokeRequest=(env:Env,req:PermissionRequest)=>invalidateActiveRequest(env,req,"revoked","grant.revoked");
/** Marks a request whose referenced operation no longer has the identity that was approved. */
export const staleRequest=(env:Env,req:PermissionRequest)=>invalidateActiveRequest(env,req,"stale","continuation.stale");
/** A one-time continuation claim: it never dispatches or bypasses a live consent check. */
export const claimApprovedRequest=(env:Env,req:PermissionRequest)=>transitionRequest(env,req,"approved","claimed","continuation.claimed");
export function permissionBlocker(req: PermissionRequest): PermissionBlocker { return {requestId:req.id,controlLink:instancePermissionsLink(req.instanceId,req.id),currentScope:req.currentScope,requestedScope:req.requestedScope,reason:req.reason,resource:req.resourceId,operation:req.operationKind}; }
