/**
 * Spend drivers and savings evidence (#1040) — read from the `ai_usage` ledger, nothing else.
 *
 * `GET /v1/usage` answers "what did I spend, on what"; this answers the two questions an owner asks
 * next: "what is DRIVING it" (top instances, models, phases and objectives, plus the waste the ledger
 * can prove — retries, duplicated calls, uncached repeated context) and "did my change actually save
 * anything" (a baseline window against a current one, normalised per call and per objective so a
 * quiet week cannot pose as a saving).
 *
 * Privacy-safe by construction: the ledger holds ids, closed labels and counts (migration 0228),
 * never prompt or reply text, and nothing here reads anything else.
 *
 * Every opportunity is an ESTIMATE at list prices with its basis stated, and none of them is acted on:
 * cheaper routing names only advisory surfaces (the Brain, #1043) — never the Pilot, an approval or a
 * submission — and stays a suggestion the owner makes in the Brain card.
 */
import { CACHE_READ_MULTIPLIER, estimateCostMicros, priceFor } from "./ai-pricing.js";
import { isCharged } from "./usage-payer.js";

/** One ledger row, as the drivers query reads it. */
export interface DriverRow {
	instance_id: string | null;
	provider: string | null;
	model: string | null;
	kind: string | null;
	source: string | null;
	phase: string | null;
	trace_id: string | null;
	tool_calls: number | null;
	attempt: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	cost_micros: number | null;
	payer: string | null;
	created_at: string;
}

export interface DriverBucket {
	key: string;
	/** A readable name where the key is an id (instances). */
	label?: string;
	calls: number;
	costMicros: number;
	tokens: number;
}

export interface SpendTotals {
	calls: number;
	costMicros: number;
	chargedMicros: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Share of prompt tokens served from cache, 0–1. */
	cacheReadShare: number;
	/** Calls whose reply asked for at least one tool, and how many tool calls in all. */
	toolCallTurns: number;
	toolCalls: number;
	/** Controller retries after a provider stall (attempt ≥ 2) — calls and their cost. */
	retryCalls: number;
	retryMicros: number;
	/** Calls that repeat an earlier call of the same objective, phase, model and prompt size. */
	duplicateCalls: number;
	duplicateMicros: number;
	/** Distinct objectives (traces) the window's spend served. */
	objectives: number;
	/** Spend with no objective recorded — ledger rows from before attribution, or untraced callers. */
	unattributedMicros: number;
}

export interface SavingsOpportunity {
	id: "retries" | "duplicates" | "uncached-context" | "cheaper-advisory-model";
	label: string;
	estimatedMicros: number;
	calls: number;
	/** How the estimate was made, in one sentence the owner can check. */
	basis: string;
	/** Where the owner acts on it. Nothing is changed automatically. */
	action: string;
}

export interface SpendDrivers {
	from: string;
	to: string;
	totals: SpendTotals;
	byInstance: DriverBucket[];
	byModel: DriverBucket[];
	/** `source · phase` — which surface and which step of it. */
	byPhase: DriverBucket[];
	byObjective: DriverBucket[];
	byDay: DriverBucket[];
	opportunities: SavingsOpportunity[];
	/** True when the window held more than {@link DRIVER_ROW_CAP} rows and only the newest were read. */
	truncated?: boolean;
}

/** Advisory surfaces the Brain selector (#1043) can move to a cheaper model. The Pilot (`coding`) is NOT one. */
export const ADVISORY_SOURCES: readonly string[] = ["chat", "copilot", "loop", "coder-brain", "overseer"];
/** The cheaper tool-capable Brain the routing estimate reprices advisory calls on. */
export const CHEAPER_BRAIN_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
/** A prompt this large, sent again within one objective without a cache read, is context worth caching. */
export const UNCACHED_PROMPT_TOKENS = 4096;
const TOP = 10;
/** The most rows one report scans — a bound on the read, stated in the response when reached. */
export const DRIVER_ROW_CAP = 50_000;
export const NO_OBJECTIVE = "(no objective recorded)";
const NOT_RECORDED = "(not recorded)";

const num = (v: unknown) => Math.max(0, Number(v) || 0);
const tokensOf = (r: DriverRow) => num(r.input_tokens) + num(r.output_tokens) + num(r.cache_read_tokens) + num(r.cache_write_tokens);

function bucket(map: Map<string, DriverBucket>, key: string, r: DriverRow) {
	const b = map.get(key) ?? { key, calls: 0, costMicros: 0, tokens: 0 };
	b.calls++;
	b.costMicros += num(r.cost_micros);
	b.tokens += tokensOf(r);
	map.set(key, b);
}
const top = (map: Map<string, DriverBucket>, n = TOP) => [...map.values()].sort((a, b) => b.costMicros - a.costMicros || b.calls - a.calls).slice(0, n);

/** Rows in time order, so "the first call" of a duplicate group is the earliest one. */
function chronological(rows: DriverRow[]): DriverRow[] {
	return [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

/** Pure: the drivers report for one window's rows. */
export function spendDrivers(rows: DriverRow[], window: { from: string; to: string }): SpendDrivers {
	const byInstance = new Map<string, DriverBucket>();
	const byModel = new Map<string, DriverBucket>();
	const byPhase = new Map<string, DriverBucket>();
	const byObjective = new Map<string, DriverBucket>();
	const byDay = new Map<string, DriverBucket>();
	const t: SpendTotals = {
		calls: 0, costMicros: 0, chargedMicros: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheReadShare: 0,
		toolCallTurns: 0, toolCalls: 0, retryCalls: 0, retryMicros: 0, duplicateCalls: 0, duplicateMicros: 0, objectives: 0, unattributedMicros: 0,
	};
	const seen = new Set<string>();
	const tracesSeenUncached = new Set<string>();
	let uncachedMicros = 0;
	let uncachedCalls = 0;
	let advisoryMicros = 0;
	let advisoryCheaperMicros = 0;
	let advisoryCalls = 0;

	for (const r of chronological(rows)) {
		const cost = num(r.cost_micros);
		t.calls++;
		t.costMicros += cost;
		if (isCharged(r.payer)) t.chargedMicros += cost;
		t.inputTokens += num(r.input_tokens);
		t.outputTokens += num(r.output_tokens);
		t.cacheReadTokens += num(r.cache_read_tokens);
		t.cacheWriteTokens += num(r.cache_write_tokens);
		if (num(r.tool_calls) > 0) t.toolCallTurns++;
		t.toolCalls += num(r.tool_calls);
		if (num(r.attempt) > 1) {
			t.retryCalls++;
			t.retryMicros += cost;
		}
		if (!r.trace_id) t.unattributedMicros += cost;

		bucket(byInstance, r.instance_id || NOT_RECORDED, r);
		bucket(byModel, r.model || NOT_RECORDED, r);
		bucket(byPhase, `${r.source || r.kind || NOT_RECORDED}${r.phase ? ` · ${r.phase}` : ""}`, r);
		bucket(byObjective, r.trace_id || NO_OBJECTIVE, r);
		bucket(byDay, r.created_at.slice(0, 10), r);

		// A duplicate is the same objective asking the same step of the same model with the same
		// prompt size again — a first attempt only: a retry is already counted as a retry.
		if (r.trace_id && num(r.input_tokens) > 0 && num(r.attempt) <= 1) {
			const k = `${r.trace_id}\u0000${r.source ?? ""}\u0000${r.phase ?? ""}\u0000${r.model ?? ""}\u0000${num(r.input_tokens)}`;
			if (seen.has(k)) {
				t.duplicateCalls++;
				t.duplicateMicros += cost;
			}
			seen.add(k);
		}

		// Large context sent again in the same objective with nothing served from cache: caching it
		// would have charged the repeat at the cache-read rate instead of the input rate.
		if (r.trace_id && r.provider === "anthropic" && num(r.cache_read_tokens) === 0 && num(r.input_tokens) >= UNCACHED_PROMPT_TOKENS) {
			const k = `${r.trace_id}\u0000${r.source ?? ""}\u0000${r.model ?? ""}`;
			if (tracesSeenUncached.has(k)) {
				uncachedCalls++;
				uncachedMicros += Math.round(num(r.input_tokens) * priceFor(r.model).inputPerM * (1 - CACHE_READ_MULTIPLIER));
			}
			tracesSeenUncached.add(k);
		}

		if (r.provider === "anthropic" && r.source && ADVISORY_SOURCES.includes(r.source)) {
			advisoryCalls++;
			advisoryMicros += cost;
			advisoryCheaperMicros += estimateCostMicros(CHEAPER_BRAIN_MODEL, num(r.input_tokens) + num(r.cache_read_tokens) + num(r.cache_write_tokens), r.output_tokens);
		}
	}
	const prompt = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
	t.cacheReadShare = prompt ? t.cacheReadTokens / prompt : 0;
	t.objectives = [...byObjective.keys()].filter((k) => k !== NO_OBJECTIVE).length;

	const opportunities: SavingsOpportunity[] = [
		{
			id: "retries",
			label: "Retried calls after a provider stall",
			estimatedMicros: t.retryMicros,
			calls: t.retryCalls,
			basis: "The full cost of every call recorded as attempt 2 or later — work that had already been paid for once.",
			action: "Find the objective in Top objectives and its trace (MCP agent_trace); a model or prompt that keeps stalling is the cause.",
		},
		{
			id: "duplicates",
			label: "Duplicated calls within one objective",
			estimatedMicros: t.duplicateMicros,
			calls: t.duplicateCalls,
			basis: "Calls that repeat an earlier first-attempt call of the same objective, step, model and prompt size; the first is not counted.",
			action: "A loop re-asking the same step: lower its iteration limit (Budget) or check it for a stuck decision.",
		},
		{
			id: "uncached-context",
			label: "Large context sent again uncached",
			estimatedMicros: uncachedMicros,
			calls: uncachedCalls,
			basis: `Repeat Anthropic calls in one objective with ${UNCACHED_PROMPT_TOKENS}+ prompt tokens and no cache read, priced at the input rate minus the cache-read rate.`,
			action: "Shorter instructions and knowledge reach every turn; trim what the agent does not need.",
		},
		{
			id: "cheaper-advisory-model",
			label: "Advisory calls on a cheaper Brain",
			estimatedMicros: Math.max(0, advisoryMicros - advisoryCheaperMicros),
			calls: advisoryCalls,
			basis: `Advisory calls (${ADVISORY_SOURCES.join(", ")}) on Anthropic, repriced at Llama 4 Scout's list rate. Never the Pilot, an approval or a submission.`,
			action: "Pick a cheaper Brain in the instance's Brain model card — only if its answers stay good enough for you.",
		},
	];
	opportunities.sort((a, b) => b.estimatedMicros - a.estimatedMicros);

	return {
		...window,
		totals: t,
		byInstance: top(byInstance),
		byModel: top(byModel),
		byPhase: top(byPhase),
		byObjective: top(byObjective),
		byDay: [...byDay.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
		opportunities,
	};
}

export interface WindowMetrics {
	from: string;
	to: string;
	calls: number;
	costMicros: number;
	objectives: number;
	costPerCallMicros: number;
	/** Null when the window recorded no objective: there is nothing to divide by. */
	costPerObjectiveMicros: number | null;
	retryShare: number;
	duplicateShare: number;
	cacheReadShare: number;
}

export interface SavingsComparison {
	baseline: WindowMetrics;
	current: WindowMetrics;
	/** `objective` when both windows recorded objectives, else `call`. */
	basis: "objective" | "call";
	/** Per-unit change, current − baseline (negative = cheaper). */
	unitDeltaMicros: number;
	unitDeltaPct: number | null;
	/** What the current window would have cost at the baseline's unit cost, minus what it cost. Positive = saved. */
	savedMicros: number;
	verdict: "saving" | "regression" | "no-change" | "insufficient-data";
	/** One sentence the Console and MCP both show. */
	summary: string;
}

export function windowMetrics(d: SpendDrivers): WindowMetrics {
	const t = d.totals;
	return {
		from: d.from,
		to: d.to,
		calls: t.calls,
		costMicros: t.costMicros,
		objectives: t.objectives,
		costPerCallMicros: t.calls ? Math.round(t.costMicros / t.calls) : 0,
		costPerObjectiveMicros: t.objectives ? Math.round((t.costMicros - t.unattributedMicros) / t.objectives) : null,
		retryShare: t.costMicros ? t.retryMicros / t.costMicros : 0,
		duplicateShare: t.costMicros ? t.duplicateMicros / t.costMicros : 0,
		cacheReadShare: t.cacheReadShare,
	};
}

/** The fewest calls a window needs before a per-unit comparison means anything. */
export const MIN_COMPARABLE_CALLS = 5;

/**
 * Pure: baseline against current, per unit of work. Total spend alone cannot show a saving — a week
 * with half the work costs half as much — so the comparison is per objective when both windows
 * recorded objectives, and per call otherwise; the response says which.
 */
export function compareWindows(baseline: SpendDrivers, current: SpendDrivers): SavingsComparison {
	const b = windowMetrics(baseline);
	const c = windowMetrics(current);
	const usd = (m: number) => `$${(Math.abs(m) / 1e6).toFixed(m && Math.abs(m) < 10_000 ? 4 : 2)}`;
	if (b.calls < MIN_COMPARABLE_CALLS || c.calls < MIN_COMPARABLE_CALLS) {
		return {
			baseline: b, current: c, basis: "call", unitDeltaMicros: 0, unitDeltaPct: null, savedMicros: 0, verdict: "insufficient-data",
			summary: `Not enough calls to compare (${b.calls} in the baseline, ${c.calls} now; at least ${MIN_COMPARABLE_CALLS} each).`,
		};
	}
	const byObjective = b.costPerObjectiveMicros !== null && c.costPerObjectiveMicros !== null;
	const basis = byObjective ? "objective" : "call";
	const bu = byObjective ? (b.costPerObjectiveMicros as number) : b.costPerCallMicros;
	const cu = byObjective ? (c.costPerObjectiveMicros as number) : c.costPerCallMicros;
	const units = byObjective ? c.objectives : c.calls;
	const unitDeltaMicros = cu - bu;
	const unitDeltaPct = bu ? Math.round((unitDeltaMicros / bu) * 1000) / 10 : null;
	const savedMicros = Math.round(-unitDeltaMicros * units);
	// Within ±2% is noise for a per-unit average, not a result.
	const verdict = unitDeltaPct === null || Math.abs(unitDeltaPct) < 2 ? "no-change" : unitDeltaMicros < 0 ? "saving" : "regression";
	const summary =
		verdict === "no-change"
			? `Cost per ${basis} is unchanged (${usd(bu)} → ${usd(cu)}).`
			: `Cost per ${basis} ${verdict === "saving" ? "fell" : "rose"} ${Math.abs(unitDeltaPct ?? 0)}% (${usd(bu)} → ${usd(cu)}): ${verdict === "saving" ? "saved" : "cost"} about ${usd(savedMicros)} over ${units} ${basis}${units === 1 ? "" : "s"} against the baseline.`;
	return { baseline: b, current: c, basis, unitDeltaMicros, unitDeltaPct, savedMicros, verdict, summary };
}
