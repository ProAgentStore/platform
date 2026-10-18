/**
 * #1166 — a terminal pane is not readable without the owner's consent.
 *
 * A pane holds what the owner typed and what tools printed: a password at a prompt that echoed it, a
 * token a CLI wrote out. `tmux_capture_pane` and `terminal_capture` used to be `read`, so any agent on
 * the account with a runner online could read any pane. They now answer to the same per-instance consent
 * as the terminal writes. Through `runRegistryTool`, over the real schema; only the relay is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getBoundRunnerConn, callRunner } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn(), callRunner: vi.fn() }));
vi.mock("../runner-client.js", async (orig) => ({ ...(await orig<typeof import("../runner-client.js")>()), getBoundRunnerConn, callRunner }));

import { runRegistryTool } from "../tool-registry.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../d1-sqlite.js";
import type { Env } from "../../types.js";

const PANE = "$ sudo -k\n$ export DB_PASSWORD=hunter2-in-the-scrollback\n$ ";
let d1: RealSchemaD1;
let env: Env;
let relayed: string[];

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "owner", instanceIds: ["i1"] });
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: "0".repeat(64) } as unknown as Env;
	relayed = [];
	getBoundRunnerConn.mockReset().mockResolvedValue({ runnerNode: "mac-mini", instanceId: "i1" });
	callRunner.mockReset().mockImplementation(async (_conn: unknown, path: string) => {
		relayed.push(path);
		return { session: "main", target: "tmux:main", pane: PANE, targets: [] };
	});
});
afterEach(() => d1.close());

const consent = (connector: string) => d1.exec(`INSERT INTO instance_connector_consent (instance_id, user_id, connector, scope) VALUES ('i1', 'owner', '${connector}', 'write')`);
const run = (tool: string, input: Record<string, unknown>) => runRegistryTool(tool, { env, userId: "owner", agentId: "agent-1", instanceId: "i1" }, input);

describe("reading a pane needs the owner's terminal consent (#1166)", () => {
	for (const [tool, connector, input] of [
		["tmux_capture_pane", "tmux", { session: "main" }],
		["terminal_capture", "terminal", { target: "tmux:main" }],
	] as const) {
		it(`${tool}: refused without ${connector} consent — the machine is never asked, and the pane never seen`, async () => {
			const r = await run(tool, input);
			expect(r.success).toBe(false);
			expect(r.content).not.toContain("hunter2");
			expect(relayed).toEqual([]);
		});

		it(`${tool}: allowed once the owner grants ${connector} consent`, async () => {
			consent(connector);
			const r = await run(tool, input);
			expect(r.success).toBe(true);
			expect(relayed.some((p) => p.endsWith("/capture"))).toBe(true);
		});
	}

	it("listing sessions stays a plain read — names, not contents", async () => {
		const r = await run("tmux_list_sessions", {});
		expect(relayed).toEqual(["/tmux/list"]);
		expect(r.content).not.toContain("hunter2");
	});
});
