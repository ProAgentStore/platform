import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { registerBehaviourRoutes } from "./instances-behaviour.js";
import type { Env } from "../types.js";

/**
 * The behaviour routes answer with RESOLVED values (creator default merged under the subscriber's
 * override), which on its own cannot tell the two apart — so every response also has to carry the
 * creator's `templateDefault`. Without it the console rendered a "reset" link on a field the
 * CREATOR set: clicking it cleared an override that did not exist and nothing changed (#232).
 */

const TEST_SECRET = "test-secret";

function testApp(opts: { instanceBehaviour?: unknown; agentBehaviour?: unknown } = {}) {
	const app = new Hono<{ Bindings: Env }>();
	const router = new Hono<{ Bindings: Env }>();
	registerBehaviourRoutes(router);
	app.route("/v1/instances", router);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});

	const instanceConfig: Record<string, unknown> = opts.instanceBehaviour ? { behaviour: opts.instanceBehaviour } : {};
	const agentConfig: Record<string, unknown> = opts.agentBehaviour ? { behaviour: opts.agentBehaviour } : {};
	const writes: string[] = [];

	const env = {
		SESSION_SIGNING_KEY: TEST_SECRET,
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							first: async () => {
								if (sql.startsWith("UPDATE")) return null;
								const row: Record<string, unknown> = {
									id: "inst-1",
									agent_id: "agent-1",
									user_id: "user-1",
									status: "active",
									config: JSON.stringify(instanceConfig),
								};
								// The join used by readBehaviour/patchBehaviour, and the agent-config read
								// the routes do for templateDefault.
								if (sql.includes("a.config AS agent_config")) row.agent_config = JSON.stringify(agentConfig);
								if (sql.includes("a.config AS config")) return { config: JSON.stringify(agentConfig) };
								return row;
							},
							run: async () => {
								// A targeted json_set: ?1 is the BOUND JSON path (#327), ?2 the value.
								writes.push(String(args[1]));
								instanceConfig.behaviour = JSON.parse(String(args[1])) as Record<string, unknown>;
								return { success: true };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;

	return { app, env, writes };
}

async function call(app: Hono<{ Bindings: Env }>, env: Env, path: string, init?: RequestInit) {
	const token = await signSession("user-1", TEST_SECRET);
	return app.request(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } }, env);
}

describe("behaviour responses distinguish the creator's default from the subscriber's override", () => {
	it("GET returns the resolved values AND what the creator shipped", async () => {
		const { app, env } = testApp({ agentBehaviour: { technicality: 80 }, instanceBehaviour: { emoji: false } });
		const res = await call(app, env, "/v1/instances/inst-1/behaviour");
		const data = await res.json<{ behaviour: Record<string, unknown>; templateDefault: Record<string, unknown> }>();

		expect(res.status).toBe(200);
		expect(data.behaviour).toMatchObject({ technicality: 80, emoji: false });
		// The one distinction the console cannot derive from `behaviour` alone.
		expect(data.templateDefault).toEqual({ technicality: 80 });
	});

	it("PUT returns it too — the console replaces its whole state from this response", async () => {
		const { app, env } = testApp({ agentBehaviour: { technicality: 80 } });
		const res = await call(app, env, "/v1/instances/inst-1/behaviour", {
			method: "PUT",
			body: JSON.stringify({ behaviour: { emoji: false } }),
		});
		const data = await res.json<{ behaviour: Record<string, unknown>; templateDefault: Record<string, unknown> }>();

		expect(res.status).toBe(200);
		expect(data.behaviour).toMatchObject({ technicality: 80, emoji: false });
		expect(data.templateDefault).toEqual({ technicality: 80 });
	});

	it("clearing an override falls back to the creator's value, not to unset", async () => {
		// The reset link's actual contract: `{field: null}` removes the SUBSCRIBER's override, and
		// what comes back is the agent's own default — so the row must keep showing a value.
		const { app, env } = testApp({ agentBehaviour: { technicality: 80 }, instanceBehaviour: { technicality: 10 } });
		const res = await call(app, env, "/v1/instances/inst-1/behaviour", {
			method: "PUT",
			body: JSON.stringify({ behaviour: { technicality: null } }),
		});
		const data = await res.json<{ behaviour: Record<string, unknown>; templateDefault: Record<string, unknown> }>();

		expect(data.behaviour.technicality).toBe(80);
		expect(data.templateDefault).toEqual({ technicality: 80 });
	});

	it("an agent with no template default reports an empty one rather than omitting it", async () => {
		const { app, env } = testApp({ instanceBehaviour: { emoji: false } });
		const res = await call(app, env, "/v1/instances/inst-1/behaviour");
		const data = await res.json<{ templateDefault: Record<string, unknown> }>();
		expect(data.templateDefault).toEqual({});
	});
});
