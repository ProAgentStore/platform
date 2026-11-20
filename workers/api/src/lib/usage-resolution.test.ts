import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { aggregateUsage, type UsageRow } from "./usage.js";
import { instanceLabels, usageCoverageSql, usageRowsSql, USAGE_INSTANCE_NAMES_SQL } from "./usage-ids.js";
import { engineUsageRowId } from "./engine-usage.js";
import { instanceListView } from "./instance-config.js";

// The Usage page's id resolution is EXECUTED here against real SQLite, not text-matched.
//
// It has to be. The entire correction in #526 is about which LEFT JOIN wins, and two live writers
// put an id in the wrong column in OPPOSITE directions:
//
//   - `agent-do.ts` builds the storage meter from `state.agentId`, which for an instance DO is the
//     INSTANCE id — so platform-paid embedding/summary rows carry an instance id in `agent_id`.
//     Measured on production: 26 such rows, 759 calls, each rendered as its own raw UUID.
//   - `agent-think.ts` passes `instanceId: state.agentId`, which is the AGENT id when a creator
//     chats with their own template — those rows fell into "Unassigned".
//
// Every version of this query reads as correct. The regression that matters is subtler still: a
// "looks like a UUID ⇒ treat it as an instance" shortcut would break `2dff5c62-…`, a genuine UUID
// *agent* id that labels correctly today. So the fixture below carries one row of each shape and
// the assertions are about which name comes out, not about which SQL was written.

interface JoinedRow extends UsageRow {
	agent_name: string | null;
}

const USER = "u1";
const OTHER = "u2";

function seed(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
		CREATE TABLE agent_instances (id TEXT PRIMARY KEY, agent_id TEXT, user_id TEXT, config TEXT);
		CREATE TABLE ai_usage (
			id TEXT PRIMARY KEY, user_id TEXT, agent_id TEXT, instance_id TEXT,
			provider TEXT, model TEXT, kind TEXT,
			input_tokens INT, output_tokens INT, cache_read_tokens INT, cache_write_tokens INT,
			cost_micros INT, payer TEXT, created_at TEXT
		);

		INSERT INTO agents VALUES
			('agent_coder_repo', 'Repo Coder'),
			-- A genuine agent whose id IS a UUID. It labels correctly today and must keep doing so.
			('2dff5c62-59f0-4d2d-b0a6-b1db5c879c46', 'tmux Operator');

		INSERT INTO agent_instances VALUES
			('bd43f4de-ef35-4051-bdec-43f8571414a1', 'agent_coder_repo', 'u1', '{"displayName":"Chess coder 2"}'),
			('5fab318d-2850-45a4-982c-958765c7261e', 'agent_coder_repo', 'u1', '{}'),
			('cda75e28-cace-4958-ac3e-6a7528e6b719', 'agent_coder_repo', 'u1', '{not json'),
			('99999999-0000-0000-0000-000000000000', 'agent_coder_repo', 'u2', '{"displayName":"Not yours"}');
	`);
	return db;
}

const insert = (db: DatabaseSync, over: Partial<Record<string, string | number | null>> = {}) => {
	const r = {
		id: `r${Math.random()}`, user_id: USER, agent_id: null, instance_id: null,
		provider: "anthropic", model: "claude-sonnet-4-6", kind: "chat",
		input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0,
		cost_micros: 1000, payer: "byok-api", created_at: "2026-08-12 10:00:00", ...over,
	};
	db.prepare(
		`INSERT INTO ai_usage VALUES (:id,:user_id,:agent_id,:instance_id,:provider,:model,:kind,
		 :input_tokens,:output_tokens,:cache_read_tokens,:cache_write_tokens,:cost_micros,:payer,:created_at)`,
	).run(r as never);
};

/** Exactly what the route does: scan, name, aggregate. */
function summarize(db: DatabaseSync, user = USER) {
	const rows = db.prepare(usageRowsSql(false).replace("?1", "?")).all(user) as unknown as JoinedRow[];
	const agentNames: Record<string, string> = {};
	for (const r of rows) if (r.agent_id && r.agent_name) agentNames[r.agent_id] = r.agent_name;
	const instRows = db.prepare(USAGE_INSTANCE_NAMES_SQL.replace("?1", "?")).all(user) as unknown as {
		id: string; config: string | null; agent_name: string | null;
	}[];
	const instanceNames = instanceLabels(
		instRows.map((r) => ({ id: r.id, displayName: instanceListView(r.config).displayName, agentName: r.agent_name })),
	);
	return { rows, summary: aggregateUsage(rows, { agentNames, instanceNames }) };
}

describe("Usage id resolution (#526)", () => {
	it("resolves an INSTANCE id written into agent_id — the DO storage meter's rows", () => {
		// `agent_id = <instance uuid>, instance_id = NULL`, which is what every platform-paid
		// embedding and summary row looks like. Both joins used to miss and the label was the UUID.
		const db = seed();
		insert(db, { agent_id: "bd43f4de-ef35-4051-bdec-43f8571414a1", kind: "embedding", provider: "platform", payer: "platform" });
		const { summary } = summarize(db);
		expect(summary.byAgent.map((b) => b.label)).toEqual(["Repo Coder"]);
		expect(summary.byInstance.map((b) => b.label)).toEqual(["Chess coder 2"]);
	});

	it("resolves an AGENT id written into instance_id — a creator chatting with their own template", () => {
		// The mirror bug: `agent-think.ts` records `instanceId: state.agentId`, and in a template DO
		// that is the agent id. Those rows read as "Unassigned" before.
		const db = seed();
		insert(db, { instance_id: "agent_coder_repo" });
		const { summary } = summarize(db);
		expect(summary.byAgent.map((b) => b.label)).toEqual(["Repo Coder"]);
		// It belongs to no instance, and says so rather than inventing one.
		expect(summary.byInstance.map((b) => b.label)).toEqual(["Not tied to an instance"]);
	});

	it("leaves a genuine UUID agent id alone — resolution is by lookup, never by shape", () => {
		const db = seed();
		insert(db, { agent_id: "2dff5c62-59f0-4d2d-b0a6-b1db5c879c46" });
		const { summary } = summarize(db);
		expect(summary.byAgent.map((b) => b.label)).toEqual(["tmux Operator"]);
		expect(summary.byInstance.map((b) => b.label)).toEqual(["Not tied to an instance"]);
	});

	it("attributes an ordinary instance-keyed row to both its instance and its template", () => {
		const db = seed();
		insert(db, { instance_id: "bd43f4de-ef35-4051-bdec-43f8571414a1", kind: "engine" });
		const { summary } = summarize(db);
		expect(summary.byAgent.map((b) => b.label)).toEqual(["Repo Coder"]);
		expect(summary.byInstance.map((b) => b.label)).toEqual(["Chess coder 2"]);
	});

	it("splits one template across its instances — the question the page could not answer", () => {
		// Three instances of one agent. `byAgent` correctly reports one row; `byInstance` is the
		// only place the owner can see which of his coders spent the money.
		const db = seed();
		insert(db, { instance_id: "bd43f4de-ef35-4051-bdec-43f8571414a1", kind: "engine", cost_micros: 3_000_000, payer: "subscription" });
		insert(db, { instance_id: "5fab318d-2850-45a4-982c-958765c7261e", kind: "engine", cost_micros: 900_000 });
		insert(db, { instance_id: "cda75e28-cace-4958-ac3e-6a7528e6b719", cost_micros: 4000 });
		const { summary } = summarize(db);
		expect(summary.byAgent).toHaveLength(1);
		expect(summary.byAgent[0]).toMatchObject({ label: "Repo Coder", costMicros: 3_904_000 });
		expect(summary.byInstance.map((b) => [b.label, b.costMicros])).toEqual([
			["Chess coder 2", 3_000_000],
			// Un-renamed, so they take the template's name and a short id keeps them apart. A
			// malformed config reads as "no display name" rather than failing the page.
			["Repo Coder · 5fab318d", 900_000],
			["Repo Coder · cda75e28", 4000],
		]);
		// And the charged figure survives the split: the biggest consumer owes nothing (#543).
		expect(summary.byInstance[0].chargedCostMicros).toBe(0);
		expect(summary.byInstance[1].chargedCostMicros).toBe(900_000);
	});

	it("names a deleted instance as deleted, not as a UUID and not as unassigned", () => {
		// Production carries exactly one of these: `26f71cd8-…`, 18 calls, matching no live
		// instance. `ai_usage` rows outlive what they name on purpose — they are the spend record.
		const db = seed();
		insert(db, { agent_id: "26f71cd8-a376-4600-8522-ababd77d2b1f", kind: "embedding" });
		const { summary } = summarize(db);
		expect(summary.byAgent.map((b) => b.label)).toEqual(["Deleted · 26f71cd8"]);
	});

	it("never surfaces another tenant's instance through a misattributed id", () => {
		// The instance joins are scoped to the row's own user. A writer bug that stamped someone
		// else's instance id onto this user's row must not turn into a cross-tenant name leak.
		const db = seed();
		insert(db, { agent_id: "99999999-0000-0000-0000-000000000000", kind: "embedding" });
		const { summary } = summarize(db);
		expect(summary.byAgent.map((b) => b.label)).toEqual(["Deleted · 99999999"]);
		expect(JSON.stringify(summary)).not.toContain("Not yours");
	});

	it("keeps a row with no id at all in its own bucket on both axes", () => {
		const db = seed();
		insert(db, { kind: "voice", provider: "openai" });
		const { summary } = summarize(db);
		expect(summary.byAgent.map((b) => b.label)).toEqual(["Unassigned"]);
		expect(summary.byInstance.map((b) => b.label)).toEqual(["Not tied to an instance"]);
	});

	it("scans only the caller's own rows", () => {
		const db = seed();
		insert(db, { user_id: OTHER, instance_id: "99999999-0000-0000-0000-000000000000" });
		expect(summarize(db).rows).toHaveLength(0);
	});
});

/**
 * #551 item 3, against REAL SQL: the session behind a coding-engine row is already in the ledger.
 *
 * Executed rather than reasoned about, for the reason this file exists — a claim about what a
 * query returns is only worth what running it says. The column added here (`u.id AS row_id`) is
 * what turns "sessions per resolved credential" from a schema change into a query.
 */
describe("engine rows carry their coding session through the scan (#551)", () => {
	it("returns row_id, and the aggregate counts distinct sessions from it", () => {
		const db = seed();
		insert(db, { id: engineUsageRowId("sess-a", "turn-1"), kind: "engine", payer: null });
		insert(db, { id: engineUsageRowId("sess-a", "turn-2"), kind: "engine", payer: null });
		insert(db, { id: engineUsageRowId("sess-b", "turn-1"), kind: "engine", payer: null });
		const { rows, summary } = summarize(db);
		// The column really is selected — not merely declared on the TypeScript row type.
		expect(rows.every((r) => typeof r.row_id === "string")).toBe(true);
		const unknown = summary.byPayer.find((b) => b.key === "unknown");
		expect(unknown?.calls).toBe(3);
		expect(unknown?.sessions).toBe(2);
	});
});

describe("Usage SQL pre-grouping gives identical totals (#1662)", () => {
	it("grouped rows aggregate to exactly what the raw ledger rows do", () => {
		const db = seed();
		const A = "bd43f4de-ef35-4051-bdec-43f8571414a1";
		const mk: Record<string, string | number | null>[] = [
			{ agent_id: "agent_coder_repo", instance_id: A, payer: "byok-api", cost_micros: 700, created_at: "2026-08-12 10:00:00" },
			{ agent_id: "agent_coder_repo", instance_id: A, payer: "byok-api", cost_micros: 300, created_at: "2026-08-12 23:00:00", cache_read_tokens: null },
			{ agent_id: A, instance_id: null, payer: "platform", kind: "embedding", cost_micros: 50, created_at: "2026-08-13 01:00:00" },
			{ instance_id: "agent_coder_repo", payer: null, cost_micros: 90, created_at: "2026-08-11 09:00:00" },
			{ agent_id: "gone-uuid", payer: null, cost_micros: 40, created_at: "2026-08-12 09:00:00" },
			{ agent_id: "agent_coder_repo", instance_id: A, kind: "engine", payer: "subscription", id: engineUsageRowId("sess-1", "a"), model: "m2", cost_micros: 10 },
			{ agent_id: "agent_coder_repo", instance_id: A, kind: "engine", payer: "subscription", id: engineUsageRowId("sess-1", "b"), model: "m2", cost_micros: 10 },
			{ agent_id: "agent_coder_repo", instance_id: A, kind: "engine", payer: "machine-login", id: engineUsageRowId("sess-2", "c"), model: "m2", cost_micros: 5 },
			{ user_id: OTHER, agent_id: "agent_coder_repo", cost_micros: 99999 },
		];
		for (const m of mk) insert(db, m);

		const { summary: grouped } = summarize(db);
		const raw = db.prepare("SELECT * FROM ai_usage WHERE user_id = ? ORDER BY created_at").all(USER) as unknown as UsageRow[];
		// Reference: the pre-#1662 per-row resolution, via the same joins on ungrouped rows.
		const ref = db.prepare(`SELECT COALESCE(ua.id, ia.agent_id, ub.agent_id, uc.id, u.agent_id) AS agent_id,
			COALESCE(ia.id, ub.id) AS instance_id, u.id AS row_id, u.provider, u.model, u.kind, u.input_tokens, u.output_tokens,
			u.cache_read_tokens, u.cache_write_tokens, u.cost_micros, u.payer, u.created_at
			FROM ai_usage u LEFT JOIN agents ua ON ua.id = u.agent_id
			LEFT JOIN agent_instances ia ON ia.id = u.instance_id AND ia.user_id = u.user_id
			LEFT JOIN agent_instances ub ON ub.id = u.agent_id AND ub.user_id = u.user_id
			LEFT JOIN agents uc ON uc.id = u.instance_id WHERE u.user_id = ?`).all(USER) as unknown as UsageRow[];
		expect(raw.length).toBe(8);
		const expected = aggregateUsage(ref, { agentNames: { agent_coder_repo: "Repo Coder" }, instanceNames: { [A]: "Chess coder 2" } });

		const strip = (s: ReturnType<typeof aggregateUsage>) => {
			const { payerCoverage: _c, ...rest } = s;
			const norm = <T extends { key: string }>(bs: T[]) => [...bs].sort((a, b) => a.key.localeCompare(b.key));
			return { ...rest, byModel: norm(rest.byModel), byKind: norm(rest.byKind), byAgent: norm(rest.byAgent).map(({ label: _l, ...b }) => b), byInstance: norm(rest.byInstance).map(({ label: _l, ...b }) => b), byPayer: norm(rest.byPayer) };
		};
		expect(strip(grouped)).toEqual(strip(expected));
		expect(grouped.byKind.find((b) => b.key === "engine")?.sessions).toBe(2);

		// Coverage computed in SQL equals the JS split over the raw rows.
		const c = db.prepare(usageCoverageSql(false).replaceAll("?1", "?")).get(USER, USER) as Record<string, number | string | null>;
		const want = aggregateUsage(ref).payerCoverage;
		expect(c.first_at).toBe(want.firstAttributedAt);
		expect([c.a_calls, c.value_a, c.b_calls, c.value_b, c.s_calls, c.value_s]).toEqual([
			want.attributed.calls, want.attributed.costMicros, want.unattributedBefore.calls, want.unattributedBefore.costMicros,
			want.unattributedSince.calls, want.unattributedSince.costMicros,
		]);
	});
});
