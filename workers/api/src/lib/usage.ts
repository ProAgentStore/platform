// The usage ledger: record one row per AI call at the choke point, and aggregate
// it for the Usage page. Recording is best-effort — a ledger write must never
// break or slow an actual chat/apply/coding call.
//
// What `cost_micros` IS, on every row without exception (#346/#347): notional value — tokens ×
// published list price. It is not a bill and never was. What it does NOT say is who pays, which
// is `payer` (migration 0092) and the only thing a money ceiling may be denominated in.

import { estimateCostMicros, estimatePlatformCostMicros } from "./ai-pricing.js";
import { engineUsageRowId, type EngineUsageReport } from "./engine-usage.js";
import { asPayer, CHARGED_SQL, isCharged, payerForEngineAuth, PAYER_LABEL, UNKNOWN_PAYER_KEY } from "./usage-payer.js";
import type { EngineAuthResolved } from "./usage-payer.js";
import type { Env } from "../types.js";

export type UsageKind =
	| "chat"
	| "apply"
	| "coding"
	/**
	 * The coding Engine itself (#267) — the CLI child process on the user's machine.
	 *
	 * Distinct from "coding", which is the cloud-side Pilot deciding what to instruct it to do.
	 * Conflating them would hide the split that matters: the Pilot's decisions are cents, the
	 * Engine's turns are the actual bill.
	 */
	| "engine"
	| "copilot"
	| "overseer"
	| "run"
	| "resume"
	| "translate"
	| "voice"
	// Declarative pipeline LLM step (ai_generate) — e.g. the Outreach agent drafting per lead.
	| "pipeline"
	// Platform-paid internal AI (issue #44), billed to the platform, not BYOK.
	| "embedding"
	| "summary";

/** What a call site knows about the call. provider+model+userId are filled in by
 *  the AI layer (it knows the real model actually used), so callers pass only the
 *  cheap context they have. */
export interface UsageContext {
	kind: UsageKind;
	instanceId?: string | null;
	agentId?: string | null;
}

export interface UsageTokens {
	input: number;
	output: number;
	/**
	 * Prompt-cache tokens, kept SEPARATE from `input` (#212).
	 *
	 * They used to be summed into it, so a cache read — billed at 0.1x — was recorded and priced
	 * exactly like a fresh input token. That both overstated cost and made the cache invisible:
	 * there was no way to tell whether prompt caching was working at all, which is the number you
	 * need before touching a prompt to make it cache better.
	 */
	cacheRead?: number;
	cacheWrite?: number;
}

interface RecordArgs extends UsageContext {
	userId: string | undefined;
	provider: string;
	model: string;
}

/**
 * Insert one usage row. Best-effort: swallows every error (a failed ledger write
 * is never worth failing the user's request over) and no-ops when there's no user
 * or no tokens to record.
 *
 * `payer` is hardcoded `'byok-api'` rather than passed in, and that is a structural fact rather
 * than a guess: this recorder is reachable only from `user-ai.ts`, which has just made the call
 * ON THE USER'S OWN KEY (their Anthropic key, or their Cloudflare account creds). Platform-paid
 * calls have their own recorder. A payer we injected the credential for is one we know.
 */
export async function recordUsage(
	env: { DB: D1Database },
	args: RecordArgs,
	usage: UsageTokens | null | undefined,
): Promise<void> {
	try {
		if (!args.userId || !usage) return;
		const n = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
		const input = n(usage.input);
		const output = n(usage.output);
		const cacheRead = n(usage.cacheRead);
		const cacheWrite = n(usage.cacheWrite);
		// A fully-cached call can legitimately have input 0 — dropping it would hide exactly the
		// calls we most want to see, and undercount spend (a cache read is not free).
		if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return;
		const cost = estimateCostMicros(args.model, input, output, { read: cacheRead, write: cacheWrite });
		await env.DB.prepare(
			`INSERT INTO ai_usage (id, user_id, agent_id, instance_id, provider, model, kind, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros, payer, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'byok-api', datetime('now'))`,
		)
			.bind(
				crypto.randomUUID(),
				args.userId,
				args.agentId ?? null,
				args.instanceId ?? null,
				args.provider,
				args.model,
				args.kind,
				input,
				output,
				cacheRead,
				cacheWrite,
				cost,
			)
			.run();
	} catch {
		/* ledger is observability, never load-bearing */
	}
}

/**
 * Record a voice (OpenAI audio) call: a cost-only row (no LLM tokens) so STT/TTS
 * show up on the Usage page alongside text. Best-effort, like recordUsage. The proxy
 * is account-scoped, so instanceId is usually absent (voice attributes to totals /
 * by-model / by-activity, not by-agent). cost is already estimated by the caller.
 */
export async function recordVoiceUsage(
	env: { DB: D1Database },
	args: { userId: string | undefined; instanceId?: string | null; model: string; costMicros: number },
): Promise<void> {
	try {
		if (!args.userId) return;
		const cost = Math.max(0, Math.floor(Number(args.costMicros) || 0));
		await env.DB.prepare(
			`INSERT INTO ai_usage (id, user_id, agent_id, instance_id, provider, model, kind, input_tokens, output_tokens, cost_micros, payer, created_at)
			 VALUES (?1, ?2, NULL, ?3, 'openai', ?4, 'voice', 0, 0, ?5, 'byok-api', datetime('now'))`,
		)
			.bind(crypto.randomUUID(), args.userId, args.instanceId ?? null, args.model, cost)
			.run();
	} catch {
		/* observability, never load-bearing */
	}
}

/**
 * Ledger a coding Engine's own reported spend (#267), corrected at #347.
 *
 * This used to be documented as "the one figure in the ledger that is a measurement", on the
 * reasoning that the CLI "knows about subscription pricing, service tiers and 1h-cache rates that
 * the price table does not model". That was false, and it was the load-bearing false statement:
 * it is why the number was given authority, and #343 is what the authority cost.
 *
 * Anthropic's docs (https://code.claude.com/docs/en/costs) say Claude Code "computes the dollar
 * figure locally from token counts priced at standard list rates, so it doesn't reflect
 * promotional pricing or contracted discounts and may differ from your actual bill", and that
 * Max/Pro subscribers "have usage included in their subscription, so the session cost figure isn't
 * relevant for billing purposes". `total_cost_usd` is tokens × list price — the same construction
 * as `ai-pricing.ts`, computed by a different process.
 *
 * It is still the better number to store, for the ordinary reason: the CLI knows the exact per-turn
 * token split and the exact model, and we would be re-deriving both from a report. `cost_source =
 * 'reported'` (0080) records that, and NOTHING MORE — whose arithmetic ran, with no authority
 * attached. Whether the figure is money is `payer`, which is a different question with a different
 * answer.
 *
 * `authResolved` is what the runner OBSERVED about the engine's credential. It is never inferred
 * from the preset's SETTING — asking for a subscription is not the same as getting one.
 *
 * Optional, but the bar for passing `null` is that no observation EXISTS — not that the call site
 * did not bother. This comment previously said the Pilot's captures "have no observation to pass",
 * which was false: `runtime.ts` puts `authResolved` on every capture snapshot, and both Pilot
 * drains held it and dropped it. The result was that the longest and most expensive sessions on
 * the platform were the only ones recording an unknown payer (#356) — while this docstring
 * asserted that was correct.
 *
 * `INSERT OR IGNORE` on a deterministic id makes the write idempotent, which is what lets more
 * than one cloud path drain and record the same turn without double-charging. Best-effort like
 * the other recorders: a failed ledger write must never break a coding session.
 */
export async function recordEngineUsage(
	env: { DB: D1Database },
	args: {
		userId: string | undefined;
		sessionId: string;
		instanceId?: string | null;
		agentId?: string | null;
		/** What the runner saw the engine authenticate with. Absent ⇒ the row's payer is unknown. */
		authResolved?: EngineAuthResolved | null;
	},
	records: EngineUsageReport[] | undefined,
): Promise<void> {
	try {
		if (!args.userId || !args.sessionId || !records?.length) return;
		const payer = payerForEngineAuth(args.authResolved);
		const stmts = records.map((r) =>
			env.DB.prepare(
				`INSERT OR IGNORE INTO ai_usage
				   (id, user_id, agent_id, instance_id, provider, model, kind, input_tokens, output_tokens,
				    cache_read_tokens, cache_write_tokens, cost_micros, cost_source, payer, created_at)
				 VALUES (?1, ?2, ?3, ?4, 'anthropic', ?5, 'engine', ?6, ?7, ?8, ?9, ?10, 'reported', ?11, datetime('now'))`,
			).bind(
				engineUsageRowId(args.sessionId, r.id),
				args.userId,
				args.agentId ?? null,
				args.instanceId ?? null,
				r.model,
				r.inputTokens,
				r.outputTokens,
				r.cacheReadTokens,
				r.cacheWriteTokens,
				Math.round(r.costUsd * 1_000_000),
				payer,
			),
		);
		await env.DB.batch(stmts);
	} catch {
		/* observability, never load-bearing */
	}
}

/**
 * Ledger a PLATFORM-PAID Workers-AI call (issue #44) — provider "platform" so the
 * admin split can separate it from BYOK. Cost is the rough platform estimate
 * (authoritative = CF billing actuals, issue #45). Best-effort like recordUsage.
 */
export async function recordPlatformUsage(
	env: { DB: D1Database },
	args: { userId: string | undefined; instanceId?: string | null; agentId?: string | null; model: string; kind: UsageKind },
	usage: UsageTokens | null | undefined,
): Promise<void> {
	try {
		if (!args.userId || !usage) return;
		const input = Math.max(0, Math.floor(Number(usage.input) || 0));
		const output = Math.max(0, Math.floor(Number(usage.output) || 0));
		if (input === 0 && output === 0) return;
		const cost = estimatePlatformCostMicros(input, output);
		await env.DB.prepare(
			`INSERT INTO ai_usage (id, user_id, agent_id, instance_id, provider, model, kind, input_tokens, output_tokens, cost_micros, payer, created_at)
			 VALUES (?1, ?2, ?3, ?4, 'platform', ?5, ?6, ?7, ?8, ?9, 'platform', datetime('now'))`,
		)
			.bind(
				crypto.randomUUID(),
				args.userId,
				args.agentId ?? null,
				args.instanceId ?? null,
				args.model,
				args.kind,
				input,
				output,
				cost,
			)
			.run();
	} catch {
		/* observability, never load-bearing */
	}
}

// ---------------------------------------------------------------------------
// Aggregation (pure — unit-tested against fixture rows)
// ---------------------------------------------------------------------------

export interface UsageRow {
	agent_id: string | null;
	instance_id: string | null;
	provider: string;
	model: string;
	kind: string;
	input_tokens: number;
	output_tokens: number;
	/** Prompt-cache tokens. NULL on rows written before 0074 — genuinely unknown, not zero. */
	cache_read_tokens?: number | null;
	cache_write_tokens?: number | null;
	/**
	 * Notional value: tokens × published list price. On EVERY row, including engine rows — the
	 * CLI's own figure is built the same way (#347). Never a bill.
	 */
	cost_micros: number;
	/** Who is charged (0092). NULL = unknown, on every row written before it and on machine-login. */
	payer?: string | null;
	created_at: string; // "YYYY-MM-DD HH:MM:SS" (UTC, D1 datetime('now'))
}

export interface UsageBucket {
	key: string;
	label?: string;
	inputTokens: number;
	outputTokens: number;
	/**
	 * Prompt-cache tokens, reported separately so the hit rate is visible.
	 *
	 * cacheReadTokens ÷ (inputTokens + cacheReadTokens) IS the cache hit rate. Before this they
	 * were summed into inputTokens, so the ratio could not be computed and nobody could tell
	 * whether caching worked — while the cost line silently assumed it never did.
	 */
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costMicros: number;
	/**
	 * The subset of `costMicros` in this bucket that someone is actually charged (#543).
	 *
	 * `costMicros` is notional value on every row, so a breakdown carrying only it answers "how
	 * much AI did this use", never "what did it cost me" — and the page printed the notional
	 * figure beside a charged headline, in the same `$` format, with nothing saying which was
	 * which. The totals loop had computed exactly this since #346; the buckets simply never did,
	 * so `byAgent`/`byKind`/`byModel`/`byPayer` (and both admin breakdowns, which share `bump`)
	 * were all notional-only.
	 *
	 * Accumulated here rather than as a parallel `chargedByAgent` array: every bucket already
	 * passes through one `bump()`, and two arrays joined by key are two things that can disagree.
	 *
	 * A bucket at 0 is NOT a claim that the work was free — `isCharged` excludes `subscription`
	 * (no marginal charge) and NULL (payer not established). The console says so beside it.
	 */
	chargedCostMicros: number;
	calls: number;
}

export interface UsageSummary {
	totals: {
		inputTokens: number;
		outputTokens: number;
		/** Notional list-price value of EVERYTHING here. Not a bill, and not what anyone owes. */
		costMicros: number;
		/**
		 * The subset of `costMicros` that someone is actually charged (`payer` in byok-api /
		 * platform). Reported separately rather than replacing the total, because the two answer
		 * different questions and adding them together is the error #346 is about — a subscription
		 * row's tokens are real consumption worth seeing, at a dollar figure worth nothing.
		 */
		chargedCostMicros: number;
		calls: number;
	};
	/**
	 * The per-day series, carrying ALL FOUR token columns (#547).
	 *
	 * It carried only input and output, so the chart plotted 4.2M tokens for 2026-08-11 — the day
	 * a 250M-token circuit breaker tripped at 268M. Cache reads are 98.2% of what that ceiling
	 * counts (`accountUsageSince` sums all four), so the one view that could answer "which day did
	 * I blow the ceiling, and on what?" was off by 137x. The numbers were already accumulated by
	 * `bump()` into `dayMap` and then dropped on the way out; nothing new is computed here.
	 */
	daily: Array<{
		date: string;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		costMicros: number;
		calls: number;
	}>;
	byModel: UsageBucket[];
	byKind: UsageBucket[];
	byAgent: UsageBucket[];
	/** Value split by who pays it — the axis the page needs to stop implying everything is a bill. */
	byPayer: UsageBucket[];
}

const emptyBucket = (key: string): UsageBucket => ({ key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, chargedCostMicros: 0, calls: 0 });

function bump(b: UsageBucket, r: UsageRow) {
	b.inputTokens += r.input_tokens || 0;
	b.outputTokens += r.output_tokens || 0;
	// `|| 0` folds pre-0074 NULLs into zero for the SUM, which is the only sane arithmetic — the
	// distinction that matters (unknown vs. genuinely no cache activity) is preserved per-row in
	// D1, not in an aggregate that has to add them up.
	b.cacheReadTokens += r.cache_read_tokens || 0;
	b.cacheWriteTokens += r.cache_write_tokens || 0;
	b.costMicros += r.cost_micros || 0;
	// The same predicate, on the same row, that the totals loop applies six lines down. Doing it
	// here is what makes every breakdown decomposable into "value" and "money" — without it the
	// page could state a true charged total and not say which agent any of it belonged to (#543).
	if (isCharged(r.payer)) b.chargedCostMicros += r.cost_micros || 0;
	b.calls += 1;
}

/** The date portion (UTC) of a D1 timestamp — "2026-07-14 10:00:00" → "2026-07-14". */
export function usageDay(ts: string): string {
	return (ts || "").slice(0, 10);
}

/**
 * Roll raw ledger rows into totals, a per-day series (dense across [fromDay,toDay]
 * inclusive when provided, so the chart has no gaps), and by-model/kind/agent
 * breakdowns sorted by cost then tokens. agentNames maps agent_id → display label.
 */
export function aggregateUsage(
	rows: UsageRow[],
	opts: { fromDay?: string; toDay?: string; agentNames?: Record<string, string> } = {},
): UsageSummary {
	const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, chargedCostMicros: 0, calls: 0 };
	const dayMap = new Map<string, UsageBucket>();
	const modelMap = new Map<string, UsageBucket>();
	const kindMap = new Map<string, UsageBucket>();
	const agentMap = new Map<string, UsageBucket>();
	const payerMap = new Map<string, UsageBucket>();

	const into = (map: Map<string, UsageBucket>, key: string, r: UsageRow) => {
		let b = map.get(key);
		if (!b) { b = emptyBucket(key); map.set(key, b); }
		bump(b, r);
	};

	for (const r of rows) {
		totals.inputTokens += r.input_tokens || 0;
		totals.outputTokens += r.output_tokens || 0;
		totals.cacheReadTokens += r.cache_read_tokens || 0;
		totals.cacheWriteTokens += r.cache_write_tokens || 0;
		totals.costMicros += r.cost_micros || 0;
		if (isCharged(r.payer)) totals.chargedCostMicros += r.cost_micros || 0;
		totals.calls += 1;
		into(dayMap, usageDay(r.created_at), r);
		into(modelMap, r.model || "unknown", r);
		into(kindMap, r.kind || "unknown", r);
		into(agentMap, r.agent_id || "unassigned", r);
		// NULL payer buckets as "unknown" rather than being dropped: a row we cannot attribute is
		// still consumption the owner should see, and hiding it would make the page's own
		// attribution look more complete than it is.
		into(payerMap, asPayer(r.payer) ?? UNKNOWN_PAYER_KEY, r);
	}

	// Dense daily series so the chart shows empty days as zero rather than skipping.
	const daily: UsageSummary["daily"] = [];
	const days = opts.fromDay && opts.toDay ? denseDays(opts.fromDay, opts.toDay) : [...dayMap.keys()].sort();
	for (const date of days) {
		const b = dayMap.get(date);
		daily.push({
			date,
			inputTokens: b?.inputTokens || 0,
			outputTokens: b?.outputTokens || 0,
			cacheReadTokens: b?.cacheReadTokens || 0,
			cacheWriteTokens: b?.cacheWriteTokens || 0,
			costMicros: b?.costMicros || 0,
			calls: b?.calls || 0,
		});
	}

	const sortBuckets = (m: Map<string, UsageBucket>) =>
		[...m.values()].sort((a, b) => b.costMicros - a.costMicros || (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));

	const byAgent = sortBuckets(agentMap).map((b) => ({
		...b,
		label: b.key === "unassigned" ? "Unassigned" : (opts.agentNames?.[b.key] || b.key),
	}));

	return {
		totals,
		daily,
		byModel: sortBuckets(modelMap),
		byKind: sortBuckets(kindMap),
		byAgent,
		byPayer: sortBuckets(payerMap).map((b) => ({ ...b, label: PAYER_LABEL[b.key] || b.key })),
	};
}

// ---------------------------------------------------------------------------
// Admin aggregation (cross-user) — pure, unit-tested. Powers /v1/admin/usage
// and /v1/admin/spending. Adds the by-provider and by-user dimensions the
// per-user page doesn't need, plus a platform-paid-vs-BYOK split.
// ---------------------------------------------------------------------------

/** A ledger row with its owning user — the per-user view filters by user, admin needs it. */
export interface AdminUsageRow extends UsageRow {
	user_id: string;
}

export interface BucketTotals {
	inputTokens: number;
	outputTokens: number;
	/** List-price value of every row counted. Not a bill (#346). */
	costMicros: number;
	/**
	 * The subset anyone is actually charged for — `payer` in byok-api / platform.
	 *
	 * The split below is on `provider`, which is the VENDOR axis: `anthropic` is reached both by a
	 * metered API key and by a subscription that costs nothing per token. So "BYOK" as a bucket is
	 * "not our Workers AI", and the figure an operator reads as BYOK SPEND has to be this one.
	 */
	chargedMicros: number;
	calls: number;
}

export interface AdminUsageSummary {
	totals: BucketTotals;
	daily: UsageSummary["daily"];
	byProvider: UsageBucket[];
	byModel: UsageBucket[];
	byKind: UsageBucket[];
	byAgent: UsageBucket[];
	byUser: UsageBucket[];
	/** Platform-paid (provider === "platform", billed to us) vs BYOK (everything else). */
	split: { platformPaid: BucketTotals; byok: BucketTotals };
}

/** Rows whose cost the platform pays are marked with this provider by the metering layer. */
export const PLATFORM_PROVIDER = "platform";

const zeroTotals = (): BucketTotals => ({ inputTokens: 0, outputTokens: 0, costMicros: 0, chargedMicros: 0, calls: 0 });

function addInto(t: BucketTotals, r: UsageRow) {
	t.inputTokens += r.input_tokens || 0;
	t.outputTokens += r.output_tokens || 0;
	t.costMicros += r.cost_micros || 0;
	if (isCharged(r.payer)) t.chargedMicros += r.cost_micros || 0;
	t.calls += 1;
}

/**
 * Roll cross-user ledger rows into admin breakdowns. `names` maps ids → display
 * labels (agentNames for agent_id, userNames for user_id).
 */
export function aggregateAdminUsage(
	rows: AdminUsageRow[],
	opts: { fromDay?: string; toDay?: string; agentNames?: Record<string, string>; userNames?: Record<string, string> } = {},
): AdminUsageSummary {
	const totals = zeroTotals();
	const maps = {
		day: new Map<string, UsageBucket>(),
		provider: new Map<string, UsageBucket>(),
		model: new Map<string, UsageBucket>(),
		kind: new Map<string, UsageBucket>(),
		agent: new Map<string, UsageBucket>(),
		user: new Map<string, UsageBucket>(),
	};
	const split = { platformPaid: zeroTotals(), byok: zeroTotals() };

	const into = (m: Map<string, UsageBucket>, key: string, r: UsageRow) => {
		let b = m.get(key);
		if (!b) { b = emptyBucket(key); m.set(key, b); }
		bump(b, r);
	};

	for (const r of rows) {
		addInto(totals, r);
		into(maps.day, usageDay(r.created_at), r);
		into(maps.provider, r.provider || "unknown", r);
		into(maps.model, r.model || "unknown", r);
		into(maps.kind, r.kind || "unknown", r);
		into(maps.agent, r.agent_id || "unassigned", r);
		into(maps.user, r.user_id || "unknown", r);
		addInto(r.provider === PLATFORM_PROVIDER ? split.platformPaid : split.byok, r);
	}

	const daily: UsageSummary["daily"] = [];
	const days = opts.fromDay && opts.toDay ? denseDays(opts.fromDay, opts.toDay) : [...maps.day.keys()].sort();
	for (const date of days) {
		const b = maps.day.get(date);
		daily.push({
			date,
			inputTokens: b?.inputTokens || 0,
			outputTokens: b?.outputTokens || 0,
			cacheReadTokens: b?.cacheReadTokens || 0,
			cacheWriteTokens: b?.cacheWriteTokens || 0,
			costMicros: b?.costMicros || 0,
			calls: b?.calls || 0,
		});
	}

	const sortByCost = (m: Map<string, UsageBucket>) =>
		[...m.values()].sort((a, b) => b.costMicros - a.costMicros || (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));

	return {
		totals,
		daily,
		byProvider: sortByCost(maps.provider),
		byModel: sortByCost(maps.model),
		byKind: sortByCost(maps.kind),
		byAgent: sortByCost(maps.agent).map((b) => ({ ...b, label: b.key === "unassigned" ? "Unassigned" : opts.agentNames?.[b.key] || b.key })),
		byUser: sortByCost(maps.user).map((b) => ({ ...b, label: opts.userNames?.[b.key] || b.key })),
		split,
	};
}

/** Inclusive list of "YYYY-MM-DD" strings from → to (UTC), capped to avoid runaway. */
export function denseDays(fromDay: string, toDay: string): string[] {
	const out: string[] = [];
	const start = Date.parse(`${fromDay}T00:00:00Z`);
	const end = Date.parse(`${toDay}T00:00:00Z`);
	if (Number.isNaN(start) || Number.isNaN(end) || end < start) return out;
	const DAY = 86_400_000;
	for (let t = start, n = 0; t <= end && n < 400; t += DAY, n++) {
		out.push(new Date(t).toISOString().slice(0, 10));
	}
	return out;
}

/**
 * Running total of CHARGED spend on one instance, in USD micros.
 *
 * Used by the durable agent loop (#158) to settle a budget reservation with the ACTUAL cost:
 * read before the iteration, read after, settle the delta. `ai_usage` is append-only, so the
 * total is monotonic and two reads are enough — no time window to get wrong.
 *
 * Filtered to {@link CHARGED_SQL} (#343/#346). A delegation pool is denominated in dollars, so it
 * may only be drawn down by dollars: a coding session whose engine runs on the owner's Claude
 * subscription accrues large notional value and no charge, and settling the pool against that
 * would exhaust a $5 budget over money nobody owes. The tokens are still in the ledger and still
 * on the Usage page; they are just not a bill, so they are not a draw.
 *
 * Caveat worth knowing: the delta is instance-scoped, not run-scoped, so a user chatting with the
 * same instance while a loop runs has that chat attributed to the loop's budget. That errs toward
 * charging the pool too much, which stops a run early — the safe direction. Under-charging would
 * let a runaway continue.
 *
 * Which is why this one THROWS while every other swallow in this file is marked "observability,
 * never load-bearing". It is read twice per iteration to compute `after - before`, so a swallowed
 * failure returned 0 and booked the iteration as free: the reservation is released, the tree pool
 * never depletes, the cap that exists to stop a runaway becomes inert, and `list_delegation_budgets`
 * reports a `spent` figure that is untrue. Every caller is inside a retrying workflow step, or has
 * an explicit fallback that errs toward over-charging.
 */
export async function instanceSpendMicros(env: Env, userId: string, instanceId: string): Promise<number> {
	const row = await env.DB.prepare(
		`SELECT COALESCE(SUM(cost_micros), 0) AS total FROM ai_usage
		  WHERE user_id = ?1 AND instance_id = ?2 AND ${CHARGED_SQL}`,
	)
		.bind(userId, instanceId)
		.first<{ total: number }>();
	return Math.max(0, Number(row?.total ?? 0));
}

/**
 * A high percentile of recent per-run spend on this user's instances, in USD micros.
 *
 * Budget defaults must come from what real runs actually cost, not from a guess — a guessed
 * ceiling is exactly how a safety feature turns into an obstacle that interrupts legitimate work.
 * The acceptance question is "what fraction of historical runs would this default have stopped?",
 * and answering it needs the distribution, not an average: averages are dragged down by the many
 * cheap chat turns and would cut long coding sessions off early.
 *
 * `kind` scopes it to comparable work (coding sessions cost far more than chat turns). Returns
 * null when there is too little history to be meaningful, so the caller keeps its static default
 * rather than trusting a percentile computed from three rows.
 *
 * Charged rows only, for the same reason the pool it sizes is: a distribution that includes
 * subscription engine turns would derive a dollar budget from dollars nobody pays, sizing the pool
 * by the wrong quantity in both directions at once.
 */
export async function spendPercentileMicros(
	env: Env,
	userId: string,
	opts: { kind?: UsageKind; percentile?: number; minSamples?: number; days?: number } = {},
): Promise<number | null> {
	const percentile = Math.min(0.999, Math.max(0.5, opts.percentile ?? 0.95));
	const minSamples = Math.max(1, opts.minSamples ?? 20);
	const days = Math.max(1, Math.min(365, opts.days ?? 30));
	try {
		// One row per call; grouping by day+kind would hide the tail we care about.
		const res = await env.DB.prepare(
			`SELECT cost_micros FROM ai_usage
			  WHERE user_id = ?1
			    AND (?2 IS NULL OR kind = ?2)
			    AND created_at >= datetime('now', ?3)
			    AND cost_micros > 0
			    AND ${CHARGED_SQL}
			  ORDER BY cost_micros ASC`,
		)
			.bind(userId, opts.kind ?? null, `-${days} days`)
			.all<{ cost_micros: number }>();
		const values = (res.results ?? []).map((r) => Number(r.cost_micros)).filter((n) => Number.isFinite(n));
		if (values.length < minSamples) return null;
		// Nearest-rank: the smallest value at or above the percentile position.
		const idx = Math.min(values.length - 1, Math.ceil(percentile * values.length) - 1);
		return Math.max(0, values[idx]);
	} catch {
		return null;
	}
}

/** What an account has consumed over a rolling window, in the two units it can be bounded in. */
export interface AccountUsageWindow {
	/** Money someone is actually charged — `payer` in byok-api / platform. The dollar ceiling. */
	chargedMicros: number;
	/** All tokens consumed, charged or not. The unit subscription and unknown work has. */
	tokens: number;
}

/**
 * What a user's agents have consumed over a rolling window — charged dollars AND tokens.
 *
 * The per-tree pool (#184) bounds ONE runaway delegation. It cannot see a thousand small runaway
 * trees: each opens its own budget, each stays inside it, and the account still bleeds. This is
 * the other control — an account-wide ceiling over time, which is a rolling window rather than a
 * pool because there is nothing to reserve against.
 *
 * Two numbers, because there are two resources and they are not convertible (#343). This
 * previously returned one unfiltered `SUM(cost_micros)` named "spend", which counted $48.76 of
 * engine turns run on a Claude subscription and refused work over a $50 bill that did not exist.
 * A subscription's own limit is a rolling 5h + weekly TOKEN allowance — there is no dollar figure
 * on the other side of it for a dollar ceiling to be comparing against.
 *
 * One query, not two: the ceiling is checked at every admission, and the second read would double
 * the D1 cost of the check for a number the first scan already has in hand.
 */
export async function accountUsageSince(env: Env, userId: string, hours = 24): Promise<AccountUsageWindow> {
	const h = Math.max(1, Math.min(24 * 30, Math.floor(hours)));
	try {
		const row = await env.DB.prepare(
			`SELECT
			   COALESCE(SUM(CASE WHEN ${CHARGED_SQL} THEN cost_micros ELSE 0 END), 0) AS charged_micros,
			   COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
			                + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0)), 0) AS tokens
			 FROM ai_usage
			  WHERE user_id = ?1 AND created_at >= datetime('now', ?2)`,
		)
			.bind(userId, `-${h} hours`)
			.first<{ charged_micros: number; tokens: number }>();
		return {
			chargedMicros: Math.max(0, Number(row?.charged_micros ?? 0)),
			tokens: Math.max(0, Number(row?.tokens ?? 0)),
		};
	} catch {
		// A ledger read failure must not become an outage. Failing OPEN is deliberate: the
		// per-tree pool still bounds the work, so the safe-ish default here is to let it run
		// rather than freeze every agent on a transient D1 blip.
		return { chargedMicros: 0, tokens: 0 };
	}
}
