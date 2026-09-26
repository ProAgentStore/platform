/**
 * A binary upload over HTTP, end to end (#762, #756).
 *
 * `upload_agent_file` over MCP and the Gmail downloader do not use the upload_file tool: they POST
 * `contentBase64` to the file route, which proxies to the agent's DO. #762 capped and typed the TOOL
 * only. These drive the real route → ownership gate → DO handler → engine → a byte-faithful R2, then
 * download through the real route, and compare SHA-256 digests: what went up is what comes back.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import * as doRoutes from "../agent-do-storage-routes.js";
import type { AgentStorageEngine } from "../agent-storage.js";
import { HttpError } from "../lib/auth.js";
import { byteEngine, byteR2 } from "../lib/byte-storage-double.js";
import { signSession } from "../lib/session.js";
import { instanceStorageRoutes, storageRoutes } from "./storage.js";
import type { Env } from "../types.js";

const SECRET = "storage-upload-secret";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** A ZIP header followed by every byte value — base64 of this carries `+`, `/` and padding. */
const BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...Array.from({ length: 256 }, (_, i) => i), 0xfb, 0xff]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const sha256 = async (bytes: ArrayBuffer | Uint8Array) => Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");

function setup() {
	const r2 = byteR2();
	const engines = new Map<string, AgentStorageEngine>();
	const doHits: string[] = [];
	const engineFor = (name: string) => {
		if (!engines.has(name)) engines.set(name, byteEngine(name, r2).engine);
		return engines.get(name)!;
	};
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB: {
			prepare: (sql: string) => ({
				bind: (...args: unknown[]) => ({
					first: async () => {
						if (sql.includes("FROM agents")) return [{ id: "agent-a", owner_id: "u1" }].find((a) => a.id === args[0]) ?? null;
						if (sql.includes("FROM agent_instances")) return args[0] === "inst-1" && args[1] === "u1" ? { id: "inst-1" } : null;
						return null;
					},
				}),
			}),
		},
		// The DO's own file routing (agent-do.ts), over a real engine per DO name.
		AGENT: {
			idFromName: (name: string) => ({ name }),
			get: (id: { name: string }) => ({
				fetch: async (req: Request) => {
					const path = new URL(req.url).pathname;
					doHits.push(`${req.method} ${id.name}${path}`);
					const e = engineFor(id.name);
					if (path === "/files" && req.method === "POST") return doRoutes.uploadFile(e, req);
					if (path === "/files" && req.method === "GET") return doRoutes.listFiles(e, new URL(req.url));
					if (path.startsWith("/files/") && req.method === "GET") return doRoutes.getFile(e, path.slice("/files/".length));
					return new Response("unrouted", { status: 500 });
				},
			}),
		},
	} as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/agents", storageRoutes);
	app.route("/v1/instances", instanceStorageRoutes);
	app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: String(err) }, 500)));
	const request = async (method: string, path: string, uid: string, body?: unknown) =>
		app.request(path, { method, headers: { Authorization: `Bearer ${await signSession(uid, SECRET, { roles: [] })}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);
	return { request, r2, doHits };
}

describe("POST /files with contentBase64 — the MCP and connector path (#762)", () => {
	it.each([
		["instance", "/v1/instances/inst-1/files"],
		["agent", "/v1/agents/agent-a/files"],
	])("%s route: bytes go up and come back down identical, typed by name", async (_, base) => {
		const { request } = setup();
		const up = await request("POST", base, "u1", { name: "Club Championships.docx", contentBase64: b64(BYTES) });
		expect(up.status).toBe(201);
		const meta = (await up.json()) as { id: string; size: number; mimeType: string };
		expect(meta).toMatchObject({ size: BYTES.length, mimeType: DOCX });

		const listed = (await (await request("GET", base, "u1")).json()) as { files: Array<{ id: string }> };
		expect(listed.files.map((f) => f.id)).toEqual([meta.id]);

		const down = await request("GET", `${base}/${meta.id}`, "u1");
		expect(down.status).toBe(200);
		expect(down.headers.get("Content-Type")).toBe(DOCX);
		const got = new Uint8Array(await down.arrayBuffer());
		expect(got.length).toBe(BYTES.length);
		expect(await sha256(got)).toBe(await sha256(BYTES));
	});

	it("over the 12MB cap is a 413 naming the limit; nothing reaches R2", async () => {
		const { request, r2 } = setup();
		const res = await request("POST", "/v1/instances/inst-1/files", "u1", { name: "big.pdf", contentBase64: "A".repeat(17 * 1024 * 1024) });
		expect(res.status).toBe(413);
		expect(((await res.json()) as { error: string }).error).toMatch(/over the 12MB limit/);
		expect(r2.objects.size).toBe(0);
	});

	it("malformed base64 is a 400, not a 500; nothing reaches R2", async () => {
		const { request, r2 } = setup();
		const res = await request("POST", "/v1/instances/inst-1/files", "u1", { name: "x.pdf", contentBase64: "not*base64!" });
		expect(res.status).toBe(400);
		expect(r2.objects.size).toBe(0);
	});
});

describe("only the owner can upload or download (#762)", () => {
	it("another user's upload to an instance is a 404 that never reaches the DO", async () => {
		const { request, r2, doHits } = setup();
		const res = await request("POST", "/v1/instances/inst-1/files", "u2", { name: "x.docx", contentBase64: b64(BYTES) });
		expect(res.status).toBe(404);
		expect(doHits).toEqual([]);
		expect(r2.objects.size).toBe(0);
	});

	it("another user's upload to an agent is a 403 that never reaches the DO", async () => {
		const { request, r2, doHits } = setup();
		const res = await request("POST", "/v1/agents/agent-a/files", "u2", { name: "x.docx", contentBase64: b64(BYTES) });
		expect(res.status).toBe(403);
		expect(doHits).toEqual([]);
		expect(r2.objects.size).toBe(0);
	});

	it("another user cannot download the owner's file by its id", async () => {
		const { request, doHits } = setup();
		const { id } = (await (await request("POST", "/v1/instances/inst-1/files", "u1", { name: "x.docx", contentBase64: b64(BYTES) })).json()) as { id: string };
		const hitsBefore = doHits.length;
		expect((await request("GET", `/v1/instances/inst-1/files/${id}`, "u2")).status).toBe(404);
		expect(doHits.length).toBe(hitsBefore);
	});

	it("an unauthenticated upload is refused", async () => {
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/instances", instanceStorageRoutes);
		app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: String(err) }, 500)));
		const res = await app.request("/v1/instances/inst-1/files", { method: "POST", body: JSON.stringify({ name: "x", contentBase64: "AA==" }) }, { SESSION_SIGNING_KEY: SECRET } as unknown as Env);
		expect(res.status).toBe(401);
	});
});
