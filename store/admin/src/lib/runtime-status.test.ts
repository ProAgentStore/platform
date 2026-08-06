import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUNTIME_LABELS, type RuntimeStatus, runtimeStatus } from "./runtime-status";

describe("runtimeStatus — four states, because 'unknown' is not 'offline'", () => {
	it("reports unknown when the live check was never made", () => {
		// The failure this prevents: an operator reads "offline" for a machine nobody
		// asked about, and restarts or reassigns a runner that was working the whole time.
		// The instances list caps its live-check fan-out at 50 rows and returns `null`
		// past that budget — `null` is "we did not look", and must never render as a
		// confident negative.
		expect(runtimeStatus({ connected: null, nodes: 1 })).toBe("unknown");
	});

	it("treats a MISSING field as unknown too, not as offline", () => {
		// A row shape that predates `runtimeConnected`, or an API that stops sending it,
		// degrades to "we don't know". `undefined` is falsy, so the obvious
		// `connected ? live : offline` would have answered "offline" with total confidence
		// about a field that was never populated.
		expect(runtimeStatus({ connected: undefined, nodes: 1 })).toBe("unknown");
	});

	it("distinguishes never-registered from offline", () => {
		// "No runner has ever run `pags up` here" is not a liveness fact at all — there is
		// no machine for `connected` to be about. Collapsing it into "offline" invents a
		// machine that is down, and sends an operator looking for it.
		expect(runtimeStatus({ connected: null, nodes: 0 })).toBe("no-runner");
		expect(runtimeStatus({ connected: false, nodes: 0 })).toBe("no-runner");
		expect(runtimeStatus({ connected: true, nodes: 0 })).toBe("no-runner");
		expect(runtimeStatus({ connected: null })).toBe("no-runner");
	});

	it("answers live/offline only when a check actually happened", () => {
		expect(runtimeStatus({ connected: true, nodes: 1 })).toBe("live");
		expect(runtimeStatus({ connected: false, nodes: 1 })).toBe("offline");
	});

	it("never returns the same status for two different inputs' meanings", () => {
		// A guard on the SHAPE: all four states must be reachable. A refactor that folded
		// one into another would still pass every case above if the cases were edited to
		// match — this one fails unless four distinct answers exist.
		const reached = new Set<RuntimeStatus>([
			runtimeStatus({ connected: true, nodes: 1 }),
			runtimeStatus({ connected: false, nodes: 1 }),
			runtimeStatus({ connected: null, nodes: 1 }),
			runtimeStatus({ connected: null, nodes: 0 }),
		]);
		expect(reached.size).toBe(4);
	});
});

describe("RUNTIME_LABELS — the words an operator acts on", () => {
	it("labels every state, and never says 'offline' about one that isn't", () => {
		// The whole point is the wording. If "unknown" ever carries the word offline in
		// its text or its tooltip, the derivation above is correct and the screen still
		// lies.
		for (const status of ["no-runner", "unknown", "live", "offline"] as RuntimeStatus[]) {
			const label = RUNTIME_LABELS[status];
			expect(label, status).toBeTruthy();
			expect(label.text.length, status).toBeGreaterThan(0);
			expect(label.title.length, status).toBeGreaterThan(0);
		}
		expect(RUNTIME_LABELS.unknown.text).not.toContain("offline");
		expect(RUNTIME_LABELS.unknown.title.toLowerCase()).toContain("not checked");
		expect(RUNTIME_LABELS["no-runner"].text).not.toContain("offline");
	});

	it("gives each state its own text, so two states cannot read the same on screen", () => {
		const texts = Object.values(RUNTIME_LABELS).map((l) => l.text);
		expect(new Set(texts).size).toBe(texts.length);
	});
});

/**
 * Strip comments before matching: the guards below describe what the COMPONENT may do,
 * and the comment explaining the very thing they forbid necessarily quotes it.
 * (Same helper, same reason, as store/console/src/lib/surfaces.test.ts.)
 */
function codeOf(relPath: string): string {
	return readFileSync(join(__dirname, relPath), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
		.join("\n");
}

describe("the component stays dumb (#282 chose extraction over a renderer)", () => {
	it("LiveDot derives its state here instead of branching on `connected` itself", () => {
		// #282's option (b) only holds if the extraction is actually consumed. A future
		// edit that re-adds `connected === null ?` inside the JSX puts the four-state
		// decision back where no test can reach it, while every test above still passes.
		const src = codeOf("./ui.tsx");
		expect(src).toContain("runtimeStatus");
		expect(src).toContain("RUNTIME_LABELS");
		expect(src).not.toMatch(/connected\s*===\s*null/);
	});
});
