/**
 * #1040 in the console: the Usage page's spend-drivers panel, rendered as real markup from the API's
 * own report builder (`spendDrivers` / `compareWindows`), so what an owner reads is what the route
 * computes — top drivers, every opportunity with its estimate and basis, and the baseline verdict.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpendDriversView } from "./SpendDrivers";
import { compareWindows, type DriverRow, spendDrivers } from "../../../../workers/api/src/lib/usage-drivers";

const row = (r: Partial<DriverRow>): DriverRow =>
	({ instance_id: "i1", provider: "anthropic", model: "claude-sonnet-4-6", kind: "chat", source: "loop", phase: "decide", trace_id: "obj-1", tool_calls: 0, attempt: 1, input_tokens: 5000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0, cost_micros: 16_500, payer: "byok-api", created_at: "2026-10-12 10:00:00", ...r }) as DriverRow;

const current = spendDrivers(
	[row({}), row({ created_at: "2026-10-12 10:01:00" }), row({ attempt: 2, created_at: "2026-10-12 10:02:00" }), row({ trace_id: "obj-2", source: "chat", phase: null, tool_calls: 2, cost_micros: 4_000 }), row({ trace_id: null, cost_micros: 1_000 }), row({ trace_id: "obj-3" })],
	{ from: "2026-10-06 00:00:00", to: "2026-10-13 00:00:00" },
);
const baseline = spendDrivers([...Array(6)].map((_, k) => row({ trace_id: `b${k}`, cost_micros: 60_000 })), { from: "a", to: "b" });

describe("Spend drivers panel (#1040)", () => {
	it("shows the totals an owner needs to find waste: retries, duplicates, tool turns, unattributed spend", () => {
		const html = renderToStaticMarkup(createElement(SpendDriversView, { drivers: current, savings: null }));
		expect(html).toContain('data-testid="spend-drivers-totals"');
		expect(html).toMatch(/6 calls/);
		expect(html).toMatch(/1 retried \(\$0\.02\)/);
		expect(html).toMatch(/1 duplicated \(\$0\.02\)/);
		expect(html).toMatch(/1 turns asked for tools/);
		expect(html).toContain("with no objective recorded");
	});

	it("ranks the top objective and phase, and lists every opportunity with its estimate, basis and action", () => {
		const html = renderToStaticMarkup(createElement(SpendDriversView, { drivers: current, savings: null }));
		expect(html.indexOf("obj-1")).toBeGreaterThan(-1);
		expect(html).toContain("loop · decide");
		for (const o of current.opportunities) {
			expect(html).toContain(o.label);
			expect(html).toContain(o.basis.slice(0, 40));
		}
		expect(html).toContain("Never the Pilot");
	});

	it("states the baseline verdict in the API's own sentence", () => {
		const savings = compareWindows(baseline, current);
		expect(savings.verdict).toBe("saving");
		const html = renderToStaticMarkup(createElement(SpendDriversView, { drivers: current, savings }));
		expect(html).toContain('data-testid="spend-savings"');
		expect(html).toContain(savings.summary);
		expect(html).toContain("text-success");
	});
});
