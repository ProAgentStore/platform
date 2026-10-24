/** #1336 over HTTP: the owner lists a quarantine, releases it with a reason, and cannot touch another owner's. */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

let uid = "u1";
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid, roles: [] }) };
});
const { instanceRoutes } = await import("./instances.js");
const { recordIssueAttempt } = await import("../lib/issue-attempts.js");

let d1: RealSchemaD1;
beforeEach(async () => {
	uid = "u1";
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["other"] });
	const env = { DB: d1.DB } as unknown as Env;
	for (let n = 1; n <= 5; n++) await recordIssueAttempt(env, { userId: "u1", instanceId: "coder", githubRepo: "acme/app", issue: 7, attemptKey: `run:${n}`, kind: "run_unsuccessful", reason: "failed" });
});
afterEach(() => d1.close());

// biome-ignore lint/suspicious/noExplicitAny: responses are read field by field
type Body = Record<string, any>;
const call = async (method: string, path: string, body?: unknown) => {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/instances", instanceRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await a.request(`/v1/instances/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, { DB: d1.DB } as unknown as Env);
	return { status: res.status, json: (await res.json()) as Body };
};

describe("issue quarantines over HTTP (#1336)", () => {
	it("lists the stop with its count and threshold", async () => {
		const r = await call("GET", "coder/issue-quarantines");
		expect(r.status).toBe(200);
		expect(r.json.quarantines).toEqual([expect.objectContaining({ githubRepo: "acme/app", issue: 7, state: "quarantined", attemptCount: 5, threshold: 5 })]);
	});
	it("a release needs a valid body and a reason, then lifts it once; a repeat is a 404", async () => {
		expect((await call("POST", "coder/issue-quarantines/release", { repo: "nope", issue: 7, reason: "x" })).status).toBe(400);
		expect((await call("POST", "coder/issue-quarantines/release", { repo: "acme/app", issue: 7 })).status).toBe(400);
		expect((await call("POST", "coder/issue-quarantines/release", { repo: "acme/app", issue: 7, reason: "fixed it" })).json).toMatchObject({ released: true });
		expect((await call("GET", "coder/issue-quarantines")).json.quarantines).toEqual([]);
		expect((await call("POST", "coder/issue-quarantines/release", { repo: "acme/app", issue: 7, reason: "again" })).status).toBe(404);
	});
	it("another owner sees none of it and cannot release it", async () => {
		uid = "u2";
		expect((await call("GET", "other/issue-quarantines")).json.quarantines).toEqual([]);
		expect((await call("POST", "other/issue-quarantines/release", { repo: "acme/app", issue: 7, reason: "mine now" })).status).toBe(404);
		expect((await call("GET", "coder/issue-quarantines")).status).toBe(404); // not their instance
		uid = "u1";
		expect((await call("GET", "coder/issue-quarantines")).json.quarantines).toHaveLength(1);
	});
});
