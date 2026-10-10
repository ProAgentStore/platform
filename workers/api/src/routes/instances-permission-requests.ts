/** Owner-only permission recovery request API (#1009). */
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { consentModeFor, setConsent, type ConsentMode } from "../lib/connector-consent.js";
import { auditPermissionRequest, cancelRequest, claimApprovedRequest, consumeClaimedRequest, denyRequest, expireRequest, getRequest, listRequests, markRevokedAfterConsume, markUncertainRequest, permissionOperationFingerprint, revokeRequest, staleRequest, transitionRequest } from "../lib/instance-permission-requests.js";
import { getRegistryTool, runRegistryTool } from "../lib/tool-registry.js";
import { validateAgainstSchema } from "../lib/json-schema-validate.js";
import { explainRefusal, instanceToolPolicy } from "../lib/instance-tool-policy.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

const isRecord=(value: unknown): value is Record<string,unknown> => !!value && typeof value==="object" && !Array.isArray(value);

export function registerPermissionRequestRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/permission-requests", async (c) => {
		const session=await requireUser(c); const instanceId=c.req.param("instanceId"); await requireOwnedInstance(c.env,instanceId,session.uid);
		return c.json({ requests: await listRequests(c.env,instanceId,session.uid) });
	});
	router.get("/:instanceId/permission-requests/:requestId", async (c) => {
		const session=await requireUser(c); const instanceId=c.req.param("instanceId"); await requireOwnedInstance(c.env,instanceId,session.uid);
		const request=await getRequest(c.env,c.req.param("requestId"),instanceId,session.uid); if (!request) throw new HttpError(404,"Permission request not found"); return c.json({request});
	});
	router.post("/:instanceId/permission-requests/:requestId/deny", async (c) => {
		const session=await requireUser(c); const instanceId=c.req.param("instanceId"); await requireOwnedInstance(c.env,instanceId,session.uid);
		const request=await getRequest(c.env,c.req.param("requestId"),instanceId,session.uid); if (!request) throw new HttpError(404,"Permission request not found");
		if (!(await denyRequest(c.env,request))) throw new HttpError(409,`Permission request is ${request.status}`); return c.json({requestId:request.id,status:"denied"});
	});
	router.post("/:instanceId/permission-requests/:requestId/cancel", async (c) => {
		const session=await requireUser(c); const instanceId=c.req.param("instanceId"); await requireOwnedInstance(c.env,instanceId,session.uid);
		const request=await getRequest(c.env,c.req.param("requestId"),instanceId,session.uid); if (!request) throw new HttpError(404,"Permission request not found");
		if (!(await cancelRequest(c.env,request))) throw new HttpError(409,`Permission request is ${request.status}`); return c.json({requestId:request.id,status:"cancelled"});
	});
	router.post("/:instanceId/permission-requests/:requestId/approve", async (c) => {
		const session=await requireUser(c); const instanceId=c.req.param("instanceId"); await requireOwnedInstance(c.env,instanceId,session.uid);
		const request=await getRequest(c.env,c.req.param("requestId"),instanceId,session.uid); if (!request) throw new HttpError(404,"Permission request not found");
		if (request.status!=="pending") throw new HttpError(409,`Permission request is ${request.status}`);
		if (Date.parse(request.expiresAt)<=Date.now()) { await expireRequest(c.env,request); throw new HttpError(409,"Permission request expired"); }
		if (request.control!=="connector_consent" || !request.connector || request.requestedScope!=="write") throw new HttpError(409,"This permission request cannot be approved by this control");
		const body=await c.req.json().catch(()=>({})) as { mode?: unknown };
		const mode: ConsentMode=body.mode==="ask" ? "ask" : body.mode==="always" ? "always" : (()=>{throw new HttpError(400,"Choose the explicit write-access mode: always or ask");})();
		// Claim the owner's decision before writing consent. A duplicate tap observes the CAS failure
		// and cannot perform a second grant write or issue a second continuation token.
		if (!(await transitionRequest(c.env,request,"pending","approved","request.approval_claimed"))) throw new HttpError(409,"Permission request changed before approval");
		// This is the owner's explicit grant action. Nothing creates a grant before this route.
		try { await setConsent(c.env,instanceId,session.uid,request.connector,"write",mode); }
		catch { await staleRequest(c.env,(await getRequest(c.env,request.id,instanceId,session.uid)) ?? request); throw new HttpError(503,"The requested grant could not be saved"); }
		const actual=await consentModeFor(c.env,instanceId,request.connector,"write");
		if (!actual) { await staleRequest(c.env,(await getRequest(c.env,request.id,instanceId,session.uid)) ?? request); await auditPermissionRequest(c.env,request,"grant.verification_failed"); throw new HttpError(409,"The requested grant could not be verified"); }
		const approved=(await getRequest(c.env,request.id,instanceId,session.uid))!;
		if (!(await claimApprovedRequest(c.env,approved))) throw new HttpError(409,"Permission request was already claimed");
		await auditPermissionRequest(c.env,approved,"grant.verified",{scope:"write",mode:actual});
		// This is deliberately not a replay token. The original caller must supply its exact payload
		// to the owner-scoped resume route, which binds it again before the normal dispatcher runs.
		return c.json({requestId:request.id,status:"claimed",resume:{method:"POST",path:`/v1/instances/${instanceId}/permission-requests/${request.id}/resume`},verifiedScope:"write",mode:actual});
	});
	router.post("/:instanceId/permission-requests/:requestId/resume", async (c) => {
		const session=await requireUser(c); const instanceId=c.req.param("instanceId"); const instance=await requireOwnedInstance(c.env,instanceId,session.uid);
		const request=await getRequest(c.env,c.req.param("requestId"),instanceId,session.uid); if (!request) throw new HttpError(404,"Permission request not found");
		if (instance.status!=="active") { await cancelRequest(c.env,request); throw new HttpError(409,"This instance is stopped; its blocked operation will not be resumed"); }
		if (request.status!=="claimed") throw new HttpError(409,`Permission request is ${request.status}`);
		if (!Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt)<=Date.now()) { await expireRequest(c.env,request); throw new HttpError(409,"Permission request expired"); }
		if (request.control!=="connector_consent" || !request.connector || request.requestedScope!=="write") throw new HttpError(409,"This permission request cannot be resumed by this control");
		const body=await c.req.json().catch(()=>null); const operation=isRecord(body) && typeof body.operation==="string" ? body.operation : ""; const args=isRecord(body) && isRecord(body.args) ? body.args : null;
		if (!operation || !args) throw new HttpError(400,"Resume requires the original operation and an object of exact arguments");
		const fingerprint=await permissionOperationFingerprint(operation,args);
		// The digest binds all argument fields, including connector-specific resource selectors,
		// without retaining sensitive raw arguments on the permission record.
		if (operation!==request.operationKind || fingerprint!==request.operationFingerprint || fingerprint!==request.continuationRef) throw new HttpError(409,"Resume arguments do not match the blocked operation");
		const tool=getRegistryTool(operation); if (!tool) { await staleRequest(c.env,request); throw new HttpError(409,"The blocked tool is no longer available"); }
		const invalid=validateAgainstSchema(tool.jsonSchema,args); if (invalid) throw new HttpError(400,invalid);
		const policy=await instanceToolPolicy(c.env,instanceId,session.uid,instance.config); const entry=policy.find((item)=>item.name===operation);
		if (!entry?.allowed) { await staleRequest(c.env,request); throw new HttpError(409,explainRefusal(operation,entry?.reason ?? "not_declared")); }
		const live=await consentModeFor(c.env,instanceId,request.connector,"write");
		if (!live) { await revokeRequest(c.env,request); throw new HttpError(409,"The verified grant is no longer active"); }
		// Claim BEFORE dispatch. A second tap cannot dispatch or create another ask-card, and any
		// post-claim ambiguity is terminal below rather than being silently replayed.
		if (!(await consumeClaimedRequest(c.env,request))) throw new HttpError(409,"Permission request was already consumed");
		try {
			// No preApprovedTicketId: when the owner selected Ask, this re-enters the normal per-call
			// gate and creates a fresh card. Changing a grant never approves an old call.
			const result=await runRegistryTool(operation,{env:c.env,userId:session.uid,instanceId},args);
			if (!result.success) {
				const current=(await getRequest(c.env,request.id,instanceId,session.uid)) ?? request;
				if (result.blocker) await markRevokedAfterConsume(c.env,current); else await markUncertainRequest(c.env,current);
				throw new HttpError(409,"The continuation was not dispatched and cannot be replayed");
			}
			await auditPermissionRequest(c.env,request,live==="ask" ? "continuation.queued_for_call_approval" : "continuation.dispatched",{operation});
			return c.json({requestId:request.id,status:live==="ask" ? "awaiting_call_approval" : "resumed",result});
		} catch (error) {
			if (error instanceof HttpError) throw error;
			await markUncertainRequest(c.env,(await getRequest(c.env,request.id,instanceId,session.uid)) ?? request);
			throw new HttpError(503,"The continuation outcome is uncertain and will not be retried");
		}
	});
}
