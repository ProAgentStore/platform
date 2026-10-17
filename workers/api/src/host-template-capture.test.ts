/**
 * #1086 — the host Worker and the agent templates.
 *
 * The HOST binds no database, only the API. So its test chains the two real Workers: the host's
 * `API` service binding is the API Worker's own `default.fetch`, over the real schema, and a host
 * crash is asserted by reading `error_log` — the whole path a production crash takes.
 *
 * The TEMPLATES are standalone Workers a creator deploys; they are not in the workspace, so they are
 * imported from source here. What they must never do again is turn an upstream AI failure into an
 * empty 200.
 *
 * `cloudflare:workers` (the Workers runtime) does not exist under Node and is replaced by the two
 * base classes the code extends. `vitest.config.ts` supplies the host's generated `pages.js` (an
 * empty committed stub) and the templates' `hono` (they have no install of their own).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
	class DurableObject {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	}
	class WorkflowEntrypoint extends DurableObject {}
	return { DurableObject, WorkflowEntrypoint };
});

import { realSchemaD1, type RealSchemaD1 } from "./lib/d1-sqlite.js";
import { signSession } from "./lib/session.js";
import type { Env } from "./types.js";

const { default: api } = await import("./index.js");
const { default: host, reportHostFailure, HOST_REPORT_BACKOFF_MS } = await import("../../host/src/index.js");
// By computed path: the templates have no install, so `tsc` must not follow them into this
// package's typecheck. Vitest resolves them at runtime (see `vitest.config.ts`).
const TEMPLATES = "../../../templates";
type TemplateApp = { request: (path: string, init: RequestInit) => Promise<Response> };
type TemplateDo = new (ctx: unknown, env: unknown) => { fetch: (req: Request) => Promise<Response> };
const templateApi = ((await import(/* @vite-ignore */ `${TEMPLATES}/template-agent-api/src/index.js`)) as { default: TemplateApp }).default;
const TemplateAgentDO = ((await import(/* @vite-ignore */ `${TEMPLATES}/template-agent-worker/src/index.js`)) as { AgentDO: TemplateDo }).AgentDO;

let d1: RealSchemaD1;
let apiEnv: Env;
let apiDown: (req: Request) => boolean;
/** Answers the host's report and then loses the answer on the way back — the write landed (#1135). */
let loseAnswer: (req: Request) => boolean;
beforeEach(() => {
	d1 = realSchemaD1();
	apiEnv = { DB: d1.DB, SESSION_SIGNING_KEY: "k", API_BUILD: "b1" } as unknown as Env;
	apiDown = () => false;
	loseAnswer = () => false;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
	d1.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
/** The host's service binding IS the API Worker — except for requests a test takes down. */
const hostEnv = () => ({
	API: {
		fetch: async (req: Request) => {
			if (apiDown(req)) throw new Error("upstream connect error");
			const headers = new Headers(req.headers);
			headers.set("CF-Connecting-IP", "192.0.2.10");
			const res = await api.fetch(new Request(req, { headers }), apiEnv, ctx);
			if (loseAnswer(req)) throw new Error("connection reset after the request was sent");
			return res;
		},
	},
});
const rows = () => d1.sqlite.prepare("SELECT source, level, status, user_id, instance_id, run_id, message, context FROM error_log ORDER BY rowid").all() as Array<Record<string, unknown>>;

describe("the host Worker (#1086)", () => {
	it("a crash is a plain 500 to the visitor and an error row in the API's log — method, path and cause, no body", async () => {
		apiDown = (req) => new URL(req.url).pathname === "/v1/admin/stats";
		const res = await host.fetch(new Request("https://proagentstore.online/admin/api/v1/admin/stats", { method: "POST", body: "secret-form-body" }), hostEnv() as never);
		expect(res.status).toBe(500);
		const [row] = rows();
		expect(row).toMatchObject({ source: "client:host", level: "error", status: 500, user_id: null, instance_id: null, run_id: null });
		expect(String(row.message)).toMatch(/upstream connect error/);
		// `caller` is the API's own reading of where a client row came from (#1120): the host Worker is a server, not a page.
		expect(JSON.parse(String(row.context))).toEqual({ method: "POST", path: "/admin/api/v1/admin/stats", caller: { origin: "none" } });
		expect(String(row.context) + String(row.message)).not.toContain("secret-form-body");
	});

	it("a failing sitemap expansion still serves the sitemap, and is recorded", async () => {
		apiDown = (req) => new URL(req.url).pathname === "/v1/agents";
		const res = await host.fetch(new Request("https://proagentstore.online/sitemap.xml"), hostEnv() as never);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("<urlset");
		expect(rows()).toEqual([expect.objectContaining({ source: "client:host-sitemap", status: 502 })]);
	});

	it("never reports a failure of the errors endpoint itself — a failing report cannot report itself", async () => {
		apiDown = () => true;
		const res = await host.fetch(new Request("https://proagentstore.online/admin/api/v1/errors/client", { method: "POST", body: "{}" }), hostEnv() as never);
		expect(res.status).toBe(500);
		expect(rows()).toEqual([]);
	});
});

describe("host reports carry an event id and a request id, and are retried (#1135)", () => {
	const crashOn = "/v1/admin/stats";
	const report = (sleeps: number[] = []) =>
		reportHostFailure(hostEnv() as never, { source: "host", method: "GET", path: "/admin/api/v1/admin/stats", status: 500, err: new Error("upstream connect error") }, async (ms) => void sleeps.push(ms));
	const reportsSent = () => {
		const sent: Request[] = [];
		const wrapped = hostEnv();
		const inner = wrapped.API.fetch;
		wrapped.API.fetch = async (req: Request) => {
			if (new URL(req.url).pathname === "/v1/errors/client") sent.push(req.clone());
			return inner(req);
		};
		return { sent, env: wrapped };
	};

	it("a crash's row carries the visitor request's cf-ray, read back through GET /v1/errors?request_id=", async () => {
		apiDown = (req) => new URL(req.url).pathname === crashOn;
		const res = await host.fetch(new Request(`https://proagentstore.online/admin/api${crashOn}`, { headers: { "cf-ray": "8d1f00aa11bb22cc-SYD" } }), hostEnv() as never);
		expect(res.status).toBe(500);
		const admin = await signSession("admin-1", "k", { roles: ["user", "admin"] });
		const read = await api.fetch(new Request("https://api.proagentstore.online/v1/errors?scope=all&request_id=8d1f00aa11bb22cc-SYD", { headers: { Authorization: `Bearer ${admin}`, "CF-Connecting-IP": "192.0.2.11" } }), apiEnv, ctx);
		const { errors } = (await read.json()) as { errors: Array<Record<string, unknown>> };
		expect(errors).toEqual([expect.objectContaining({ source: "client:host", request_id: "8d1f00aa11bb22cc-SYD" })]);
	});

	it("every report names an event id, minted once — the same id on each attempt", async () => {
		let attempt = 0;
		apiDown = (req) => new URL(req.url).pathname === "/v1/errors/client" && attempt++ === 0;
		const { sent, env } = reportsSent();
		await reportHostFailure(env as never, { source: "host", method: "GET", path: "/x", status: 500, err: new Error("boom") }, async () => undefined);
		const ids = await Promise.all(sent.map(async (r) => ((await r.json()) as { id: string }).id));
		expect(ids).toHaveLength(2);
		expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(ids[1]).toBe(ids[0]);
	});

	it("a report that could not be delivered is retried with backoff, and lands once", async () => {
		let attempts = 0;
		apiDown = (req) => new URL(req.url).pathname === "/v1/errors/client" && ++attempts <= 2;
		const sleeps: number[] = [];
		await report(sleeps);
		expect(sleeps).toEqual([...HOST_REPORT_BACKOFF_MS]);
		expect(rows()).toEqual([expect.objectContaining({ source: "client:host", status: 500 })]);
		expect(console.error).not.toHaveBeenCalled();
	});

	it("a re-send of a report that WAS stored (its answer was lost) writes one row, not two", async () => {
		let lost = 0;
		loseAnswer = (req) => new URL(req.url).pathname === "/v1/errors/client" && lost++ === 0;
		const sleeps: number[] = [];
		await report(sleeps);
		expect(sleeps).toEqual([HOST_REPORT_BACKOFF_MS[0]]);
		expect(rows()).toEqual([expect.objectContaining({ source: "client:host" })]);
		expect(Number((d1.sqlite.prepare("SELECT repeat_count FROM error_log").get() as { repeat_count: number }).repeat_count)).toBe(1);
	});

	it("gives up after the last backoff and says so on the console — and never retries a report the API rejected as malformed", async () => {
		apiDown = (req) => new URL(req.url).pathname === "/v1/errors/client";
		const sleeps: number[] = [];
		await report(sleeps);
		expect(sleeps).toEqual([...HOST_REPORT_BACKOFF_MS]);
		expect(console.error).toHaveBeenCalledWith("[host] could not report a failure:", "upstream connect error", "— original:", "Error: upstream connect error");

		const rejected: number[] = [];
		const env400 = { API: { fetch: async () => new Response(JSON.stringify({ ok: false }), { status: 400 }) } };
		await reportHostFailure(env400 as never, { source: "host", method: "GET", path: "/x", status: 500, err: new Error("boom") }, async (ms) => void rejected.push(ms));
		expect(rejected).toEqual([]);
	});

	it("does not hold the visitor's 500 for its retries when the runtime can keep them alive", async () => {
		apiDown = (req) => new URL(req.url).pathname === crashOn;
		const held: Promise<unknown>[] = [];
		const res = await host.fetch(new Request(`https://proagentstore.online/admin/api${crashOn}`), hostEnv() as never, { waitUntil: (p: Promise<unknown>) => void held.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext);
		expect(res.status).toBe(500);
		expect(held).toHaveLength(1);
		await Promise.all(held);
		expect(rows()).toEqual([expect.objectContaining({ source: "client:host" })]);
	});
});

describe("agent templates propagate an upstream AI failure (#1086)", () => {
	const creds = { "X-CF-Account-ID": "acct", "X-CF-AI-Token": "tok", "Content-Type": "application/json" };
	const upstream = (status: number, body: unknown) => vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));

	it("API template: an upstream refusal is a 502 naming the status — not a 200 with an empty result, and no upstream body", async () => {
		upstream(403, { errors: [{ message: "account acct-secret-detail not entitled" }] });
		const res = await templateApi.request("/run", { method: "POST", headers: creds, body: JSON.stringify({ input: "hi" }) });
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body).toMatchObject({ error: "upstream_ai_failed", upstreamStatus: 403 });
		expect(JSON.stringify(body)).not.toContain("acct-secret-detail");
	});

	it("API template: an EMPTY reply is a failure too", async () => {
		upstream(200, { result: { response: "" } });
		expect((await templateApi.request("/run", { method: "POST", headers: creds, body: JSON.stringify({ input: "hi" }) })).status).toBe(502);
	});

	it("API template: a real reply still returns 200 with it", async () => {
		upstream(200, { result: { response: "done" } });
		const res = await templateApi.request("/run", { method: "POST", headers: creds, body: JSON.stringify({ input: "hi" }) });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ result: "done" });
	});

	const workerDo = () => {
		const store = new Map<string, unknown>();
		const storage = { list: async () => new Map(), put: async (k: string, v: unknown) => void store.set(k, v) };
		return { agent: new TemplateAgentDO({ storage }, {}), store };
	};
	const chat = (agent: InstanceType<TemplateDo>) =>
		agent.fetch(new Request("https://do/chat", { method: "POST", headers: creds, body: JSON.stringify({ message: "hello" }) }));

	it("worker template: an upstream failure is a 502 and stores NOTHING — no empty assistant turn in history", async () => {
		upstream(500, { error: "internal" });
		const { agent, store } = workerDo();
		const res = await chat(agent);
		expect(res.status).toBe(502);
		expect(await res.json()).toMatchObject({ error: "upstream_ai_failed", upstreamStatus: 500 });
		expect(store.size).toBe(0);
	});

	it("worker template: a real reply is stored and returned", async () => {
		upstream(200, { result: { response: "hi there" } });
		const { agent, store } = workerDo();
		const res = await chat(agent);
		expect(res.status).toBe(200);
		expect([...store.values()]).toContainEqual({ role: "assistant", content: "hi there" });
	});
});
