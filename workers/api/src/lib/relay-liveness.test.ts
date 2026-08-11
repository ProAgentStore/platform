/**
 * #497: the two directions of the incumbent-liveness question, both pinned.
 *
 * The direction that was broken (a frozen peer counted as alive, so a woken laptop was locked
 * out of its own relay slot) and the direction #237 shipped and must keep (a genuinely live
 * second runner is still refused with 4409) are the SAME code path with different peers. A test
 * of only the new behaviour would let the next change take the old promise back.
 */
import { describe, expect, it } from "vitest";
import { PONG_STALE_MS, RunnerLiveness, type PingableSocket } from "./relay-liveness.js";

/** A peer that answers a ping — the shape of a runner whose process is running. */
function livePeer(liveness: RunnerLiveness, now = () => Date.now()): PingableSocket {
	return {
		send(data: string) {
			if (data === "ping") setTimeout(() => liveness.pong(now()), 0);
		},
		close() { /* not used */ },
	};
}

/** A peer that takes the ping and never answers — a SIGSTOPped holder / a slept laptop. */
const frozenPeer = (): PingableSocket => ({ send() { /* swallowed */ }, close() {} });

/** A peer whose socket is gone at the transport layer — a hard-killed runner. */
function deadPeer(): PingableSocket & { closed: boolean } {
	const peer = {
		closed: false,
		send() { throw new Error("closed"); },
		close() { peer.closed = true; },
	};
	return peer;
}

describe("RunnerLiveness.probe — the connect-time question", () => {
	it("a live incumbent answers, so the newcomer is still refused (#237's promise)", async () => {
		const liveness = new RunnerLiveness();
		expect(await liveness.probe([livePeer(liveness)], { deadlineMs: 200 })).toBe(true);
	});

	it("a FROZEN incumbent does not answer, so the slot is releasable", async () => {
		const liveness = new RunnerLiveness();
		expect(await liveness.probe([frozenPeer()], { deadlineMs: 30 })).toBe(false);
	});

	it("an unreachable socket is false immediately — nothing to wait for", async () => {
		const liveness = new RunnerLiveness();
		const started = Date.now();
		expect(await liveness.probe([deadPeer()], { deadlineMs: 5_000 })).toBe(false);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("no incumbent at all is not alive", async () => {
		expect(await new RunnerLiveness().probe([], { deadlineMs: 5_000 })).toBe(false);
	});

	it("ONE pong is enough when several sockets are listed", async () => {
		const liveness = new RunnerLiveness();
		expect(await liveness.probe([frozenPeer(), livePeer(liveness)], { deadlineMs: 200 })).toBe(true);
	});

	it("a late pong cannot resolve an already-expired probe as alive", async () => {
		const liveness = new RunnerLiveness();
		expect(await liveness.probe([frozenPeer()], { deadlineMs: 10 })).toBe(false);
		liveness.pong(); // the frozen peer thawed — must not retroactively change the verdict
		expect(await liveness.probe([frozenPeer()], { deadlineMs: 10 })).toBe(false);
	});
});

describe("RunnerLiveness.observe — the status-time question, answered without waiting", () => {
	it("answers optimistically the first time: an unknown is not an outage", () => {
		const liveness = new RunnerLiveness();
		expect(liveness.observe([frozenPeer()], 1_000)).toBe(true);
	});

	it("reports a frozen peer gone once its ping has stood unanswered past the grace window", () => {
		const liveness = new RunnerLiveness();
		const peer = frozenPeer();
		expect(liveness.observe([peer], 1_000)).toBe(true);
		expect(liveness.observe([peer], 1_000 + PONG_STALE_MS + 1)).toBe(false);
	});

	it("does not call a peer gone while its ping is still young", () => {
		const liveness = new RunnerLiveness();
		const peer = frozenPeer();
		liveness.observe([peer], 1_000);
		expect(liveness.observe([peer], 1_000 + PONG_STALE_MS - 1)).toBe(true);
	});

	it("a peer that pongs stays connected however often it is asked", () => {
		const liveness = new RunnerLiveness();
		const peer: PingableSocket = { send: () => liveness.pong(5_000), close: () => {} };
		expect(liveness.observe([peer], 1_000)).toBe(true);
		expect(liveness.observe([peer], 60_000)).toBe(true);
	});

	it("an unreachable socket is gone, and no socket at all is gone", () => {
		const liveness = new RunnerLiveness();
		expect(liveness.observe([deadPeer()], 1_000)).toBe(false);
		expect(liveness.observe([], 1_000)).toBe(false);
	});

	it("closes a socket the send cannot reach, so it stops being re-pinged forever", () => {
		const peer = deadPeer();
		new RunnerLiveness().observe([peer], 1_000);
		expect(peer.closed).toBe(true);
	});

	it("does NOT close a peer that merely failed to answer — a busy runner is not a dead one", () => {
		const liveness = new RunnerLiveness();
		let closed = false;
		const peer: PingableSocket = { send() { /* swallowed */ }, close() { closed = true; } };
		liveness.observe([peer], 1_000);
		expect(liveness.observe([peer], 1_000 + PONG_STALE_MS + 1)).toBe(false);
		expect(closed).toBe(false);
	});

	it("recovers: a peer that starts answering again reads connected", () => {
		const liveness = new RunnerLiveness();
		const frozen = frozenPeer();
		liveness.observe([frozen], 1_000);
		expect(liveness.observe([frozen], 10_000)).toBe(false);
		liveness.pong(11_000);
		expect(liveness.observe([frozen], 12_000)).toBe(true);
	});
});
