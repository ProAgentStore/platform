/**
 * Bounded recovery for the CONTROLLER's AI-provider calls (#907) — the Pilot's decisions, the Loop
 * orchestrator and the Co-pilot. Not the coding CLI and not the runner: a provider stream that went
 * silent says nothing about either, and the exhaustion message says so.
 *
 * ── Why this replaces `runUserWorkersAiWithStallRetry`
 *
 * That wrapper had no production caller, a "ceiling" constant nothing enforced, an empty telemetry
 * hook and a hardcoded provider. This module is called by every controller path, and:
 *
 *   - enforces a WALL-CLOCK ceiling that counts attempt time AND backoff — the next attempt is only
 *     started while there is time for a whole one, and each attempt's own deadlines are clamped to
 *     what remains;
 *   - honours cancellation before every attempt and after every backoff;
 *   - retries ONLY a provider stall (silence before content, silence mid-reply, a dropped stream).
 *     Every other error — credentials, credit, rate limit, the total-length ceiling, a bug — passes
 *     through untouched on the first throw;
 *   - never forwards a partial reply: a stalled attempt raised before returning anything, so there is
 *     nothing partial to forward, and a retry re-asks the same question from the same state;
 *   - emits sanitized telemetry per attempt and for the outcome: provider, model, configured
 *     deadlines, measured phase, attempts, backoff, cancellation — never prompts, keys or pane text.
 *
 * It does not nest inside the workflow's step retry: a Pilot decide that exhausts here is RETURNED
 * across the step boundary (see `pilot-decide.ts`), not thrown, so Cloudflare does not retry it a
 * second and third time. The round-level resume (`coding-interrupt.ts`, bounded per run) stays the
 * one outer layer.
 */
import type { Env } from "../types.js";
import { INCOMPLETE_TOOL_ARGS_MARKER } from "./anthropic-stream.js";
import { logEvent } from "./events.js";
import { patchInstanceConfig } from "./instance-config.js";
import type { StreamDeadlines, StreamPhase } from "./user-ai.js";

/** Documented defaults (#907). Settings are per instance, validated against {@link CONTROLLER_AI_BOUNDS}. */
export const CONTROLLER_AI_DEFAULTS = {
	/** Until the first content event — a model preparing a large decision legitimately takes a while. */
	preContentSeconds: 60,
	/** Silence allowed between chunks once the reply has begun. */
	silenceSeconds: 45,
	/** One decision's whole recovery — every attempt plus every backoff. */
	decisionCeilingSeconds: 240,
} as const;

export const CONTROLLER_AI_BOUNDS = {
	preContentSeconds: [20, 180],
	silenceSeconds: [15, 120],
	decisionCeilingSeconds: [60, 600],
} as const;

/** Attempts per decision, and the waits between them. Bounded further by the ceiling. */
export const CONTROLLER_AI_MAX_ATTEMPTS = 4;
export const CONTROLLER_AI_BACKOFF_MS = [2_000, 5_000, 10_000] as const;
/** No attempt is started with less than this left of the ceiling — it could not finish usefully. */
export const CONTROLLER_AI_MIN_ATTEMPT_MS = 15_000;

export type ControllerAiSettings = { -readonly [K in keyof typeof CONTROLLER_AI_DEFAULTS]: number };

export interface ControllerAiPolicy {
	preContentMs: number;
	silenceMs: number;
	ceilingMs: number;
	maxAttempts: number;
	backoffMs: readonly number[];
}

export function policyFrom(settings: Partial<ControllerAiSettings> = {}): ControllerAiPolicy {
	const s = { ...CONTROLLER_AI_DEFAULTS, ...settings };
	return { preContentMs: s.preContentSeconds * 1000, silenceMs: s.silenceSeconds * 1000, ceilingMs: s.decisionCeilingSeconds * 1000, maxAttempts: CONTROLLER_AI_MAX_ATTEMPTS, backoffMs: CONTROLLER_AI_BACKOFF_MS };
}

/** Validate an owner's settings patch: integers inside the bounds, known keys only. `null` clears a key. */
export function sanitizeControllerAiSettings(raw: unknown): { ok: true; patch: Partial<Record<keyof ControllerAiSettings, number | null>> } | { ok: false; error: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send an object with preContentSeconds, silenceSeconds and/or decisionCeilingSeconds." };
	const patch: Partial<Record<keyof ControllerAiSettings, number | null>> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!(key in CONTROLLER_AI_BOUNDS)) return { ok: false, error: `Unknown setting "${key}". Known: ${Object.keys(CONTROLLER_AI_BOUNDS).join(", ")}.` };
		const k = key as keyof ControllerAiSettings;
		if (value === null) {
			patch[k] = null;
			continue;
		}
		const [min, max] = CONTROLLER_AI_BOUNDS[k];
		if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return { ok: false, error: `${key} must be a whole number of seconds from ${min} to ${max}.` };
		patch[k] = value;
	}
	return { ok: true, patch };
}

/** The instance's stored settings (`agent_instances.config.controllerAi`), invalid values ignored. */
export async function readControllerAiSettings(env: Env, instanceId: string, userId: string): Promise<Partial<ControllerAiSettings>> {
	try {
		const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ config: string | null }>();
		const stored = (JSON.parse(row?.config || "{}") as { controllerAi?: unknown }).controllerAi;
		if (!stored || typeof stored !== "object") return {};
		const out: Partial<ControllerAiSettings> = {};
		for (const [k, [min, max]] of Object.entries(CONTROLLER_AI_BOUNDS) as Array<[keyof ControllerAiSettings, readonly [number, number]]>) {
			const v = (stored as Record<string, unknown>)[k];
			if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) out[k] = v;
		}
		return out;
	} catch {
		return {};
	}
}

export async function readControllerAiPolicy(env: Env, instanceId: string | undefined, userId: string): Promise<ControllerAiPolicy> {
	return policyFrom(instanceId ? await readControllerAiSettings(env, instanceId, userId) : {});
}

/** Store a validated patch, merging with what is there (`null` removes a key → back to its default). */
export async function writeControllerAiSettings(env: Env, instanceId: string, userId: string, patch: Partial<Record<keyof ControllerAiSettings, number | null>>): Promise<Partial<ControllerAiSettings>> {
	const current = await readControllerAiSettings(env, instanceId, userId);
	const next: Record<string, number> = { ...current };
	for (const [k, v] of Object.entries(patch)) {
		if (v === null) delete next[k];
		else if (typeof v === "number") next[k] = v;
	}
	await patchInstanceConfig(env, instanceId, userId, "controllerAi", next);
	return next as Partial<ControllerAiSettings>;
}

/** Tests only: replace the backoff wait (the `setClonePollDelayForTest` pattern). `null` restores real time. */
let testSleep: ((ms: number) => Promise<void>) | null = null;
export function setControllerAiSleepForTest(fn: ((ms: number) => Promise<void>) | null): void {
	testSleep = fn;
}

// The tool-args marker (#907): a stream that stopped mid tool call is the provider stopping mid-reply.
// Without it that failure passed straight through, and the bounded recovery below never retried it.
const STALL_MARKERS = ["did not begin replying", "stopped sending mid-reply", "ended mid-reply", INCOMPLETE_TOOL_ARGS_MARKER];

/** A provider stall — the only failure this recovers. Anything else passes through. */
export function isControllerAiStall(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if ((err as { retryable?: boolean }).retryable === false) return false;
	return STALL_MARKERS.some((m) => err.message.includes(m)) || (err as { streamPhase?: unknown }).streamPhase !== undefined;
}

export type ControllerSurface = "pilot" | "loop" | "copilot";

/** One stall, as recorded. Sanitized by construction: handles and measurements, no content. */
export interface StallTelemetry {
	surface: ControllerSurface;
	provider: string | null;
	model: string | null;
	attempt: number;
	maxAttempts: number;
	phase: StreamPhase | null;
	backoffMs: number | null;
	elapsedMs: number;
	preContentMs: number;
	silenceMs: number;
	ceilingMs: number;
}

export type RecoveryOutcome = "recovered" | "exhausted" | "ceiling" | "cancelled";

/**
 * The controller ran out of recovery. The message is the owner's sentence: what failed, what did not,
 * what was tried, and the next step. It also carries a stall marker so the run-level classifier files
 * it as `provider_stall` — a resumable provider fact, never a CLI, credit, runner or code failure.
 */
export class ControllerAiStalled extends Error {
	constructor(
		readonly attempts: number,
		readonly reason: "exhausted" | "ceiling",
		readonly elapsedMs: number,
		readonly phases: Array<StreamPhase | null>,
	) {
		const where = phases.map((p) => (p ? (p.contentStarted ? "mid-reply" : "before any content") : "unmeasured")).join(", ");
		super(
			`The controller's AI provider stalled on ${attempts} attempt${attempts === 1 ? "" : "s"} over ${Math.round(elapsedMs / 1000)}s (${where || "no attempt completed"}) and ${reason === "ceiling" ? "the decision's recovery ceiling was reached" : "the retries for this decision are spent"} — it stopped sending mid-reply or never began. The coding CLI, the runner and the repository were not involved, and no partial decision was sent to the engine. The objective and its queue are kept; the run resumes or can be continued once the provider responds.`,
		);
		this.name = "ControllerAiStalled";
	}
}

export class ControllerAiCancelled extends Error {
	constructor(readonly attempts: number) {
		super("The run was cancelled while the controller was recovering from an AI-provider stall; no further attempt was made.");
		this.name = "ControllerAiCancelled";
	}
}

export interface RecoveryDeps {
	surface: ControllerSurface;
	isCancelled?: () => Promise<boolean>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** Sanitized telemetry sink — one call per stall, one for the outcome when any stall happened. */
	emit?: (event: "stall" | RecoveryOutcome, data: StallTelemetry | (Omit<StallTelemetry, "phase" | "backoffMs"> & { outcome: RecoveryOutcome })) => Promise<void> | void;
}

/**
 * Run `call` under the policy. `call` receives the deadlines for THIS attempt (clamped to the time
 * left) and the attempt number, and must make exactly one provider request.
 */
export async function withControllerAiRecovery<T>(policy: ControllerAiPolicy, deps: RecoveryDeps, call: (deadlines: StreamDeadlines, attempt: number) => Promise<T>): Promise<T> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? testSleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const start = now();
	const phases: Array<StreamPhase | null> = [];
	let provider: string | null = null;
	let model: string | null = null;
	const base = () => ({ surface: deps.surface, provider, model, maxAttempts: policy.maxAttempts, elapsedMs: now() - start, preContentMs: policy.preContentMs, silenceMs: policy.silenceMs, ceilingMs: policy.ceilingMs });
	const finish = async (outcome: RecoveryOutcome, attempt: number) => {
		if (phases.length) await Promise.resolve(deps.emit?.(outcome, { ...base(), attempt, outcome })).catch(() => undefined);
	};
	for (let attempt = 1; ; attempt++) {
		if (await deps.isCancelled?.().catch(() => false)) {
			await finish("cancelled", attempt - 1);
			throw new ControllerAiCancelled(attempt - 1);
		}
		const remaining = policy.ceilingMs - (now() - start);
		if (attempt > 1 && remaining < CONTROLLER_AI_MIN_ATTEMPT_MS) {
			await finish("ceiling", attempt - 1);
			throw new ControllerAiStalled(attempt - 1, "ceiling", now() - start, phases);
		}
		try {
			const result = await call({ preContentMs: Math.min(policy.preContentMs, remaining), silenceMs: policy.silenceMs, totalMs: Math.max(1, remaining) }, attempt);
			await finish("recovered", attempt);
			return result;
		} catch (err) {
			if (!isControllerAiStall(err)) throw err;
			const e = err as { streamPhase?: StreamPhase; provider?: string; model?: string };
			provider = e.provider ?? provider;
			model = e.model ?? model;
			phases.push(e.streamPhase ?? null);
			const last = attempt >= policy.maxAttempts;
			const backoffMs = last ? null : (policy.backoffMs[attempt - 1] ?? policy.backoffMs[policy.backoffMs.length - 1] ?? 0);
			await Promise.resolve(deps.emit?.("stall", { ...base(), attempt, phase: e.streamPhase ?? null, backoffMs })).catch(() => undefined);
			if (last) {
				await finish("exhausted", attempt);
				throw new ControllerAiStalled(attempt, "exhausted", now() - start, phases);
			}
			if (now() - start + (backoffMs ?? 0) + CONTROLLER_AI_MIN_ATTEMPT_MS > policy.ceilingMs) {
				await finish("ceiling", attempt);
				throw new ControllerAiStalled(attempt, "ceiling", now() - start, phases);
			}
			await sleep(backoffMs ?? 0);
		}
	}
}

/**
 * The one entry point every controller uses: the instance's policy, the trace as the telemetry sink,
 * and the recovery loop. `call` gets this attempt's stream deadlines — pass them as `streamDeadlines`.
 */
export async function controllerAiCall<T>(
	env: Env,
	ctx: { userId: string; instanceId?: string; traceId?: string | null; surface: ControllerSurface; isCancelled?: () => Promise<boolean>; policy?: ControllerAiPolicy; sleep?: (ms: number) => Promise<void> },
	call: (deadlines: StreamDeadlines, attempt: number) => Promise<T>,
): Promise<T> {
	const policy = ctx.policy ?? (await readControllerAiPolicy(env, ctx.instanceId, ctx.userId));
	return withControllerAiRecovery(policy, { surface: ctx.surface, isCancelled: ctx.isCancelled, sleep: ctx.sleep, emit: (event, data) => recordControllerAiEvent(env, ctx, event, { ...data }) }, call);
}

/** Sanitized: handles and measurements only — no prompt, reply, key or pane text ever reaches here. */
async function recordControllerAiEvent(env: Env, ctx: { userId: string; instanceId?: string; traceId?: string | null }, event: "stall" | RecoveryOutcome, data: Record<string, unknown>): Promise<void> {
	const what = event === "stall" ? `controller AI provider stalled (attempt ${data.attempt} of ${data.maxAttempts})` : `controller AI recovery ${event} after ${data.attempt} attempt(s)`;
	await logEvent(env, { source: "controller-ai", event: `controller_ai.${event}`, level: event === "stall" || event === "recovered" ? "warn" : event === "cancelled" ? "info" : "error", message: what, userId: ctx.userId, instanceId: ctx.instanceId ?? null, traceId: ctx.traceId ?? null, context: data }).catch(() => undefined);
}
