/** Owner approval is a one-time, re-verified boundary — never an automatic external replay (#1009). */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { createOrReuseRequest, getRequest } from "../lib/instance-permission-requests.js";
import type { Env } from "../types.js";

const viewer = vi.hoisted(() => ({ uid: "u1" }));
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: viewer.uid, roles: [] }) };
});
const { registerPermissionRequestRoutes } = await import("./instances-permission-requests.js");

let d1: RealSchemaD1;
beforeEach(() => {
	viewer.uid = "u1"; d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id,github_login) VALUES ('u1','u1'),('u2','u2'); INSERT INTO agents (id,owner_id,slug,name,config) VALUES ('a1','u1','a1','A','{}'); INSERT INTO agent_instances (id,agent_id,user_id,status,config) VALUES ('i1','a1','u1','active','{}'),('other','a1','u2','active','{}')");
});
afterEach(() => d1.close());

const env = () => ({ DB: d1.DB } as unknown as Env);
async function create(expiresAt?: string) {
	return (await createOrReuseRequest(env(), { instanceId:"i1", userId:"u1", control:"connector_consent", connector:"github", requestedScope:"write", operationKind:"github_create_issue", operationFingerprint:crypto.randomUUID(), continuationRef:"opaque", reason:"GitHub write is blocked", expiresAt })).request;
}
async function call(requestId: string, suffix: "approve" | "deny" | "cancel", body?: unknown) {
	const app = new Hono<{ Bindings: Env }>(); const routes = new Hono<{ Bindings: Env }>(); registerPermissionRequestRoutes(routes); app.route("/v1/instances", routes);
	app.onError((e,c) => e instanceof HttpError ? c.json({error:e.message},e.status as 400) : c.json({error:String(e)},500));
	const init: RequestInit = { method:"POST", headers:{"content-type":"application/json"} }; if (body !== undefined) init.body=JSON.stringify(body);
	const response = await app.request(`/v1/instances/i1/permission-requests/${requestId}/${suffix}`,init,env()); return { status:response.status, body:await response.json() as Record<string,unknown> };
}

describe("instance permission request routes (#1009)", () => {
	it("approves one explicit grant, verifies it, and returns exactly one non-replay continuation claim", async () => {
		const request=await create(); const first=await call(request.id,"approve",{mode:"ask"}); const second=await call(request.id,"approve",{mode:"ask"});
		expect(first).toMatchObject({status:200,body:{requestId:request.id,status:"claimed",resumeToken:request.id,verifiedScope:"write",mode:"ask"}});
		expect(second.status).toBe(409);
		expect((await getRequest(env(),request.id,"i1","u1"))?.status).toBe("claimed");
		expect((await d1.DB.prepare("SELECT mode FROM instance_connector_consent WHERE instance_id='i1' AND connector='github' AND scope='write'").first<{mode:string}>())?.mode).toBe("ask");
	});

	it("makes denial, cancellation and expiry terminal before any grant is written", async () => {
		const denied=await create(); expect((await call(denied.id,"deny")).status).toBe(200); expect((await call(denied.id,"approve",{mode:"always"})).status).toBe(409);
		const cancelled=await create(); expect((await call(cancelled.id,"cancel")).status).toBe(200); expect((await call(cancelled.id,"approve",{mode:"always"})).status).toBe(409);
		const expired=await create("1970-01-01T00:00:00.000Z"); expect((await call(expired.id,"approve",{mode:"always"})).status).toBe(409);
		for (const [id,status] of [[denied.id,"denied"],[cancelled.id,"cancelled"],[expired.id,"expired"]] as const) expect((await getRequest(env(),id,"i1","u1"))?.status).toBe(status);
	});

	it("does not reveal or decide another owner's request", async () => {
		const request=await create(); viewer.uid="u2";
		expect((await call(request.id,"approve",{mode:"always"})).status).toBe(404);
		expect((await getRequest(env(),request.id,"i1","u2"))).toBeNull();
	});
});
