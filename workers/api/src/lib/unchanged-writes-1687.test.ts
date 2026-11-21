/**
 * #1687 — a call that would store what the row already holds writes 0 rows. Counted with SQLite's own
 * `total_changes()` (what D1 bills as rows written) on the real schema.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../types.js";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { ISSUE_CACHE_REFRESH_HOURS, type IssueCache, upsertIssueTicket } from "./issue-tickets.js";
import { RESOURCES_WRITE_MIN_MS, saveResourceSample } from "./runner-resources.js";
import { updateGateState } from "./runner-admission-gate.js";

let db: RealSchemaD1 | null = null;
afterEach(() => {
	db?.close();
	db = null;
});
const open = () => {
	db = realSchemaD1();
	return { d: db, env: { DB: db.DB } as unknown as Env };
};
const changes = (d: RealSchemaD1) => Number((d.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
const GiB = 1024 ** 3;
const T0 = Date.UTC(2026, 10, 21, 10, 0, 0);
const sample = (at: number) => ({ loadAvg: [0.5, 0.5, 0.5], cpus: 8, memTotalBytes: 16 * GiB, memFreeBytes: 8 * GiB, platform: "linux", sampledAt: at });
const SEED = `INSERT INTO users (id, github_login) VALUES ('u1','u1'); INSERT INTO agents (id,owner_id,slug,name) VALUES ('a','u1','s','S');
	INSERT INTO agent_instances (id,agent_id,user_id,status,config) VALUES ('i1','a','u1','active','{}');
	INSERT INTO instance_runtime_nodes (instance_id,user_id,runner_node,endpoint_url,machine_id,status) VALUES ('i1','u1','pink','relay://','m1','online');`;
const stored = (d: RealSchemaD1) => JSON.parse((d.sqlite.prepare("SELECT resources AS r FROM instance_runtime_nodes").get() as { r: string }).r).sampledAt as number;

describe("saveResourceSample throttle (#1687)", () => {
	it("leaves the node row alone for a sample inside the window, rewrites it past the window, and after a clock step back", async () => {
		const { d, env } = open();
		d.exec(SEED);
		await saveResourceSample(env, "i1", "u1", "pink", sample(T0));
		expect(stored(d)).toBe(T0);
		await saveResourceSample(env, "i1", "u1", "pink", sample(T0 + 30_000));
		expect(stored(d)).toBe(T0);
		await saveResourceSample(env, "i1", "u1", "pink", sample(T0 + RESOURCES_WRITE_MIN_MS));
		expect(stored(d)).toBe(T0 + RESOURCES_WRITE_MIN_MS);
		const rt = (ok: boolean, at: number) => ({ ...sample(at), runtime: { ok, latencyMs: 5, checkedAt: at } });
		await saveResourceSample(env, "i1", "u1", "pink", rt(true, T0 + 70_000));
		await saveResourceSample(env, "i1", "u1", "pink", rt(true, T0 + 80_000));
		expect(stored(d)).toBe(T0 + 70_000);
		await saveResourceSample(env, "i1", "u1", "pink", rt(false, T0 + 90_000)); // the verdict flipped: stored at once
		expect(stored(d)).toBe(T0 + 90_000);
		await saveResourceSample(env, "i1", "u1", "pink", sample(T0 - 5 * 60_000)); // the runner's clock went back
		expect(stored(d)).toBe(T0 - 5 * 60_000);
	});

	it("writes 0 rows on the node table for a skipped beat, 1 for a stored one", async () => {
		const { d, env } = open();
		d.exec(SEED);
		await saveResourceSample(env, "i1", "u1", "pink", sample(T0));
		// A trigger-free count of the node table's own changes: swap the history writes out of the measurement.
		d.exec("CREATE TEMP TABLE hits (n INTEGER); CREATE TEMP TRIGGER t_hit AFTER UPDATE ON instance_runtime_nodes BEGIN INSERT INTO hits VALUES (1); END;");
		const hits = () => Number((d.sqlite.prepare("SELECT COUNT(*) AS n FROM hits").get() as { n: number }).n);
		await saveResourceSample(env, "i1", "u1", "pink", sample(T0 + 30_000));
		expect(hits()).toBe(0);
		await saveResourceSample(env, "i1", "u1", "pink", sample(T0 + 60_000));
		expect(hits()).toBe(1);
	});
});

describe("updateGateState judges the beat's own sample (#1687)", () => {
	it("an overloaded sample the row did not store still opens the gate (a runner without a machine id judges the row itself)", async () => {
		const { d, env } = open();
		d.exec(SEED);
		d.exec("UPDATE instance_runtime_nodes SET machine_id = NULL");
		await saveResourceSample(env, "i1", "u1", "pink", sample(T0)); // calm sample stored
		const hot = { ...sample(T0 + 30_000), loadAvg: [40, 40, 40] }; // skipped by the throttle
		await saveResourceSample(env, "i1", "u1", "pink", hot);
		expect(stored(d)).toBe(T0);
		const withoutFresh = await updateGateState(env, "i1", "u1", "pink", T0 + 30_000);
		const withFresh = await updateGateState(env, "i1", "u1", "pink", T0 + 30_000, hot as never);
		expect(withoutFresh.state.state).toBe("accepting");
		expect(withFresh.state.state).not.toBe("accepting");
	});
});

describe("upsertIssueTicket no-op (#1687)", () => {
	const cache = (title: string): IssueCache => ({ number: 7, repo: "o/r", title, state: "open", stateReason: null, labels: [], assignees: [], url: "https://github.com/o/r/issues/7", updatedAt: "2026-11-21T00:00:00Z", closedAt: null, summary: "s" });
	const seed = (d: RealSchemaD1) => d.exec(`${SEED} INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1','i1','u1','o/r','/w','ready');`);

	it("writes 0 rows for an identical call, rewrites on a changed title and once the row is older than the refresh window", async () => {
		const { d, env } = open();
		seed(d);
		const call = (title: string) => upsertIssueTicket(env, "i1", "u1", { repoId: "r1", issueNumber: 7, cache: cache(title), linkedBy: "sync" });
		await call("A");
		let before = changes(d);
		await call("A");
		expect(changes(d) - before).toBe(0);
		before = changes(d);
		await call("B");
		expect(changes(d) - before).toBeGreaterThan(0);
		d.exec(`UPDATE tickets SET updated_at = datetime('now', '-${ISSUE_CACHE_REFRESH_HOURS + 1} hours')`);
		before = changes(d);
		await call("B");
		expect(changes(d) - before).toBeGreaterThan(0);
	});

	it("a stronger link still upgrades a sync link, a weaker one writes nothing", async () => {
		const { d, env } = open();
		seed(d);
		const link = (linkedBy: "sync" | "manual") => upsertIssueTicket(env, "i1", "u1", { repoId: "r1", issueNumber: 7, cache: cache("A"), linkedBy });
		await link("sync");
		await link("manual");
		expect((d.sqlite.prepare("SELECT linked_by AS l FROM tickets").get() as { l: string }).l).toBe("manual");
		const before = changes(d);
		await link("sync");
		expect(changes(d) - before).toBe(0);
	});
});
