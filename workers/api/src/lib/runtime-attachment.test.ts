import { describe, expect, it } from "vitest";
import { diagnoseAttachment, HEARTBEAT_FRESH_MS } from "./runtime-attachment.js";

const NOW = Date.parse("2026-08-06T12:00:00Z");
/** D1 writes `YYYY-MM-DD HH:MM:SS` (a space, no zone), which is why the parser patches it. */
const secondsAgo = (n: number) => new Date(NOW - n * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

describe("diagnoseAttachment", () => {
	it("says nothing is wrong when a socket is live", () => {
		const d = diagnoseAttachment({ hasRuntimeRow: true, relayConnected: true, lastSeenAt: null, now: NOW });
		expect(d.state).toBe("attached");
		expect(d.remedy).toBeNull();
	});

	it("distinguishes never-registered from offline — they need different things from the user", () => {
		const never = diagnoseAttachment({ hasRuntimeRow: false, relayConnected: false, lastSeenAt: null, now: NOW });
		expect(never.state).toBe("never-registered");
		expect(never.remedy).toBe("pags up");

		const offline = diagnoseAttachment({ hasRuntimeRow: true, relayConnected: false, lastSeenAt: secondsAgo(600), now: NOW });
		expect(offline.state).toBe("runner-offline");
		expect(offline.remedy).toBe("pags up");
	});

	// THE case this exists for: the machine is demonstrably alive (still heartbeating, its other
	// agents connected) yet this one agent has no socket. That rendered as an unexplained amber
	// dot — and `pags up` is the WRONG advice here, because the runner is already running.
	it("identifies the machine-online-but-detached case and gives --force, not plain `pags up`", () => {
		const d = diagnoseAttachment({ hasRuntimeRow: true, relayConnected: false, lastSeenAt: secondsAgo(10), now: NOW });
		expect(d.state).toBe("machine-online-agent-detached");
		expect(d.remedy).toBe("pags up --force");
		expect(d.message).toMatch(/another runner/i);
	});

	it("uses the heartbeat window as the boundary between the two", () => {
		const justFresh = secondsAgo(HEARTBEAT_FRESH_MS / 1000 - 5);
		const justStale = secondsAgo(HEARTBEAT_FRESH_MS / 1000 + 5);
		expect(diagnoseAttachment({ hasRuntimeRow: true, relayConnected: false, lastSeenAt: justFresh, now: NOW }).state)
			.toBe("machine-online-agent-detached");
		expect(diagnoseAttachment({ hasRuntimeRow: true, relayConnected: false, lastSeenAt: justStale, now: NOW }).state)
			.toBe("runner-offline");
	});

	// A missing or unparseable timestamp must read as "not fresh". Treating it as fresh would
	// tell a user with no runner at all to run `--force`, which does nothing for them.
	it("treats an absent or malformed last-seen as stale", () => {
		for (const lastSeenAt of [null, undefined, "", "not-a-date"]) {
			expect(diagnoseAttachment({ hasRuntimeRow: true, relayConnected: false, lastSeenAt, now: NOW }).state)
				.toBe("runner-offline");
		}
	});

	it("connected wins over everything — a live socket is not a diagnosis problem", () => {
		expect(diagnoseAttachment({ hasRuntimeRow: false, relayConnected: true, lastSeenAt: null, now: NOW }).state).toBe("attached");
	});

	// #380. The pinned machine is dead and ANOTHER machine is live. The heartbeat lands on the
	// shared default row, so `lastSeenAt` is fresh — which used to diagnose
	// `machine-online-agent-detached` and prescribe `pags up --force` for a laptop that is
	// switched off. The pin is both the cause and the thing to change, so it is checked first.
	it("names the pin — and the machine that IS up — instead of prescribing --force at a dead one", () => {
		const d = diagnoseAttachment({
			hasRuntimeRow: true,
			relayConnected: false,
			lastSeenAt: secondsAgo(10),
			now: NOW,
			pinnedNode: "RLs-MacBook-Air.local",
			liveNodeExcludedByPin: "Mac",
		});
		expect(d.state).toBe("pinned-machine-offline");
		expect(d.message).toContain("RLs-MacBook-Air.local");
		expect(d.message).toContain("Mac");
		// No command: `pags up` is already running on Mac, and `--force` takes a machine over
		// rather than changing where this agent points. The fix is one click in "Runs on".
		expect(d.remedy).toBeNull();
	});

	it("does not reach for the pin when nothing else is live — that is plain runner-offline", () => {
		const d = diagnoseAttachment({
			hasRuntimeRow: true,
			relayConnected: false,
			lastSeenAt: secondsAgo(600),
			now: NOW,
			pinnedNode: "laptop",
			liveNodeExcludedByPin: null,
		});
		expect(d.state).toBe("runner-offline");
		expect(d.remedy).toBe("pags up");
	});

	it("a pin that resolved (relay live) is still just attached", () => {
		const d = diagnoseAttachment({
			hasRuntimeRow: true,
			relayConnected: true,
			lastSeenAt: secondsAgo(10),
			now: NOW,
			pinnedNode: "laptop",
			liveNodeExcludedByPin: "desktop",
		});
		expect(d.state).toBe("attached");
	});
});
