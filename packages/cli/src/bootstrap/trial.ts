/**
 * A freshly installed CLI is on TRIAL until it proves it runs (#1141).
 *
 * On 2026-10-17 two machines went dark mid auto-update to 0.4.149: the stub moved onto the new
 * payload, it never heartbeated, and nothing moved back — `runner_restart` could not reach a machine
 * whose runner was not running, and the owner was remote. The payload cache already keeps the
 * previous version beside the new one (#862); this is what lets the stub fall back to it.
 *
 *   - An install records a trial for the new version, naming the one it replaces.
 *   - The first START of that version stamps the trial's clock; a payload installed and then held
 *     back by busy work is not judged by its install time.
 *   - The payload clears the trial once its relay registers with the platform ({@link markPayloadHealthy}).
 *   - A trial version that crashes on import, has been started {@link MAX_TRIAL_STARTS} times, or is
 *     still unproven after {@link TRIAL_MS} of RUNNING is marked BAD: the stub never picks it
 *     again, never re-fetches it, and leaves a rollback notice the previous version reports.
 *   - The window is AWAKE time (#1382). A laptop that sleeps through it — pink slept 590 s of a 300 s window, 8 seconds
 *     after the restart — was failed for time it never spent running, and rolled back a healthy release. The trial records
 *     what it observed (a tick every {@link TRIAL_TICK_MS}) and counts a gap longer than {@link TRIAL_SLEEP_GAP_MS} as the
 *     machine being asleep, not as the release failing to register. A genuinely broken release is still bounded: a
 *     wall-clock limit of {@link TRIAL_MAX_WALL_MS} from its first start, and the start-count limit, are unchanged.
 *
 * Node builtins ONLY, like payload.ts: the stub imports this, so it must never need replacing.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How long a trial version has, of time it was actually running, to register with the platform. */
export const TRIAL_MS = 5 * 60_000;
/** How often a running trial records that it is still being observed. */
export const TRIAL_TICK_MS = 15_000;
/** A silence longer than this between two observations is the machine asleep (or the process suspended), not time the release ran. */
export const TRIAL_SLEEP_GAP_MS = 3 * TRIAL_TICK_MS;
/** The finite bound on a release that never registers, however much of it the machine spent asleep. */
export const TRIAL_MAX_WALL_MS = 60 * 60_000;
/** Starts of an unproven version (`pags up` and its `runner connect` both count) before it is given up on. */
export const MAX_TRIAL_STARTS = 6;

export interface Trial {
	version: string;
	/** The version it replaced — the one a rollback lands on when it is still cached. */
	previous: string | null;
	installedAt: number;
	/** The first start of `version`; absent until it has been started once. */
	startedAt?: number;
	starts: number;
	/** Time the trial has actually been observed running (#1382). Absent on a record written before this was kept. */
	awakeMs?: number;
	/** Time the machine was observed asleep during the trial — kept so the receipt can say so (#1382). */
	sleptMs?: number;
	/** The last time the trial was observed, as above. */
	seenAt?: number;
}

export interface RollbackNotice {
	from: string;
	to: string | null;
	reason: string;
	at: number;
}

const trialPath = (root: string) => join(root, ".trial.json");
const badPath = (root: string) => join(root, ".bad.json");
const noticePath = (root: string) => join(root, ".rollback.json");
const activatedPath = (root: string) => join(root, ".activated.json");

/** A probed candidate remains staged until the update bridge's final policy and work check. */
export function activatedVersion(root: string): string | null {
	const record = readJson(activatedPath(root)) as { version?: unknown } | null;
	return typeof record?.version === "string" ? record.version : null;
}

export function activatePayload(root: string, version: string): void {
	if (!/^(\d+)\.(\d+)\.(\d+)/.test(version)) throw new Error("invalid CLI version to activate");
	writeJson(root, activatedPath(root), { version, at: Date.now() });
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

/** Write-then-rename, so a crash mid-write never leaves a record the stub misreads. */
function writeJson(root: string, path: string, value: unknown): void {
	mkdirSync(root, { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(value));
	renameSync(temp, path);
}

export function readTrial(root: string): Trial | null {
	const t = readJson(trialPath(root)) as Partial<Trial> | null;
	if (!t || typeof t.version !== "string" || typeof t.installedAt !== "number") return null;
	return {
		version: t.version,
		previous: typeof t.previous === "string" ? t.previous : null,
		installedAt: t.installedAt,
		...(typeof t.startedAt === "number" ? { startedAt: t.startedAt } : {}),
		starts: typeof t.starts === "number" && t.starts >= 0 ? t.starts : 0,
		...(typeof t.awakeMs === "number" && t.awakeMs >= 0 ? { awakeMs: t.awakeMs } : {}),
		...(typeof t.sleptMs === "number" && t.sleptMs >= 0 ? { sleptMs: t.sleptMs } : {}),
		...(typeof t.seenAt === "number" ? { seenAt: t.seenAt } : {}),
	};
}

/** Put `version` on trial. Best-effort: a cache that cannot be written leaves the old behaviour, never a broken start. */
export function beginTrial(root: string, version: string, previous: string | null, now = Date.now()): void {
	if (version === previous) return;
	try {
		writeJson(root, trialPath(root), { version, previous, installedAt: now, starts: 0 } satisfies Trial);
	} catch {
		/* best-effort: without a record the stub simply runs the newest payload, as before #1141 */
	}
}

/** The versions given up on, with why. */
export function badVersions(root: string): Record<string, string> {
	const raw = readJson(badPath(root)) as { versions?: Record<string, unknown> } | null;
	const out: Record<string, string> = {};
	for (const [v, why] of Object.entries(raw?.versions ?? {})) if (typeof why === "string") out[v] = why;
	return out;
}

/** Where each given-up version fell back to and when (#1150); absent for a mark written before this was kept. */
export function badDetails(root: string): Record<string, { to: string | null; at: number | null }> {
	const raw = readJson(badPath(root)) as { details?: Record<string, { to?: unknown; at?: unknown }> } | null;
	const out: Record<string, { to: string | null; at: number | null }> = {};
	for (const [v, d] of Object.entries(raw?.details ?? {})) out[v] = { to: typeof d?.to === "string" ? d.to : null, at: typeof d?.at === "number" ? d.at : null };
	return out;
}

/**
 * Give up on `version`: never picked or fetched again, its trial ended, and a notice left for the
 * version that runs next to report (`to` is what the stub falls back to, when it knows).
 */
export function markBad(root: string, version: string, reason: string, to: string | null, now = Date.now(), opts: { notice?: boolean } = {}): void {
	try {
		writeJson(root, badPath(root), { versions: { ...badVersions(root), [version]: reason.slice(0, 300) }, details: { ...badDetails(root), [version]: { to, at: now } } });
		// A release refused BEFORE it ever ran here (#1148) has nothing to roll back from: no notice for the next start to report.
		if (opts.notice !== false) writeJson(root, noticePath(root), { from: version, to, reason: reason.slice(0, 300), at: now } satisfies RollbackNotice);
		if (readTrial(root)?.version === version) rmSync(trialPath(root), { force: true });
	} catch {
		/* best-effort, as above */
	}
}

/**
 * Forget that `version` was given up on, so it can be installed on trial again (#1150): the owner's "try it again", for a failure
 * that was environmental or has been fixed on the machine. Only the bad mark goes; a rollback notice already recorded stays as history.
 * Returns whether there was a mark to clear.
 */
export function clearBad(root: string, version: string): boolean {
	const bad = badVersions(root);
	if (!(version in bad)) return false;
	delete bad[version];
	const details = badDetails(root);
	delete details[version];
	try {
		writeJson(root, badPath(root), { versions: bad, details });
		return true;
	} catch {
		return false;
	}
}

/** The payload proved itself: its relay registered. Clears its trial; anything else is untouched. */
export function markPayloadHealthy(root: string, version: string): boolean {
	const trial = readTrial(root);
	if (trial?.version !== version) return false;
	rmSync(trialPath(root), { force: true });
	return true;
}

/** The rollback notice WITHOUT clearing it: the watchdog reports it, the version that runs next still takes it. */
export function peekRollbackNotice(root: string): RollbackNotice | null {
	const n = readJson(noticePath(root)) as Partial<RollbackNotice> | null;
	if (!n || typeof n.from !== "string" || typeof n.reason !== "string") return null;
	return { from: n.from, to: typeof n.to === "string" ? n.to : null, reason: n.reason, at: typeof n.at === "number" ? n.at : 0 };
}

/** Read and clear the rollback notice — reported once, by whichever version runs next. */
export function takeRollbackNotice(root: string): RollbackNotice | null {
	const n = readJson(noticePath(root)) as Partial<RollbackNotice> | null;
	rmSync(noticePath(root), { force: true });
	if (!n || typeof n.from !== "string" || typeof n.reason !== "string") return null;
	return { from: n.from, to: typeof n.to === "string" ? n.to : null, reason: n.reason, at: typeof n.at === "number" ? n.at : 0 };
}

export type TrialVerdict = { kind: "none" } | { kind: "trial"; trial: Trial } | { kind: "give-up"; reason: string };

/** What the clock says about a trial observed at `now`: time awake, time asleep, and when it was last seen. Pure. */
export function accrueTrial(trial: Trial, now: number): { awakeMs: number; sleptMs: number; seenAt: number; sleptNow: number } {
	if (trial.startedAt === undefined) return { awakeMs: 0, sleptMs: 0, seenAt: now, sleptNow: 0 };
	const seen = trial.seenAt ?? trial.startedAt;
	const gap = Math.max(0, now - seen);
	const awake = trial.awakeMs ?? 0;
	const slept = trial.sleptMs ?? 0;
	// A normal tick is a short gap: all of it ran. A long silence was the machine asleep: one tick of it ran, the rest was not running.
	if (gap <= TRIAL_SLEEP_GAP_MS) return { awakeMs: awake + gap, sleptMs: slept, seenAt: now, sleptNow: 0 };
	return { awakeMs: awake + TRIAL_TICK_MS, sleptMs: slept + (gap - TRIAL_TICK_MS), seenAt: now, sleptNow: gap - TRIAL_TICK_MS };
}

const minutes = (ms: number) => Math.round(ms / 60_000);

/** Has the trial run out — of awake time, or of the wall-clock bound? The reason says which, and how much of it was sleep. */
export function trialExpiry(trial: Trial, now: number): { reason: string } | null {
	const a = accrueTrial(trial, now);
	const sleep = a.sleptMs >= 60_000 ? ` (the machine slept about ${minutes(a.sleptMs)} minute${minutes(a.sleptMs) === 1 ? "" : "s"} of that; sleep does not count against it)` : "";
	if (a.awakeMs >= TRIAL_MS) return { reason: `it did not register with the platform within ${TRIAL_MS / 60_000} minutes of running${sleep}` };
	if (trial.startedAt !== undefined && now - trial.startedAt >= TRIAL_MAX_WALL_MS) {
		return { reason: `it had still not registered ${TRIAL_MAX_WALL_MS / 60_000} minutes after first starting (the wall-clock limit; ${minutes(a.awakeMs)} minutes of that awake${sleep ? `, the rest asleep` : ""})` };
	}
	return null;
}

/**
 * One observation of a running trial: record the awake/asleep time and say whether it has run out. Returns what the caller should
 * report — `slept` when a gap was the machine asleep (so the update log can say the clock paused), `expired` when the trial is over.
 * Does nothing for a version that is not on trial.
 */
export function advanceTrial(root: string, version: string, now = Date.now()): { expired: { reason: string } | null; slept: number } {
	const trial = readTrial(root);
	if (!trial || trial.version !== version || trial.startedAt === undefined) return { expired: null, slept: 0 };
	const a = accrueTrial(trial, now);
	const next: Trial = { ...trial, awakeMs: a.awakeMs, sleptMs: a.sleptMs, seenAt: a.seenAt };
	try {
		writeJson(root, trialPath(root), next);
	} catch {
		/* best-effort */
	}
	return { expired: trialExpiry(trial, now), slept: a.sleptNow };
}

/**
 * What a start of `version` means for its trial — and records the start. `give-up` when it is past its
 * starts or its clock; `trial` while it is still being proven; `none` when it is not on trial.
 */
export function noteTrialStart(root: string, version: string, now = Date.now()): TrialVerdict {
	const trial = readTrial(root);
	if (!trial || trial.version !== version) return { kind: "none" };
	if (trial.startedAt !== undefined) {
		// The gap since the last observation is judged like any other: asleep, not running (#1382), unless it was a short one.
		const expiry = trialExpiry(trial, now);
		if (expiry) return { kind: "give-up", reason: expiry.reason };
	}
	if (trial.starts >= MAX_TRIAL_STARTS) {
		return { kind: "give-up", reason: `it was started ${trial.starts} times without registering with the platform` };
	}
	const a = accrueTrial(trial, now);
	const next: Trial = { ...trial, startedAt: trial.startedAt ?? now, starts: trial.starts + 1, awakeMs: a.awakeMs, sleptMs: a.sleptMs, seenAt: a.seenAt };
	try {
		writeJson(root, trialPath(root), next);
	} catch {
		/* best-effort */
	}
	return { kind: "trial", trial: next };
}
