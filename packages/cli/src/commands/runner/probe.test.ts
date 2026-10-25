/** #1148 — the probe proves a candidate loads, reaches the API with the saved sign-in, and can open a relay socket. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProbeDeps, PROBE_MARKER, runProbe, webSocketRoundTrip } from "./probe.js";

const good = (over: Partial<ProbeDeps> = {}): ProbeDeps => ({
	version: "0.4.150",
	expect: "0.4.150",
	hasSession: () => true,
	listInstances: async () => ["i1", "i2"],
	mintRelayToken: async () => "tok",
	roundTrip: async () => 42,
	...over,
});
const failed = (r: Awaited<ReturnType<typeof runProbe>>) => r.steps.filter((s) => !s.ok).map((s) => s.name);

describe("runProbe", () => {
	it("passes when it loads as the expected release, the API takes the sign-in and a relay socket answers", async () => {
		const r = await runProbe(good());
		expect(r.ok).toBe(true);
		expect(r.steps.map((s) => s.name)).toEqual(["loads", "session", "relay"]);
		expect(r.steps[2].detail).toContain("42ms");
	});
	it("opens the relay socket for the first agent only, with a token minted for that agent", async () => {
		const mint = vi.fn(async () => "tok");
		const trip = vi.fn(async () => 5);
		await runProbe(good({ mintRelayToken: mint, roundTrip: trip }));
		expect(mint).toHaveBeenCalledWith("i1");
		expect(trip).toHaveBeenCalledWith("i1", "tok");
	});
	it("fails if it is not the release that was installed", async () => {
		const r = await runProbe(good({ version: "0.4.149" }));
		expect(r.ok).toBe(false);
		expect(failed(r)).toEqual(["loads"]);
		expect(r.steps[0].detail).toMatch(/0\.4\.149, not the 0\.4\.150/);
	});
	it("fails the session when there is no saved sign-in, and does not try the relay", async () => {
		const listed = vi.fn(async () => ["i1"]);
		const r = await runProbe(good({ hasSession: () => false, listInstances: listed }));
		expect(failed(r)).toEqual(["session", "relay"]);
		expect(listed).not.toHaveBeenCalled();
	});
	it("fails the session when the API refuses the sign-in", async () => {
		const r = await runProbe(good({ listInstances: async () => { throw new Error("401 Unauthorized"); } }));
		expect(failed(r)).toEqual(["session", "relay"]);
		expect(r.steps[1].detail).toContain("401 Unauthorized");
	});
	it("fails the relay when no socket opens or no echo comes back", async () => {
		const r = await runProbe(good({ roundTrip: async () => { throw new Error("no answer within 10s"); } }));
		expect(failed(r)).toEqual(["relay"]);
		expect(r.steps[2].detail).toContain("no answer within 10s");
		expect(failed(await runProbe(good({ mintRelayToken: async () => { throw new Error("402 upgrade required"); } })))).toEqual(["relay"]);
	});
	it("has nothing to open a relay socket for when the account has no agents, and says so as a pass", async () => {
		const r = await runProbe(good({ listInstances: async () => [] }));
		expect(r.ok).toBe(true);
		expect(r.steps[2].detail).toMatch(/no agents/);
	});
	it("its marker is what the parent searches for", () => {
		expect(PROBE_MARKER).toBe("PAGS_PROBE ");
	});
});

describe("webSocketRoundTrip", () => {
	const real = globalThis.WebSocket;
	afterEach(() => { globalThis.WebSocket = real; });

	class Fake {
		static last: Fake;
		onopen: (() => void) | null = null;
		onmessage: ((e: { data: unknown }) => void) | null = null;
		onerror: (() => void) | null = null;
		onclose: (() => void) | null = null;
		sent: string[] = [];
		closed = false;
		constructor(public url: string) { Fake.last = this; }
		send(d: string) { this.sent.push(d); }
		close() { this.closed = true; }
	}
	const install = () => { globalThis.WebSocket = Fake as unknown as typeof WebSocket; };

	it("connects with probe=1 under the probe's own node name, sends one rtt frame and resolves on its echo", async () => {
		install();
		const p = webSocketRoundTrip("wss://api.example", "pags-probe-host")("i 1", "tok/en");
		const url = new URL(Fake.last.url);
		expect(url.origin + url.pathname).toBe("wss://api.example/v1/relay/i%201/connect");
		expect(url.searchParams.get("probe")).toBe("1");
		expect(url.searchParams.get("node")).toBe("pags-probe-host");
		expect(url.searchParams.get("token")).toBe("tok/en");
		Fake.last.onopen?.();
		expect(Fake.last.sent).toHaveLength(1);
		const id = Fake.last.sent[0].replace("rtt:", "");
		Fake.last.onmessage?.({ data: "probe-ok" }); // the greeting is not the answer
		Fake.last.onmessage?.({ data: `rtt-echo:${id}` });
		expect(await p).toBeGreaterThanOrEqual(0);
		expect(Fake.last.closed).toBe(true);
	});
	it("rejects when the connection is refused or closes unanswered, and when nothing answers in time", async () => {
		install();
		const refused = webSocketRoundTrip("wss://x", "n")("i", "t");
		Fake.last.onerror?.();
		await expect(refused).rejects.toThrow(/refused or dropped/);
		const closed = webSocketRoundTrip("wss://x", "n")("i", "t");
		Fake.last.onclose?.();
		await expect(closed).rejects.toThrow(/closed before/);
		const slow = webSocketRoundTrip("wss://x", "n", 20)("i", "t");
		Fake.last.onopen?.();
		await expect(slow).rejects.toThrow(/no answer within/);
		expect(Fake.last.closed).toBe(true);
	});
});
