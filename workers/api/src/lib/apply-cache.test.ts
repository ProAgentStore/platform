import { describe, expect, it, vi } from "vitest";
import { atsHost, deriveJobPassword, getAtsCacheHint, saveAtsCache } from "./apply-cache.js";
import type { Env } from "../types.js";

describe("deriveJobPassword", () => {
	const env = { SESSION_SIGNING_KEY: "test-secret" } as unknown as Env;
	it("is stable per user, differs across users, and meets complexity", async () => {
		const p1 = await deriveJobPassword(env, "user-1");
		expect(await deriveJobPassword(env, "user-1")).toBe(p1); // same every run
		expect(await deriveJobPassword(env, "user-2")).not.toBe(p1); // per-user
		expect(p1).toMatch(/[A-Z]/);
		expect(p1).toMatch(/[a-z]/);
		expect(p1).toMatch(/[0-9]/);
		expect(p1).toMatch(/[^A-Za-z0-9]/);
		expect(p1.length).toBeGreaterThanOrEqual(12);
	});
});

describe("atsHost", () => {
	it("extracts the host without www", () => {
		expect(atsHost("https://jobs.dayforcehcm.com/en-AU/ausredcross/x/jobs/13204")).toBe("jobs.dayforcehcm.com");
		expect(atsHost("https://www.lever.co/acme")).toBe("lever.co");
		expect(atsHost("not a url")).toBe("");
	});
});

describe("ats apply cache", () => {
	function mockEnv() {
		const store = new Map<string, { notes: string; steps: number }>();
		const prepare = vi.fn((sql: string) => ({
			bind: (...args: unknown[]) => ({
				first: async () => {
					const [userId, host] = args as [string, string];
					const row = store.get(`${userId}:${host}`);
					return row ? { notes: row.notes } : null;
				},
				run: async () => {
					const [userId, host, notes, steps] = args as [string, string, string, number];
					store.set(`${userId}:${host}`, { notes, steps });
					return { success: true };
				},
			}),
		}));
		return { env: { DB: { prepare } } as unknown as Env, store };
	}

	it("saves a transcript and reads it back as a numbered hint", async () => {
		const { env } = mockEnv();
		await saveAtsCache(env, "u1", "jobs.dayforcehcm.com", ["navigate to job", 'click button "Apply"', "upload résumé to \"Resume\""]);
		const hint = await getAtsCacheHint(env, "u1", "jobs.dayforcehcm.com");
		expect(hint).toContain("1. navigate to job");
		expect(hint).toContain('2. click button "Apply"');
		expect(hint).toContain("3. upload résumé");
	});

	it("returns undefined for an unknown host and ignores empty saves", async () => {
		const { env } = mockEnv();
		expect(await getAtsCacheHint(env, "u1", "unknown.com")).toBeUndefined();
		await saveAtsCache(env, "u1", "", ["x"]); // no host → no-op
		await saveAtsCache(env, "u1", "h", []); // no actions → no-op
		expect(await getAtsCacheHint(env, "u1", "h")).toBeUndefined();
	});
});
