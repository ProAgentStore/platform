import type { ChildProcess } from "node:child_process";

/** Preserve the existing bounded escalation when stopping this run's engine. */
export function killApplyEngine(child?: ChildProcess): void {
	if (!child || child.exitCode !== null) return;
	child.kill("SIGTERM");
	setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 5_000).unref?.();
}
