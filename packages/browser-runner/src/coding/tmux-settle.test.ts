/**
 * Unit tests for the `waitForPaneSettle` heuristic (#481).
 *
 * These tests are PURE — they pass a custom `captureFn` so no real tmux session is
 * needed. The settle logic is the only thing under test; the tmux I/O layer is
 * already covered by `tmux-connector.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { waitForPaneSettle } from "./tmux.js";

/** Fast test config: 50ms quiet window, 20ms poll, 1s backstop. */
const FAST = { quietMs: 50, pollMs: 20, timeoutMs: 1_000 };

describe("waitForPaneSettle", () => {
	it("returns immediately when pane content is already stable", async () => {
		// captureFn always returns the same string → pane is stable from the first poll.
		let calls = 0;
		const pane = await waitForPaneSettle("sess", {
			...FAST,
			captureFn: () => {
				calls++;
				return "$ prompt";
			},
		});
		expect(pane).toBe("$ prompt");
		// Should have polled at least once to confirm stability.
		expect(calls).toBeGreaterThan(0);
	});

	it("changed=false scenario: pane does not change after send (not-ready CLI)", async () => {
		// captureFn always returns the same content, simulating a pane that didn't react.
		const before = "$ waiting";
		const pane = await waitForPaneSettle("sess", {
			...FAST,
			captureFn: () => before,
		});
		// Pane equals paneBefore → changed would be false at the call site.
		expect(pane).toBe(before);
	});

	it("changed=true scenario: pane changes once then settles (ready CLI)", async () => {
		// First two polls return old content; after that the CLI reacts.
		let calls = 0;
		const pane = await waitForPaneSettle("sess", {
			...FAST,
			captureFn: () => {
				calls++;
				return calls <= 2 ? "old content" : "new content with prompt >";
			},
		});
		// After the CLI reacts, pane settles on new content.
		expect(pane).toBe("new content with prompt >");
	});

	it("launch-and-wait: returns only after pane settles (simulates startup)", async () => {
		// Simulate a CLI that paints its startup output over several polls, then settles.
		// The settle function must NOT return until the pane has been stable for quietMs.
		let calls = 0;
		// Paint phases: empty → painting → prompt (stable after 3 polls).
		const phases = ["", "Claude Code v1.0…", "Claude Code v1.0…", "❯"];
		const start = Date.now();
		const pane = await waitForPaneSettle("sess", {
			...FAST,
			captureFn: () => {
				const phase = Math.min(calls++, phases.length - 1);
				return phases[phase];
			},
		});
		const elapsed = Date.now() - start;
		// Must have waited at least `quietMs` after the last change.
		expect(elapsed).toBeGreaterThanOrEqual(FAST.quietMs);
		expect(pane).toBe("❯");
	});

	it("backstop: returns when the timeout elapses even if the pane never settles", async () => {
		// A pane that keeps changing (animated spinner) — should bail at timeoutMs.
		let counter = 0;
		const start = Date.now();
		const backstopMs = 120;
		const pane = await waitForPaneSettle("sess", {
			quietMs: 500, // long quiet window — will never be reached
			pollMs: 20,
			timeoutMs: backstopMs,
			captureFn: () => `frame ${counter++}`,
		});
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(backstopMs - 30); // allow some scheduling slack
		// Returns the last captured content.
		expect(pane).toMatch(/^frame \d+$/);
	});
});
