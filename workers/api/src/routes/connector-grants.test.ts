// #352 — a folder grant is refused for an agent that cannot use a file connector.
//
// At the ROUTE, deliberately, and not only at the rule: `4c03862` made the console stop offering
// the grant panel to such an agent, but the panel is one of three doors onto the same table — the
// console, this route, and MCP's `grant_instance_connector_folder`, which posts here. A gate that
// only the console consults is a suggestion, and the thing being decided is what an agent may
// ever read.
//
// The network is not stubbed at all, and that is part of the assertion: a refusal that reached
// Google would mean the gate ran after the round trip. `fetch` is left to fail loudly instead.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { driveRoutes } from "./drive.js";
import { workdriveRoutes } from "./workdrive.js";

const TEST_SECRET = "test-secret";
const USER = "user-1";
const INSTANCE = "inst-1";

/**
 * A D1 double answering the two reads the gate makes — the instance row and the agent's declared
 * capabilities — and nothing else. `user_api_keys` deliberately comes back EMPTY: an agent that
 * passes the gate then fails on "not connected", which is how a test proves the request got past
 * the gate without needing a real Drive credential.
 */
function testEnv(agentTools: string[] | null, opts: { disabledTools?: string[] } = {}) {
	const instanceConfig = opts.disabledTools ? JSON.stringify({ disabledTools: opts.disabledTools }) : "{}";
	const agentConfig = agentTools ? JSON.stringify({ capabilities: { surfaces: [], runtime: null, workflow: null, tools: agentTools } }) : "{}";
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					const a = args as string[];
					return {
						async first() {
							if (sql.includes("FROM agent_instances i JOIN agents a")) {
								return a[0] === INSTANCE && a[1] === USER ? { slug: "some-agent", category: null, config: agentConfig } : null;
							}
							if (sql.includes("FROM agent_instances")) {
								return a[0] === INSTANCE && a[1] === USER
									? { id: INSTANCE, agent_id: "agent-1", user_id: USER, status: "active", config: instanceConfig }
									: null;
							}
							// user_api_keys — nobody has connected anything on this deployment.
							return null;
						},
						async all() {
							return { results: [] };
						},
						async run() {
							return { success: true };
						},
					};
				},
			};
		},
	};
	return { DB, SESSION_SIGNING_KEY: TEST_SECRET, KEY_ENCRYPTION_KEY: "0".repeat(64) } as unknown as Env;
}

function app() {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/drive", driveRoutes);
	a.route("/v1/workdrive", workdriveRoutes);
	a.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	return a;
}

async function grant(env: Env, base: "drive" | "workdrive") {
	const res = await app().request(
		`/v1/${base}/instances/${INSTANCE}/grants`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${await signSession(USER, TEST_SECRET)}`, "Content-Type": "application/json" },
			body: JSON.stringify({ url: "https://drive.google.com/drive/folders/abc123" }),
		},
		env,
	);
	return { status: res.status, body: (await res.json()) as { error?: string } };
}

describe("#352 — granting a folder is gated on the agent, not on the account", () => {
	// The steady state the issue is about: one `user_api_keys` row is the whole account's Drive
	// connection, so "is Drive connected" answers the same for every agent the owner has. Only
	// the agent differs between these two cases.
	it("refuses a terminal Operator, naming the tools it would have to declare", async () => {
		for (const base of ["drive", "workdrive"] as const) {
			const { status, body } = await grant(testEnv(["tmux_capture_pane", "tmux_send_keys"]), base);
			expect(status).toBe(403);
			expect(body.error).toMatch(/knowledge base/);
			expect(body.error).toMatch(/search_knowledge/);
		}
	});

	it("lets an agent that reads its knowledge base through — the refusal is about reach, not about Drive", async () => {
		for (const base of ["drive", "workdrive"] as const) {
			const { status, body } = await grant(testEnv(["search_knowledge"]), base);
			// 400 "not connected" comes from the step AFTER the gate, so passing it is the proof.
			expect(status).toBe(400);
			expect(body.error).toMatch(/not connected/);
		}
	});

	// An agent that declares no allowlist gets the permissive per-surface default, which includes
	// the knowledge tools. Every agent on the platform predates `capabilities.tools`, so a gate
	// that read "declares nothing" as "may have nothing" would refuse most of them.
	it("does not refuse an agent that declares no allowlist at all", async () => {
		const { status } = await grant(testEnv(null), "drive");
		expect(status).toBe(400);
	});

	// The owner's own off-switch counts. If they turned the knowledge tools off on their copy,
	// the agent cannot read what the folder would import, whatever the creator declared.
	it("honours the owner's per-instance off-switches, not just the creator's declaration", async () => {
		const env = testEnv(["search_knowledge", "list_knowledge", "read_knowledge"], {
			disabledTools: ["search_knowledge", "list_knowledge", "read_knowledge"],
		});
		const { status, body } = await grant(env, "drive");
		expect(status).toBe(403);
		expect(body.error).toMatch(/knowledge base/);
	});
});
