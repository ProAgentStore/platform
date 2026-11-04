import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { ensureWebsiteAccessRequest, type WebsiteAccessAnswerAdapters } from "../lib/website-access.js";
import { registerWebsiteAccessRoutes } from "./instances-website-access.js";

vi.mock("../lib/auth.js", async () => ({ ...(await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js")), requireUser: async () => ({ uid: "u1", roles: [] }) }));
let db: RealSchemaD1;
let env: Env;
let app: Hono<{ Bindings: Env }>;
let id: string;
let adapters: WebsiteAccessAnswerAdapters;
beforeEach(async () => {
	db = realSchemaD1();
	seedTenant(db, { userId: "u1", instanceIds: ["i1", "i2"] });
	seedTenant(db, { userId: "u2", instanceIds: ["other"] });
	// Only D1 is exercised; verify its fixture contract before supplying the narrower test bindings.
	const bindings: Pick<Env, "DB"> = { DB: db.DB };
	env = bindings as Env;
	adapters = { canAnswer: async () => true, isCurrent: async () => true, resume: vi.fn(async () => ({ resumed: true })) };
	app = new Hono<{ Bindings: Env }>();
	registerWebsiteAccessRoutes(app, () => adapters);
	app.onError((error, c) => error instanceof HttpError ? c.json({ error: error.message }, error.status as 400) : c.json({ error: String(error) }, 500));
	id = (await ensureWebsiteAccessRequest(env, { userId: "u1", instanceId: "i1", subjectKind: "local_apply_run", subjectId: "run-1", hostname: "jobs.example.com", pauseKey: "p1" }, { attention: { notify: async () => undefined } })).id;
});
afterEach(() => db.close());
const call = (path: string, method = "GET", body?: unknown) => app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);

it("GET resolves the question without granting or resuming; cross-instance reads are refused", async () => {
	expect(await (await call(`/i1/website-requests/${id}`)).json()).toMatchObject({ request: { hostname: "jobs.example.com", status: "pending" } });
	expect(await (await call("/i1/website-grants")).json()).toMatchObject({ decisions: [] });
	expect(adapters.resume).not.toHaveBeenCalled();
	expect((await call(`/i2/website-requests/${id}`)).status).toBe(404);
	expect((await call(`/other/website-requests/${id}`)).status).toBe(404);
});

it("POST cannot retarget a linked question and repeated/revoked answers cannot grant again", async () => {
	for (const extra of [{ hostname: "evil.example" }, { subjectId: "new-run" }, { instanceId: "i2" }]) expect((await call(`/i1/website-requests/${id}/answer`, "POST", { decision: "approve", ...extra })).status).toBe(400);
	const path = `/i1/website-requests/${id}/answer`;
	expect(await (await call(path, "POST", { decision: "approve" })).json()).toMatchObject({ recorded: true, resumed: true });
	expect(await (await call("/i1/website-grants")).json()).toEqual({ domains: ["jobs.example.com"], decisions: [{ hostname: "jobs.example.com", decision: "allow" }] });
	expect((await call("/i1/website-grants/jobs.example.com", "DELETE")).status).toBe(200);
	expect(await (await call(path, "POST", { decision: "approve" })).json()).toMatchObject({ resumed: false, repeated: true });
	expect(await (await call("/i1/website-grants")).json()).toMatchObject({ decisions: [] });
	expect(adapters.resume).toHaveBeenCalledTimes(1);
});
