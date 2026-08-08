/**
 * The terminal-target binding route (#402) — the subscriber's half of the ceiling.
 *
 * Driven through the real Hono app so the tenant gate, the body parsing and the config write are
 * all the shipped ones; only D1 is a stub, and it is a stub that REMEMBERS, because the property
 * under test is that what the route writes is what the merge reads back. A test that asserted the
 * SQL string would pass just as happily against a write nothing can resolve.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { connectorConstraintsForInstance } from "../lib/agent-capabilities.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { instanceRoutes } from "./instances.js";

const SECRET = "terminal-binding-secret";
const token = (uid: string) => signSession(uid, SECRET, { roles: ["user"] });

/**
 * A D1 that holds ONE instance and its agent, and applies `json_set`/`json_remove` on
 * `$.surfaceOptions` for real (by hand — the route's patch is a single top-level key, which is the
 * whole of what `patchInstanceConfig` does).
 */
function buildApp(agentConfig: Record<string, unknown>, instanceConfig: Record<string, unknown> = {}) {
	const state = { agent: JSON.stringify(agentConfig), instance: JSON.stringify(instanceConfig) };
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					const [id, uid] = args as [string, string];
					const mine = id === "inst-1" && uid === "u1";
					return {
						async first() {
							if (!mine) return null;
							if (sql.includes("agent_config")) return { agent_config: state.agent, instance_config: state.instance };
							if (sql.includes("SELECT config")) return { config: state.instance };
							return { id, agent_id: "a1", user_id: uid, status: "active", config: state.instance, created_at: "", updated_at: "" };
						},
						async all() {
							return { results: [] };
						},
						async run() {
							if (!sql.includes("json_set")) return { meta: { changes: 0 } };
							const [path, value, instanceId, userId] = args as [string, string, string, string];
							if (instanceId !== "inst-1" || userId !== "u1") return { meta: { changes: 0 } };
							state.instance = JSON.stringify({ ...JSON.parse(state.instance), [path.replace("$.", "")]: JSON.parse(value) });
							return { meta: { changes: 1 } };
						},
					};
				},
			};
		},
	};
	const env = { SESSION_SIGNING_KEY: SECRET, DB } as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});
	/** `uid: null` sends no Authorization header — the anonymous probe. */
	const call = async (method: "GET" | "PUT", body?: unknown, uid: string | null = "u1") =>
		app.request(
			"/v1/instances/inst-1/terminal-target",
			{
				method,
				headers: { ...(uid ? { Authorization: `Bearer ${await token(uid)}` } : {}), "Content-Type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			env,
		);
	return { call, env, state };
}

const SINGLE_TMUX = { capabilities: { surfaces: ["tmux"], surfaceOptions: { terminal: { backends: ["tmux"], targets: "single" } } } };

describe("GET /v1/instances/:id/terminal-target", () => {
	it("reports the creator's cardinality and ceiling alongside the instance's binding", async () => {
		// All three, because the caller's real question is "must I bind one, and to what" — and
		// `targets`/`backends` come from the AGENT while only the binding is the instance's.
		const { call } = buildApp(SINGLE_TMUX, { surfaceOptions: { terminal: { boundTarget: "tmux:main" } } });
		expect(await (await call("GET")).json()).toEqual({ target: "tmux:main", targets: "single", backends: ["tmux"] });
	});

	it("answers `many` and no ceiling for an agent that declares nothing — every agent today", async () => {
		// `many` is never stored (it is the default), so an absent field has to be REPORTED as
		// `many` rather than omitted, and an absent ceiling as null rather than [] — an empty list
		// reads as "no backend is allowed", the opposite of what absent means.
		const { call } = buildApp({ capabilities: { surfaces: ["tmux"] } });
		expect(await (await call("GET")).json()).toEqual({ target: null, targets: "many", backends: null });
	});

	it("is 404 for someone else's instance, and 401 with no session", async () => {
		const { call } = buildApp(SINGLE_TMUX);
		expect((await call("GET", undefined, "u2")).status).toBe(404);
		expect((await call("GET", undefined, null)).status).toBe(401);
	});
});

describe("PUT /v1/instances/:id/terminal-target", () => {
	it("BINDS A TARGET WITHIN THE CEILING and the dispatcher's merge reads it back", async () => {
		const { call, env } = buildApp(SINGLE_TMUX);
		const res = await call("PUT", { target: "tmux:main" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ target: "tmux:main", targets: "single", backends: ["tmux"] });
		// The assertion that matters: the same resolver `runRegistryTool` calls now sees it.
		expect(await connectorConstraintsForInstance(env, "inst-1", "u1", "terminal")).toEqual({
			backends: ["tmux"],
			targets: "single",
			boundTarget: "tmux:main",
		});
	});

	it("REFUSES a target outside the agent's ceiling instead of saving a value that would be dropped", async () => {
		// The merge drops an out-of-scope binding on the read path, which is right for a config
		// written by anything other than this handler. On a SAVE it would mean reporting success
		// and then showing an empty field.
		const { call, env } = buildApp(SINGLE_TMUX);
		const res = await call("PUT", { target: "iterm2:1:1:1" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("`terminal.backends` (tmux)");
		expect((await connectorConstraintsForInstance(env, "inst-1", "u1", "terminal"))?.boundTarget).toBeUndefined();
	});

	it("clears the binding with an empty value", async () => {
		const { call, env } = buildApp(SINGLE_TMUX, { surfaceOptions: { terminal: { boundTarget: "tmux:main" } } });
		expect(await (await call("PUT", { target: "" })).json()).toEqual({ target: null, targets: "single", backends: ["tmux"] });
		expect((await connectorConstraintsForInstance(env, "inst-1", "u1", "terminal"))?.boundTarget).toBeUndefined();
	});

	it("leaves the instance's OTHER config alone — the #231 loss, one key at a time", async () => {
		const { call, state } = buildApp(SINGLE_TMUX, { runnerNode: "laptop", surfaceOptions: { coding: { drive: false } } });
		await call("PUT", { target: "tmux:main" });
		const cfg = JSON.parse(state.instance) as { runnerNode: string; surfaceOptions: Record<string, unknown> };
		expect(cfg.runnerNode).toBe("laptop");
		// And a sibling ENTRY in the same map survives the read-merge-write of that one key.
		expect(cfg.surfaceOptions.coding).toEqual({ drive: false });
		expect(cfg.surfaceOptions.terminal).toEqual({ boundTarget: "tmux:main" });
	});

	it("stores nothing a subscriber is not allowed to declare, however the body is shaped", async () => {
		// The write goes back through `parseSurfaceOptions`, so a hand-crafted body cannot smuggle
		// a value past the closed vocabulary into stored config.
		const { call, state } = buildApp(SINGLE_TMUX);
		await call("PUT", { target: "tmux:main", backends: ["iterm2"], targets: "many" });
		expect(JSON.parse(state.instance).surfaceOptions).toEqual({ terminal: { boundTarget: "tmux:main" } });
	});

	it("is 404 for someone else's instance — a stranger cannot rebind another owner's terminal", async () => {
		const { call, state } = buildApp(SINGLE_TMUX);
		expect((await call("PUT", { target: "tmux:main" }, "u2")).status).toBe(404);
		expect(state.instance).toBe("{}");
	});
});
