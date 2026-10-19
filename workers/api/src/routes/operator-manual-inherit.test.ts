/**
 * #1237 — a template's operator manual, inherited by every instance of it, over the real schema and
 * the real routes. Only the signed-in user is faked (two of them: the template's owner and a stranger).
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ uid: "owner" }));
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: who.uid, roles: ["user", "creator"] }) };
});

import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { runRegistryTool } from "../lib/tool-registry.js";
import type { Env } from "../types.js";

const { agentRoutes } = await import("./agents.js");
const { instanceRoutes } = await import("./instances.js");

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	who.uid = "owner";
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('owner', 'owner'), ('stranger', 'stranger')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('coder', 'owner', 'repo-coder', 'Repo Coder', '{}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('stash', 'coder', 'owner', 'active', '{}'), ('clubs', 'coder', 'owner', 'active', '{}')`);
	// The operator-manual read renders its generated half from the instance's tool policy, which asks the DO.
	env = { DB: d1.DB, AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }) } } as unknown as Env;
});
afterEach(() => d1.close());

async function call(path: string, init: RequestInit = {}) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/agents", agentRoutes);
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } }, env);
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const setTemplate = (manual: string) => call("/v1/agents/coder/operator-manual", { method: "PUT", body: JSON.stringify({ manual }) });
const setInstance = (id: string, manual: string) => call(`/v1/instances/${id}/operator-manual`, { method: "PUT", body: JSON.stringify({ manual }) });
const read = (id: string) => call(`/v1/instances/${id}/operator-manual`);
const STANDARD = "Checkouts are home-relative: ~/dev/stores/pas/apps/<app>. Never /Users/... or C:\\Users\\...";

describe("an instance inherits its template's operator manual (#1237)", () => {
	it("inherit-only: the template's manual reaches every instance, with no per-instance action", async () => {
		expect((await setTemplate(STANDARD)).status).toBe(200);
		for (const id of ["stash", "clubs"]) {
			const { body } = await read(id);
			expect(body).toMatchObject({ manual: "", inherited: STANDARD, sections: { inherited: STANDARD, instance: null } });
			expect(body.combined).toBe(`## Inherited from the agent template\n\n${STANDARD}`);
		}
		expect(await call("/v1/agents/coder/operator-manual")).toMatchObject({ status: 200, body: { manual: STANDARD, instances: 2 } });
	});

	it("instance-only: no template manual, the instance's own reads exactly as before", async () => {
		await setInstance("stash", "Stash deploys from main only.");
		const { body } = await read("stash");
		expect(body).toMatchObject({ manual: "Stash deploys from main only.", inherited: "", sections: { inherited: null, instance: "Stash deploys from main only." }, combined: "Stash deploys from main only." });
	});

	it("both: one read shows both, sectioned — the inherited text first, the instance's own after it as the overriding addendum", async () => {
		await setTemplate(STANDARD);
		await setInstance("stash", "Stash lives at ~/dev/stores/pas/apps/stash.");
		const { body } = await read("stash");
		expect(body.sections).toEqual({ inherited: STANDARD, instance: "Stash lives at ~/dev/stores/pas/apps/stash." });
		expect(body.combined).toBe(`## Inherited from the agent template\n\n${STANDARD}\n\n## This instance's own manual (addendum — where it conflicts with the inherited text, this wins)\n\nStash lives at ~/dev/stores/pas/apps/stash.`);
		// The other instance has no addendum: it shows the inherited layer alone.
		expect((await read("clubs")).body.sections).toEqual({ inherited: STANDARD, instance: null });
		// The agent's own read_operator_manual sees the same two layers, as data.
		const r = await runRegistryTool("read_operator_manual", { env, instanceId: "stash", userId: "owner" }, {});
		expect(r.success).toBe(true);
		expect(r.content).toContain(STANDARD);
		expect(r.content).toContain("Stash lives at ~/dev/stores/pas/apps/stash.");
	});

	it("update propagation: a template edit shows on existing instances on their next read, with no resync", async () => {
		await setTemplate("v1: deliver to main.");
		expect((await read("stash")).body.inherited).toBe("v1: deliver to main.");
		await setTemplate("v2: deliver to main; checkouts are home-relative.");
		expect((await read("stash")).body.inherited).toBe("v2: deliver to main; checkouts are home-relative.");
		expect((await read("clubs")).body.inherited).toBe("v2: deliver to main; checkouts are home-relative.");
		// A future instance inherits it from its first read.
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('fresh', 'coder', 'owner', 'active', '{}')`);
		expect((await read("fresh")).body.inherited).toBe("v2: deliver to main; checkouts are home-relative.");
		// Clearing it clears it everywhere.
		await setTemplate("");
		expect((await read("stash")).body.sections).toEqual({ inherited: null, instance: null });
	});

	it("owner only: a stranger can neither read nor write the template's manual; the cap is a 400 naming the length", async () => {
		await setTemplate(STANDARD);
		who.uid = "stranger";
		expect((await setTemplate("hijack")).status).toBe(403);
		expect((await call("/v1/agents/coder/operator-manual")).status).toBe(403);
		who.uid = "owner";
		expect((await call("/v1/agents/coder/operator-manual")).body.manual).toBe(STANDARD);
		const big = await setTemplate("x".repeat(16_001));
		expect(big).toMatchObject({ status: 400, body: { error: "Operator manual too long: 16001 chars (max 16000)." } });
		expect((await call("/v1/agents/missing/operator-manual")).status).toBe(404);
	});

	it("the template listing does not carry the manual (it stays off listings, like the instance one)", async () => {
		await setTemplate(STANDARD);
		const { body } = await call("/v1/agents/my/agents");
		expect(body.agents[0]).toMatchObject({ id: "coder", hasOperatorManual: true });
		expect(body.agents[0]).not.toHaveProperty("operator_manual");
	});
});
