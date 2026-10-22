/**
 * #1286: release notes are a coding-agent integration. Eligibility is the instance's declared capabilities — never its name or slug.
 * Real schema; the release-note routes and the release-notes Discord grant purpose answer 422 for anything that is not a coder,
 * leave stored settings alone, and keep ordinary Discord grants as they were.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { releaseNotesEligible } from "../lib/release-notes-eligibility.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { instanceReleaseNotesRoutes } = await import("./instances-release-notes.js");
const { discordRoutes } = await import("./discord.js");

let d1: RealSchemaD1;
const caps = (c: unknown) => JSON.stringify({ capabilities: c });
const agent = (id: string, slug: string, name: string, config: string) => d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('${id}', 'u1', '${slug}', '${name}', '${config}')`);
const instance = (id: string, agentId: string, config = "{}") => d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('${id}', '${agentId}', 'u1', 'active', '${config}')`);

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1')");
	agent("chat", "t1286-coder", "Coder", caps({ surfaces: [], runtime: null })); // named like a coder, is not one
	agent("renamed", "t1286-banana", "Banana", caps({ surfaces: ["coding"], runtime: "coding", tools: [] })); // a coder with no Discord/Slack tools
	agent("wf", "t1286-wf", "Workflow only", caps({ surfaces: [], runtime: "coding", workflow: "CODING_SESSION" }));
	instance("i-chat", "chat", JSON.stringify({ releaseNotes: { enabled: false, channels: ["g1"] } }));
	instance("i-renamed", "renamed");
	instance("i-wf", "wf");
});
afterEach(() => d1.close());

const app = () => {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/instances", instanceReleaseNotesRoutes);
	a.route("/v1/discord", discordRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
};
const call = async (path: string, method = "GET", body?: unknown) => {
	const res = await app().request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, { DB: d1.DB } as unknown as Env);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("releaseNotesEligible", () => {
	it("is the declared coding surface or workflow — and nothing else", () => {
		expect(releaseNotesEligible({ surfaces: ["coding"], workflow: null })).toBe(true);
		expect(releaseNotesEligible({ surfaces: [], workflow: "CODING_SESSION" })).toBe(true);
		expect(releaseNotesEligible({ surfaces: ["apply"], workflow: "JOB_APPLY" })).toBe(false);
		expect(releaseNotesEligible({ surfaces: [], workflow: null })).toBe(false);
		expect(releaseNotesEligible(null)).toBe(false);
	});
});

describe("a non-coder has no release notes to configure (#1286)", () => {
	it("GET, PUT and the test send answer 422 with the unsupported-feature reason — even for an agent named 'Coder'", async () => {
		for (const [path, method, body] of [
			["/v1/instances/i-chat/release-notes", "GET", undefined],
			["/v1/instances/i-chat/release-notes", "PUT", { enabled: true }],
			["/v1/instances/i-chat/release-notes/test", "POST", { grantId: "g1" }],
		] as const) {
			const r = await call(path, method, body);
			expect(r.status, `${method} ${path}`).toBe(422);
			expect(String(r.body.error)).toMatch(/coding-agent feature/);
		}
	});

	it("a release-notes channel grant is refused before Discord is asked; nothing stored is changed or deleted", async () => {
		const r = await call("/v1/discord/instances/i-chat/grants", "POST", { channelId: "123456789012345678", purpose: "release_notes" });
		expect(r.status).toBe(422);
		const row = d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = 'i-chat'").get() as { config: string };
		expect(JSON.parse(row.config)).toEqual({ releaseNotes: { enabled: false, channels: ["g1"] } });
	});

	it("an ordinary Discord grant for that agent is NOT answered as a release-notes matter", async () => {
		const r = await call("/v1/discord/instances/i-chat/grants", "POST", { channelId: "123456789012345678" });
		expect(String(r.body.error ?? "")).not.toMatch(/coding-agent feature/);
	});
});

describe("a coder keeps its release notes (#1286)", () => {
	it.each(["i-renamed", "i-wf"])("%s: the setting reads and writes, whatever it is called and with no Discord or Slack tools", async (id) => {
		const got = await call(`/v1/instances/${id}/release-notes`);
		expect(got.status).toBe(200);
		expect(got.body).toHaveProperty("effective");
		const put = await call(`/v1/instances/${id}/release-notes`, "PUT", { enabled: false });
		expect(put.status).toBe(200);
		expect((put.body.settings as { enabled: boolean }).enabled).toBe(false);
	});

	it("the coder's test send gets past the capability gate (and fails only on the unknown grant)", async () => {
		const r = await call("/v1/instances/i-renamed/release-notes/test", "POST", { grantId: "nope" });
		expect(String(r.body.error ?? "")).not.toMatch(/coding-agent feature/);
	});
});
