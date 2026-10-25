import { describe, expect, it } from "vitest";
import { PROBE_LIFETIME_MS, serveProbe } from "./relay-probe.js";

function fakeSocket() {
	const sent: string[] = [];
	let listener: ((e: { data: unknown }) => void) | undefined;
	const state = { accepted: false, closed: null as null | [number | undefined, string | undefined] };
	return {
		sent,
		state,
		say: (data: unknown) => listener?.({ data }),
		socket: {
			accept: () => { state.accepted = true; },
			send: (d: string) => { sent.push(d); },
			close: (code?: number, reason?: string) => { state.closed = [code, reason]; },
			addEventListener: (_t: "message", l: (e: { data: unknown }) => void) => { listener = l; },
		},
	};
}

describe("the relay probe socket (#1148)", () => {
	it("accepts, says probe-ok, and echoes round-trip probes the way the relay does", () => {
		const f = fakeSocket();
		serveProbe(f.socket, () => undefined);
		expect(f.state.accepted).toBe(true);
		expect(f.sent).toEqual(["probe-ok"]);
		f.say("rtt:abc-123");
		expect(f.sent).toEqual(["probe-ok", "rtt-echo:abc-123"]);
	});
	it("ignores everything else: it relays nothing and runs no command", () => {
		const f = fakeSocket();
		serveProbe(f.socket, () => undefined);
		f.say(JSON.stringify({ id: "1", method: "POST", path: "/coding/start", body: {} }));
		f.say(new Uint8Array([1, 2]));
		f.say("rtt:bad id!");
		expect(f.sent).toEqual(["probe-ok"]);
	});
	it("closes itself after its lifetime whatever the client does, and tolerates an already-closed socket", () => {
		const f = fakeSocket();
		let fire: (() => void) | undefined;
		let after = 0;
		serveProbe(f.socket, (fn, ms) => { fire = fn; after = ms; });
		expect(after).toBe(PROBE_LIFETIME_MS);
		fire?.();
		expect(f.state.closed).toEqual([1000, "probe finished"]);
		f.socket.close = () => { throw new Error("gone"); };
		expect(() => fire?.()).not.toThrow();
	});
});
