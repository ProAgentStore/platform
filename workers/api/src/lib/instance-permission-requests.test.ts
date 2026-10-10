import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { cancelRequest, claimApprovedRequest, consumeClaimedRequest, createOrReuseRequest, denyRequest, expireRequest, getRequest, markUncertainRequest, permissionBlocker, permissionOperationFingerprint, permissionResourceId, revokeRequest, staleRequest, transitionRequest } from "./instance-permission-requests.js";
import { requestOwnerAttention } from "./owner-attention.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
beforeEach(() => { d1=realSchemaD1(); d1.exec("INSERT INTO users (id,github_login) VALUES ('u1','u1'),('u2','u2'); INSERT INTO agents (id,owner_id,slug,name,config) VALUES ('a1','u1','a1','A','{}'); INSERT INTO agent_instances (id,agent_id,user_id,status,config) VALUES ('i1','a1','u1','active','{}'),('other','a1','u2','active','{}')"); });
afterEach(()=>d1.close());
const env=()=>({DB:d1.DB} as unknown as Env);
const input=()=>({instanceId:"i1",userId:"u1",control:"connector_consent",connector:"github",requestedScope:"write",operationKind:"github_create_issue",operationFingerprint:"op-1",continuationRef:"opaque-1",reason:"needs GitHub write"});

describe("instance permission requests (#1009)", () => {
	it("deduplicates the exact active owner/instance operation and never crosses owners", async () => {
		const first=await createOrReuseRequest(env(),input()); const duplicate=await createOrReuseRequest(env(),input());
		expect(duplicate).toMatchObject({reused:true,request:{id:first.request.id}});
		expect(await getRequest(env(),first.request.id,"other","u2")).toBeNull();
	});
	it("denial is terminal and an approval continuation can be claimed once", async () => {
		const {request}=await createOrReuseRequest(env(),input()); expect(await denyRequest(env(),request)).toBe(true); expect(await denyRequest(env(),request)).toBe(false);
		const second=await createOrReuseRequest(env(),{...input(),operationFingerprint:"op-2"});
		expect(await transitionRequest(env(),second.request,"pending","approved","request.approved")).toBe(true);
		const approved=(await getRequest(env(),second.request.id,"i1","u1"))!;
		expect(await claimApprovedRequest(env(),approved)).toBe(true); expect(await claimApprovedRequest(env(),approved)).toBe(false);
	});
	it("canonicalizes the exact operation identity and consumes a verified claim only once", async () => {
		expect(await permissionOperationFingerprint("github_create_issue",{repo:"o/r",title:"one"})).toBe(await permissionOperationFingerprint("github_create_issue",{title:"one",repo:"o/r"}));
		expect(await permissionOperationFingerprint("github_create_issue",{repo:"o/r",title:"one"})).not.toBe(await permissionOperationFingerprint("github_create_issue",{repo:"o/r",title:"two"}));
		const {request}=await createOrReuseRequest(env(),{...input(),operationFingerprint:"op-consume"}); await transitionRequest(env(),request,"pending","approved","request.approved");
		const approved=(await getRequest(env(),request.id,"i1","u1"))!; await claimApprovedRequest(env(),approved);
		const claimed=(await getRequest(env(),request.id,"i1","u1"))!; expect(await consumeClaimedRequest(env(),claimed)).toBe(true); expect(await consumeClaimedRequest(env(),claimed)).toBe(false);
		expect(await markUncertainRequest(env(),(await getRequest(env(),request.id,"i1","u1"))!)).toBe(true);
	});
	it("shows only a validated non-secret GitHub repository as the affected resource", () => {
		expect(permissionResourceId("github",{repo:"owner/repo"})).toBe("owner/repo");
		expect(permissionResourceId("github",{repo:"https://token@example.test/x"})).toBeNull();
		expect(permissionResourceId("github",{repo:"owner/repo",body:"a secret-looking message"})).toBe("owner/repo");
		expect(permissionResourceId("gmail",{to:"person@example.test"})).toBeNull();
	});
	it("preserves the affected resource in the owner-facing blocker without persisting arguments", async () => {
		const request=(await createOrReuseRequest(env(),{...input(),operationFingerprint:"resource-op",resourceId:"owner/repo"})).request;
		expect(permissionBlocker(request)).toMatchObject({resource:"owner/repo",operation:"github_create_issue"});
	});
	it("cancels, expires, revokes, and stales active requests without ever reopening them", async () => {
		const cancelled=await createOrReuseRequest(env(),input()); expect(await cancelRequest(env(),cancelled.request)).toBe(true); expect(await cancelRequest(env(),cancelled.request)).toBe(false);
		const expired=await createOrReuseRequest(env(),{...input(),operationFingerprint:"op-expired"}); expect(await expireRequest(env(),expired.request)).toBe(true);
		const approved=await createOrReuseRequest(env(),{...input(),operationFingerprint:"op-revoked"}); expect(await transitionRequest(env(),approved.request,"pending","approved","request.approved")).toBe(true);
		expect(await revokeRequest(env(),(await getRequest(env(),approved.request.id,"i1","u1"))!)).toBe(true);
		const claimed=await createOrReuseRequest(env(),{...input(),operationFingerprint:"op-cancelled-claim"}); await transitionRequest(env(),claimed.request,"pending","approved","request.approved"); await claimApprovedRequest(env(),(await getRequest(env(),claimed.request.id,"i1","u1"))!); expect(await cancelRequest(env(),(await getRequest(env(),claimed.request.id,"i1","u1"))!)).toBe(true);
		const stale=await createOrReuseRequest(env(),{...input(),operationFingerprint:"op-stale"}); expect(await staleRequest(env(),stale.request)).toBe(true);
		for (const [request,status] of [[cancelled.request,"cancelled"],[expired.request,"expired"],[approved.request,"revoked"],[claimed.request,"cancelled"],[stale.request,"stale"]] as const) {
			expect((await getRequest(env(),request.id,"i1","u1"))?.status).toBe(status);
		}
	});

	it("uses the typed deep link and records an honest offline attention outcome without a real push", async () => {
		const request=(await createOrReuseRequest(env(),input())).request; const calls: unknown[][]=[];
		const outcome=await requestOwnerAttention({}, { event:"approval_required", userId:"u1", instanceId:"i1", subject:{kind:"permission-request",instanceId:"i1",requestId:request.id}, about:{kind:"permission-request",id:request.id,state:"pending"}, title:"Permission needed", body:"A tool is blocked", notificationType:"permission" }, {
			notify: async (...args) => { calls.push(args); }, pushed: async () => "unavailable",
		});
		expect(calls).toHaveLength(1); expect(outcome).toMatchObject({recorded:true,push:"unavailable",url:`/console/instances/i1/settings?focus=permissions&permission_request=${request.id}`});
	});
});
