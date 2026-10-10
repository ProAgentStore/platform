/** Owner-only permission recovery request API (#1009). */
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { consentModeFor, setConsent, type ConsentMode } from "../lib/connector-consent.js";
import { auditPermissionRequest, cancelRequest, claimApprovedRequest, denyRequest, expireRequest, getRequest, listRequests, staleRequest, transitionRequest } from "../lib/instance-permission-requests.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

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
		// The claim is the one-time, durable continuation token. A caller must still re-check live
		// consent before dispatching, so this endpoint cannot replay an uncertain external write.
		return c.json({requestId:request.id,status:"claimed",resumeToken:request.id,verifiedScope:"write",mode:actual});
	});
}
