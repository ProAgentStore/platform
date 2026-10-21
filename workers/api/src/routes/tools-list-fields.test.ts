/**
 * #1263 — a comma-list field (`labels`, `assignees`, `exclude_labels`) takes an array through `call_instance_tool`'s route.
 *
 * The array is joined to the string the schema declares BEFORE validation and before the handler, so the handler, the schema
 * the model is shown and the pinned session's zod shape need no change of type. The cases: the three GitHub tools' fields,
 * the handler receiving the string, the refusals that would otherwise silently split a name, a non-listed field staying strict,
 * and the listing carrying `listFields` beside the schema (and only with it).
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";

const ran: Array<{ name: string; input: Record<string, unknown> }> = [];
vi.mock("../lib/tool-registry.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/tool-registry.js")>("../lib/tool-registry.js");
	return {
		...actual,
		runRegistryTool: async (name: string, _ctx: unknown, input: Record<string, unknown>) => {
			ran.push({ name, input });
			return { success: true, content: "ok" };
		},
	};
});
const { toolRoutes } = await import("./tools.js");

const SECRET = "list-fields-secret";
const TOOLS = ["github_list_issues", "github_create_issue", "github_update_issue", "github_read_issue"];

function buildApp() {
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								if (!sql.includes("FROM agent_instances")) return null;
								const [id, uid] = args as [string, string];
								if (id !== "inst-1" || uid !== "u1") return null;
								if (sql.includes("JOIN agents")) return { slug: "fixture", category: "general", config: JSON.stringify({ capabilities: { tools: TOOLS } }), instance_config: "{}" };
								return { id, agent_id: "a1", user_id: uid, status: "active", config: "{}", created_at: "", updated_at: "" };
							},
							async all() {
								return { results: [] };
							},
							async run() {
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", toolRoutes);
	app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: String(err) }, 500)));
	return { app, env };
}

async function call(name: string, body: unknown) {
	const { app, env } = buildApp();
	const res = await app.request(`/v1/instances/inst-1/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${await signSession("u1", SECRET, { roles: ["user"] })}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
	ran.length = 0;
});

describe("an array for a comma-list field (#1263)", () => {
	it.each([
		["github_list_issues", "labels", { repo: "a/b" }],
		["github_list_issues", "exclude_labels", { repo: "a/b" }],
		["github_create_issue", "labels", { repo: "a/b", title: "t" }],
		["github_update_issue", "labels", { repo: "a/b", number: 4 }],
		["github_update_issue", "assignees", { repo: "a/b", number: 4 }],
	])("%s.%s: the array is accepted and the handler receives the comma string", async (name, field, base) => {
		const r = await call(name, { ...base, [field]: ["bug", "P1: blocks external users"] });
		expect(r.status, JSON.stringify(r.json)).toBe(200);
		expect(ran).toEqual([{ name, input: { ...base, [field]: "bug,P1: blocks external users" } }]);
	});

	it("the string form still works exactly as before", async () => {
		const r = await call("github_update_issue", { repo: "a/b", number: 4, labels: "bug,mcp" });
		expect(r.status).toBe(200);
		expect(ran[0].input.labels).toBe("bug,mcp");
	});

	it("trims entries, and an empty array becomes the empty string every list field reads as 'nothing given'", async () => {
		await call("github_list_issues", { repo: "a/b", labels: [" bug ", "mcp "], exclude_labels: [] });
		expect(ran[0].input).toEqual({ repo: "a/b", labels: "bug,mcp", exclude_labels: "" });
	});

	it("refuses an entry holding a comma, by name — it would be silently split into two labels", async () => {
		const r = await call("github_create_issue", { repo: "a/b", title: "t", labels: ["bug", "a,b"] });
		expect(r.status).toBe(400);
		expect(String(r.json.error)).toMatch(/"a,b" contains a comma/);
		expect(ran).toEqual([]);
	});

	it.each([
		["a number", [1]],
		["null", [null]],
		["an object", [{ name: "bug" }]],
		["a nested array", [["bug"]]],
		["an empty string", ["bug", ""]],
		["whitespace", ["  "]],
	])("refuses an array holding %s, naming the entry", async (_what, labels) => {
		const r = await call("github_create_issue", { repo: "a/b", title: "t", labels });
		expect(r.status).toBe(400);
		expect(String(r.json.error)).toMatch(/entry \d is not a non-empty string/);
		expect(ran).toEqual([]);
	});

	it("an array for a field that is NOT a comma list is still refused by the validator", async () => {
		const r = await call("github_create_issue", { repo: ["a/b"], title: "t" });
		expect(r.status).toBe(400);
		expect(r.json.error).toBe('Field "repo" must be a string');
		const t = await call("github_create_issue", { repo: "a/b", title: ["t"] });
		expect(t.json.error).toBe('Field "title" must be a string');
	});

	it("a tool with no list fields never coerces: github_read_issue still refuses an array", async () => {
		const r = await call("github_read_issue", { repo: "a/b", number: [1] });
		expect(r.status).toBe(400);
	});

	it("other wrong types for a list field are still the validator's refusal", async () => {
		const r = await call("github_create_issue", { repo: "a/b", title: "t", labels: 5 });
		expect(r.status).toBe(400);
		expect(r.json.error).toBe('Field "labels" must be a string');
	});

	it("does not mutate the caller's object and leaves other fields untouched", async () => {
		const { coerceListFields } = await import("../lib/json-schema-validate.js");
		const input = { repo: "a/b", labels: ["x", "y"], extra: ["keep"] };
		const out = coerceListFields(["labels"], input);
		expect(input.labels).toEqual(["x", "y"]);
		expect(out.input).toEqual({ repo: "a/b", labels: "x,y", extra: ["keep"] });
		expect(coerceListFields(undefined, input).input).toBe(input);
		expect(coerceListFields([], input).input).toBe(input);
	});
});

describe("the listing carries listFields beside the schema (#1263)", () => {
	async function listing(query: string) {
		const { app, env } = buildApp();
		const res = await app.request(`/v1/instances/inst-1/tools${query}`, { headers: { Authorization: `Bearer ${await signSession("u1", SECRET, { roles: ["user"] })}` } }, env);
		return ((await res.json()) as { tools: Array<{ name: string; jsonSchema?: { properties: Record<string, { type: string }> }; listFields?: string[] }> }).tools;
	}

	it("with schemas: the fields, and the schema still declares them as strings", async () => {
		const rows = await listing("?schemas=true");
		const update = rows.find((r) => r.name === "github_update_issue");
		expect(update?.listFields).toEqual(["labels", "assignees"]);
		expect(update?.jsonSchema?.properties.labels.type).toBe("string");
		expect(update?.jsonSchema?.properties.assignees.type).toBe("string");
		expect(rows.find((r) => r.name === "github_list_issues")?.listFields).toEqual(["labels", "exclude_labels"]);
		expect(rows.find((r) => r.name === "github_read_issue")?.listFields).toBeUndefined();
	});

	it("without schemas: no listFields either (it travels with the schema, so the default listing does not grow)", async () => {
		const rows = await listing("");
		expect(rows.every((r) => r.listFields === undefined)).toBe(true);
	});
});
