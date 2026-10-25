/**
 * #1238 — an account-level operator manual, applied across every template the owner runs, over the real schema and the real routes.
 * Only the signed-in user is faked (the owner, and a stranger who is also a template creator).
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
import { combinedOperatorManual } from "../lib/operator-manual.js";
import { runRegistryTool } from "../lib/tool-registry.js";
import type { Env } from "../types.js";

const { agentRoutes } = await import("./agents.js");
const { instanceRoutes } = await import("./instances.js");
const { preferenceRoutes } = await import("./preferences.js");

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	who.uid = "owner";
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('owner', 'owner'), ('creator', 'creator')`);
	// Two different templates the owner runs, and a third owned by someone else that the owner subscribes to.
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('coder', 'owner', 'repo-coder', 'Repo Coder', '{}'), ('scout', 'owner', 'job-scout', 'Job Scout', '{}'), ('theirs', 'creator', 'their-agent', 'Their Agent', '{}')`);
	d1.exec(
		`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
		 ('stash', 'coder', 'owner', 'active', '{}'), ('scout-1', 'scout', 'owner', 'active', '{}'),
		 ('sub-1', 'theirs', 'owner', 'active', '{}'), ('creator-1', 'theirs', 'creator', 'active', '{}')`,
	);
	env = { DB: d1.DB, AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }) } } as unknown as Env;
});
afterEach(() => d1.close());

async function call(path: string, init: RequestInit = {}) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/agents", agentRoutes);
	app.route("/v1/instances", instanceRoutes);
	app.route("/v1/preferences", preferenceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } }, env);
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const put = (path: string, manual: string) => call(path, { method: "PUT", body: JSON.stringify({ manual }) });
const setAccount = (manual: string) => put("/v1/preferences/operator-manual", manual);
const setTemplate = (manual: string) => put("/v1/agents/coder/operator-manual", manual);
const setInstance = (id: string, manual: string) => put(`/v1/instances/${id}/operator-manual`, manual);
const read = (id: string) => call(`/v1/instances/${id}/operator-manual`);
const MACHINES = "Machines: Mac mini (main), pink laptop, Dell (Windows). Main only, no PRs. Checkouts are home-relative: ~/dev/stores/<store>/apps/<app>.";

describe("an account manual shows on every instance the owner runs (#1238 acceptance)", () => {
	it("account-only: it reaches instances of DIFFERENT templates on the next read, with no resync", async () => {
		expect((await setAccount(MACHINES)).status).toBe(200);
		for (const id of ["stash", "scout-1", "sub-1"]) {
			const { body } = await read(id);
			expect(body).toMatchObject({ account: MACHINES, inherited: "", manual: "", sections: { account: MACHINES, inherited: null, instance: null } });
			expect(body.combined).toBe(`## Inherited from your account\n\n${MACHINES}`);
		}
	});

	it("all three: one read shows them in precedence order — account, then template, then instance — each later one an overriding addendum", async () => {
		await setAccount(MACHINES);
		await setTemplate("Repo Coders deliver to main.");
		await setInstance("stash", "Stash lives at ~/dev/stores/pas/apps/stash.");
		const { body } = await read("stash");
		expect(body.sections).toEqual({ account: MACHINES, inherited: "Repo Coders deliver to main.", instance: "Stash lives at ~/dev/stores/pas/apps/stash." });
		const c = body.combined as string;
		expect(c.indexOf("## Inherited from your account")).toBe(0);
		expect(c.indexOf("## Inherited from the agent template")).toBeGreaterThan(c.indexOf("## Inherited from your account"));
		expect(c.indexOf("## This instance's own manual")).toBeGreaterThan(c.indexOf("## Inherited from the agent template"));
		expect(c).toBe(
			`## Inherited from your account\n\n${MACHINES}\n\n## Inherited from the agent template\n\nRepo Coders deliver to main.\n\n## This instance's own manual (addendum — where it conflicts with the inherited text, this wins)\n\nStash lives at ~/dev/stores/pas/apps/stash.`,
		);
		// A different template's instance gets the account layer but not this template's.
		expect((await read("scout-1")).body.sections).toEqual({ account: MACHINES, inherited: null, instance: null });
	});

	it("account + instance, no template: no template heading", async () => {
		await setAccount(MACHINES);
		await setInstance("scout-1", "Scout runs hourly.");
		expect((await read("scout-1")).body.combined).toBe(`## Inherited from your account\n\n${MACHINES}\n\n## This instance's own manual (addendum — where it conflicts with the inherited text, this wins)\n\nScout runs hourly.`);
	});

	it("update propagation: an edit shows on existing instances on their next read; a future one has it from its first; clearing clears it everywhere", async () => {
		await setAccount("v1: main only.");
		expect((await read("stash")).body.account).toBe("v1: main only.");
		await setAccount("v2: main only; no PRs.");
		for (const id of ["stash", "scout-1"]) expect((await read(id)).body.account).toBe("v2: main only; no PRs.");
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('fresh', 'scout', 'owner', 'active', '{}')`);
		expect((await read("fresh")).body.account).toBe("v2: main only; no PRs.");
		await setAccount("");
		expect((await read("stash")).body.sections).toEqual({ account: null, inherited: null, instance: null });
		expect((await call("/v1/preferences/operator-manual")).body).toMatchObject({ manual: "" });
	});

	it("the instance-only and template-only reads are exactly as #1237 left them", async () => {
		await setInstance("stash", "Only mine.");
		expect((await read("stash")).body.combined).toBe("Only mine.");
		await setTemplate("Template standard.");
		expect((await read("stash")).body.combined).toBe("## Inherited from the agent template\n\nTemplate standard.\n\n## This instance's own manual (addendum — where it conflicts with the inherited text, this wins)\n\nOnly mine.");
	});
});

describe("whose account (#1238 decision 3): the instance owner's, never the template creator's", () => {
	it("a creator's account manual does not reach a subscriber's instance of the creator's template — and the subscriber's own does", async () => {
		who.uid = "creator";
		await setAccount("CREATOR'S PRIVATE STANDARD");
		expect((await read("creator-1")).body.account).toBe("CREATOR'S PRIVATE STANDARD");
		who.uid = "owner";
		// 'owner' subscribes to the creator's template ('sub-1'): the creator's account manual must not be on it.
		expect((await read("sub-1")).body.account).toBe("");
		await setAccount(MACHINES);
		expect((await read("sub-1")).body.account).toBe(MACHINES);
		expect(JSON.stringify((await read("sub-1")).body)).not.toContain("CREATOR'S PRIVATE STANDARD");
	});

	it("each account has its own manual: one owner cannot read or overwrite another's — there is no id to name", async () => {
		await setAccount(MACHINES);
		who.uid = "creator";
		expect((await call("/v1/preferences/operator-manual")).body.manual).toBe("");
		await setAccount("creator's own");
		who.uid = "owner";
		expect((await call("/v1/preferences/operator-manual")).body.manual).toBe(MACHINES);
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM account_operator_manuals").first<{ n: number }>())?.n).toBe(2);
	});
});

describe("the account API", () => {
	it("GET returns the manual and how many of the owner's instances read it; PUT replaces it", async () => {
		await setAccount(MACHINES);
		expect(await call("/v1/preferences/operator-manual")).toMatchObject({ status: 200, body: { manual: MACHINES, instances: 3 } });
		expect(await setAccount("replaced")).toMatchObject({ status: 200, body: { ok: true, manual: "replaced" } });
		expect((await call("/v1/preferences/operator-manual")).body.manual).toBe("replaced");
	});

	it("the cap is a 400 naming the length, and nothing is saved", async () => {
		await setAccount("kept");
		expect(await setAccount("x".repeat(16_001))).toMatchObject({ status: 400, body: { error: "Operator manual too long: 16001 chars (max 16000)." } });
		expect((await call("/v1/preferences/operator-manual")).body.manual).toBe("kept");
		expect((await setAccount("x".repeat(16_000))).status).toBe(200);
	});

	it("it stays off the preferences payload (0143 / #739 decision 2): the preferences blob never carries the manual", async () => {
		await setAccount(MACHINES);
		const prefs = JSON.stringify((await call("/v1/preferences")).body);
		expect(prefs).not.toContain("Mac mini");
		const row = await d1.DB.prepare("SELECT preferences FROM users WHERE id = 'owner'").first<{ preferences: string | null }>();
		expect(row?.preferences ?? "").not.toContain("Mac mini");
	});
});

describe("every reader of an instance's manual sees the account layer", () => {
	it("the agent's own read_operator_manual gets it, as data", async () => {
		await setAccount(MACHINES);
		await setTemplate("Template rule.");
		const r = await runRegistryTool("read_operator_manual", { env, instanceId: "stash", userId: "owner" }, {});
		expect(r.success).toBe(true);
		expect(r.content).toContain(MACHINES);
		expect(r.content).toContain("Template rule.");
	});

	it("the connection guide carries it", async () => {
		await setAccount(MACHINES);
		const { body } = await call("/v1/instances/stash/connection-guide");
		expect(JSON.stringify(body)).toContain("home-relative");
	});
});

describe("combinedOperatorManual", () => {
	it("leaves out empty layers and keeps the precedence order", () => {
		expect(combinedOperatorManual({ inherited: "", instance: "" })).toBe("");
		expect(combinedOperatorManual({ account: "A", inherited: "", instance: "" })).toBe("## Inherited from your account\n\nA");
		expect(combinedOperatorManual({ account: "A", inherited: "T", instance: "" })).toBe("## Inherited from your account\n\nA\n\n## Inherited from the agent template\n\nT");
		expect(combinedOperatorManual({ account: "  ", inherited: "", instance: "I" })).toBe("I");
	});
});
