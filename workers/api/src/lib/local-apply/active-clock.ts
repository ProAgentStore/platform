import type { ApplyRun } from "./store.js";

/** Wall time while paused is not browser execution, including across restarts or trace truncation. */
export function activeApplyMilliseconds(run: ApplyRun, now: number): number {
	const elapsed = run.activeElapsedMs ?? 0;
	return elapsed + (run.status === "running" ? Math.max(0, now - (run.activeStartedAt ?? run.startedAt ?? run.createdAt)) : 0);
}
