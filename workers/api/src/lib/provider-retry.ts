import { isValidModelId } from "./coding-engine-model.js";

/**
 * How a coding run retries an AI provider that failed transiently (#1391) — attempts, exponential backoff, jitter, all per instance.
 *
 * A turn that dies on "Selected model is at capacity" is classified `transient` (`engine-provider-error.ts`): the Pilot is told to resend once, and
 * a repeat parks. The parks used to be a fixed ladder — 2, 5 and 15 minutes, no jitter, no way to change it — so every run that met the same outage
 * woke at the same instants and asked the provider again together, and an owner whose provider needed longer, or less, had no say.
 *
 * Now the ladder is the policy: `attempts` waits, each `baseMs` doubled per wait up to `maxMs`, spread by `jitter`. Pure, and DETERMINISTIC — the
 * workflow that parks on it is replayed, so the spread comes from a hash of the run and the attempt, never from a clock or `Math.random`: a replay
 * lands on the same instant the first pass chose, and two runs still land on different ones.
 *
 * The defaults are the old ladder's shape grown by one attempt: 2, 4, 8, then 15 minutes (capped), 20% either way.
 */

export interface ProviderRetryPolicy {
	/** Waits before the run gives up (the Pilot's one free resend comes before the first). */
	attempts: number;
	/** The first wait, in ms. */
	baseMs: number;
	/** No wait is longer than this, jitter included. */
	maxMs: number;
	/** The spread either side of the backoff, as a fraction: 0.2 is ±20%. */
	jitter: number;
	/**
	 * The model to try ONCE when every attempt is spent (#1392), or null for none — the default. Never chosen by the platform: it is only ever a model the
	 * owner wrote here. It applies to the run that needs it and is put back afterwards, so a later run starts on the instance's configured model.
	 */
	fallbackModel: string | null;
}

export const DEFAULT_PROVIDER_RETRY: Readonly<ProviderRetryPolicy> = { attempts: 4, baseMs: 2 * 60_000, maxMs: 15 * 60_000, jitter: 0.2, fallbackModel: null };

/** The bounds a configured value is held to — wide enough for any real outage, narrow enough that a typo cannot park a run for a week. */
export const PROVIDER_RETRY_BOUNDS = {
	attempts: { min: 1, max: 8 },
	baseMs: { min: 5_000, max: 10 * 60_000 },
	maxMs: { min: 5_000, max: 60 * 60_000 },
	jitter: { min: 0, max: 0.5 },
} as const;

/** What an instance stores: only the fields its owner set. Absent fields inherit the defaults. */
export type ProviderRetryConfig = Partial<ProviderRetryPolicy>;

/** Why a fallback model is refused, or null when it is a model id. Exposed so the route can say it instead of quietly dropping a typo from an opt-in setting. */
export function fallbackModelProblem(v: unknown): string | null {
	return v === null || isValidModelId(v) ? null : "fallbackModel must be a model id (letters, digits and . _ : / @ [ ] -, no spaces, at most 100 characters) or null";
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const within = (v: number, b: { min: number; max: number }) => Math.min(b.max, Math.max(b.min, v));

/**
 * A stored or submitted value as a clean override: recognised fields only, numbers only, each clamped to its bound. Never throws — a stored value
 * that is not an object is no override. `maxMs` is raised to `baseMs` if it would sit below it, so the ladder always climbs.
 */
export function sanitizeProviderRetry(raw: unknown): ProviderRetryConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const r = raw as Record<string, unknown>;
	const out: ProviderRetryConfig = {};
	if (finite(r.attempts)) out.attempts = within(Math.round(r.attempts), PROVIDER_RETRY_BOUNDS.attempts);
	if (finite(r.baseMs)) out.baseMs = within(Math.round(r.baseMs), PROVIDER_RETRY_BOUNDS.baseMs);
	if (finite(r.maxMs)) out.maxMs = within(Math.round(r.maxMs), PROVIDER_RETRY_BOUNDS.maxMs);
	if (finite(r.jitter)) out.jitter = within(r.jitter, PROVIDER_RETRY_BOUNDS.jitter);
	// Only a real model id is kept (a typo must not become a command-line fragment); the route refuses a bad one before it gets here.
	if (isValidModelId(r.fallbackModel)) out.fallbackModel = r.fallbackModel;
	if (out.baseMs !== undefined && out.maxMs !== undefined && out.maxMs < out.baseMs) out.maxMs = out.baseMs;
	return out;
}

/** The policy in force: the defaults, then the instance's own fields. */
export function resolveProviderRetry(config?: ProviderRetryConfig | null): ProviderRetryPolicy {
	const o = sanitizeProviderRetry(config);
	const merged = { ...DEFAULT_PROVIDER_RETRY, ...o };
	// An override of the base alone must not leave the ceiling below it; one of the ceiling alone must not leave the base above it.
	return { ...merged, maxMs: Math.max(merged.maxMs, merged.baseMs), baseMs: Math.min(merged.baseMs, merged.maxMs) };
}

/** A small stable hash of a string to [0, 1) — FNV-1a. Same input, same number, on every replay. */
function unit(seed: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h / 0x1_0000_0000;
}

/**
 * The wait before retry number `taken + 1` (`taken` waits already served): `baseMs · 2^taken`, capped at `maxMs`, spread ±`jitter` by a hash of
 * `seed` and `taken`, and capped again so no wait exceeds `maxMs`. With no `seed` there is no spread — the exact backoff, which is what a test
 * of the shape wants and what a caller with nothing stable to hash gets.
 */
export function retryDelayMs(taken: number, policy: ProviderRetryPolicy, seed?: string): number {
	const exact = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, Math.trunc(taken)));
	if (!seed || policy.jitter <= 0) return exact;
	const spread = (unit(`${seed}:${Math.trunc(taken)}`) * 2 - 1) * policy.jitter; // −jitter … +jitter
	return Math.max(1_000, Math.min(policy.maxMs, Math.round(exact * (1 + spread))));
}

/** Every wait the policy will serve, in order — for the owner-facing sentence and the tests. */
export function retrySchedule(policy: ProviderRetryPolicy, seed?: string): number[] {
	return Array.from({ length: policy.attempts }, (_, i) => retryDelayMs(i, policy, seed));
}

/** "2 min", "8 min", "45 s" — how a wait is said to a person. */
export function sayWait(ms: number): string {
	return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1_000)} s`;
}

/**
 * What the loop-limits routes read back (#1391): the policy a run on this instance will use — the defaults with the owner's fields on top — and
 * the waits it serves, before the per-run spread. The stored setting itself rides in `limits.providerRetry`.
 */
export function providerRetryView(limits: { providerRetry?: ProviderRetryConfig }): { effectiveProviderRetry: ProviderRetryPolicy & { scheduleMs: number[] } } {
	const policy = resolveProviderRetry(limits.providerRetry);
	return { effectiveProviderRetry: { ...policy, scheduleMs: retrySchedule(policy) } };
}
