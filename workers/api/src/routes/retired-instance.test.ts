/**
 * What a RETIRED agent looks like to the surfaces that render it (#979), over the real schema.
 *
 * The one response the console builds its instance list AND its instance page from is
 * `GET /v1/instances/my/instances`, and MCP's `my_instances` passes that body through verbatim. So
 * this is the test that makes "UI and MCP cannot disagree" an assertion rather than an intention:
 * both read these fields, and they are produced here once.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { agentCapabilities } from "../lib/agent-capabilities.js";
import { loopDriverFor } from "../lib/loop-drivers.js";
import { HttpError } from "../lib/auth.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { instanceRoutes } = await import("./instances.js");

let d1: RealSchemaD1;
const env = () => ({ DB: d1.DB } as unknown as Env);

/**
 * The REAL seeded legacy agent (`agent_job_application_assistant`, drafted by migration 0189,
 * declaring `workflow: "JOB_APPLY"`) with an `active` subscription on it — which is exactly the
 * live state #979 reports. Only the owner and the instances are seeded here; the agent rows are
 * the platform's own.
 */
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, description, category, visibility, config) VALUES
	  ('scout-a', 'u1', 't979-scout', 'Job Search Scout', 'Finds leads', 'productivity', 'public', '{"capabilities":{"surfaces":[],"runtime":"local_browser"}}'),
	  ('tailor-a', 'u1', 't979-tailor', 'Application Tailor', 'Writes materials', 'productivity', 'public', '{"capabilities":{"surfaces":[],"runtime":"local_artifact"}}'),
	  ('chat-a', 'u1', 't979-helper', 'Helper', 'Chats', 'productivity', 'public', '{}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('legacy-inst', 'agent_job_application_assistant', 'u1', 'active', '{}'),
	  ('scout', 'scout-a', 'u1', 'active', '{}'),
	  ('tailor', 'tailor-a', 'u1', 'active', '{"displayName":"My Tailor"}'),
	  ('chat', 'chat-a', 'u1', 'active', '{}')`);
});
afterEach(() => d1.close());

async function myInstances() {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request("/v1/instances/my/instances", {}, env());
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	const body = (await res.json()) as { instances: any[] };
	return { status: res.status, instances: body.instances };
}

describe("a retired agent is reported as retired, before anything is attempted (#979)", () => {
	it("the legacy instance carries the retirement, with the owner's own replacement pipeline", async () => {
		const { status, instances } = await myInstances();
		expect(status).toBe(200);
		const legacy = instances.find((i) => i.id === "legacy-inst");

		// The SUBSCRIPTION is untouched — that is the whole point of modelling these separately.
		expect(legacy.status).toBe("active");
		expect(legacy.retirement).toMatchObject({ workflow: "JOB_APPLY", status: "retired", label: "Retired — disabled", since: "2026-10-08" });
		expect(legacy.retirement.migration).toMatch(/Scout → Tailor → Runner/);
		// …and the capability it is derived from travels with it, so a reader that has the
		// capabilities (MCP's `get_agent_capabilities`, the surface registry) sees the same fact.
		expect(legacy.capabilities.retired).toMatchObject({ workflow: "JOB_APPLY" });

		// The route out: the owner's OWN instances, by id, with the display name they gave them.
		expect(legacy.retirement.replacements).toMatchObject([
			{ role: "scout", instanceId: "scout", consolePath: "/instances/scout" },
			{ role: "tailor", instanceId: "tailor", instanceName: "My Tailor", consolePath: "/instances/tailor" },
			{ role: "runner", instanceId: null, consolePath: null },
		]);
		expect(legacy.retirement.missingRoles).toEqual(["runner"]);
	});

	it("every OTHER instance is byte-identical to before — no field appears on a live agent", async () => {
		const { instances } = await myInstances();
		for (const id of ["scout", "tailor", "chat"]) {
			const inst = instances.find((i) => i.id === id);
			expect(inst, id).toBeTruthy();
			expect(Object.hasOwn(inst, "retirement"), id).toBe(false);
			expect(Object.hasOwn(inst.capabilities, "retired"), id).toBe(false);
		}
	});

	it("resolves the retirement from the WORKFLOW, so a declared legacy agent is caught too", () => {
		// The fallback derivation (an un-migrated row, by slug) and an explicit declaration must
		// agree: a retired agent that declared its capabilities must not read as live.
		const bySlug = agentCapabilities({ slug: "job-application-assistant", category: "productivity", config: null });
		const declared = agentCapabilities({ slug: "whatever", category: "x", config: JSON.stringify({ capabilities: { surfaces: ["apply"], runtime: "browser", workflow: "JOB_APPLY" } }) });
		expect(bySlug.retired).toMatchObject({ workflow: "JOB_APPLY" });
		expect(declared.retired).toMatchObject({ workflow: "JOB_APPLY" });
		expect(agentCapabilities({ slug: "coder-repo", category: "code", config: null }).retired).toBeUndefined();
	});
});

describe("nothing autonomous can be started on it (#979)", () => {
	it("the loop driver refuses with 410 and the migration message, at the one door every caller uses", async () => {
		// The Loop button, start_instance_loop, a trigger, a ticket and a supervisor's delegate_goal
		// all reach `loopDriverFor(...).start`. Before this they would have started a chat loop on an
		// agent whose every apply tool refuses — paid iterations to reach the same sentence.
		const caps = agentCapabilities({ slug: "job-application-assistant", category: "productivity", config: null });
		const out = await loopDriverFor(caps).start({ env: env(), instanceId: "legacy-inst", userId: "u1", objective: "apply to this job", budgetId: "b1", depth: 0 });
		expect(out).toMatchObject({ ok: false, status: 410 });
		if (!out.ok) {
			expect(out.error).toMatch(/^Retired — disabled\./);
			expect(out.error).toMatch(/Scout → Tailor → Runner/);
		}
	});

	it("410, not 409: a caller that retries a 409 is right to, and retrying this never changes", async () => {
		const caps = agentCapabilities({ slug: "job-application-assistant", category: "productivity", config: null });
		const out = await loopDriverFor(caps).start({ env: env(), instanceId: "legacy-inst", userId: "u1", objective: "x", budgetId: "b1", depth: 0 });
		expect(out.ok === false && out.status).toBe(410);
		// No run row was opened for a refused start — the gate is in FRONT of the driver.
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM agent_loop_runs").first<{ n: number }>())?.n).toBe(0);
	});

	it("a LIVE agent is unaffected by the gate", async () => {
		const caps = agentCapabilities({ slug: "t979-helper", category: "productivity", config: null });
		// It reaches the real chat driver, which opens its run row and asks the workflow binding — so
		// the assertion is that it got PAST the gate, not that it succeeded in a test with no binding.
		const started = { create: vi.fn(async () => ({ id: "wf" })) };
		const out = await loopDriverFor(caps).start({ env: { DB: d1.DB, AGENT_LOOP: started } as unknown as Env, instanceId: "chat", userId: "u1", objective: "x", budgetId: "b1", depth: 0 });
		expect(out.ok).toBe(true);
		expect(started.create).toHaveBeenCalledTimes(1);
	});
});
