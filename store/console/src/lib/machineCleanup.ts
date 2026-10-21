/**
 * Runner post-run cleanup, as the machine page shows and edits it (#1265).
 *
 * A master toggle (gentle | harsh) sets the defaults of six checkboxes; each checkbox can be overridden for
 * this machine. The API is authoritative: it resolves mode + overrides into the `behaviours` it returns and
 * sends the runner, so this module never re-derives what is in force — it only decides which boxes are
 * ticked, which are overrides, and what a click should send.
 */

export type CleanupMode = "gentle" | "harsh";

/** The first CLI that carries the cleanup behaviours (mirrors the server's CLEANUP_MIN_CLI). */
export const CLEANUP_MIN_CLI = "0.4.167";

/** Does a runner of this version do what the settings below say? Unknown version → assume it does (the server is the judge). */
export function runnerSupportsCleanup(version: string | null | undefined): boolean {
	const have = (version ?? "").trim().replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10));
	if (have.length < 3 || have.some((n) => !Number.isFinite(n))) return true;
	const need = CLEANUP_MIN_CLI.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (have[i] !== need[i]) return have[i] > need[i];
	}
	return true;
}

export type CleanupKey = "processGroupKill" | "leftoverSweep" | "browserCleanup" | "tempCleanup" | "loadWarning" | "cachePruning";

export const CLEANUP_ROWS: ReadonlyArray<{ key: CleanupKey; label: string; hint: string }> = [
	{ key: "processGroupKill", label: "Kill the engine's whole process tree", hint: "On end, timeout and abort — builds, test runners, dev servers and watchers it started go with it." },
	{ key: "leftoverSweep", label: "Sweep leftover processes after a session", hint: "Gentle only reports them (and ends ones carrying the session marker); harsh also ends orphaned tooling running from runner workdirs." },
	{ key: "browserCleanup", label: "Clean up Playwright browsers", hint: "Only Playwright's own throwaway browsers and profiles. Never your Chrome." },
	{ key: "tempCleanup", label: "Delete each run's temp folder and worktrees", hint: "A worktree with uncommitted changes is left alone." },
	{ key: "loadWarning", label: "Warn when load is far above what sessions account for", hint: "The leftover-process signal. Harsh also runs a sweep." },
	{ key: "cachePruning", label: "Prune caches when the disk is over 90%", hint: "Package caches and git-ignored build outputs under runner checkouts. Off in gentle, where a warning is shown instead." },
];

/** What the mode alone turns on — mirrors the server's `behaviourDefaults`, used only to mark overrides. */
export function modeDefaults(mode: CleanupMode): Record<CleanupKey, boolean> {
	return { processGroupKill: true, leftoverSweep: true, browserCleanup: true, tempCleanup: true, loadWarning: true, cachePruning: mode === "harsh" };
}

export interface CleanupReport {
	mode: CleanupMode;
	orphanedProcesses: number;
	orphans: Array<{ pid: number; reason: string; sessionId: string | null; command: string }>;
	loadMismatch: boolean;
	unexplainedLoad: number;
	diskUsedPct: number | null;
	warnings: string[];
	lastPass: {
		at: string | null;
		reason: string;
		killedProcesses: number;
		orphansFound: number;
		browsersReaped: number;
		tempFoldersRemoved: number;
		worktreesRemoved: number;
		cachesPruned: number;
		buildOutputsRemoved: number;
		freedBytes: number | null;
	} | null;
}

export interface MachineCleanup {
	mode: CleanupMode;
	behaviours: Record<CleanupKey, boolean>;
	overrides: Partial<Record<CleanupKey, boolean>>;
	report: CleanupReport | null;
	report_at: string | null;
	now_requested_at: string | null;
	now_done_at: string | null;
}

export interface CheckboxState {
	key: CleanupKey;
	label: string;
	hint: string;
	checked: boolean;
	/** This machine's box differs from the mode's default. */
	overridden: boolean;
}

/** The six boxes as the page draws them. Falls back to gentle defaults when an older API sends no cleanup block. */
export function checkboxes(cleanup: MachineCleanup | null | undefined): CheckboxState[] {
	const mode: CleanupMode = cleanup?.mode === "harsh" ? "harsh" : "gentle";
	const defaults = modeDefaults(mode);
	return CLEANUP_ROWS.map((row) => {
		const checked = cleanup?.behaviours?.[row.key] ?? defaults[row.key];
		return { ...row, checked, overridden: checked !== defaults[row.key] };
	});
}

/** What ticking or clearing one box sends: a value that differs from the mode's default is an override; one that matches returns it to the default (null). */
export function overrideBody(mode: CleanupMode, key: CleanupKey, checked: boolean): { cleanup_overrides: Partial<Record<CleanupKey, boolean | null>> } {
	return { cleanup_overrides: { [key]: checked === modeDefaults(mode)[key] ? null : checked } };
}

export function modeBody(mode: CleanupMode): { cleanup_mode: CleanupMode } {
	return { cleanup_mode: mode };
}

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "unknown";
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
	return `${Math.round(bytes / 1024)} KB`;
}

/** "Clean now" as the page should word it: nothing asked, asked and waiting for the machine, or done. */
export function cleanNowState(cleanup: MachineCleanup | null | undefined): { pending: boolean; text: string | null } {
	const asked = cleanup?.now_requested_at ? Date.parse(cleanup.now_requested_at) : 0;
	const done = cleanup?.now_done_at ? Date.parse(cleanup.now_done_at) : 0;
	if (asked && done < asked) return { pending: true, text: "Asked — the machine runs it on its next heartbeat (within about 30 seconds if it is connected)." };
	if (done) return { pending: false, text: `Last requested pass finished ${new Date(done).toLocaleString()}.` };
	return { pending: false, text: null };
}

/** The runner's report as short lines for the page: what it found, what it left alone, what its last pass did. */
export function reportLines(report: CleanupReport | null | undefined): string[] {
	if (!report) return [];
	const lines: string[] = [];
	if (report.orphanedProcesses > 0) lines.push(`${report.orphanedProcesses} leftover process${report.orphanedProcesses === 1 ? "" : "es"} found and not touched`);
	if (report.diskUsedPct !== null) lines.push(`disk ${report.diskUsedPct}% full`);
	if (report.loadMismatch) lines.push(`load is ${report.unexplainedLoad} above what sessions account for`);
	const p = report.lastPass;
	if (p) {
		const did = [
			p.killedProcesses ? `ended ${p.killedProcesses} process${p.killedProcesses === 1 ? "" : "es"}` : "",
			p.browsersReaped ? `reaped ${p.browsersReaped} browser${p.browsersReaped === 1 ? "" : "s"}` : "",
			p.tempFoldersRemoved ? `removed ${p.tempFoldersRemoved} temp folder${p.tempFoldersRemoved === 1 ? "" : "s"}` : "",
			p.worktreesRemoved ? `removed ${p.worktreesRemoved} worktree${p.worktreesRemoved === 1 ? "" : "s"}` : "",
			p.cachesPruned ? `pruned ${p.cachesPruned} cache${p.cachesPruned === 1 ? "" : "s"}` : "",
			p.buildOutputsRemoved ? `removed ${p.buildOutputsRemoved} build output${p.buildOutputsRemoved === 1 ? "" : "s"}` : "",
			p.freedBytes ? `freed ${formatBytes(p.freedBytes)}` : "",
		].filter(Boolean);
		lines.push(`last pass (${p.reason}): ${did.length ? did.join(", ") : "nothing to clean"}`);
	}
	return lines;
}
