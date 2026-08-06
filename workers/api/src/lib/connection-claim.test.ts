import { describe, expect, it } from "vitest";
import { claimDelivery, type DeliveryRow } from "./connection-deliveries.js";
import type { Env } from "../types.js";

/** D1 stub that records UPDATEs and answers a settable `changes`. */
function stubDb(changes: number) {
	const calls: Array<{ sql: string; args: unknown[] }> = [];
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async run() {
								calls.push({ sql, args });
								return { meta: { changes } };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
	return { env, calls };
}

const row = (over: Partial<DeliveryRow> = {}) =>
	({ id: "d1", next_attempt_at: "2026-08-04T00:00:00.000Z", status: "pending", ...over }) as DeliveryRow;

describe("claimDelivery — the sweep must not execute a delivery twice", () => {
	it("claims a row nobody else holds, and hands back the claim's identity", async () => {
		const { env, calls } = stubDb(1);
		const claim = await claimDelivery(env, row(), new Date("2026-08-04T00:00:00.000Z"));
		// Compare-and-swap on next_attempt_at, exactly like runDueTriggers does on next_run_at.
		expect(calls[0].sql).toContain("next_attempt_at IS ?4");
		expect(calls[0].sql).toContain("status = 'pending'");
		expect(calls[0].args).toContain("2026-08-04T00:00:00.000Z");
		// The hold it wrote IS the claim token — the terminal writes present it back (#239),
		// so an attempt that outlives its hold cannot overwrite a newer outcome.
		expect(claim).toEqual({ id: "d1", hold: calls[0].args[1] });
	});

	it("refuses when another invocation already claimed it", async () => {
		// The cron is `* * * * *` and a sweep of 25 rows each starting a Workflow can exceed 60s,
		// so two invocations really do see the same due row. Without this, a `run_pipeline`
		// delivery executed twice — site-builder building and billing twice — and BOTH attempts
		// then markDelivered, so nothing recorded that it happened.
		const { env } = stubDb(0);
		await expect(claimDelivery(env, row(), new Date())).resolves.toBeNull();
	});

	it("holds the row forward rather than parking it in a non-recoverable state", async () => {
		// If the attempt dies mid-flight (isolate reset) the hold simply lapses and the sweep
		// picks it up again — an `attempting` status would strand it forever.
		const { env, calls } = stubDb(1);
		const now = new Date("2026-08-04T00:00:00.000Z");
		await claimDelivery(env, row(), now);
		const held = calls[0].args[1] as string;
		expect(new Date(held).getTime()).toBeGreaterThan(now.getTime());
	});
});
