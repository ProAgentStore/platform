// Per-instance iteration floor and ceiling (#820) — the owner's standing answer to "how long may
// a run on THIS agent be", enforced server-side rather than re-decided by every caller.
//
// `sanitizeMaxIterations` already clamps a request into `[1, accountCeiling]`, and its fallback
// when a caller names no number is 10. That default is the whole complaint: runs on the Coder
// instance were started at 10 over and over — by chat callers, by the console, by continuation
// flows — and died at `max_iterations` 10/10 with the work on track but unfinished (#815, #813,
// #613, #806 all ended that way). The owner asked explicitly NOT to depend on whoever starts the
// run picking a better number, which makes this a property of the instance, not of the call.
//
// Pure here, D1 in `loop-limits-store.ts`, for the reason the presets split the same way (#234):
// the arithmetic that decides how long an autonomous run may spend someone's tokens is worth
// testing without a database in the room.

/** An owner's configured bounds for one instance. Either half may be absent — most are. */
export interface LoopLimitsConfig {
	/** Clamp a request UP to this. Absent ⇒ no floor (effectively 1). */
	minIterations?: number;
	/** Clamp a request DOWN to this. Absent ⇒ the account ceiling alone applies. */
	maxIterations?: number;
	/** The longest objective a run on this instance accepts (#854). Absent ⇒ `DEFAULT_MAX_OBJECTIVE_CHARS`. */
	maxObjectiveChars?: number;
}

/**
 * How long a run's objective may be, in characters, when the owner has set nothing (#854).
 *
 * It was 2,000 — an input-hardening number from `/loop-decide` (ceb19f22) copied into every entry
 * point by #158, bounding no column (both are TEXT) and no model window. What it does bound is the
 * Pilot's system prompt, which carries the objective whole on EVERY decision beside ~4.4k chars of
 * rules, a 6k-char terminal pane and the step log. 8,000 chars (~2k tokens) keeps that worst case
 * near 7k tokens — inside the tightest brain model (Llama 3.3's 24k window, #852) with room left
 * for the 2,048-token reply — and fits an issue's acceptance criteria plus a refinement.
 */
export const DEFAULT_MAX_OBJECTIVE_CHARS = 8_000;

/**
 * The range an owner may set `maxObjectiveChars` to. The ceiling is the same arithmetic taken to
 * its limit: 20k chars (~5k tokens) still leaves the smallest window room for the pane and reply.
 * It is also what every store slices to, so nothing an instance accepts is ever cut afterwards.
 */
export const MIN_CONFIGURABLE_OBJECTIVE_CHARS = 100;
export const MAX_CONFIGURABLE_OBJECTIVE_CHARS = 20_000;

/** The objective cap in force on an instance. */
export function effectiveMaxObjectiveChars(config: LoopLimitsConfig): number {
	return config.maxObjectiveChars ?? DEFAULT_MAX_OBJECTIVE_CHARS;
}

/** The cap in force and the range it may be set to — what the loop-limits routes report beside the iteration bounds. */
export function objectiveCapView(config: LoopLimitsConfig) {
	return {
		maxObjectiveChars: effectiveMaxObjectiveChars(config),
		objectiveChars: { default: DEFAULT_MAX_OBJECTIVE_CHARS, min: MIN_CONFIGURABLE_OBJECTIVE_CHARS, max: MAX_CONFIGURABLE_OBJECTIVE_CHARS },
	};
}

/**
 * Why `objective` is refused, or null. States both numbers, so a caller can fix it in one try —
 * the bare "objective too long" named neither the limit nor how far over it was.
 */
export function objectiveTooLong(objective: string, limit: number): string | null {
	return objective.length > limit ? `objective too long: ${objective.length} chars, limit ${limit}` : null;
}

/**
 * The widest either bound may be set to. Deliberately the same number
 * `delegation-budget-store.ts` allows `loop_max_iterations` to reach, so an instance bound can
 * always express its account's ceiling — a floor it could not reach would be unsettable for an
 * account whose ceiling had been raised.
 */
export const MAX_CONFIGURABLE_ITERATIONS = 1_000;

/**
 * The Pilot's own per-round cap when a caller names no number — `workflows/coding-session.ts`
 * passes `maxSteps ?? PILOT_DEFAULT_MAX_STEPS`. Named here because the coding driver has to clamp
 * THAT number, not `sanitizeMaxIterations`'s fallback of 10, when the caller supplied nothing:
 * see `boundedMaxSteps` in `loop-drivers.ts` for why the two differ.
 */
export const PILOT_DEFAULT_MAX_STEPS = 40;

/**
 * Coerce anything — a PUT body, a hand-edited config blob — into bounds that can be enforced.
 *
 * Total by construction: this also runs on READ, and a config somebody edited by hand into
 * nonsense must degrade to "no limits configured" rather than throw on the start path and take
 * the instance's Loop button down with it.
 *
 * An INVERTED pair (`min` above `max`) is normalised by pulling the floor down to the ceiling
 * rather than dropping either. Dropping the floor would silently grant longer runs than the owner
 * asked for; dropping the ceiling would silently grant more spend. Lowering the floor is the only
 * repair that cannot exceed a number the owner actually wrote. The route hands the stored result
 * straight back, so the repair is visible rather than inferred.
 */
export function sanitizeLoopLimitsConfig(raw: unknown): LoopLimitsConfig {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const min = bound(r.minIterations);
	const max = bound(r.maxIterations);
	const out: LoopLimitsConfig = {};
	if (max !== undefined) out.maxIterations = max;
	if (min !== undefined) out.minIterations = max !== undefined ? Math.min(min, max) : min;
	const chars = objectiveBound(r.maxObjectiveChars);
	if (chars !== undefined) out.maxObjectiveChars = chars;
	return out;
}

function objectiveBound(raw: unknown): number | undefined {
	const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
	if (!Number.isFinite(n) || n < 1) return undefined;
	return Math.max(MIN_CONFIGURABLE_OBJECTIVE_CHARS, Math.min(MAX_CONFIGURABLE_OBJECTIVE_CHARS, Math.floor(n)));
}

/**
 * A PUT body applied to what is stored (#854). The iteration pair keeps its original meaning — the
 * body REPLACES it, and naming neither clears it — unless the body only speaks about the objective
 * cap, which must not wipe iteration bounds the owner set in another call. `maxObjectiveChars` is a
 * patch of its own: absent keeps it, `null`/`0` returns it to the default. An empty body clears all.
 */
export function mergeLoopLimits(stored: LoopLimitsConfig, raw: unknown): LoopLimitsConfig {
	const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const speaksIterations = body.minIterations !== undefined || body.maxIterations !== undefined;
	const speaksObjective = "maxObjectiveChars" in body;
	const iterations = speaksIterations || !speaksObjective ? body : stored;
	const chars = speaksObjective ? body.maxObjectiveChars : Object.keys(body).length ? stored.maxObjectiveChars : undefined;
	return sanitizeLoopLimitsConfig({ minIterations: iterations.minIterations, maxIterations: iterations.maxIterations, maxObjectiveChars: chars });
}

function bound(raw: unknown): number | undefined {
	const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
	if (!Number.isFinite(n)) return undefined;
	const i = Math.floor(n);
	if (i < 1) return undefined;
	return Math.min(i, MAX_CONFIGURABLE_ITERATIONS);
}

/** True when the owner has configured either bound — the caller-supplied default should yield. */
export function hasLoopLimits(config: LoopLimitsConfig): boolean {
	return config.minIterations !== undefined || config.maxIterations !== undefined;
}

/**
 * Apply the instance's bounds to an already-account-clamped request.
 *
 * THE ACCOUNT CEILING ALWAYS WINS. An instance `maxIterations` may only narrow it, and the floor
 * is itself clamped to whatever ceiling survives that — otherwise a floor of 30 on an account
 * whose ceiling is 20 would be a per-instance setting that walks straight through an account-wide
 * spend bound (#477), which is the one thing this feature must not become. `#820` says as much:
 * the account ceiling is out of scope.
 *
 * Note the floor is applied LAST and is therefore what a caller passing nothing actually gets —
 * that is the point of the feature, not a side effect.
 */
export function clampIterations(requested: number, config: LoopLimitsConfig, accountCeiling: number): number {
	const ceiling = Number.isFinite(accountCeiling)
		? Math.max(1, Math.min(MAX_CONFIGURABLE_ITERATIONS, Math.floor(accountCeiling)))
		: MAX_CONFIGURABLE_ITERATIONS;
	const effectiveCeiling = Math.min(config.maxIterations ?? ceiling, ceiling);
	const effectiveFloor = Math.min(config.minIterations ?? 1, effectiveCeiling);
	// A non-finite request lands on the floor rather than on 1: "unreadable" and "unspecified" are
	// the same thing to an owner who configured a minimum precisely so neither would mean 10.
	if (!Number.isFinite(requested)) return effectiveFloor;
	return Math.max(effectiveFloor, Math.min(effectiveCeiling, Math.floor(requested)));
}
