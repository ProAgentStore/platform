// The usage ledger: record one row per AI call at the choke point, and aggregate
// it for the Usage page. Recording is best-effort — a ledger write must never
// break or slow an actual chat/apply/coding call.

import { estimateCostMicros, estimatePlatformCostMicros } from "./ai-pricing.js";
import type { Env } from "../types.js";

export type UsageKind =
	| "chat"
	| "apply"
	| "coding"
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
 */
export async function recordUsage(
	env: { DB: D1Database },
	args: RecordArgs,
	usage: UsageTokens | null | undefined,
): Promise<void> {
	try {
		if (!args.userId || !usage) return;
		const input = Math.max(0, Math.floor(Number(usage.input) || 0));
		const output = Math.max(0, Math.floor(Number(usage.output) || 0));
		if (input === 0 && output === 0) return;
		const cost = estimateCostMicros(args.model, input, output);
		await env.DB.prepare(
			`INSERT INTO ai_usage (id, user_id, agent_id, instance_id, provider, model, kind, input_tokens, output_tokens, cost_micros, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))`,
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
			`INSERT INTO ai_usage (id, user_id, agent_id, instance_id, provider, model, kind, input_tokens, output_tokens, cost_micros, created_at)
			 VALUES (?1, ?2, NULL, ?3, 'openai', ?4, 'voice', 0, 0, ?5, datetime('now'))`,
		)
			.bind(crypto.randomUUID(), args.userId, args.instanceId ?? null, args.model, cost)
			.run();
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
			`INSERT INTO ai_usage (id, user_id, agent_id, instance_id, provider, model, kind, input_tokens, output_tokens, cost_micros, created_at)
			 VALUES (?1, ?2, ?3, ?4, 'platform', ?5, ?6, ?7, ?8, ?9, datetime('now'))`,
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
	cost_micros: number;
	created_at: string; // "YYYY-MM-DD HH:MM:SS" (UTC, D1 datetime('now'))
}

export interface UsageBucket {
	key: string;
	label?: string;
	inputTokens: number;
	outputTokens: number;
	costMicros: number;
	calls: number;
}

export interface UsageSummary {
	totals: { inputTokens: number; outputTokens: number; costMicros: number; calls: number };
	daily: Array<{ date: string; inputTokens: number; outputTokens: number; costMicros: number; calls: number }>;
	byModel: UsageBucket[];
	byKind: UsageBucket[];
	byAgent: UsageBucket[];
}

const emptyBucket = (key: string): UsageBucket => ({ key, inputTokens: 0, outputTokens: 0, costMicros: 0, calls: 0 });

function bump(b: UsageBucket, r: UsageRow) {
	b.inputTokens += r.input_tokens || 0;
	b.outputTokens += r.output_tokens || 0;
	b.costMicros += r.cost_micros || 0;
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
	const totals = { inputTokens: 0, outputTokens: 0, costMicros: 0, calls: 0 };
	const dayMap = new Map<string, UsageBucket>();
	const modelMap = new Map<string, UsageBucket>();
	const kindMap = new Map<string, UsageBucket>();
	const agentMap = new Map<string, UsageBucket>();

	const into = (map: Map<string, UsageBucket>, key: string, r: UsageRow) => {
		let b = map.get(key);
		if (!b) { b = emptyBucket(key); map.set(key, b); }
		bump(b, r);
	};

	for (const r of rows) {
		totals.inputTokens += r.input_tokens || 0;
		totals.outputTokens += r.output_tokens || 0;
		totals.costMicros += r.cost_micros || 0;
		totals.calls += 1;
		into(dayMap, usageDay(r.created_at), r);
		into(modelMap, r.model || "unknown", r);
		into(kindMap, r.kind || "unknown", r);
		into(agentMap, r.agent_id || "unassigned", r);
	}

	// Dense daily series so the chart shows empty days as zero rather than skipping.
	const daily: UsageSummary["daily"] = [];
	const days = opts.fromDay && opts.toDay ? denseDays(opts.fromDay, opts.toDay) : [...dayMap.keys()].sort();
	for (const date of days) {
		const b = dayMap.get(date);
		daily.push({ date, inputTokens: b?.inputTokens || 0, outputTokens: b?.outputTokens || 0, costMicros: b?.costMicros || 0, calls: b?.calls || 0 });
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
	costMicros: number;
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

const zeroTotals = (): BucketTotals => ({ inputTokens: 0, outputTokens: 0, costMicros: 0, calls: 0 });

function addInto(t: BucketTotals, r: UsageRow) {
	t.inputTokens += r.input_tokens || 0;
	t.outputTokens += r.output_tokens || 0;
	t.costMicros += r.cost_micros || 0;
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
		daily.push({ date, inputTokens: b?.inputTokens || 0, outputTokens: b?.outputTokens || 0, costMicros: b?.costMicros || 0, calls: b?.calls || 0 });
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
 * Running total of estimated spend on one instance, in USD micros.
 *
 * Used by the durable agent loop (#158) to settle a budget reservation with the ACTUAL cost:
 * read before the iteration, read after, settle the delta. `ai_usage` is append-only, so the
 * total is monotonic and two reads are enough — no time window to get wrong.
 *
 * Caveat worth knowing: the delta is instance-scoped, not run-scoped, so a user chatting with the
 * same instance while a loop runs has that chat attributed to the loop's budget. That errs toward
 * charging the pool too much, which stops a run early — the safe direction. Under-charging would
 * let a runaway continue.
 */
export async function instanceSpendMicros(env: Env, userId: string, instanceId: string): Promise<number> {
	try {
		const row = await env.DB.prepare(
			"SELECT COALESCE(SUM(cost_micros), 0) AS total FROM ai_usage WHERE user_id = ?1 AND instance_id = ?2",
		)
			.bind(userId, instanceId)
			.first<{ total: number }>();
		return Math.max(0, Number(row?.total ?? 0));
	} catch {
		return 0;
	}
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

/**
 * Total estimated spend for a user over a rolling window, in USD micros.
 *
 * The per-tree pool (#184) bounds ONE runaway delegation. It cannot see a thousand small runaway
 * trees: each opens its own budget, each stays inside it, and the account still bleeds. This is
 * the other control — an account-wide ceiling over time, which is a rolling window rather than a
 * pool because there is nothing to reserve against.
 */
export async function userSpendSinceMicros(env: Env, userId: string, hours = 24): Promise<number> {
	const h = Math.max(1, Math.min(24 * 30, Math.floor(hours)));
	try {
		const row = await env.DB.prepare(
			`SELECT COALESCE(SUM(cost_micros), 0) AS total FROM ai_usage
			  WHERE user_id = ?1 AND created_at >= datetime('now', ?2)`,
		)
			.bind(userId, `-${h} hours`)
			.first<{ total: number }>();
		return Math.max(0, Number(row?.total ?? 0));
	} catch {
		// A ledger read failure must not become an outage. Failing OPEN is deliberate: the
		// per-tree pool still bounds the work, so the safe-ish default here is to let it run
		// rather than freeze every agent on a transient D1 blip.
		return 0;
	}
}
