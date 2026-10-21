/**
 * #1167 — the runtime's own health on the heartbeat sample. The relay pong and the heartbeat are answered by the CLI
 * (`runner connect`), not the runtime child that executes commands, so a wedged runtime still read online; the CLI now
 * sends what the runtime's `/health` answered, and the platform reads it.
 */
import { describe, expect, it } from "vitest";
import { parseResourceSample, resourcesView, runtimeHealthOf } from "./runner-resources.js";

const T = Date.parse("2026-10-21T10:00:00Z");
const base = { loadAvg: [0.5, 0.5, 0.5], cpus: 4, memTotalBytes: 8 * 1024 ** 3, memFreeBytes: 4 * 1024 ** 3, platform: "linux", sampledAt: T };

describe("the sample's runtime block", () => {
	it("is kept when valid, and a CLI that sends none is `unknown`, never unhealthy", () => {
		expect(parseResourceSample({ ...base, runtime: { ok: true, latencyMs: 12, checkedAt: T } })?.runtime).toEqual({ ok: true, latencyMs: 12, checkedAt: T });
		expect(parseResourceSample(base)?.runtime).toBeUndefined();
		expect(resourcesView(base, 0)?.runtime).toBeNull();
	});

	it("keeps a failure's reason, bounded and marked, and a null latency (no answer at all)", () => {
		const s = parseResourceSample({ ...base, runtime: { ok: false, latencyMs: null, error: `no answer in 4s ${"x".repeat(400)}`, checkedAt: T } });
		expect(s?.runtime).toMatchObject({ ok: false, latencyMs: null, error: expect.stringMatching(/^no answer in 4s/) });
		expect((s?.runtime?.error ?? "").length).toBeLessThan(260);
	});

	it("drops a malformed block whole rather than reading it as healthy", () => {
		for (const bad of [{ ok: "yes", checkedAt: T }, { ok: true }, { ok: true, checkedAt: -1 }, "up", null, []]) {
			expect(parseResourceSample({ ...base, runtime: bad })?.runtime, JSON.stringify(bad)).toBeUndefined();
		}
		// A bad latency alone does not discard a valid verdict.
		expect(parseResourceSample({ ...base, runtime: { ok: false, latencyMs: -5, checkedAt: T } })?.runtime).toMatchObject({ ok: false, latencyMs: null });
	});
});

describe("the view", () => {
	it("says responsive, with no warning", () => {
		const v = resourcesView({ ...base, runtime: { ok: true, latencyMs: 8, checkedAt: T } }, 0);
		expect(v?.runtime).toEqual({ state: "responsive", latencyMs: 8, checkedAt: "2026-10-21T10:00:00.000Z" });
		expect(v?.warnings).toEqual([]);
	});

	it("says unresponsive, names why, and warns that commands will time out", () => {
		const v = resourcesView({ ...base, runtime: { ok: false, latencyMs: null, error: "no answer in 4s", checkedAt: T } }, 0);
		expect(v?.runtime).toMatchObject({ state: "unresponsive", error: "no answer in 4s" });
		expect(v?.warnings.join(" ")).toMatch(/connected but its runtime did not answer its own health check \(no answer in 4s\).*time out.*runner_restart/);
	});
});

describe("the node's runtime_health", () => {
	const view = (ok: boolean, at = T) => resourcesView({ ...base, runtime: { ok, latencyMs: ok ? 5 : null, checkedAt: at } }, 0);
	it("is the verdict while the heartbeat that carried it is fresh", () => {
		expect(runtimeHealthOf(view(true), T + 60_000)).toBe("responsive");
		expect(runtimeHealthOf(view(false), T + 60_000)).toBe("unresponsive");
	});

	it("is `unknown` once that heartbeat is stale, and when there is no verdict at all", () => {
		expect(runtimeHealthOf(view(false), T + 10 * 60_000)).toBe("unknown");
		expect(runtimeHealthOf(resourcesView(base, 0))).toBe("unknown");
		expect(runtimeHealthOf(null)).toBe("unknown");
	});
});
