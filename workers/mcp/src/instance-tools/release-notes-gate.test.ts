import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerReleaseNotesTools } from "./release-notes.js";

// #1346: the release gate's production_deploy item carries the deploy job and step. The MCP schema
// must not strip them (zod drops unknown keys, which would silently save the weaker gate), and the
// readback must carry the migration state so an agent can see an old gate is held.

type Shape = Record<string, z.ZodTypeAny>;
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function setup(responseBody: unknown = {}) {
	const calls: Array<{ url: string; method: string; body: string | null }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: (init?.body as string | undefined) ?? null });
		return new Response(JSON.stringify(responseBody), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	const store = new Map<string, string>();
	const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k), list: async () => ({ keys: [], list_complete: true }) } as unknown as KVNamespace;
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv };
	const tools = new Map<string, { schema: Shape; handler: Handler }>();
	registerReleaseNotesTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, as in contract.test.ts
		{ tool: (name: string, _d: string, schema: Shape, handler: Handler) => tools.set(name, { schema, handler }) } as any,
		{ env, tokenFor: (t?: string) => t || "session-token", safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read", "write"] as SafetyContext["scopes"] }), groups: new Set<string>() },
	);
	/** Like the SDK: validate against the published schema first, so a stripped field is really stripped. */
	const run = (name: string, args: Record<string, unknown>) => {
		const t = tools.get(name);
		if (!t) throw new Error(`not registered: ${name}`);
		return t.handler(z.object(t.schema).parse(args));
	};
	return { run, calls };
}
afterEach(() => vi.unstubAllGlobals());

const gate = [
	{ path: ".github/workflows/ci.yml", role: "check" },
	{ path: ".github/workflows/e2e-full.yml", role: "check" },
	{ path: ".github/workflows/deploy.yml", role: "production_deploy", jobName: "deploy", stepName: "Upload to R2" },
];

describe("set_instance_release_notes carries the deploy job and step (#1346)", () => {
	it("forwards jobName and stepName on the production_deploy item, untouched", async () => {
		const h = setup({ settings: { requiredWorkflows: gate }, gate: { state: "ready" } });
		await h.run("set_instance_release_notes", { instance_id: "i1", requiredWorkflows: gate });
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]).toMatchObject({ url: "https://api.test/v1/instances/i1/release-notes", method: "PUT" });
		expect(JSON.parse(h.calls[0].body ?? "{}").requiredWorkflows).toEqual(gate);
	});
	it("a dry run shows the selectors it would send and touches no network", async () => {
		const h = setup();
		const res = await h.run("set_instance_release_notes", { instance_id: "i1", requiredWorkflows: gate, dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(res.content[0].text).toContain("Upload to R2");
	});
	it("reads back the gate state, so an old gate's migration message reaches the agent", async () => {
		const held = { state: "configuration_required", message: "Set requiredWorkflows again with jobName and stepName" };
		const h = setup({ settings: { requiredWorkflows: gate.slice(0, 1) }, gate: held });
		const res = await h.run("get_instance_release_notes", { instance_id: "i1" });
		expect(JSON.parse(res.content[0].text).gate).toEqual(held);
	});
});
