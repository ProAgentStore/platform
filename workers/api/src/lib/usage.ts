// The usage ledger: record one row per AI call at the choke point, and aggregate
// it for the Usage page. Recording is best-effort — a ledger write must never
// break or slow an actual chat/apply/coding call.

import { estimateCostMicros } from "./ai-pricing.js";

export type UsageKind =
	| "chat"
	| "apply"
	| "coding"
	| "copilot"
	| "overseer"
	| "run"
	| "resume"
	| "translate"
	| "voice";

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
