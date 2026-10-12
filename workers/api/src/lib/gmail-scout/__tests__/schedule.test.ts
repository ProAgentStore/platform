/**
 * Scheduled Gmail Scout scans and recorded preflight failures (#1022), on the real migrated schema.
 *
 * The Scout's Agent DO is a stub that reports email permission OFF, so every scan stops at its first
 * preflight check — which is the path that used to throw unrecorded. No Gmail token is ever requested.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../../d1-sqlite.js";
import { GMAIL_SCOUT_SCAN_INTERVAL_MS } from "../config.js";
import { runDueGmailScoutScans, scanGmailScout } from "../scan.js";
import type { Env } from "../../../types.js";

let d1: RealSchemaD1;
let env: Env;
// The real clock: the scan state stamps failures with SQLite `datetime('now')`, so the sweep must judge against it.
const NOW = Date.now();
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["never", "off", "fresh", "old"] });
	const agent = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ permissions: { email: false } }) }) };
	env = { DB: d1.DB, AGENT: agent } as unknown as Env;
	for (const [id, enabled] of [["never", 1], ["off", 0], ["fresh", 1], ["old", 1]] as const) {
		d1.exec(`INSERT INTO gmail_scout_configs (id, instance_id, pinned_email, enabled) VALUES ('cfg-${id}', '${id}', 'scout@example.com', ${enabled})`);
	}
	d1.exec(`INSERT INTO gmail_scout_scan_state (instance_id, last_scan_at) VALUES ('fresh', '${sqlTime(NOW - 60 * 60_000)}'), ('old', '${sqlTime(NOW - GMAIL_SCOUT_SCAN_INTERVAL_MS - 60_000)}')`);
});
afterEach(() => d1.close());

const state = (id: string) => d1.sqlite.prepare("SELECT failure_count AS failures, last_failure_message AS message FROM gmail_scout_scan_state WHERE instance_id = ?").get(id) as { failures: number; message: string | null } | undefined;

describe("a Scout that cannot read its mailbox says so (#1022)", () => {
	it("records the preflight failure on its scan state instead of throwing unrecorded", async () => {
		await expect(scanGmailScout(env, "never", "u1")).rejects.toThrow(/Email access is not enabled/);
		expect(state("never")).toMatchObject({ failures: 1, message: expect.stringMatching(/Email access is not enabled/) });
	});
});

describe("scheduled scans (#1022)", () => {
	it("scans every enabled Scout that is due — never scanned, or not within the interval — and skips the rest", async () => {
		const out = await runDueGmailScoutScans(env, NOW);
		expect(out).toEqual({ scanned: 0, failed: 2 });
		expect(state("never")?.failures).toBe(1);
		expect(state("old")?.failures).toBe(1);
		expect(state("fresh")?.failures ?? 0).toBe(0); // scanned an hour ago
		expect(state("off")).toBeUndefined(); // disabled: never touched
	});

	it("retries a failing source on the same cadence, never every minute", async () => {
		await runDueGmailScoutScans(env, NOW);
		expect(await runDueGmailScoutScans(env, NOW + 60_000)).toEqual({ scanned: 0, failed: 0 });
		expect(state("never")?.failures).toBe(1);
	});

	it("is bounded per tick", async () => {
		expect(await runDueGmailScoutScans(env, NOW, 1)).toEqual({ scanned: 0, failed: 1 });
	});
});
