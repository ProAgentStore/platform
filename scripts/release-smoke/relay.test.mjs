/** #1369: the smoke platform must satisfy the CLI's real relay probe, without skipping it. */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runProbe, webSocketRoundTrip } from "../../packages/cli/src/commands/runner/probe.ts";
import { attachProbeRelay } from "./relay.mjs";

const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture() {
	const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
	const relay = attachProbeRelay(server, { instanceId: "smoke-i1", token: "smoke" });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise((resolve) => { relay.close(); server.closeAllConnections(); server.close(resolve); }));
	return `ws://127.0.0.1:${server.address().port}`;
}

describe("release smoke relay", () => {
	it("passes the actual candidate probe only after a real WebSocket round trip", async () => {
		const base = await fixture();
		const result = await runProbe({ version: "0.4.183", expect: "0.4.183", hasSession: () => true,
			listInstances: async () => ["smoke-i1"], mintRelayToken: async () => "smoke",
			roundTrip: webSocketRoundTrip(base, "pags-probe-smoke", 1000) });
		expect(result.ok).toBe(true);
		expect(result.steps.find((s) => s.name === "relay")).toMatchObject({ ok: true, detail: expect.stringMatching(/opened and answered/) });
	});

	it.each([["wrong-instance", "smoke"], ["smoke-i1", "wrong-token"]])("cannot pass a probe for %s with token %s", async (id, token) => {
		const base = await fixture();
		await expect(webSocketRoundTrip(base, "pags-probe-smoke", 1000)(id, token)).rejects.toThrow();
	});

	it("does not upgrade an ordinary runtime connection", async () => {
		const base = await fixture();
		const result = await new Promise((resolve) => {
			const socket = new WebSocket(`${base}/v1/relay/smoke-i1/connect?token=smoke`);
			socket.onopen = () => { socket.close(); resolve("opened"); };
			socket.onerror = () => resolve("refused");
		});
		expect(result).toBe("refused");
	});
});
