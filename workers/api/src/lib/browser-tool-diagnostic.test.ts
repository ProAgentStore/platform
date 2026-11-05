import { describe, expect, it } from "vitest";
import { sanitizeBrowserToolDiagnostic } from "./browser-tool-diagnostic.js";

const diagnostic = () => ({
	kind: "request_deadline", phase: "native_response", tool: "browser_file_upload", execution: "pending", recoverable: false,
	message: "The action may still execute", originalError: "Request timed out", elapsedMs: 60_000,
	machine: { load1: 9.5, loadPerCpu: 1.1875, cpus: 8, freeMemoryBytes: 1024, totalMemoryBytes: 8192 },
});

describe("closed browser tool diagnosis", () => {
	it("keeps typed execution uncertainty and only approved machine evidence", () => {
		const value = diagnostic();
		expect(sanitizeBrowserToolDiagnostic({ ...value, rawArguments: { password: "PRIVATE" }, machine: { ...value.machine, processEnv: "PRIVATE" } })).toEqual(value);
		expect(sanitizeBrowserToolDiagnostic({ ...value, kind: "page_operation_failure", execution: "settled", recoverable: true })).toMatchObject({ kind: "page_operation_failure", execution: "settled", recoverable: true });
		expect(sanitizeBrowserToolDiagnostic({ ...value, machine: { ...value.machine, load1: null, loadPerCpu: null } })?.machine).toMatchObject({ load1: null, loadPerCpu: null });
	});
	it.each([
		{ kind: "browser_is_stuck" }, { phase: "raw_html" }, { execution: "cancelled" }, { recoverable: "yes" },
		{ tool: "x".repeat(101) }, { message: {} }, { elapsedMs: -1 }, { elapsedMs: Infinity }, { elapsedMs: 1.5 },
		{ machine: { ...diagnostic().machine, cpus: 0 } }, { machine: { ...diagnostic().machine, load1: NaN } },
		{ machine: { ...diagnostic().machine, freeMemoryBytes: Number.MAX_SAFE_INTEGER + 1 } },
	])("drops invalid diagnostic fields rather than upgrading their claim: %j", (invalid) => {
		expect(sanitizeBrowserToolDiagnostic({ ...diagnostic(), ...invalid })).toBeUndefined();
	});
	it("sanitizes credential URLs before clipping and refuses oversized prose", () => {
		const url = "https://person:PRIVATE_PASSWORD@jobs.test/apply?token=PRIVATE_TOKEN#PRIVATE_FRAGMENT";
		const result = sanitizeBrowserToolDiagnostic({ ...diagnostic(), message: `Loading ${url} ${"x".repeat(3000)}`, originalError: `Failed ${url}` });
		expect(result?.message.length).toBeLessThanOrEqual(2000);
		expect(result?.message).toContain("https://jobs.test/apply");
		expect(result?.originalError).toBe("Failed https://jobs.test/apply");
		expect(JSON.stringify(result)).not.toContain("PRIVATE");
		expect(sanitizeBrowserToolDiagnostic({ ...diagnostic(), originalError: "x".repeat(16_385) })?.originalError).toBe("[diagnostic text omitted: oversized]");
	});
});
