/** #1314: actual migrated SQLite and actual admission paths. Only external calls are fake. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { encryptKey } from "./crypto.js";
import { automaticProviderHold, observeProviderAccount, providerCredentialId, selectedProviderAccount } from "./provider-account-hold.js";
import { setCoderBrain } from "./coder-brain.js";
import { queueGate, runPoTriage } from "./po-triage-wake.js";
import { runAutoPickup, setAutoPickup, sweepAutoPickup, wakeIdleCoder } from "./auto-pickup.js";
import { enqueueObjective } from "./objective-queue.js";
import type { Env } from "../types.js";

const start = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
vi.mock("../routes/push.js", () => ({ notifyUser: (...args: unknown[]) => notify(...args) }));
vi.mock("./loop-drivers.js", async (original) => ({ ...(await original<typeof import("./loop-drivers.js")>()), loopDriverFor: () => ({ id: "coding", start }) }));
vi.mock("./delegation-budget-store.js", async (original) => ({ ...(await original<typeof import("./delegation-budget-store.js")>()), openBudget: async () => ({ id: "budget-test" }) }));
const { tryDequeueAndStart } = await import("./objective-queue-start.js");
const KEK = "17".repeat(32), OLD = "not-a-real-anthropic-key-old", NEW = "not-a-real-anthropic-key-new";
const CF = { accountId: "audit-account", token: "not-a-real-cloudflare-token" };
const ISSUE = { number: 9, title: "An open issue", state: "open", labels: [], assignees: [], comments: 0, updatedAt: "", url: "u/9" };
let d1: RealSchemaD1, env: Env;
let pickedModel: string | null;
async function key(provider = "anthropic", value = OLD, userId = "u1") {
	const e = await encryptKey(value, KEK);
	await d1.DB.prepare("INSERT INTO user_api_keys(user_id,provider,account_id,key_ciphertext,dek_wrapped,iv) VALUES(?1,?2,'',?3,?4,?5) ON CONFLICT(user_id,provider,account_id) DO UPDATE SET key_ciphertext=excluded.key_ciphertext,dek_wrapped=excluded.dek_wrapped,iv=excluded.iv")
		.bind(userId, provider, e.ciphertext, e.dekWrapped, e.iv).run();
}
const entries = () => d1.sqlite.prepare("SELECT id,objective,status,deferral_count FROM instance_objective_queue").all();
beforeEach(async () => {
	d1 = realSchemaD1(); seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	d1.exec("INSERT INTO coding_repos(id,instance_id,user_id,name,github_repo) VALUES('repo1','coder','u1','app','acme/app')");
	pickedModel = null;
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: KEK, AGENT: { idFromName: (s: string) => s, get: () => ({ fetch: async () => Response.json({ model: pickedModel, modelChosen: pickedModel !== null }) }) } } as unknown as Env;
	start.mockReset().mockResolvedValue({ ok: true, runId: "run-test", driver: "coding" });
	notify.mockReset().mockResolvedValue(undefined);
	await key(); await setAutoPickup(env, "coder", "u1", { enabled: true, maxPerDay: 100 });
});
afterEach(() => { d1.close(); vi.unstubAllGlobals(); });

describe("provider and credential scoping", () => {
	it("credit/auth holds survive repeated terminal/cron wakes; one notice; verified recovery admits again", async () => {
		for (const failure of ["provider_credit", "provider_credentials"] as const) {
			await observeProviderAccount(env, "u1", "anthropic", OLD, failure);
			const options = { listOpenIssues: async () => ({ issues: [ISSUE], unreadable: false }), startQueued: async () => start() };
			for (let i = 0; i < 3; i++) {
				expect(await runAutoPickup(env, "coder", "u1", options)).toMatchObject({ started: false });
				await wakeIdleCoder(env, "coder", "u1");
				await sweepAutoPickup(env, Date.now() + i * 60_000, async () => {
					expect(await runAutoPickup(env, "coder", "u1", options)).toMatchObject({ started: false });
					return "held";
				});
			}
			expect(entries()).toEqual([]); expect(start).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledTimes(failure === "provider_credit" ? 1 : 2);
			await observeProviderAccount(env, "u1", "anthropic", OLD, null);
			expect(await runAutoPickup(env, "coder", "u1", options)).toMatchObject({ started: true, issue: 9 });
			d1.exec("DELETE FROM instance_objective_queue"); start.mockClear();
		}
	});

	it("a replacement key escapes the old hold; a delayed old-key failure cannot poison it", async () => {
		await observeProviderAccount(env, "u1", "anthropic", OLD, "provider_credit");
		await key("anthropic", NEW);
		await observeProviderAccount(env, "u1", "anthropic", OLD, "provider_credentials");
		expect(await automaticProviderHold(env, "coder", "u1")).toBeNull();
		expect(await selectedProviderAccount(env, "coder", "u1")).toEqual({ provider: "anthropic", credentialId: await providerCredentialId("anthropic", NEW) });
	});

	it("success only clears the exact owner/provider/credential; Cloudflare identity includes its account", async () => {
		await observeProviderAccount(env, "u1", "anthropic", OLD, "provider_credit");
		await observeProviderAccount(env, "u1", "anthropic", NEW, null);
		await observeProviderAccount(env, "other-user", "anthropic", OLD, null);
		await observeProviderAccount(env, "u1", "cloudflare", CF, null);
		expect(await automaticProviderHold(env, "coder", "u1")).not.toBeNull();
		expect(await providerCredentialId("cloudflare", CF)).not.toBe(await providerCredentialId("cloudflare", { ...CF, accountId: "another-account" }));
		expect(await providerCredentialId("cloudflare", JSON.stringify({ token: CF.token, accountId: CF.accountId }))).toBe(await providerCredentialId("cloudflare", CF));
	});

	it("a Cloudflare Brain hold does not block an Anthropic Pilot; a Cloudflare chat loop checks only Cloudflare", async () => {
		await key("cloudflare", JSON.stringify(CF)); pickedModel = "@cf/meta/llama-4-scout-17b-16e-instruct";
		await observeProviderAccount(env, "u1", "cloudflare", CF, "provider_credentials");
		// seedTenant's generic workflow honours its selected advisory Brain.
		expect(await automaticProviderHold(env, "coder", "u1")).toMatchObject({ provider: "cloudflare" });
		d1.exec("UPDATE agents SET config = '{\"capabilities\":{\"workflow\":\"CODING_SESSION\",\"surfaces\":[\"coding\"],\"runtime\":\"coding\"}}'");
		expect(await automaticProviderHold(env, "coder", "u1")).toBeNull();
		await observeProviderAccount(env, "u1", "anthropic", OLD, "provider_credit");
		expect(await automaticProviderHold(env, "coder", "u1")).toMatchObject({ provider: "anthropic" });
	});

	it("a legacy default Pilot with only Cloudflare checks that credential; explicit Haiku never substitutes it", async () => {
		await key("cloudflare", JSON.stringify(CF));
		d1.exec("DELETE FROM user_api_keys WHERE provider='anthropic'");
		d1.exec("UPDATE agents SET config = '{\"capabilities\":{\"workflow\":\"CODING_SESSION\",\"surfaces\":[\"coding\"],\"runtime\":\"coding\"}}'");
		await observeProviderAccount(env, "u1", "cloudflare", CF, "provider_credentials");
		expect(await automaticProviderHold(env, "coder", "u1")).toMatchObject({ provider: "cloudflare" });
		d1.exec("UPDATE agent_instances SET config=json_set(config,'$.pilot.model','claude-haiku-5-5')");
		await expect(selectedProviderAccount(env, "coder", "u1")).rejects.toThrow(/requires an Anthropic API key/);
	});

	it.each(["cloudflare-only", "no-keys"] as const)("an explicit Haiku Pilot with %s waits before automatic admission or a pending queue claim", async (availability) => {
		if (availability === "cloudflare-only") await key("cloudflare", JSON.stringify(CF));
		d1.exec("DELETE FROM user_api_keys WHERE provider='anthropic'");
		d1.exec("UPDATE agents SET config = '{\"capabilities\":{\"workflow\":\"CODING_SESSION\",\"surfaces\":[\"coding\"],\"runtime\":\"coding\"}}'");
		d1.exec("UPDATE agent_instances SET config=json_set(config,'$.pilot.model','claude-haiku-5-5')");
		const fetch = vi.fn(async () => { throw new Error("A provider must not be probed by admission"); }); vi.stubGlobal("fetch", fetch);
		const list = vi.fn(async () => ({ issues: [ISSUE], unreadable: false }));
		for (let i = 0; i < 3; i++) expect(await runAutoPickup(env, "coder", "u1", { listOpenIssues: list, startQueued: async () => start() }))
			.toMatchObject({ started: false, reason: expect.stringContaining("requires an Anthropic API key") });
		expect(list).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
		expect(entries()).toEqual([]);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM auto_pickup_log WHERE outcome='started'").get()).toEqual({ n: 0 });
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM auto_pickup_admissions").get()).toEqual({ n: 0 });
		const q = await enqueueObjective(env, { instanceId: "coder", userId: "u1", repoId: "repo1", objective: "Original objective" });
		expect(await tryDequeueAndStart(env, "coder", "repo1", "u1")).toMatchObject({ drained: false, held: expect.stringContaining("Profile → API Keys") });
		expect(entries()).toEqual([{ id: q.id, objective: "Original objective", status: "pending", deferral_count: 0 }]);
		await key();
		expect(await automaticProviderHold(env, "coder", "u1")).toBeNull();
		expect(await tryDequeueAndStart(env, "coder", "repo1", "u1")).toMatchObject({ started: true, entryId: q.id });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("old informational error-log failures alone never permanently bind an unrelated replacement credential", async () => {
		d1.exec("INSERT INTO error_log(id,user_id,source,message,context) VALUES('old','u1','coding:session','Anthropic (400): insufficient credit','{\"failureClass\":\"provider_credit\"}')");
		expect(await queueGate(env, "coder", "u1")).toBeNull();
	});

	it("claims one account-wide notice when two coders wake concurrently", async () => {
		seedTenant(d1, { userId: "u2", instanceIds: ["elsewhere"] });
		d1.exec("UPDATE agent_instances SET user_id='u1' WHERE id='elsewhere'");
		await observeProviderAccount(env, "u1", "anthropic", OLD, "provider_credit");
		const send = vi.fn(async () => undefined);
		await Promise.all([automaticProviderHold(env, "coder", "u1", send), automaticProviderHold(env, "elsewhere", "u1", send)]);
		expect(send).toHaveBeenCalledTimes(1);
	});
});

describe("automatic admission, without consuming the original objective", () => {
	it("holds pre-existing pending work before claiming/opening a budget; verification drains that same entry", async () => {
		const q = await enqueueObjective(env, { instanceId: "coder", userId: "u1", repoId: "repo1", objective: "Original owner-approved objective" });
		await observeProviderAccount(env, "u1", "anthropic", OLD, "provider_credentials");
		for (let i = 0; i < 3; i++) expect(await tryDequeueAndStart(env, "coder", "repo1", "u1")).toMatchObject({ drained: false, held: expect.stringContaining("rejected") });
		expect(entries()).toEqual([{ id: q.id, objective: "Original owner-approved objective", status: "pending", deferral_count: 0 }]);
		expect(start).not.toHaveBeenCalled();
		await observeProviderAccount(env, "u1", "anthropic", OLD, null);
		expect(await tryDequeueAndStart(env, "coder", "repo1", "u1")).toMatchObject({ drained: true, entryId: q.id, started: true });
		expect(entries()).toEqual([{ id: q.id, objective: "Original owner-approved objective", status: "started", deferral_count: 0 }]);
	});

	it("two non-provider needs_human endings bound replacement attempts while recovered auth does not", async () => {
		const q = await enqueueObjective(env, { instanceId: "coder", userId: "u1", repoId: "repo1", objective: "Implement GitHub issue #9", metadata: JSON.stringify({ autoPickup: { repo: "acme/app", issue: 9 } }) });
		d1.exec("UPDATE instance_objective_queue SET status='started'");
		for (const [id, why] of [["human-1", "decision"], ["human-2", "escalated"]]) {
			await d1.DB.prepare("INSERT INTO agent_loop_runs(run_id,user_id,instance_id,objective,status,stop_reason,max_iterations,started_at,queue_entry_id) VALUES(?1,'u1','coder','Implement GitHub issue #9','needs_human',?2,10,1,?3)").bind(id, why, q.id).run();
		}
		const result = await runAutoPickup(env, "coder", "u1", { listOpenIssues: async () => ({ issues: [ISSUE], unreadable: false }), postComment: async () => true, notify: async () => undefined });
		expect(result).toMatchObject({ started: false, reason: expect.stringContaining("none") });
		expect(entries()).toHaveLength(1);
	});

	it("holds the PO-triage path too; storage failures fail closed while observation failures preserve provider outcomes", async () => {
		await observeProviderAccount(env, "u1", "anthropic", OLD, "provider_credit");
		expect(await queueGate(env, "coder", "u1")).toMatch(/insufficient balance/);
		await setCoderBrain(env, "coder", "u1", { enabled: true, poEnabled: true });
		const report = await runPoTriage(env, { instance_id: "coder", user_id: "u1" }, { dryRun: false }, new Date(), {
			listOpenIssues: async () => ({ issues: [{ ...ISSUE, body: "The login form crashes on an empty email. Scope: src/login.ts. Acceptance criteria: empty email shows an inline error." }], complete: true, unreadable: false }),
			listComments: async () => [], startQueued: async () => start(), postComment: async () => true,
		});
		expect(report).toMatchObject({ skipped: false, gate: expect.stringMatching(/insufficient balance/) });
		expect(entries()).toEqual([]); expect(start).not.toHaveBeenCalled();
		const bad = { ...env, DB: { prepare() { throw new Error("contains a secret that must not surface"); } } } as unknown as Env;
		await expect(observeProviderAccount(bad, "u1", "anthropic", OLD, "provider_credit")).resolves.toBeUndefined();
		expect(await automaticProviderHold(bad, "coder", "u1")).toMatchObject({ reason: expect.stringContaining("could not be checked") });
		expect((await automaticProviderHold(bad, "coder", "u1"))?.reason).not.toContain("secret");
	});
});
