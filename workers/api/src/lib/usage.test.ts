import { describe, expect, it } from "vitest";
import { aggregateUsage, denseDays, instanceSpendMicros, usageDay, type UsageRow, type UsageSummary } from "./usage.js";
import { bucketLabel, instanceLabels } from "./usage-ids.js";
import type { Env } from "../types.js";

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
	agent_id: "a1", instance_id: "i1", provider: "anthropic", model: "claude-sonnet-4-6",
	kind: "chat", input_tokens: 1000, output_tokens: 200, cost_micros: 6000,
	created_at: "2026-07-14 10:00:00", ...over,
});

describe("usageDay", () => {
	it("takes the UTC date portion of a D1 timestamp", () => {
		expect(usageDay("2026-07-14 23:59:59")).toBe("2026-07-14");
	});
});

describe("denseDays", () => {
	it("returns an inclusive list", () => {
		expect(denseDays("2026-07-12", "2026-07-14")).toEqual(["2026-07-12", "2026-07-13", "2026-07-14"]);
	});
	it("is empty when to < from", () => {
		expect(denseDays("2026-07-14", "2026-07-12")).toEqual([]);
	});
});

describe("aggregateUsage", () => {
	it("sums totals across rows", () => {
		const s = aggregateUsage([row(), row({ input_tokens: 500, output_tokens: 100, cost_micros: 3000 })]);
		expect(s.totals).toEqual({ inputTokens: 1500, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 9000, chargedCostMicros: 0, calls: 2 });
	});

	it("reports charged value separately from total list value — never added together", () => {
		// The page's whole correction (#346/#347). `cost_micros` is notional value on EVERY row:
		// tokens × list price, ours or Claude Code's. Only some of it is money anyone owes, and
		// a single "Est. cost" over the sum is what taught the product to read this as a bill.
		const s = aggregateUsage([
			row({ payer: "byok-api", cost_micros: 4000 }),
			row({ payer: "platform", cost_micros: 1000 }),
			row({ payer: "subscription", kind: "engine", cost_micros: 2_870_000 }),
			row({ payer: null, kind: "engine", cost_micros: 900_000 }),
		]);
		expect(s.totals.chargedCostMicros).toBe(5000);
		expect(s.totals.costMicros).toBe(3_775_000); // the value is real; the charge is $0.005
	});

	it("buckets by payer, with an unattributed row shown rather than dropped", () => {
		// A row we cannot attribute is still consumption the owner should see. Hiding it would
		// make the page's own attribution look more complete than it is.
		const s = aggregateUsage([
			row({ payer: "byok-api", cost_micros: 100 }),
			row({ payer: null, cost_micros: 900 }),
		]);
		expect(s.byPayer.map((b) => b.key).sort()).toEqual(["byok-api", "unknown"]);
		expect(s.byPayer.find((b) => b.key === "unknown")?.label).toBe("Payer not established");
	});

	it("treats a pre-payer row as unknown, not as charged", () => {
		// No backfill on migration 0092: rows written before it genuinely do not record who paid,
		// and stamping one on retrospectively is the inference the column exists to remove.
		const s = aggregateUsage([row({ cost_micros: 6000 })]);
		expect(s.totals.chargedCostMicros).toBe(0);
		expect(s.byPayer[0].key).toBe("unknown");
	});

	it("breaks down by model, kind and agent sorted by cost", () => {
		const s = aggregateUsage([
			row({ model: "claude-sonnet-4-6", kind: "chat", agent_id: "a1", cost_micros: 6000 }),
			row({ model: "claude-opus-4", kind: "coding", agent_id: "a2", cost_micros: 90000 }),
		]);
		expect(s.byModel[0].key).toBe("claude-opus-4"); // higher cost first
		expect(s.byKind.map((b) => b.key)).toContain("coding");
		expect(s.byAgent[0].key).toBe("a2");
		expect(s.byAgent[0].calls).toBe(1);
	});

	it("labels agents from the name map and marks null agent as Unassigned", () => {
		const s = aggregateUsage([row({ agent_id: "a1" }), row({ agent_id: null })], { agentNames: { a1: "Coder" } });
		const a1 = s.byAgent.find((b) => b.key === "a1");
		const un = s.byAgent.find((b) => b.key === "unassigned");
		expect(a1?.label).toBe("Coder");
		expect(un?.label).toBe("Unassigned");
	});

	it("produces a dense daily series with zero-filled gaps when a range is given", () => {
		const s = aggregateUsage(
			[row({ created_at: "2026-07-12 08:00:00" }), row({ created_at: "2026-07-14 08:00:00" })],
			{ fromDay: "2026-07-12", toDay: "2026-07-14" },
		);
		expect(s.daily.map((d) => d.date)).toEqual(["2026-07-12", "2026-07-13", "2026-07-14"]);
		expect(s.daily[1]).toMatchObject({ date: "2026-07-13", inputTokens: 0, calls: 0 }); // the gap day
		expect(s.daily[0].inputTokens).toBe(1000);
	});

	it("without a range, daily covers only days that have data (sorted)", () => {
		const s = aggregateUsage([row({ created_at: "2026-07-14 08:00:00" }), row({ created_at: "2026-07-10 08:00:00" })]);
		expect(s.daily.map((d) => d.date)).toEqual(["2026-07-10", "2026-07-14"]);
	});
});

/**
 * Read the two cache columns off `totals`.
 *
 * `aggregateUsage` computes and returns `totals.cacheReadTokens` / `totals.cacheWriteTokens`
 * (usage.ts:417 and 434-435) and the console reads them (store/console/src/pages/Usage.tsx:281,
 * where they are declared optional), but `UsageSummary["totals"]` (usage.ts:319) never declared
 * them — the same drop-on-the-way-out shape #547 fixed for `daily`, one level up. Until that
 * declaration is widened, the assertions below cannot name the fields directly.
 *
 * This narrows instead of casting: if the totals loop ever stops emitting either column, the
 * throw fires and the test fails, which is exactly what naming the field would have done. Once
 * the production type carries them this helper can be deleted and the reads inlined.
 */
function cacheTotals(totals: UsageSummary["totals"]): { cacheReadTokens: number; cacheWriteTokens: number } {
	const t = totals as Record<string, unknown>;
	const cacheReadTokens = t.cacheReadTokens;
	const cacheWriteTokens = t.cacheWriteTokens;
	if (typeof cacheReadTokens !== "number" || typeof cacheWriteTokens !== "number")
		throw new Error("aggregateUsage stopped reporting cache tokens in totals");
	return { cacheReadTokens, cacheWriteTokens };
}

describe("prompt-cache tokens are reported separately (#212)", () => {
	it("keeps cache reads OUT of inputTokens, so the hit rate is computable", () => {
		// They used to be summed into input. That made the hit rate — cacheRead ÷ (input +
		// cacheRead) — impossible to compute, so nobody could tell whether prompt caching was
		// working, while the cost line silently priced every read at the full input rate.
		const s = aggregateUsage([row({ input_tokens: 200, cache_read_tokens: 1800, cache_write_tokens: 0 })]);
		expect(s.totals.inputTokens).toBe(200);
		const { cacheReadTokens } = cacheTotals(s.totals);
		expect(cacheReadTokens).toBe(1800);
		const hitRate = cacheReadTokens / (s.totals.inputTokens + cacheReadTokens);
		expect(hitRate).toBeCloseTo(0.9);
	});

	it("carries the split into every breakdown, not just totals", () => {
		// The per-kind view is where you would actually look: "is the Coder's chat cache-hitting?"
		const s = aggregateUsage([
			row({ kind: "chat", input_tokens: 100, cache_read_tokens: 900 }),
			row({ kind: "coding", input_tokens: 1000, cache_read_tokens: 0 }),
		]);
		const chat = s.byKind.find((b) => b.key === "chat");
		const coding = s.byKind.find((b) => b.key === "coding");
		expect(chat?.cacheReadTokens).toBe(900);
		expect(coding?.cacheReadTokens).toBe(0);
	});

	it("carries the split into the DAILY series too, which is what the ceiling is denominated in (#547)", () => {
		// The series dropped the two cache columns on the way out, although `bump()` had already
		// accumulated them into the day bucket. So the chart plotted `input + output` while the
		// circuit breaker counted all four — and cache was 98.2% of what it counted. The day the
		// 250M ceiling tripped at 268M rendered as 4.2M tokens.
		const rows = [
			row({ created_at: "2026-08-11 03:00:00", input_tokens: 1_100_000, output_tokens: 1_000_000, cache_read_tokens: 400_000_000, cache_write_tokens: 4_000_000 }),
			row({ created_at: "2026-08-11 19:00:00", input_tokens: 1_092_612, output_tokens: 1_032_986, cache_read_tokens: 446_000_000, cache_write_tokens: 5_400_000 }),
		];
		const s = aggregateUsage(rows, { fromDay: "2026-08-10", toDay: "2026-08-11" });
		const aug11 = s.daily.find((d) => d.date === "2026-08-11");
		expect(aug11).toMatchObject({ inputTokens: 2_192_612, outputTokens: 2_032_986, cacheReadTokens: 846_000_000, cacheWriteTokens: 9_400_000 });

		// The identity that silently failed for two of the four columns: the series must sum to the
		// totals over the same range. A zero-filled gap day contributes nothing to either side.
		const sum = (k: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens") =>
			s.daily.reduce((n, d) => n + d[k], 0);
		const totalCache = cacheTotals(s.totals);
		expect(sum("inputTokens")).toBe(s.totals.inputTokens);
		expect(sum("outputTokens")).toBe(s.totals.outputTokens);
		expect(sum("cacheReadTokens")).toBe(totalCache.cacheReadTokens);
		expect(sum("cacheWriteTokens")).toBe(totalCache.cacheWriteTokens);
	});

	it("treats a pre-migration NULL as zero for the sum without crashing", () => {
		// Rows written before 0074 have NULL — genuinely unknown. Aggregation has to add them up
		// somehow, and zero is the only sane arithmetic; the unknown-vs-zero distinction lives in
		// D1, not in a total.
		const s = aggregateUsage([row({ cache_read_tokens: null, cache_write_tokens: null })]);
		expect(cacheTotals(s.totals)).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 0 });
	});
});

// ── #543: every breakdown carries the charged figure, not just the totals ────
//
// The measured symptom: the console printed $9,566.69 beside "Repo Coder" and $36.35 as the
// charged headline, 263x apart, with nothing on the page connecting them — because `bump()`
// accumulated five columns of the row it was handed and not the sixth.
describe("charged value decomposes per bucket (#543)", () => {
	// One fixture spanning all four payer states, so the identity below is asserted over a row set
	// that contains each of them — charged, platform-charged, subscription (real tokens, no
	// charge) and NULL (pre-0092 / machine-login, payer never established).
	const fourPayers = () => [
		row({ agent_id: "a-chat", kind: "chat", payer: "byok-api", cost_micros: 4000 }),
		row({ agent_id: "a-chat", kind: "embedding", payer: "platform", cost_micros: 1000 }),
		row({ agent_id: "a-coder", kind: "engine", payer: "subscription", cost_micros: 2_870_000 }),
		row({ agent_id: "a-coder", kind: "engine", payer: null, cost_micros: 900_000 }),
	];

	it("sums to the same charged figure the totals report, on every axis", () => {
		const s = aggregateUsage(fourPayers());
		const sum = (bs: { chargedCostMicros: number }[]) => bs.reduce((n, b) => n + b.chargedCostMicros, 0);
		expect(s.totals.chargedCostMicros).toBe(5000);
		expect(sum(s.byAgent)).toBe(s.totals.chargedCostMicros);
		expect(sum(s.byKind)).toBe(s.totals.chargedCostMicros);
		expect(sum(s.byModel)).toBe(s.totals.chargedCostMicros);
		expect(sum(s.byPayer)).toBe(s.totals.chargedCostMicros);
	});

	it("shows an agent whose whole value is unattributed as $0 charged, not as idle", () => {
		// The Repo Coder case exactly: 99.4% of the account's notional value, none of it money we
		// can name. Both numbers have to survive — filtering the breakdown to charged rows would
		// render the busiest agent as absent, which is a worse answer than the one being fixed.
		const s = aggregateUsage(fourPayers());
		const coder = s.byAgent.find((b) => b.key === "a-coder");
		expect(coder?.costMicros).toBe(3_770_000);
		expect(coder?.chargedCostMicros).toBe(0);
		const chat = s.byAgent.find((b) => b.key === "a-chat");
		expect(chat?.costMicros).toBe(5000);
		expect(chat?.chargedCostMicros).toBe(5000);
	});

	it("keeps the two payer buckets that are money apart from the two that are not", () => {
		const s = aggregateUsage(fourPayers());
		const by = (k: string) => s.byPayer.find((b) => b.key === k);
		expect(by("byok-api")).toMatchObject({ costMicros: 4000, chargedCostMicros: 4000 });
		expect(by("platform")).toMatchObject({ costMicros: 1000, chargedCostMicros: 1000 });
		// Real tokens, real value, no marginal charge — and a payer we could not establish. Both
		// report zero charged, and neither is a claim that the work was free.
		expect(by("subscription")).toMatchObject({ costMicros: 2_870_000, chargedCostMicros: 0 });
		expect(by("unknown")).toMatchObject({ costMicros: 900_000, chargedCostMicros: 0 });
	});
});


// ── #526: what did THIS instance cost? ───────────────────────────────────────
//
// `byAgent` groups by template, which is the creator's unit. An owner running seven Repo Coders
// against seven repositories saw one row called "Repo Coder" carrying all seven, so the page could
// show a five-figure total and not answer the only question anybody asks it.
describe("byInstance — the subscriber's unit, not the creator's (#526)", () => {
	const sevenCoders = () => [
		// One template, three instances. The expensive rows are engine rows, which have always
		// carried instance_id and never agent_id — so this axis is populated on day one.
		row({ agent_id: null, instance_id: "chess", kind: "engine", payer: "subscription", cost_micros: 3_000_000 }),
		row({ agent_id: null, instance_id: "chess", kind: "chat", payer: "byok-api", cost_micros: 4000 }),
		row({ agent_id: null, instance_id: "heartfull", kind: "engine", payer: "byok-api", cost_micros: 900_000 }),
		row({ agent_id: null, instance_id: "lead", kind: "chat", payer: "byok-api", cost_micros: 1000 }),
	];

	it("splits one template's spend across the instances that actually did the work", () => {
		const s = aggregateUsage(sevenCoders());
		expect(s.byInstance.map((b) => b.key)).toEqual(["chess", "heartfull", "lead"]);
		expect(s.byInstance.find((b) => b.key === "chess")).toMatchObject({ costMicros: 3_004_000, calls: 2 });
		expect(s.byInstance.find((b) => b.key === "heartfull")).toMatchObject({ costMicros: 900_000, calls: 1 });
	});

	it("carries the charged figure per instance, so a row can never be read as a bill", () => {
		// The #543 rule at finer granularity. "Chess coder 2" is the account's biggest consumer and
		// owes nothing — its engine ran on a subscription. A per-instance card printing only the
		// notional figure would reproduce the exact misreading #543 fixed, one level down.
		const s = aggregateUsage(sevenCoders());
		const chess = s.byInstance.find((b) => b.key === "chess");
		expect(chess?.costMicros).toBe(3_004_000);
		expect(chess?.chargedCostMicros).toBe(4000);
	});

	it("sums to the same totals as every other axis, including rows with no instance", () => {
		// A creator's direct run against a template, and account-scoped voice, have no instance.
		// Dropping them would make this axis quietly disagree with the headline.
		const s = aggregateUsage([...sevenCoders(), row({ agent_id: "a1", instance_id: null, kind: "run", payer: "byok-api", cost_micros: 500 })]);
		const sum = (bs: { costMicros: number; chargedCostMicros: number }[]) => bs.reduce((n, b) => n + b.costMicros, 0);
		expect(sum(s.byInstance)).toBe(s.totals.costMicros);
		expect(sum(s.byInstance)).toBe(sum(s.byAgent));
		expect(s.byInstance.reduce((n, b) => n + b.chargedCostMicros, 0)).toBe(s.totals.chargedCostMicros);
		expect(s.byInstance.find((b) => b.key === "unassigned")?.label).toBe("Not tied to an instance");
	});

	it("labels an instance from the subscriber's own name for it", () => {
		const s = aggregateUsage(sevenCoders(), { instanceNames: { chess: "Chess coder 2" } });
		expect(s.byInstance.find((b) => b.key === "chess")?.label).toBe("Chess coder 2");
	});
});

describe("bucketLabel — an id that names nothing is a fact, not a missing lookup (#526)", () => {
	it("uses the name when there is one", () => {
		expect(bucketLabel("a1", { a1: "Repo Coder" }, "Unassigned")).toBe("Repo Coder");
	});

	it("says the thing was deleted instead of printing a raw UUID", () => {
		// Measured on production: `26f71cd8-a376-4600-8522-ababd77d2b1f` carried 18 calls and matched
		// no live instance — the instance was removed and its spend record deliberately survived it
		// (`routes/analytics.ts`: "ai_usage rows survive, because they are the spend record").
		expect(bucketLabel("26f71cd8-a376-4600-8522-ababd77d2b1f", {}, "Unassigned")).toBe("Deleted · 26f71cd8");
	});

	it("keeps two deleted things apart", () => {
		// Collapsing them into one "Deleted" row would merge two accounts' worth of spend on screen.
		expect(bucketLabel("aaaaaaaa-1", {}, "Unassigned")).not.toBe(bucketLabel("bbbbbbbb-1", {}, "Unassigned"));
	});

	it("keeps 'unassigned' meaning the row carried no id at all", () => {
		expect(bucketLabel("unassigned", { unassigned: "wrong" }, "Unassigned")).toBe("Unassigned");
	});
});

describe("instanceLabels — seven un-renamed coders must not become seven identical rows (#526)", () => {
	it("prefers the subscriber's own name", () => {
		expect(instanceLabels([{ id: "i1", displayName: "Chess coder 2", agentName: "Repo Coder" }]).i1).toBe("Chess coder 2");
	});

	it("falls back to the agent name, and disambiguates when that collides", () => {
		// The failure this exists to prevent: splitting by instance and then labelling every split
		// "Repo Coder" reproduces the collapse, with the rows now separated but unreadable.
		const out = instanceLabels([
			{ id: "aaaaaaaa-1", agentName: "Repo Coder" },
			{ id: "bbbbbbbb-2", agentName: "Repo Coder" },
			{ id: "cccccccc-3", agentName: "Language Buddy" },
		]);
		expect(out["aaaaaaaa-1"]).toBe("Repo Coder · aaaaaaaa");
		expect(out["bbbbbbbb-2"]).toBe("Repo Coder · bbbbbbbb");
		// A name that is already unique is left alone — renaming is the fix, and someone who has
		// already renamed should not be punished with an id.
		expect(out["cccccccc-3"]).toBe("Language Buddy");
	});

	it("still returns something for an instance with no name anywhere", () => {
		expect(instanceLabels([{ id: "deadbeef-9", displayName: null, agentName: null }])["deadbeef-9"]).toBe("Instance deadbeef");
	});
});

// ── #325: the one read in this module that is NOT observability ──────────────
//
// Every other swallow in usage.ts is marked "observability, never load-bearing". This one is read
// twice per iteration to compute `after - before`, so a swallowed failure returned 0 and booked the
// iteration as free: the reservation is released, the tree pool never depletes, the cap that exists
// to stop a runaway becomes inert, and `list_delegation_budgets` reports a `spent` that is untrue.
// The module's own docstring says under-charging is the unsafe direction — and 0 is the maximum of it.
describe("instanceSpendMicros — a ledger read failure is not a spend of zero (#325)", () => {
	const envWith = (first: () => Promise<{ total: number } | null>) =>
		({ DB: { prepare: () => ({ bind: () => ({ first }) }) } }) as unknown as Env;

	it("propagates the failure instead of reporting nothing was spent", async () => {
		await expect(
			instanceSpendMicros(envWith(async () => { throw new Error("D1_ERROR: network"); }), "u1", "i1"),
		).rejects.toThrow(/D1_ERROR/);
	});

	it("still reads a real total, and floors a nonsense one at zero", async () => {
		expect(await instanceSpendMicros(envWith(async () => ({ total: 4200 })), "u1", "i1")).toBe(4200);
		expect(await instanceSpendMicros(envWith(async () => null), "u1", "i1")).toBe(0);
	});
});
