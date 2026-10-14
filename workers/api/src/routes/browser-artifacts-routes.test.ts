/**
 * The replay screenshot routes (#1063): owner-only at every level — the instance, the run the frame
 * belongs to, and the artifact row — and never cached. Real schema, real routes; only the signed-in user
 * is faked, and R2 is in memory.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { putBrowserArtifact } from "../lib/browser-artifacts.js";
import type { Env } from "../types.js";

const who = vi.hoisted(() => ({ uid: "u1" }));
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: who.uid, roles: [] }) };
});
const { registerBrowserArtifactRoutes } = await import("./instances-browser-artifacts.js");

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
let d1: RealSchemaD1;
const objects = new Map<string, Uint8Array>();
const env = () => ({ DB: d1.DB, STORAGE: { put: async (k: string, v: Uint8Array) => void objects.set(k, v), get: async (k: string) => (objects.has(k) ? { body: objects.get(k) } : null), delete: async (k: string) => void objects.delete(k) } }) as unknown as Env;

async function call(path: string, uid = "u1") {
	who.uid = uid;
	const router = new Hono<{ Bindings: Env }>();
	registerBrowserArtifactRoutes(router);
	const app = new Hono<{ Bindings: Env }>().route("/v1/instances", router);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return app.request(`/v1/instances${path}`, {}, env());
}

let artifactId: string;
beforeEach(async () => {
	objects.clear();
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('a1', 'u1', 't1063', 'Scout')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'a1', 'u1', 'active', '{}'), ('i1b', 'a1', 'u1', 'active', '{}'), ('i2', 'a1', 'u2', 'active', '{}')`);
	const now = Date.now();
	d1.exec(`INSERT INTO local_browser_runs (id, instance_id, user_id, request_id, objective, status, policy, created_at, updated_at) VALUES
	  ('run-1', 'i1', 'u1', 'r1', 'find jobs', 'completed', '{}', ${now}, ${now}),
	  ('run-x', 'i2', 'u2', 'r2', 'their jobs', 'completed', '{}', ${now}, ${now})`);
	const out = await putBrowserArtifact(env(), { userId: "u1", instanceId: "i1", subjectKind: "local_browser_run", subjectId: "run-1", seq: 1, bytes: JPEG, metadata: { point: "navigated", url: "https://au.seek.com/job/1" } });
	artifactId = out.stored ? out.artifact.id : "";
	await putBrowserArtifact(env(), { userId: "u2", instanceId: "i2", subjectKind: "local_browser_run", subjectId: "run-x", seq: 1, bytes: JPEG, metadata: { point: "navigated" } });
});
afterEach(() => d1.close());

const LIST = "/i1/browser-artifacts?subject_kind=local_browser_run&subject_id=run-1";

describe("the owner reads their run's replay", () => {
	it("lists the run's frames — metadata only, no key, no-store", async () => {
		const res = await call(LIST);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = (await res.json()) as { artifacts: Array<Record<string, unknown>> };
		expect(body.artifacts).toEqual([expect.objectContaining({ id: artifactId, seq: 1, point: "navigated", domain: "au.seek.com" })]);
		expect(JSON.stringify(body)).not.toMatch(/browser-artifacts\/u1|r2Key|r2_key/);
	});

	it("serves the bytes, no-store and nosniff", async () => {
		const res = await call(`/i1/browser-artifacts/${artifactId}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/jpeg");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
	});
});

describe("anyone else gets a 404 — never another owner's pixels", () => {
	it("another user, on this instance", async () => {
		expect((await call(LIST, "u2")).status).toBe(404);
		expect((await call(`/i1/browser-artifacts/${artifactId}`, "u2")).status).toBe(404);
	});

	it("the owner, asking for another owner's run or frame through their own instance", async () => {
		expect((await call("/i1/browser-artifacts?subject_kind=local_browser_run&subject_id=run-x")).status).toBe(404);
		const theirs = d1.sqlite.prepare("SELECT id FROM browser_run_artifacts WHERE user_id = 'u2'").get() as { id: string };
		expect((await call(`/i1/browser-artifacts/${theirs.id}`)).status).toBe(404);
		expect((await call(`/i2/browser-artifacts/${theirs.id}`)).status).toBe(404);
	});

	it("the owner, through ANOTHER of their instances — the run belongs to i1, not i1b", async () => {
		expect((await call("/i1b/browser-artifacts?subject_kind=local_browser_run&subject_id=run-1")).status).toBe(404);
		expect((await call(`/i1b/browser-artifacts/${artifactId}`)).status).toBe(404);
	});

	it("a frame whose run row is gone is not served", async () => {
		d1.exec("DELETE FROM local_browser_runs WHERE id = 'run-1'");
		expect((await call(`/i1/browser-artifacts/${artifactId}`)).status).toBe(404);
	});

	it("an unknown subject kind or a missing run id is refused", async () => {
		expect((await call("/i1/browser-artifacts?subject_kind=desktop&subject_id=run-1")).status).toBe(400);
		expect((await call("/i1/browser-artifacts?subject_kind=local_browser_run")).status).toBe(400);
	});
});
