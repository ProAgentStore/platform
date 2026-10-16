/**
 * #1079 — a PAUSED local-browser run no longer holds one of the instance's `maxConcurrent` slots, over
 * the real schema and the real claim. It is still an open run: it is synced and resumable.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "../d1-sqlite.js";
import type { Env } from "../../types.js";
import type { EffectiveLocalBrowserPolicy } from "./policy.js";
import { claimLocalBrowserRun } from "./store.js";

let d1: RealSchemaD1;
let env: Env;
const policy = { limits: { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 } } as unknown as EffectiveLocalBrowserPolicy;
const claim = (id: string) => claimLocalBrowserRun(env, { id, instanceId: "scout", userId: "u1", requestId: `req-${id}`, objective: "roles", policy, now: 1 });
const setStatus = (id: string, status: string) => d1.exec(`UPDATE local_browser_runs SET status = '${status}' WHERE id = '${id}'`);

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["scout"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

describe("which local-browser runs hold a concurrency slot (#1079)", () => {
	it("a paused run waits on a person: a second run starts beside it", async () => {
		expect((await claim("r1")).kind).toBe("created");
		setStatus("r1", "paused");
		expect((await claim("r2")).kind).toBe("created");
	});

	it("a working (or queued) run still holds its slot — the cap is unchanged for work in flight", async () => {
		expect((await claim("r1")).kind).toBe("created"); // queued
		expect(await claim("r2")).toMatchObject({ kind: "at_capacity", active: 1 });
		setStatus("r1", "running");
		expect(await claim("r3")).toMatchObject({ kind: "at_capacity", active: 1 });
	});
});
