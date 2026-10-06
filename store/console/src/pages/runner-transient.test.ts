/**
 * The header dot and the Runner card keep their last reading through a probe blip (#933).
 * The rule is coder-web's `relayVerdict` / `isTransientStatus` (tested there).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PAGE = readFileSync(join(__dirname, "InstanceDetail.tsx"), "utf8");
const PANEL = readFileSync(join(__dirname, "..", "components", "RunnerPanel.tsx"), "utf8");

describe("the header dot (#933)", () => {
	const check = PAGE.slice(PAGE.indexOf("const checkRuntime = useCallback"), PAGE.indexOf("} catch {", PAGE.indexOf("const checkRuntime = useCallback")));

	it("folds each answer through relayVerdict instead of reading a missing relay as offline", () => {
		expect(check).toContain("setRunnerOnline((prev) => relayVerdict(prev, d));");
		expect(check).not.toContain("setRunnerOnline(d.relay?.connected === true)");
	});

	it("keeps the node and the attachment reason a blip does not carry", () => {
		expect(check.indexOf("if (isTransientStatus(d)) return;")).toBeGreaterThan(-1);
		expect(check.indexOf("if (isTransientStatus(d)) return;")).toBeLessThan(check.indexOf("setRunnerAttachment(d.attachment ?? null);"));
	});

	it("says 'checking' — not 'offline' — before the first reading", () => {
		expect(PAGE).toContain('runnerOnline === null ? "Checking the runner…" : "Runner offline"');
	});
});

describe("the Runner card (#933)", () => {
	it("keeps its last real reading when the answer is a blip", () => {
		expect(PANEL).toContain("if (st && !isTransientStatus(st)) setRuntimeInfo(st);");
	});
});
