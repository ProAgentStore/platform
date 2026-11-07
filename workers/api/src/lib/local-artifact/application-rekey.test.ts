/** #1609: an application keyed in the pre-#1606 form still blocks a new lead for the same job; the re-key is idempotent and never merges. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../d1-sqlite.js";
import type { Env } from "../../types.js";
import { claimApplication, getApplicationByWorkKey, rekeyApplications } from "./store.js";

let d1: RealSchemaD1;
let env: Env;
const lead = (url: string) => JSON.stringify({ leadUrl: url, lead: { url } });
const insert = (id: string, key: string | null, url: string) =>
	d1.exec(`INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, work_key, status, lead, created_at, updated_at) VALUES ('${id}', 'tailor', 'u1', 'scout', 'l-${id}', 1, 'k-${id}', ${key ? `'${key}'` : "NULL"}, 'tailoring', '${lead(url)}', 1, 1)`);
const claim = (workKey: string) => claimApplication(env, { id: "new", instanceId: "tailor", userId: "u1", sourceInstanceId: "scout", leadId: "l-new", lifecycleVersion: 1, key: "k-new", workKey, lead: {}, status: "tailoring", now: 2 });

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["scout", "tailor"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

describe("legacy work keys (#1609)", () => {
	it("an application keyed url:https://au.seek.com/job/N blocks a new lead seek:N", async () => {
		insert("a1", "url:https://au.seek.com/job/95684523", "https://au.seek.com/job/95684523");
		expect((await getApplicationByWorkKey(env, "tailor", "u1", "seek:95684523"))?.id).toBe("a1");
		const out = await claim("seek:95684523");
		expect(out).toMatchObject({ created: false, app: { id: "a1" } });
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM job_applications").first<{ n: number }>())?.n).toBe(1);
		expect(await getApplicationByWorkKey(env, "tailor", "u1", "seek:11111111")).toBeNull();
	});
	it("re-keys idempotently, dry run first", async () => {
		insert("a1", "url:http://careers.x.example/job/Dev/123456?eid=1", "http://careers.x.example/job/Dev/123456?eid=1");
		insert("a2", "seek:5", "https://www.seek.com.au/job/5");
		const dry = await rekeyApplications(env, "tailor", "u1", { dryRun: true });
		expect(dry).toMatchObject({ dryRun: true, scanned: 2, rekeyed: 1, collisions: [] });
		expect((await d1.DB.prepare("SELECT work_key FROM job_applications WHERE id='a1'").first<{ work_key: string }>())?.work_key).toMatch(/^url:http:/);
		await rekeyApplications(env, "tailor", "u1", { dryRun: false });
		expect((await d1.DB.prepare("SELECT work_key FROM job_applications WHERE id='a1'").first<{ work_key: string }>())?.work_key).toBe("pageup:careers.x.example:123456");
		expect(await rekeyApplications(env, "tailor", "u1", { dryRun: false })).toMatchObject({ rekeyed: 0, collisions: [] });
	});
	it("reports two applications for one job and leaves both", async () => {
		insert("a1", "url:https://au.seek.com/job/7", "https://au.seek.com/job/7");
		insert("a2", "url:https://www.seek.com.au/job/7?x=1", "https://www.seek.com.au/job/7?x=1");
		const report = await rekeyApplications(env, "tailor", "u1", { dryRun: false });
		expect(report).toMatchObject({ rekeyed: 0, collisions: [{ workKey: "seek:7", applicationIds: ["a1", "a2"] }] });
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM job_applications").first<{ n: number }>())?.n).toBe(2);
	});
});
