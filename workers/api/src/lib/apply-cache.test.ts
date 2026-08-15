import { describe, expect, it, vi } from "vitest";
import { atsHost, deriveJobPassword, getAtsCacheHint, listAtsCache, outcomeRank, saveAtsCache, shouldReplaceCache } from "./apply-cache.js";
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


/**
 * The per-ATS cache, on the two axes it was wrong about:
 *
 *  #633 — the row is keyed on the bare HOST, and on Greenhouse / Lever / Ashby / SmartRecruiters
 *         the employer is in the PATH. Every employer on those platforms shared one row, and the
 *         row is injected into the next application's prompt under "reuse the good steps". Two
 *         live rows carried a cover letter naming one company and a 90-word answer written for
 *         another. The fix is the distinction the codebase already drew for `providedAnswers`:
 *         the ROUTE is reusable across employers, the ANSWERS are not.
 *  #655 — every terminal path upserted unconditionally, so a run cancelled two steps in replaced
 *         a 40-step route that had actually submitted. And `outcome`, added by migration 0017
 *         "so the … next run sees the prior result", was written by every call site and read by
 *         nothing that reaches the prompt.
 */
describe("ats apply cache", () => {
	interface Row { notes: string; steps: number; outcome: string | null; updated_at: string }
	function mockEnv(seed: Record<string, Row> = {}) {
		const store = new Map<string, Row>(Object.entries(seed));
		const prepare = vi.fn((sql: string) => ({
			bind: (...args: unknown[]) => ({
				first: async () => {
					const [userId, host] = args as [string, string];
					const row = store.get(`${userId}:${host}`);
					if (!row) return null;
					return sql.includes("notes") ? row : { outcome: row.outcome, updated_at: row.updated_at };
				},
				run: async () => {
					const [userId, host, notes, steps, outcome] = args as [string, string, string, number, string];
					store.set(`${userId}:${host}`, { notes, steps, outcome, updated_at: "2026-08-15 10:00:00" });
					return { success: true };
				},
				all: async () => ({ results: [...store.entries()].map(([k, v]) => ({ host: k.split(":")[1], ...v })) }),
			}),
		}));
		return { env: { DB: { prepare } } as unknown as Env, store };
	}

	it("saves a transcript and reads it back as a numbered hint", async () => {
		const { env } = mockEnv();
		await saveAtsCache(env, "u1", "jobs.dayforcehcm.com", ["navigate to job", 'click button "Apply"', 'upload résumé to "Resume"']);
		const hint = (await getAtsCacheHint(env, "u1", "jobs.dayforcehcm.com")) ?? "";
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

	// ── #633: what crosses to the next employer, and what does not ──────────────

	it("WITHHOLDS the typed answers — the route survives, the cover letter does not", async () => {
		const { env, store } = mockEnv();
		await saveAtsCache(env, "u1", "jobs.ashbyhq.com", [
			'click button "Apply"',
			'type "Dear Hiring Manager, I am excited to apply for the Head of Engineering role at Business AI Group." into textbox "Why do you want to work here?"',
			'type "Pj9!J8erKq2Xab" into textbox "Password"',
			'select "Australian Permanent Resident" in "Working rights"',
			'click button "Submit application"',
		], "submitted");
		const stored = store.get("u1:jobs.ashbyhq.com")?.notes ?? "";
		expect(stored).not.toContain("Business AI Group");
		expect(stored).not.toContain("Pj9!J8erKq2Xab");
		// The ROUTE is intact: which controls, in which order, and which option was picked.
		expect(stored).toContain('click button "Apply"');
		expect(stored).toContain('into textbox "Why do you want to work here?"');
		expect(stored).toContain('select "Australian Permanent Resident" in "Working rights"');
		expect(stored).toContain('click button "Submit application"');
		// A job-specific question says so, so the next run writes a fresh answer instead of
		// hunting for one it thinks it lost.
		expect(stored).toMatch(/written for a DIFFERENT employer/);
	});

	it("neutralises the rows already in production, without a backfill", async () => {
		// The live `employmenthero.com` row was written before any of this existed.
		const { env } = mockEnv({
			"u1:employmenthero.com": {
				notes: '27. type "Dear Hiring Manager, I am excited to apply for the Head of Engineering role at Business AI Group." into textbox ""',
				steps: 33,
				outcome: "max_steps",
				updated_at: "2026-07-06 02:00:00",
			},
		});
		const hint = (await getAtsCacheHint(env, "u1", "employmenthero.com")) ?? "";
		expect(hint).not.toContain("Business AI Group");
	});

	it("withholds a mailbox read's one-time link and a navigation's employer path", async () => {
		const { env, store } = mockEnv();
		await saveAtsCache(env, "u1", "jobs.lever.co", [
			"read_email_link → Email \"Sign in\" from x. Most likely sign-in link: https://jobs.lever.co/magic?token=abc123",
			"navigate to https://jobs.lever.co/acme-corp/1234/apply",
			'type "0404453580" into textbox "Phone" — "Phone" now reads "+61404453580"',
		]);
		const stored = store.get("u1:jobs.lever.co")?.notes ?? "";
		expect(stored).not.toContain("token=abc123");
		expect(stored).not.toContain("acme-corp");
		expect(stored).toContain("navigate to https://jobs.lever.co/…");
		expect(stored).not.toContain("+61404453580");
		expect(stored).toContain('now reads "⟨withheld⟩"');
	});

	it("caps the hint — it is the LARGER of the two inputs and was capped nowhere", async () => {
		const { env } = mockEnv();
		await saveAtsCache(env, "u1", "big.com", Array.from({ length: 80 }, (_, i) => `click button "Step ${i}"`));
		const hint = (await getAtsCacheHint(env, "u1", "big.com")) ?? "";
		expect(hint.split("\n").length).toBeLessThan(45);
		expect(hint).toContain("steps omitted");
	});

	// ── #655: what it learns from, and what it refuses to unlearn ───────────────

	it("a cancelled run does NOT overwrite a submitted route", async () => {
		const { env, store } = mockEnv();
		await saveAtsCache(env, "u1", "greenhouse.io", Array.from({ length: 40 }, (_, i) => `click button "Step ${i}"`), "submitted");
		await saveAtsCache(env, "u1", "greenhouse.io", ['navigate to https://greenhouse.io/x', 'click button "Apply"'], "cancelled");
		const row = store.get("u1:greenhouse.io");
		expect(row?.outcome).toBe("submitted");
		expect(row?.steps).toBe(40);
	});

	it("but a run at least as good DOES replace it, and a stale route never pins the slot", async () => {
		const { env, store } = mockEnv();
		await saveAtsCache(env, "u1", "greenhouse.io", ["a", "b"], "submitted");
		await saveAtsCache(env, "u1", "greenhouse.io", ["c", "d", "e"], "submitted");
		expect(store.get("u1:greenhouse.io")?.steps).toBe(3);
		// A route from months ago must not lock out a failing run on a redesigned ATS.
		expect(shouldReplaceCache({ outcome: "failed", now: Date.parse("2026-08-15T00:00:00Z") }, { outcome: "submitted", updatedAt: "2026-01-01 00:00:00" })).toBe(true);
		expect(shouldReplaceCache({ outcome: "failed", now: Date.parse("2026-08-15T00:00:00Z") }, { outcome: "submitted", updatedAt: "2026-08-14 00:00:00" })).toBe(false);
	});

	it("ranks outcomes so the prompt keeps the best evidence available", () => {
		expect(outcomeRank("submitted")).toBeGreaterThan(outcomeRank("ready"));
		expect(outcomeRank("ready")).toBeGreaterThan(outcomeRank("stuck"));
		expect(outcomeRank("stuck")).toBeGreaterThan(outcomeRank("cancelled"));
		expect(outcomeRank("cancelled")).toBe(outcomeRank("failed"));
	});

	it("tells the prompt how the prior run ENDED — the column migration 0017 added for this", async () => {
		const { env } = mockEnv();
		await saveAtsCache(env, "u1", "h1.com", ['click button "Submit"'], "submitted");
		expect(await getAtsCacheHint(env, "u1", "h1.com")).toMatch(/ENDED IN A SUBMITTED APPLICATION/);
		const { env: env2 } = mockEnv();
		await saveAtsCache(env2, "u1", "h2.com", ['click button "Next"'], "stuck");
		expect(await getAtsCacheHint(env2, "u1", "h2.com")).toMatch(/ENDED IN "stuck"/);
	});

	it("the transparency view is sanitized too — it is what the console renders back", async () => {
		const { env } = mockEnv();
		await saveAtsCache(env, "u1", "h.com", ['type "secret answer" into textbox "Why us?"'], "submitted");
		const rows = await listAtsCache(env, "u1");
		expect(rows.length).toBe(1);
		expect(rows[0].notes).not.toContain("secret answer");
		expect(rows[0].outcome).toBe("submitted");
	});
});
