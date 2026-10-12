import { describe, expect, it } from "vitest";
// Deployment verification runs as native Node ESM in GitHub Actions.
// @ts-expect-error The deployment script intentionally has no TypeScript build.
import { assertIdentity, expectedIdentity, pollIdentity } from "../../../scripts/smoke-mcp-deployment.mjs";

describe("MCP deployment identity smoke check", () => {
	const expected = expectedIdentity('export const MCP_SERVER_VERSION = "1.2.3";', 'export const MCP_TOOL_COUNT = 246;', '"1.2.3": "sha256:catalog"', "commit");
	const healthy = { ...expected, ok: true, deployed_at: "2026-10-03T00:00:00Z" };
	it("extracts the exact version, count, locked schema and build", () => {
		expect(expected).toEqual({ server_name: "ProAgentStore", server_version: "1.2.3", tool_count: 246, schema_revision: "sha256:catalog", build_commit: "commit" });
		expect(() => assertIdentity(healthy, expected)).not.toThrow();
	});
	it.each(["server_version", "tool_count", "schema_revision", "build_commit"])("rejects stale %s even on HTTP 200", (key) => {
		expect(() => assertIdentity({ ...healthy, [key]: "stale" }, expected)).toThrow(key);
	});
	it("requires a deployment timestamp", () => {
		expect(() => assertIdentity({ ...healthy, deployed_at: "unknown" }, expected)).toThrow("timestamp");
	});
});

describe("MCP version propagation polling (#1051)", () => {
	const expected = expectedIdentity('export const MCP_SERVER_VERSION = "0.1.126";', "export const MCP_TOOL_COUNT = 246;", '"0.1.126": "sha256:catalog"', "3b687eb2");
	const live = { ...expected, ok: true, deployed_at: "2026-10-12T17:21:41Z" };
	const stale = { ...live, server_version: "0.1.125", schema_revision: "sha256:old", build_commit: "70faccec" };
	const clock = () => {
		let t = 0;
		return { now: () => t, sleep: async (ms: number) => {
			t += ms;
		} };
	};

	it("succeeds once the new version is served after a propagation delay", async () => {
		const responses = [stale, stale, stale, live];
		const lines: string[] = [];
		const result = await pollIdentity({ expected, fetchHealth: async () => responses.shift(), ...clock(), intervalMs: 10_000, windowMs: 180_000, log: (l: string) => lines.push(l) });
		expect(result).toEqual({ attempts: 4, elapsedMs: 30_000 });
		expect(lines[0]).toContain("attempt 1 at 0.0s: expected 0.1.126 3b687eb2, observed 0.1.125 70faccec");
		expect(lines.at(-1)).toContain("verified after 30.0s (attempt 4)");
	});

	it("retries transport errors inside the window", async () => {
		const responses: Array<() => unknown> = [() => { throw new Error("MCP health HTTP 522"); }, () => live];
		const result = await pollIdentity({ expected, fetchHealth: async () => responses.shift()!(), ...clock(), log: () => {} });
		expect(result.attempts).toBe(2);
	});

	it("fails after the bounded window when the old version is still served, with diagnostics", async () => {
		const c = clock();
		let calls = 0;
		const run = pollIdentity({ expected, fetchHealth: async () => {
			calls++;
			return stale;
		}, ...c, intervalMs: 10_000, windowMs: 60_000, log: () => {} });
		await expect(run).rejects.toThrow(/not serving the expected identity after 60\.0s \(window 60s\)/);
		await expect(run).rejects.toThrow(/server_version: expected 0\.1\.126, received 0\.1\.125/);
		await expect(run).rejects.toThrow(/"build_commit":"70faccec"/);
		await expect(run).rejects.toThrow(/Cloudflare dashboard/);
		expect(calls).toBe(7);
		expect(c.now()).toBe(60_000);
	});

	it("never accepts an older version, even one that is otherwise healthy", async () => {
		const olderOnly = { ...live, server_version: "0.1.125" };
		await expect(pollIdentity({ expected, fetchHealth: async () => olderOnly, ...clock(), windowMs: 20_000, log: () => {} })).rejects.toThrow("server_version");
	});

	it("reports when no health response ever succeeded", async () => {
		await expect(
			pollIdentity({ expected, fetchHealth: async () => { throw new Error("MCP health HTTP 503"); }, ...clock(), windowMs: 10_000, log: () => {} }),
		).rejects.toThrow(/Observed: no successful health response/);
	});
});
