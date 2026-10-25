/**
 * #1358 — the real RelayDO tells the runner it has stopped waiting. The relay's command cap is two minutes; the CLI used to go on
 * forwarding for up to ten, because nothing told it the caller had already been answered with a timeout. On timeout the relay now sends
 * `{ type: "cancel", id }` to the socket the command went to, and to no other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
	class DurableObject {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	}
	return { DurableObject, WorkflowEntrypoint: DurableObject };
});

import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./lib/d1-sqlite.js";
import type { Env } from "./types.js";

const { RelayDO } = await import("./relay-do.js");

let d1: RealSchemaD1;
let env: Env;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["iA"] });
	env = { DB: d1.DB } as unknown as Env;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
	d1.close();
	vi.restoreAllMocks();
});

/** A runner socket that answers pings (so the liveness gate passes) and records every frame it is sent. */
function runnerSocket(onPing: (self: WebSocket) => void) {
	const sent: string[] = [];
	const socket = {
		send(data: string) {
			sent.push(data);
			if (data === "ping") queueMicrotask(() => onPing(socket as unknown as WebSocket));
		},
		close() {},
	};
	return { socket, sent };
}

function relayWith(sockets: Array<ReturnType<typeof runnerSocket>>) {
	const state = { id: { name: "iA:node:mac" }, getWebSockets: () => sockets.map((s) => s.socket), acceptWebSocket: () => undefined };
	const r = new RelayDO(state as unknown as DurableObjectState, env);
	return r;
}

const command = (r: InstanceType<typeof RelayDO>, body: unknown) => r.fetch(new Request("https://relay/command", { method: "POST", body: JSON.stringify(body) }));
const frames = (sent: string[]) => sent.filter((s) => s !== "ping").map((s) => JSON.parse(s) as { id: string; type?: string; path?: string });

describe("the relay cancels a command it gave up on (#1358)", () => {
	it("sends { type: 'cancel', id } for the command that timed out, after the command itself", async () => {
		let relay!: InstanceType<typeof RelayDO>;
		const runner = runnerSocket((self) => void relay.webSocketMessage(self, "pong"));
		relay = relayWith([runner]);

		const res = await command(relay, { path: "/coding/act", timeoutMs: 20 });

		expect(res.status).toBe(504);
		expect(await res.json()).toEqual({ error: "Relay command timed out", code: "RUNNER_RELAY_TIMEOUT" });
		const [cmd, cancel] = frames(runner.sent);
		expect(cmd).toMatchObject({ path: "/coding/act" });
		expect(cancel).toEqual({ type: "cancel", id: cmd.id }); // exactly the id it sent, and no path: an older CLI drops it as noise
	});

	it("sends no cancel for a command that was answered in time", async () => {
		let relay!: InstanceType<typeof RelayDO>;
		const runner = runnerSocket((self) => void relay.webSocketMessage(self, "pong"));
		relay = relayWith([runner]);

		const pending = command(relay, { path: "/coding/capture", timeoutMs: 5_000 });
		await vi.waitFor(() => expect(frames(runner.sent)).toHaveLength(1));
		const [{ id }] = frames(runner.sent);
		await relay.webSocketMessage(runner.socket as unknown as WebSocket, JSON.stringify({ id, status: 200, result: { pane: "ok" } }));

		expect((await pending).status).toBe(200);
		await new Promise((r) => setTimeout(r, 40));
		expect(frames(runner.sent).filter((f) => f.type === "cancel")).toEqual([]);
	});

	it("cancels only the command that timed out, not one still running beside it", async () => {
		let relay!: InstanceType<typeof RelayDO>;
		const runner = runnerSocket((self) => void relay.webSocketMessage(self, "pong"));
		relay = relayWith([runner]);

		const slow = command(relay, { path: "/coding/act", timeoutMs: 5_000 });
		await vi.waitFor(() => expect(frames(runner.sent)).toHaveLength(1));
		const doomed = await command(relay, { path: "/tmux/send", timeoutMs: 20 });
		expect(doomed.status).toBe(504);

		const [first, second, cancel] = frames(runner.sent);
		expect(first.path).toBe("/coding/act");
		expect(second.path).toBe("/tmux/send");
		expect(cancel).toEqual({ type: "cancel", id: second.id });
		// settle the first so nothing is left hanging
		await relay.webSocketMessage(runner.socket as unknown as WebSocket, JSON.stringify({ id: first.id, status: 200, result: {} }));
		expect((await slow).status).toBe(200);
	});

	it("survives a socket that closed before the cancel could be written", async () => {
		let relay!: InstanceType<typeof RelayDO>;
		const runner = runnerSocket((self) => void relay.webSocketMessage(self, "pong"));
		relay = relayWith([runner]);
		const send = runner.socket.send.bind(runner.socket);
		runner.socket.send = (data: string) => {
			if (data.includes('"cancel"')) throw new Error("socket closed");
			send(data);
		};

		const res = await command(relay, { path: "/coding/act", timeoutMs: 20 });

		expect(res.status).toBe(504); // the caller still gets its timeout; the failed cancel changes nothing it sees
	});
});
