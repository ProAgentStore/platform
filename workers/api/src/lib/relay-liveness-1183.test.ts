/**
 * #1183: relay liveness is judged per SOCKET and survives the DO hibernating.
 *
 * A "hibernation" is simulated the way it happens: a brand-new RunnerLiveness (the DO's memory is gone) over the SAME sockets, whose
 * attachments are what the runtime keeps. Before: the first /status after a wake read connected whatever the peer was doing, and one
 * live pong vouched for a dead socket in a two-socket slot.
 */
import { describe, expect, it } from "vitest";
import { PONG_STALE_MS, RunnerLiveness, sendOnFirstOpen, type PingableSocket } from "./relay-liveness.js";

/** A socket with a real attachment slot, and a record of what it was sent. */
function socket(onPing?: (ws: PingableSocket) => void): PingableSocket & { sent: string[]; attachment: unknown } {
	const ws: PingableSocket & { sent: string[]; attachment: unknown } = {
		sent: [],
		attachment: null,
		send(data: string) {
			ws.sent.push(data);
			if (data === "ping") onPing?.(ws);
		},
		close() {},
		serializeAttachment(v: unknown) {
			ws.attachment = structuredClone(v);
		},
		deserializeAttachment() {
			return ws.attachment === null ? null : structuredClone(ws.attachment);
		},
	};
	return ws;
}

describe("a hibernated DO still knows each socket's last round trip", () => {
	it("a peer that stopped answering before the DO slept is reported gone on the FIRST status after the wake", () => {
		const frozen = socket();
		const before = new RunnerLiveness();
		expect(before.observe([frozen], 1_000)).toBe(true); // unknown: pinged, no verdict yet
		const woken = new RunnerLiveness(); // the DO was evicted; only the attachment remains
		expect(woken.observe([frozen], 1_000 + PONG_STALE_MS + 1)).toBe(false);
	});

	it("a peer that pongs while the DO is awake is still connected after a wake, however long it slept", () => {
		const live = socket();
		const before = new RunnerLiveness();
		before.observe([live], 1_000);
		before.pong(live, 1_050);
		const woken = new RunnerLiveness();
		expect(woken.observe([live], 600_000)).toBe(true);
	});

	it("a pong that arrives AFTER the wake (the message that woke it) is credited to its socket and persisted", () => {
		const ws = socket();
		new RunnerLiveness().observe([ws], 1_000);
		const woken = new RunnerLiveness();
		woken.pong(ws, 1_200);
		expect((ws.attachment as { liveness: { pongAt: number } }).liveness.pongAt).toBe(1_200);
		expect(new RunnerLiveness().observe([ws], 1_000 + PONG_STALE_MS * 5)).toBe(true);
	});

	it("a socket never seen before is unknown, reads connected once, and that call starts its record", () => {
		const fresh = socket();
		const l = new RunnerLiveness();
		expect(l.observe([fresh], 5_000)).toBe(true);
		expect((fresh.attachment as { liveness: { pingAt: number } }).liveness.pingAt).toBe(5_000);
		expect(new RunnerLiveness().observe([fresh], 5_000 + PONG_STALE_MS + 1)).toBe(false);
	});

	it("keeps whatever else a socket's attachment carries", () => {
		const ws = socket();
		ws.serializeAttachment?.({ tag: "runner", other: 7 });
		new RunnerLiveness().observe([ws], 1_000);
		expect(ws.attachment).toMatchObject({ tag: "runner", other: 7, liveness: { pingAt: 1_000 } });
	});

	it("an unreadable attachment is an unknown, not a crash", () => {
		const ws = socket();
		ws.deserializeAttachment = () => {
			throw new Error("corrupt");
		};
		expect(new RunnerLiveness().observe([ws], 1_000)).toBe(true);
	});
});

describe("one live socket does not vouch for a dead one (#1183)", () => {
	it("status: the slot is connected while ANY socket is, and the dead socket's own silence is judged on its own", () => {
		const live = socket();
		const dead = socket();
		const l = new RunnerLiveness();
		l.observe([dead, live], 1_000);
		l.pong(live, 1_020); // only the live one answers
		const later = 1_000 + PONG_STALE_MS + 1;
		expect(l.observe([dead, live], later)).toBe(true); // the slot has a runner
		expect(l.observe([dead], later + PONG_STALE_MS + 1)).toBe(false); // the dead one alone is not vouched for
	});

	it("dispatch: probeAlive returns only the socket that answered, and the command is sent on it - not on the dead one listed first", async () => {
		const l = new RunnerLiveness();
		const dead = socket(); // takes the ping, never answers
		const live = socket(() => setTimeout(() => l.pong(live, Date.now()), 0));
		const alive = await l.probeAlive([dead, live], { deadlineMs: 200 });
		expect(alive).toEqual([live]);
		expect(sendOnFirstOpen(alive, "COMMAND")).toBe(live);
		expect(dead.sent).toEqual(["ping"]);
		expect(live.sent).toEqual(["ping", "COMMAND"]);
	});

	it("probe is false when nothing answers, and a thawed socket's late pong does not rewrite that verdict", async () => {
		const l = new RunnerLiveness();
		const frozen = socket();
		expect(await l.probe([frozen], { deadlineMs: 10 })).toBe(false);
		l.pong(frozen, Date.now());
		expect(await l.probeAlive([socket()], { deadlineMs: 10 })).toEqual([]);
	});
});
