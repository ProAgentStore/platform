/**
 * #1358 — the relay gives up on a command at two minutes, but the CLI went on forwarding it to the local runtime for up to ten, holding
 * its mutation slot (and so an update drain) the whole time. The relay now sends `{ type: "cancel", id }` when it times out; the CLI
 * stops the forward for that id, sends no reply (the relay's caller was already told), and lets go of the slot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayMutationAdmission } from "./auto-update-controller.js";
import { openRelaySocket, relayLimits } from "./relay.js";

vi.mock("../../output.js", () => ({ writeLine: () => undefined, writeError: () => undefined }));

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

class FakeSocket {
	static last: FakeSocket;
	sent: string[] = [];
	onopen?: (() => void) | null;
	onmessage?: ((e: { data: string }) => Promise<void>) | null;
	onclose?: ((e: { code: number; reason: string }) => void) | null;
	onerror?: (() => void) | null;
	constructor(public url: string) {
		FakeSocket.last = this;
	}
	send(d: string) {
		this.sent.push(d);
	}
	close() {}
}

/** A local runtime whose requests never answer on their own; each records its signal and rejects when it is aborted. */
function hangingRuntime() {
	const signals = new Map<string, AbortSignal>();
	vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
		const path = url.replace("http://127.0.0.1:9", "");
		if (init.signal) signals.set(path, init.signal);
		return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
	});
	return signals;
}

async function open() {
	vi.stubGlobal("WebSocket", FakeSocket);
	const admission = new RelayMutationAdmission();
	const handle = openRelaySocket("inst-1", "wss://api.test", async () => "t", "http://127.0.0.1:9", "rt", false, undefined, undefined, undefined, undefined, () => admission.begin());
	await vi.waitFor(() => expect(FakeSocket.last?.onmessage).toBeDefined());
	const ws = FakeSocket.last;
	const send = (frame: unknown) => ws.onmessage?.({ data: JSON.stringify(frame) });
	return { admission, handle, ws, send };
}

describe("a cancel from the relay stops the forward it names (#1358)", () => {
	it("aborts the local request, sends no reply, and releases the mutation slot", async () => {
		const signals = hangingRuntime();
		const { admission, handle, ws, send } = await open();
		const forwarded = send({ id: "slow-1", method: "POST", path: "/coding/act", body: {} });
		await vi.waitFor(() => expect(admission.pending()).toBe(1));
		expect(signals.get("/coding/act")?.aborted).toBe(false);

		await send({ type: "cancel", id: "slow-1" });
		await forwarded;

		expect(signals.get("/coding/act")?.aborted).toBe(true);
		expect(admission.pending()).toBe(0); // the slot an update drain waits on is free again
		expect(ws.sent).toEqual([]); // the relay's caller was already told it timed out; a late reply would be noise
		handle.close();
	});

	it("cancels only the command it names", async () => {
		const signals = hangingRuntime();
		const { admission, handle, send } = await open();
		const a = send({ id: "a", method: "POST", path: "/coding/act", body: {} });
		const b = send({ id: "b", method: "POST", path: "/tmux/send", body: {} });
		await vi.waitFor(() => expect(admission.pending()).toBe(2));

		await send({ type: "cancel", id: "a" });
		await a;

		expect(signals.get("/coding/act")?.aborted).toBe(true);
		expect(signals.get("/tmux/send")?.aborted).toBe(false);
		expect(admission.pending()).toBe(1);
		// settle b so the test leaves nothing hanging
		await send({ type: "cancel", id: "b" });
		await b;
		handle.close();
	});

	it("ignores a cancel for a command it never had, or already finished, without throwing", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
		const { ws, send, handle } = await open();
		await send({ type: "cancel", id: "never-seen" });
		await send({ id: "done-1", method: "POST", path: "/coding/act", body: {} });
		expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({ id: "done-1", status: 200 });
		const before = ws.sent.length;
		await send({ type: "cancel", id: "done-1" }); // too late to matter
		expect(ws.sent.length).toBe(before);
		handle.close();
	});

	it("still answers 504 when the forward's own limit fires first — the backstop for a relay that never cancels", async () => {
		hangingRuntime();
		const previous = relayLimits.forwardMs;
		relayLimits.forwardMs = 40;
		try {
			const { ws, send, handle, admission } = await open();
			await send({ id: "backstop-1", method: "POST", path: "/coding/act", body: {} });
			expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({ id: "backstop-1", status: 504, error: expect.stringContaining("did not answer within") });
			expect(admission.pending()).toBe(0);
			handle.close();
		} finally {
			relayLimits.forwardMs = previous;
		}
	});

	it("a frame with a type and no path is not a command — an older CLI would have dropped it the same way", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const { send, handle } = await open();
		await send({ type: "cancel" });
		await send({ type: "something-new", id: "x" });
		expect(fetchSpy).not.toHaveBeenCalled();
		handle.close();
	});
});
