/**
 * Per-repository checkout and publication strategy (#1670) — two INDEPENDENT settings.
 *
 *   checkout: "shared"   the repo's one existing working directory (today's behaviour).
 *             "worktree" a runner-managed `git worktree` per run, created at the latest target commit.
 *   publish:  "direct"   push the run's commits to the configured target branch (today's behaviour).
 *             "pr"       push a run branch and let the cloud open a pull request for review.
 *
 * Three combinations are SUPPORTED presets; the other combination (shared/pr) is representable but
 * not offered, because a shared checkout has no per-run branch to publish. A repository with no
 * stored strategy resolves to shared/direct — exactly what every repository does today — so nothing
 * migrates and no direct-to-main repository is ever turned into a PR repository by this module.
 * Disposable clones and fork-based PRs are left as extra `checkout` / `publish` values later.
 */

export type CheckoutMode = "shared" | "worktree";
export type PublishMode = "direct" | "pr";
export type StrategyPreset = "shared-direct" | "isolated-direct" | "isolated-pr";

export interface RepoStrategy {
	checkout: CheckoutMode;
	publish: PublishMode;
}

export const PRESETS: Record<StrategyPreset, RepoStrategy> = {
	"shared-direct": { checkout: "shared", publish: "direct" },
	"isolated-direct": { checkout: "worktree", publish: "direct" },
	"isolated-pr": { checkout: "worktree", publish: "pr" },
};

/** What a repository without a stored strategy does: today's behaviour, unchanged. */
export const DEFAULT_STRATEGY: RepoStrategy = PRESETS["shared-direct"];

export function presetOf(s: RepoStrategy): StrategyPreset | null {
	return (Object.entries(PRESETS).find(([, p]) => p.checkout === s.checkout && p.publish === s.publish)?.[0] as StrategyPreset | undefined) ?? null;
}

/** A stored value of unknown shape, read as a strategy. Anything not recognised falls back to the existing behaviour, never to a new one. */
export function resolveStrategy(stored: unknown): RepoStrategy {
	if (typeof stored === "string" && stored in PRESETS) return { ...PRESETS[stored as StrategyPreset] };
	if (stored && typeof stored === "object") {
		const o = stored as Record<string, unknown>;
		const checkout: CheckoutMode = o.checkout === "worktree" ? "worktree" : "shared";
		const publish: PublishMode = o.publish === "pr" ? "pr" : "direct";
		return { checkout, publish };
	}
	return { ...DEFAULT_STRATEGY };
}

/** Reasons a requested strategy is refused (empty = supported). */
export function strategyProblems(s: RepoStrategy): string[] {
	if (s.checkout === "shared" && s.publish === "pr") return ["a shared checkout has no per-run branch to open a pull request from; choose an isolated checkout for PR publishing"];
	return [];
}
