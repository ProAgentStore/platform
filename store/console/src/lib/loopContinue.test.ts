/**
 * Which ended runs offer Continue (#806), and the one assertion that is not about this file.
 *
 * The last test reads the WORKER's own `RESUMABLE_STOP_REASONS` and requires the two lists to
 * match. The module header explains why a copy is acceptable and which direction of drift is
 * survivable; this is what keeps the drift from happening silently anyway. It is a source read
 * rather than an import because the console and the worker are separate builds — importing worker
 * code into a console test would bring `Env` and the D1 types with it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canContinueRun, CONTINUABLE_STOP_REASONS } from "./loopContinue";

describe("canContinueRun", () => {
	it.each(["interrupted", "max_iterations", "engine_limit", "provider_credit"])("offers Continue after %s", (stopReason) => {
		expect(canContinueRun({ status: "failed", stopReason })).toBe(true);
	});

	it.each(["done", "failed", "cancelled", "escalated", "no_progress", "budget"])("does not offer it after %s", (stopReason) => {
		expect(canContinueRun({ status: "failed", stopReason })).toBe(false);
	});

	it("never offers it on a run that is still going", () => {
		// Belt and braces: a running run carries no stop reason today, but a Continue button
		// underneath a live Stop button is the one outcome that must be impossible by construction.
		expect(canContinueRun({ status: "running", stopReason: null })).toBe(false);
		expect(canContinueRun({ status: "running", stopReason: "max_iterations" })).toBe(false);
	});

	it("says no to a run it knows nothing about", () => {
		expect(canContinueRun(null)).toBe(false);
		expect(canContinueRun(undefined)).toBe(false);
		expect(canContinueRun({ status: "failed" })).toBe(false);
	});
});

describe("the copy of the server's list", () => {
	it("matches RESUMABLE_STOP_REASONS in the API worker", () => {
		const source = readFileSync(new URL("../../../../workers/api/src/lib/agent-loop-store.ts", import.meta.url).pathname, "utf8");
		const declared = /export const RESUMABLE_STOP_REASONS = \[([^\]]*)\]/.exec(source);
		expect(declared).not.toBeNull();
		const server = [...(declared as RegExpExecArray)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
		expect(server.length).toBeGreaterThan(0);
		expect([...CONTINUABLE_STOP_REASONS]).toEqual(server);
	});
});
