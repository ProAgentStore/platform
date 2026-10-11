import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { createLocalApplyTakeoverAdapter } from "./takeover-adapter.js";

const request = { handoffId: "handoff-1", runId: "run-1", applicationId: "application-1", browserProfile: "isolated" as const };

describe("local-apply takeover adapter", () => {
	it("retains the supplied isolated run page, never a shared runner page", async () => {
		const retained = new Map<string, { page: Page }>();
		const isolatedPage = { isClosed: () => false } as Page;
		const sharedPage = { isClosed: () => false } as Page;
		const adapter = createLocalApplyTakeoverAdapter({
			get: (id) => retained.get(id),
			set: (id, page) => retained.set(id, { page }),
			frame: async () => ({ frame: "data:image/jpeg;base64,SAFE", width: 1, height: 1 }),
			input: async () => undefined,
			end: async () => undefined,
		});

		await adapter.open(request, isolatedPage);
		expect(retained.get("local-apply:handoff-1")?.page).toBe(isolatedPage);
		expect(retained.get("local-apply:handoff-1")?.page).not.toBe(sharedPage);
	});

	it("rejects a stale page and does not retain a replacement", async () => {
		const retained = new Map<string, { page: Page }>();
		const adapter = createLocalApplyTakeoverAdapter({
			get: (id) => retained.get(id),
			set: (id, page) => retained.set(id, { page }),
			frame: async () => ({ frame: "data:image/jpeg;base64,SAFE", width: 1, height: 1 }),
			input: async () => undefined,
			end: async () => undefined,
		});
		await expect(adapter.open(request, { isClosed: () => true } as Page)).rejects.toThrow(/no longer available/);
		expect(retained.size).toBe(0);
	});
});
