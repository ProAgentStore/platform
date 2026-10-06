/**
 * RunnerPanel reads what a pin move and a reattach did, and offers the reattach (#932). The
 * sentences are `lib/runnerPanel.ts`'s (tested there); this holds the card to using them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "RunnerPanel.tsx"), "utf8");

describe("RunnerPanel (#932)", () => {
	it("reads the PUT …/runner-node answer instead of assuming 'Pinned to X'", () => {
		expect(SRC).toContain("await settle(pinOutcome(node, resp));");
		expect(SRC).not.toMatch(/`Pinned to \$\{node\}`/);
	});

	it("re-reads the card after every move, and once more while it is unconfirmed", () => {
		const settle = SRC.slice(SRC.indexOf("const settle = async"), SRC.indexOf("const save = async"));
		expect(settle).toContain("await refresh();");
		expect(settle).toMatch(/outcome\.tone === "pending"\) setTimeout\(\(\) => void refresh\(\)/);
	});

	it("offers Reattach, which calls POST …/runner-attach for the pinned machine", () => {
		expect(SRC).toContain("/runner-attach`, { method: \"POST\"");
		expect(SRC).toContain("await settle(reattachOutcome(node, a));");
		expect(SRC).toContain('data-testid="runner-reattach"');
		expect(SRC).toContain("canReattach(runnerNode, warning, move)");
	});

	it("shows the outcome with its tone", () => {
		expect(SRC).toContain('data-testid="runner-move-outcome"');
	});
});
