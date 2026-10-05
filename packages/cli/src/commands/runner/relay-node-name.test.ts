/**
 * The relay socket connects under the name the process registers and heartbeats under (#922).
 *
 * It used to read `os.hostname()` afresh on every (re)connect while registration and the heartbeat
 * kept the name read at startup. macOS renames a machine under a running process (`Sergeys-Mac-mini
 * .local` → `Macmini`), so after the next reconnect the socket sat in a relay slot nobody's row named:
 * list_runner_nodes probed the registered name and showed the live machine disconnected with a fresh
 * `lastSeenAt`, and the slot that did hold the socket reported a `lastSeenAt` weeks old.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ name: "Drifted-Name" }));
vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return { ...actual, hostname: () => host.name };
});
vi.mock("../../output.js", () => ({ writeLine: () => undefined, writeError: () => undefined }));

const { openRelaySocket } = await import("./relay.js");

class FakeSocket {
	static urls: string[] = [];
	static last: FakeSocket;
	onopen?: () => void;
	onmessage?: (e: { data: string }) => Promise<void>;
	onclose?: (e: { code: number; reason: string }) => void;
	onerror?: () => void;
	constructor(public url: string) {
		FakeSocket.urls.push(url);
		FakeSocket.last = this;
	}
	send() {}
	close() {}
}

beforeEach(() => {
	FakeSocket.urls = [];
	host.name = "Drifted-Name";
	vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

const nodeOf = (url: string) => new URL(url).searchParams.get("node");

describe("the relay socket's node name (#922)", () => {
	it("is the name it was opened with, not whatever the hostname reads at connect time", async () => {
		const handle = openRelaySocket("inst-1", "wss://api.test", async () => "relay-token", "http://127.0.0.1:9", "rt", false, undefined, undefined, undefined, "Registered-Name");
		await vi.waitFor(() => expect(FakeSocket.urls).toHaveLength(1));
		expect(nodeOf(FakeSocket.urls[0])).toBe("Registered-Name");
		handle.close();
	});

	it("keeps that name across a reconnect after the hostname has moved", async () => {
		host.name = "Sergeys-Mac-mini.local";
		const handle = openRelaySocket("inst-1", "wss://api.test", async () => "relay-token", "http://127.0.0.1:9", "rt", false, undefined, undefined, undefined, "Sergeys-Mac-mini.local");
		await vi.waitFor(() => expect(FakeSocket.urls).toHaveLength(1));
		// macOS renames the machine under the running process, then the socket drops (a sleep, a
		// network change) and the runner reconnects on its backoff.
		host.name = "Macmini";
		FakeSocket.last.onclose?.({ code: 1006, reason: "" });
		await vi.waitFor(() => expect(FakeSocket.urls).toHaveLength(2), { timeout: 3000 });
		expect(FakeSocket.urls.map(nodeOf)).toEqual(["Sergeys-Mac-mini.local", "Sergeys-Mac-mini.local"]);
		handle.close();
	});

	it("still defaults to the hostname for a caller that names none", async () => {
		const handle = openRelaySocket("inst-1", "wss://api.test", async () => "relay-token", "http://127.0.0.1:9", "rt");
		await vi.waitFor(() => expect(FakeSocket.urls).toHaveLength(1));
		expect(nodeOf(FakeSocket.urls[0])).toBe("Drifted-Name");
		handle.close();
	});
});
