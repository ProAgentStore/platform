import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerStore } from "./store.js";
import type { RunnerTask } from "./types.js";

function task(id: string, status: RunnerTask["status"]): RunnerTask {
	return { id, type: "browser.open", status, input: {}, requiresApproval: false, createdAt: "", updatedAt: "" };
}

describe("RunnerStore.expireInFlightTasks", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-store-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("fails needs_human + running on boot, leaves terminal tasks untouched", () => {
		const store = new RunnerStore(dir);
		store.putTask(task("a", "needs_human"));
		store.putTask(task("b", "running"));
		store.putTask(task("c", "completed"));
		store.putTask(task("d", "cancelled"));

		const expired = store.expireInFlightTasks();

		expect(expired).toBe(2);
		expect(store.getTask("a")?.status).toBe("failed");
		expect(store.getTask("a")?.error).toMatch(/orphaned/i);
		expect(store.getTask("b")?.status).toBe("failed");
		expect(store.getTask("c")?.status).toBe("completed");
		expect(store.getTask("d")?.status).toBe("cancelled");
	});

	it("persists the expiry so a fresh store instance sees no in-flight tasks", () => {
		new RunnerStore(dir).putTask(task("a", "needs_human"));
		new RunnerStore(dir).expireInFlightTasks();
		// A brand-new store reading the same file sees the failed state.
		expect(new RunnerStore(dir).getTask("a")?.status).toBe("failed");
	});
});
