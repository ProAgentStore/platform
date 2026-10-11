/** Owner-only permission recovery request API (#1009). */
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { cancelRequest, denyRequest, getRequest, listRequests, permissionRequestView } from "../lib/instance-permission-requests.js";
import { wipeContinuation } from "../lib/instance-permission-recovery.js";
import { approveAndResume, resumeBlockedOperation } from "../lib/instance-permission-resume.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

const isRecord=(value: unknown): value is Record<string,unknown> => !!value && typeof value==="object" && !Array.isArray(value);

export function registerPermissionRequestRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/permission-requests", async (c) => {
		const session=await requireUser(c); const instanceId=c.req.param("instanceId"); await requireOwnedInstance(c.env,instanceId,session.uid);
		return c.json({ requests: (await listRequests(c.env,instanceId,session.uid)).map(permissionRequestView) });
	});
	router.get("/:instanceId/permission-requests/:requestId", async (c) => {
		const session=await requireUser(c); const instanceId=c.req.param("instanceId"); await requireOwnedInstance(c.env,instanceId,session.uid);
		const request=await getRequest(c.env,c.req.param("requestId"),instanceId,session.uid); if (!request) throw new HttpError(404,"Permission request not found"); return c.json({request: permissionRequestView(request)});
	});
	router.post("/:instanceId/permission-requests/:requestId/deny", async (c) => {
		const session=await requireUser(c); const instanceId=c.req.param("instanceId"); await requireOwnedInstance(c.env,instanceId,session.uid);
		const request=await getRequest(c.env,c.req.param("requestId"),instanceId,session.uid); if (!request) throw new HttpError(404,"Permission request not found");
		if (!(await denyRequest(c.env,request))) throw new HttpError(409,`Permission request is ${request.status}`); await wipeContinuation(c.env,request.id); return c.json({requestId:request.id,status:"denied"});
	});
	router.post("/:instanceId/permission-requests/:requestId/cancel", async (c) => {
		const session=await requireUser(c); const instanceId=c.req.param("instanceId"); await requireOwnedInstance(c.env,instanceId,session.uid);
		const request=await getRequest(c.env,c.req.param("requestId"),instanceId,session.uid); if (!request) throw new HttpError(404,"Permission request not found");
		if (!(await cancelRequest(c.env,request))) throw new HttpError(409,`Permission request is ${request.status}`); await wipeContinuation(c.env,request.id); return c.json({requestId:request.id,status:"cancelled"});
	});
	// Approval is the owner's explicit act at the verified control: it writes ONLY the grant this
	// request names, reads it back, and then resumes the exact blocked operation once (#1009).
	router.post("/:instanceId/permission-requests/:requestId/approve", async (c) => {
		const session=await requireUser(c); const instanceId=c.req.param("instanceId"); await requireOwnedInstance(c.env,instanceId,session.uid);
		const request=await getRequest(c.env,c.req.param("requestId"),instanceId,session.uid); if (!request) throw new HttpError(404,"Permission request not found");
		const body=await c.req.json().catch(()=>({})) as { mode?: unknown };
		const mode=body.mode==="ask" ? "ask" as const : body.mode==="always" ? "always" as const : null;
		const out=await approveAndResume(c.env,request,mode);
		return c.json(out.body,out.status as 200);
	});
	// A resume the platform could not do itself (no kept continuation) — the original caller's exact
	// arguments, re-checked against the approved fingerprint, the live grant and the instance policy.
	router.post("/:instanceId/permission-requests/:requestId/resume", async (c) => {
		const session=await requireUser(c); const instanceId=c.req.param("instanceId"); await requireOwnedInstance(c.env,instanceId,session.uid);
		const body=await c.req.json().catch(()=>null);
		const operation=isRecord(body) && typeof body.operation==="string" ? body.operation : undefined;
		const args=isRecord(body) && isRecord(body.args) ? body.args : null;
		const { httpStatus, ...outcome }=await resumeBlockedOperation(c.env,{requestId:c.req.param("requestId"),instanceId,userId:session.uid,operation,args});
		return c.json({requestId:c.req.param("requestId"),...outcome},httpStatus as 200);
	});
}
