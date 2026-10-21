/**
 * #1168 — a relay socket the network dropped silently never fires `onclose`. The CLI now notices: after a bounded silence it
 * sends its own echo probe, and no answer means the socket is replaced. Any inbound frame is proof of life.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRelaySocket, RTT_ECHO_PREFIX, RTT_PROBE_PREFIX } from "./relay.js";

const lines: string[] = [];
vi.mock("../../output.js", () => ({ writeLine: (l: string) => void lines.push(l), writeError: () => undefined }));

class FakeSocket {
	static all: FakeSocket[] = [];
	sent: string[] = [];
	closedByCli = false;
	sendThrows = false;
	onopen?: (() => void) | null;
	onmessage?: ((e: { data: string }) => Promise<void>) | null;
	onclose?: ((e: { code: number; reason: string }) => void) | null;
	onerror?: (() => void) | null;
	constructor(public url: string) {
		FakeSocket.all.push(this);
	}
	send(data: string) {
		if (this.sendThrows) throw new Error("socket is closed");
		this.sent.push(data);
	}
	close() {
		this.closedByCli = true;
	}
	probes() {
		return this.sent.filter((m) => m.startsWith(RTT_PROBE_PREFIX));
	}
	/** The relay answering our latest probe. */
	async echo() {
		const id = this.probes().at(-1)?.slice(RTT_PROBE_PREFIX.length);
		await this.onmessage?.({ data: `${RTT_ECHO_PREFIX}${id}` });
	}
}

const LIVENESS = { idleMs: 60_000, probeTimeoutMs: 10_000, checkEveryMs: 15_000 };

beforeEach(() => {
	vi.useFakeTimers();
	FakeSocket.all = [];
	lines.length = 0;
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function open() {
	const handle = openRelaySocket("inst-1", "wss://api.test", async () => "relay-token", "http://127.0.0.1:9", "rt", false, undefined, undefined, undefined, undefined, undefined, undefined, LIVENESS);
	await vi.advanceTimersByTimeAsync(0);
	const ws = FakeSocket.all[0];
	ws.onopen?.();
	return { handle, ws };
}

describe("half-open relay socket (#1168)", () => {
	it("a socket that goes silent and ignores a probe is replaced, even though it never fires onclose", async () => {
		const { handle, ws } = await open();
		await vi.advanceTimersByTimeAsync(60_000); // the check at 60s finds a minute of silence
		expect(ws.probes()).toHaveLength(1); // the CLI asked, rather than assuming
		expect(FakeSocket.all).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(10_000); // no echo
		expect(ws.closedByCli).toBe(true);
		expect(ws.onclose).toBeNull(); // detached: its own close event can neither double-schedule nor reconnect twice
		expect(lines.some((l) => /half-open/.test(l))).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(FakeSocket.all).toHaveLength(2);
		expect(FakeSocket.all[1]).not.toBe(ws);
		handle.close();
	});

	it("a quiet but healthy socket is probed, answers, and is kept", async () => {
		const { handle, ws } = await open();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(ws.probes()).toHaveLength(1);
		await ws.echo();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(ws.closedByCli).toBe(false);
		expect(FakeSocket.all).toHaveLength(1);
		handle.close();
	});

	it("any inbound frame counts as life: a busy socket is never probed", async () => {
		const { handle, ws } = await open();
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(30_000);
			await ws.onmessage?.({ data: "ping" });
		}
		expect(ws.probes()).toEqual([]);
		expect(ws.sent.filter((m) => m === "pong")).toHaveLength(10);
		handle.close();
	});

	it("traffic that arrives while the probe is out saves the socket even if the echo itself is lost", async () => {
		const { handle, ws } = await open();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(ws.probes()).toHaveLength(1);
		await ws.onmessage?.({ data: "ping" });
		await vi.advanceTimersByTimeAsync(11_000);
		expect(ws.closedByCli).toBe(false);
		handle.close();
	});

	it("a probe that cannot even be written replaces the socket at once", async () => {
		const { handle, ws } = await open();
		ws.sendThrows = true;
		await vi.advanceTimersByTimeAsync(75_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(ws.closedByCli).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(FakeSocket.all).toHaveLength(2);
		handle.close();
	});

	it("the replacement socket is watched too, and a normal close still reconnects exactly once", async () => {
		const { handle, ws } = await open();
		await vi.advanceTimersByTimeAsync(100_000);
		await vi.advanceTimersByTimeAsync(1_000);
		const second = FakeSocket.all[1];
		second.onopen?.();
		await vi.advanceTimersByTimeAsync(100_000);
		expect(second.probes().length).toBeGreaterThan(0);
		await vi.advanceTimersByTimeAsync(11_000);
		expect(second.closedByCli).toBe(true);
		expect(ws.closedByCli).toBe(true);
		handle.close();
	});

	it("an ordinary onclose still reconnects once, and the old socket's watchdog stops probing", async () => {
		const { handle, ws } = await open();
		ws.onclose?.({ code: 1006, reason: "" });
		await vi.advanceTimersByTimeAsync(1_000);
		expect(FakeSocket.all).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(ws.probes()).toEqual([]);
		handle.close();
	});

	it("close() stops the watchdog: no probe and no reconnect after the handle is closed", async () => {
		const { handle, ws } = await open();
		handle.close();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(ws.probes()).toEqual([]);
		expect(FakeSocket.all).toHaveLength(1);
	});
});
