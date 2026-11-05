/** #1555: detach and connection attempts have one bounded, disposable owner. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRelaySocket, type RelaySocketHandle } from "./relay.js";
vi.mock("../../output.js", () => ({ writeLine: () => undefined, writeError: () => undefined }));
class FakeSocket {
	static OPEN = 1;
	static all: FakeSocket[] = [];
	readyState = 0;
	closed = false;
	sent: string[] = [];
	onopen?: (() => void) | null;
	onmessage?: ((event: { data: string }) => Promise<void>) | null;
	onclose?: ((event: { code: number; reason: string }) => void) | null;
	onerror?: (() => void) | null;
	constructor(public url: string) { FakeSocket.all.push(this); }
	send(data: string) { this.sent.push(data); }
	close() { this.closed = true; }
	open() { this.readyState = 1; this.onopen?.(); }
}
let handles: RelaySocketHandle[];
beforeEach(() => { vi.useFakeTimers(); handles = []; FakeSocket.all = []; vi.stubGlobal("WebSocket", FakeSocket); });
afterEach(() => { for (const handle of handles) handle.close(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function start(mint: (signal?: AbortSignal) => Promise<string> = async () => "inert", onOpen = vi.fn()) {
	const handle = openRelaySocket("fixture", "wss://fixture.test", mint, "http://local.test", "inert", false, undefined, onOpen);
	handles.push(handle); return { handle, onOpen };
}

describe("relay attempt disposal", () => {
	it("closing during token mint prevents the late token from opening a ghost socket", async () => {
		let release!: (token: string) => void;
		const { handle } = start(() => new Promise((resolve) => { release = resolve; }));
		handle.close(); release("inert"); await vi.advanceTimersByTimeAsync(0);
		expect(FakeSocket.all).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("closing during mint aborts its IO and suppresses a late rejection/retry", async () => {
		let reject!: (error: Error) => void;
		let signal: AbortSignal | undefined;
		const { handle } = start((given) => { signal = given; return new Promise((_, no) => { reject = no; }); });
		handle.close(); reject(new Error("late network error")); await vi.advanceTimersByTimeAsync(0);
		expect(signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("a hung mint times out and retries instead of permanently losing this agent", async () => {
		const mint = vi.fn(async () => new Promise<string>(() => undefined)); start(mint);
		await vi.advanceTimersByTimeAsync(16_000);
		expect(mint).toHaveBeenCalledTimes(2);
	});
	it("a socket that never opens or closes is disposed and retried after the opening deadline", async () => {
		start(); await vi.advanceTimersByTimeAsync(0);
		const first = FakeSocket.all[0];
		await vi.advanceTimersByTimeAsync(21_000);
		expect(first.closed).toBe(true);
		expect(FakeSocket.all).toHaveLength(2);
	});
	it("a WebSocket constructor failure retries without an unhandled rejection", async () => {
		let constructions = 0;
		class ThrowsOnce extends FakeSocket { constructor(url: string) { if (++constructions === 1) throw new Error("bad handshake"); super(url); } }
		vi.stubGlobal("WebSocket", ThrowsOnce); start();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(constructions).toBe(2); expect(FakeSocket.all).toHaveLength(1);
	});
	it("saved callbacks from a detached socket cannot reopen it or dispatch more work", async () => {
		const { handle, onOpen } = start(); await vi.advanceTimersByTimeAsync(0);
		const ws = FakeSocket.all[0], opened = ws.onopen, message = ws.onmessage;
		const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
		handle.close(); opened?.();
		await message?.({ data: JSON.stringify({ id: "stale", path: "/coding/act" }) });
		expect(onOpen).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("closing a live socket settles its pending RTT probes immediately", async () => {
		const { handle } = start(); await vi.advanceTimersByTimeAsync(0); FakeSocket.all[0].open();
		let settled = false;
		const pending = handle.probeRtt().then((rtt) => { settled = true; return rtt; });
		handle.close(); await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(true); expect(await pending).toBeNull(); expect(vi.getTimerCount()).toBe(0);
	});
	it("transient socket replacement neither aborts nor replays an already forwarded mutation", async () => {
		let finish!: (value: Response) => void;
		let signal: AbortSignal | undefined;
		const fetchMock = vi.fn((_url: string, init: RequestInit) => { signal = init.signal ?? undefined; return new Promise<Response>((resolve) => { finish = resolve; }); });
		vi.stubGlobal("fetch", fetchMock);
		const { handle } = start(); await vi.advanceTimersByTimeAsync(0); const ws = FakeSocket.all[0]; ws.open();
		const forwarded = ws.onmessage?.({ data: JSON.stringify({ id: "inflight", path: "/coding/act", body: {} }) });
		ws.onclose?.({ code: 1006, reason: "network changed" }); await vi.advanceTimersByTimeAsync(1_000);
		expect(signal?.aborted).toBe(false); expect(fetchMock).toHaveBeenCalledOnce();
		finish(new Response("{}")); await forwarded; handle.close();
	});
});
