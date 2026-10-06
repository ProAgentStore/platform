/**
 * Which model-driven routes a coding agent reaches follows what it DECLARES (#942), on the real
 * migrated schema — the seeded `local-coder` row from 0164, not a fixture standing in for it.
 *
 *   · the cross-repo Overseer is gone with the legacy Coder it belonged to — no agent reaches it;
 *   · the per-session Agent chat (`/agent`) is the Co-pilot's own chat, so `copilot:false` closes
 *     it exactly as it closes `/explain` — until #942 it was the one Co-pilot route with no gate;
 *   · `drive:false` keeps the chat but takes away `drive_claude`, the tool that drives the engine;
 *   · an agent that declares nothing keeps both — the default kept on purpose on #942.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env, SessionPayload } from "../types.js";

const current: SessionPayload = { uid: "u1", roles: [] } as unknown as SessionPayload;
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => current };
});

/** Every model call the Agent chat makes, so "was `drive_claude` offered?" is observable. */
const modelCalls: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
vi.mock("../lib/user-ai.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/user-ai.js")>("../lib/user-ai.js");
	return {
		...actual,
		runUserWorkersAi: async (_env: unknown, _uid: string, _model: string, params: { tools?: Array<{ function: { name: string } }> }) => {
			modelCalls.push(params);
			return { response: "It is running the tests." };
		},
	};
});

const { codingRoutes } = await import("./coding.js");

let d1: RealSchemaD1;
let env: Env;

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function app() {
	const router = new Hono<{ Bindings: Env }>();
	router.route("/v1/instances", codingRoutes);
	router.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 404) : c.json({ error: String(e) }, 500)));
	return router;
}

const post = (path: string, body: unknown) =>
	app().request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);

/** A coding agent declaring exactly `capabilities`, one instance of it, and one session on it. */
function codingAgent(instanceId: string, capabilities: Record<string, unknown>) {
	const agentId = `agent-${instanceId}`;
	d1.exec(
		`INSERT INTO agents (id, owner_id, slug, name, category, config)
		  VALUES (${q(agentId)}, 'u1', ${q(agentId)}, ${q(agentId)}, 'code', ${q(JSON.stringify({ capabilities }))})`,
	);
	instance(instanceId, agentId);
}

function instance(instanceId: string, agentId: string) {
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id) VALUES (${q(instanceId)}, ${q(agentId)}, 'u1')`);
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, provider, clone_status, workdir) VALUES (${q(`r-${instanceId}`)}, ${q(instanceId)}, 'u1', 'app', 'local', 'ready', '/home/me/app')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES (${q(`s-${instanceId}`)}, ${q(instanceId)}, ${q(`r-${instanceId}`)}, 'u1')`);
}

const agentChat = (instanceId: string, message: string) => post(`/v1/instances/${instanceId}/coding/sessions/s-${instanceId}/agent`, { message });
const offeredTools = () => (modelCalls.at(-1)?.tools ?? []).map((t) => t.function.name);

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: [] });
	env = { DB: d1.DB } as unknown as Env;
	modelCalls.length = 0;
});

afterEach(() => d1.close());

describe("the cross-repo Overseer is retired with the legacy Coder (#942)", () => {
	it("is not a route for any agent, including one that declares nothing", async () => {
		codingAgent("plain-1", { surfaces: ["coding"] });
		const res = await post("/v1/instances/plain-1/coding/overseer", { message: "what is everyone doing?" });
		expect(res.status).toBe(404);
		expect(modelCalls).toHaveLength(0);
	});
});

describe("POST …/sessions/:id/agent follows the declared coding options (#942)", () => {
	it("is closed for the seeded Local Coder (copilot:false), like /explain, before any model call", async () => {
		instance("lc-1", "agent_local_coder");
		const agent = await agentChat("lc-1", "what is it doing?");
		expect(agent.status).toBe(404);
		expect(((await agent.json()) as { error: string }).error).toMatch(/single chat/);
		const explain = await post("/v1/instances/lc-1/coding/sessions/s-lc-1/explain", { question: "what is it doing?" });
		expect(explain.status).toBe(404);
		expect(modelCalls).toHaveLength(0);
	});

	it("keeps the chat but withholds drive_claude from an agent that declares drive:false", async () => {
		codingAgent("nodrive-1", { surfaces: ["coding"], surfaceOptions: { coding: { drive: false } } });
		const res = await agentChat("nodrive-1", "what is it doing?");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ delegated: false, reply: "It is running the tests." });
		expect(modelCalls).toHaveLength(1);
		expect(offeredTools()).toEqual([]);
	});

	it("refuses a forced delegation (@claude) from an agent that declares drive:false", async () => {
		codingAgent("nodrive-2", { surfaces: ["coding"], surfaceOptions: { coding: { drive: false } } });
		const res = await agentChat("nodrive-2", "@claude run the tests");
		expect(res.status).toBe(403);
		expect(modelCalls).toHaveLength(0);
	});

	it("offers drive_claude to an agent that declares nothing — the default kept on #942", async () => {
		codingAgent("plain-2", { surfaces: ["coding"] });
		const res = await agentChat("plain-2", "what is it doing?");
		expect(res.status).toBe(200);
		expect(offeredTools()).toEqual(["drive_claude"]);
	});
});
