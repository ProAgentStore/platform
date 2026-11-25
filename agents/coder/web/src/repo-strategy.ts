/**
 * A repo's checkout + publishing preset, as the owner sees it (#1710, from #1670).
 *
 * The three presets and the default are the cloud's vocabulary (workers/api/src/lib/checkout-strategy.ts),
 * vendored here as plain strings: no cross-package import. The listing carries `effectiveStrategy` (the
 * stored preset, or shared-direct when nothing was chosen), so this module never re-derives the default
 * from a missing field.
 */
export type StrategyPreset = "shared-direct" | "isolated-direct" | "isolated-pr";

export const STRATEGY_OPTIONS: ReadonlyArray<{ value: StrategyPreset; label: string; short: string; detail: string }> = [
	{ value: "shared-direct", label: "Shared checkout, push to main", short: "Shared · direct", detail: "Works in your own checkout and pushes straight to the default branch. What every repo did before this setting existed." },
	{ value: "isolated-direct", label: "Isolated checkout, push to main", short: "Isolated · direct", detail: "Each run works in its own checkout and still publishes straight to the default branch." },
	{ value: "isolated-pr", label: "Isolated checkout, open a pull request", short: "Isolated · PR", detail: "Each run works in its own checkout and publishes through a pull request instead of pushing to main." },
];

export const DEFAULT_STRATEGY: StrategyPreset = "shared-direct";

export const STRATEGY_KEEP_NOTE = "Repos that push straight to main stay as they are unless you change this here. Only you can change it; agents cannot.";

/** The preset a repo row is on. Unknown or absent is the default, never a throw. */
export function repoStrategy(repo: { effectiveStrategy?: string; strategy?: string }): StrategyPreset {
	const v = repo.effectiveStrategy ?? repo.strategy;
	return STRATEGY_OPTIONS.some((o) => o.value === v) ? (v as StrategyPreset) : DEFAULT_STRATEGY;
}

export function strategyOption(p: StrategyPreset) {
	return STRATEGY_OPTIONS.find((o) => o.value === p) ?? STRATEGY_OPTIONS[0];
}
