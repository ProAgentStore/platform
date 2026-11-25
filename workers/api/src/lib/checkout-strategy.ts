/**
 * Per-repository checkout and publication strategy (#1670) — the cloud half of the vocabulary.
 *
 * Two independent settings (checkout: shared | worktree, publish: direct | pr) exposed as exactly three
 * presets. The runner-side module `packages/browser-runner/src/coding/checkout-strategy.ts` is the same
 * table, vendored rather than imported (no cross-package runtime dependency); keep the two in step.
 *
 * Nothing stored means shared/direct — what every repository does today. This module never converts a
 * repository to anything: an unrecognised STORED value falls back to the existing behaviour, and an
 * unrecognised REQUESTED value is refused at the door.
 */

export type CheckoutMode = "shared" | "worktree";
export type PublishMode = "direct" | "pr";
export type StrategyPreset = "shared-direct" | "isolated-direct" | "isolated-pr";

export interface RepoStrategy {
	checkout: CheckoutMode;
	publish: PublishMode;
}

export const STRATEGY_PRESETS: Record<StrategyPreset, RepoStrategy> = {
	"shared-direct": { checkout: "shared", publish: "direct" },
	"isolated-direct": { checkout: "worktree", publish: "direct" },
	"isolated-pr": { checkout: "worktree", publish: "pr" },
};

export const DEFAULT_STRATEGY_PRESET: StrategyPreset = "shared-direct";

const isPreset = (v: unknown): v is StrategyPreset => typeof v === "string" && Object.hasOwn(STRATEGY_PRESETS, v);

/** The stored column, read. Absent or unrecognised is "nothing chosen" (undefined), never a throw. */
export function parseStrategy(raw: string | null | undefined): StrategyPreset | undefined {
	return isPreset(raw) ? raw : undefined;
}

/** What a repository actually does: its stored preset, else today's shared/direct. */
export function resolveRepoStrategy(stored: StrategyPreset | undefined): RepoStrategy {
	return { ...STRATEGY_PRESETS[stored ?? DEFAULT_STRATEGY_PRESET] };
}

/** A requested value at the API door: one of the three presets, or `null` to clear back to the default. */
export function sanitizeStrategy(raw: unknown): { ok: true; value: StrategyPreset | null } | { ok: false; error: string } {
	if (raw === null) return { ok: true, value: null };
	if (isPreset(raw)) return { ok: true, value: raw };
	return { ok: false, error: `strategy must be one of: ${Object.keys(STRATEGY_PRESETS).join(", ")} (or null to return to shared-direct)` };
}
