import { describe, expect, it } from "vitest";
import { guardedToolRefusal, taskCommitGuard } from "./mcp-call-policy.js";

describe("owner policy cannot be cleared by a later action", () => {
	it("keeps the saved task read-only even when the request omits or weakens its guard", () => {
		expect(taskCommitGuard({ readOnly: true }, undefined, undefined)?.mode).toBe("read_only");
		expect(taskCommitGuard({ readOnly: true }, { mode: "dry_run" }, undefined)?.mode).toBe("read_only");
		expect(taskCommitGuard({ dryRun: true }, undefined, undefined)?.mode).toBe("dry_run");
	});
	it("keeps a legacy task's first guard and its vocabulary across later actions", () => {
		const first = taskCommitGuard({}, { mode: "dry_run", labels: "submit|send" }, undefined);
		expect(taskCommitGuard({}, undefined, first)).toEqual(first);
		expect(taskCommitGuard({}, { mode: "dry_run", labels: "never-matches" }, first)).toEqual(first);
		expect(taskCommitGuard({}, { mode: "read_only" }, first)?.mode).toBe("read_only");
	});
	it("does not invent a restriction for an explicitly committing task", () => {
		expect(taskCommitGuard({ dryRun: false, readOnly: false }, undefined, undefined)).toBeUndefined();
	});
	it("refuses newly introduced tools rather than silently admitting a new write path", async () => {
		expect(await guardedToolRefusal("browser_new_mutating_tool", {}, { mode: "read_only" }, async () => null, false)).toContain("BLOCKED");
	});
});
