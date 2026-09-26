/**
 * The relay socket answers the cloud's membership-sync command ITSELF (#850) — it is how a repin
 * attaches an agent on this machine without a restart — and forwards every other command to the
 * local runner exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBERSHIP_SYNC_PATH, openRelaySocket } from "./relay.js";
import { RUNNER_UPDATE_PATH } from "./self-update.js";

vi.mock("../../output.js", () => ({ writeLine: () => undefined, writeError: () => undefined }));

class FakeSocket {
	static last: FakeSocket;
	sent: string[] = [];
	onopen?: () => void;
	onmessage?: (e: { data: string }) => Promise<void>;
	onclose?: (e: { code: number; reason: string }) => void;
	onerror?: () => void;
	constructor(public url: string) {
		FakeSocket.last = this;
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {}
}

const forwarded: string[] = [];
beforeEach(() => {
	forwarded.length = 0;
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", async (url: string) => {
		forwarded.push(String(url));
		return new Response(JSON.stringify({ ok: true }), { status: 200 });
	});
});
afterEach(() => vi.unstubAllGlobals());

async function open(onControl?: (path: string) => Promise<{ status: number; result: unknown }>) {
	const handle = openRelaySocket("inst-1", "wss://api.test", async () => "relay-token", "http://127.0.0.1:9", "rt", false, undefined, undefined, onControl);
	await vi.waitFor(() => expect(FakeSocket.last?.onmessage).toBeDefined());
	return { ws: FakeSocket.last, handle };
}

describe("the membership-sync control command (#850)", () => {
	it("is answered by the CLI, not forwarded to the local runner", async () => {
		const onControl = vi.fn(async () => ({ status: 200, result: { attached: ["inst-1", "inst-2"] } }));
		const { ws, handle } = await open(onControl);
		await ws.onmessage?.({ data: JSON.stringify({ id: "c1", path: MEMBERSHIP_SYNC_PATH }) });
		expect(onControl).toHaveBeenCalledWith(MEMBERSHIP_SYNC_PATH, undefined);
		expect(forwarded).toEqual([]);
		expect(JSON.parse(ws.sent[0])).toEqual({ id: "c1", status: 200, result: { attached: ["inst-1", "inst-2"] } });
		handle.close();
	});

	it("hands the cloud's body through — a targeted reattach names its agent (#856)", async () => {
		const onControl = vi.fn(async () => ({ status: 200, result: { attached: ["inst-9"], target: "inst-9", holding: true } }));
		const { ws, handle } = await open(onControl);
		await ws.onmessage?.({ data: JSON.stringify({ id: "c4", path: MEMBERSHIP_SYNC_PATH, body: { attach: "inst-9", force: true } }) });
		expect(onControl).toHaveBeenCalledWith(MEMBERSHIP_SYNC_PATH, { attach: "inst-9", force: true });
		expect(JSON.parse(ws.sent[0])).toMatchObject({ id: "c4", status: 200, result: { target: "inst-9", holding: true } });
		handle.close();
	});

	it("answers runner_update itself too — never forwarded to the local runner (#859)", async () => {
		const onControl = vi.fn(async () => ({ status: 200, result: { action: "restarting", current: "0.4.62", latest: "0.4.63" } }));
		const { ws, handle } = await open(onControl);
		await ws.onmessage?.({ data: JSON.stringify({ id: "c5", path: RUNNER_UPDATE_PATH, body: { dryRun: false } }) });
		expect(onControl).toHaveBeenCalledWith(RUNNER_UPDATE_PATH, { dryRun: false });
		expect(forwarded).toEqual([]);
		expect(JSON.parse(ws.sent[0])).toMatchObject({ id: "c5", status: 200, result: { action: "restarting" } });
		handle.close();
	});

	it("reports a failed sync as a 500 rather than leaving the cloud waiting", async () => {
		const { ws, handle } = await open(async () => {
			throw new Error("GET /v1/instances/my/instances failed");
		});
		await ws.onmessage?.({ data: JSON.stringify({ id: "c2", path: MEMBERSHIP_SYNC_PATH }) });
		expect(JSON.parse(ws.sent[0])).toMatchObject({ id: "c2", status: 500, result: { error: expect.stringContaining("failed") } });
		handle.close();
	});

	it("still forwards every other command to the local runner", async () => {
		const onControl = vi.fn();
		const { ws, handle } = await open(onControl);
		await ws.onmessage?.({ data: JSON.stringify({ id: "c3", path: "/coding/capture", body: {} }) });
		expect(onControl).not.toHaveBeenCalled();
		expect(forwarded).toEqual(["http://127.0.0.1:9/coding/capture"]);
		handle.close();
	});
});
