/**
 * `pags up --replace` — stopping the runner that is already here, deliberately (#896).
 *
 * The rule the issue states and this file implements: **never kill another user process by
 * default.** Replacement is explicit, it is asked for rather than imposed, and it is refused in
 * the two cases where taking the machine would destroy something:
 *
 *  - **work is running on the holder.** A runner restart is not cheap here. Its `close()` stops
 *    every local runtime it owns: a Claude coding session survives (it is re-spawned with
 *    `--resume`), but a Codex or Grok turn, a local browser research run, an Application Tailor run
 *    and an Application Runner fill are all LOST, and the cloud only notices minutes later. So
 *    `--replace` asks the holder what it is doing and refuses while anything is live, listing what
 *    would be lost; `--replace --now` is the owner saying it anyway.
 *  - **the holder is a service.** launchd/systemd would restart it seconds later and the two would
 *    fight, so the answer is to stop the unit, not to replace the process.
 *
 * The shutdown is authorised by the `nonce` in the mode-600 lock file: only a process that can read
 * the owner's own lock can ask the holder to stop. It is never sent to the cloud.
 */
import type { RunnerLockFile } from "./runner-lock.js";
import { pidAlive } from "./runner-lock.js";

/** What the holder says it is doing, from its own `/health`. */
export interface HolderWork {
	codingTurns: number;
	localRuns: number;
	/** The named pieces of work, for the refusal to list. */
	detail: string[];
}

export interface ReplaceDeps {
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	alive?: (pid: number) => boolean;
	now?: () => number;
}

export interface ReplaceOutcome {
	ok: boolean;
	lines: string[];
}

/** How long the holder gets to drain and exit before `--replace` gives up. */
export const REPLACE_EXIT_TIMEOUT_MS = 30_000;

/** "1 research run (Job Search Scout), 1 Codex turn" — what `--now` would throw away. */
export function describeWork(work: HolderWork): string {
	if (work.detail.length) return work.detail.join(", ");
	const parts: string[] = [];
	if (work.codingTurns) parts.push(`${work.codingTurns} coding turn${work.codingTurns === 1 ? "" : "s"}`);
	if (work.localRuns) parts.push(`${work.localRuns} local run${work.localRuns === 1 ? "" : "s"}`);
	return parts.join(", ") || "work";
}

export const hasWork = (work: HolderWork | null): boolean => !!work && work.codingTurns + work.localRuns > 0;

/**
 * Decide whether a replace may proceed, from facts alone. PURE, so the rule is testable without a
 * process to stop: the refusals are the product behaviour, not the HTTP.
 */
export function replaceVerdict(lock: RunnerLockFile, work: HolderWork | null, opts: { now?: boolean }): { allowed: boolean; lines: string[] } {
	if (lock.launch === "service") {
		return {
			allowed: false,
			lines: [
				`That runner is managed by a background service${lock.launchDetail ? ` (${lock.launchDetail})` : ""}, so replacing it would only make the service start it again.`,
				"Stop its launchd/systemd unit instead, then run `pags up` here.",
			],
		};
	}
	if (hasWork(work) && !opts.now) {
		return {
			allowed: false,
			lines: [
				`That runner is busy: ${describeWork(work as HolderWork)}.`,
				"Stopping it now would lose that work — a Codex or Grok turn, a research run, a tailoring run or an application fill do not survive a restart.",
				"Wait for it to finish, or run `pags up --replace --now` to stop it anyway.",
			],
		};
	}
	return { allowed: true, lines: [] };
}

/** Ask the holder what it is doing. A holder too old to answer reports nothing, and is replaceable. */
export async function holderWork(lock: RunnerLockFile, deps: ReplaceDeps = {}): Promise<HolderWork | null> {
	if (!lock.port) return null;
	try {
		const res = await (deps.fetchImpl ?? fetch)(`http://127.0.0.1:${lock.port}/health`, { headers: lock.runnerToken ? { Authorization: `Bearer ${lock.runnerToken}` } : {}, signal: AbortSignal.timeout(5000) });
		if (!res.ok) return null;
		const body = (await res.json()) as { work?: { codingTurns?: unknown; localRuns?: unknown; detail?: unknown } };
		const w = body.work;
		if (!w) return null;
		const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
		return { codingTurns: n(w.codingTurns), localRuns: n(w.localRuns), detail: (Array.isArray(w.detail) ? w.detail : []).filter((x): x is string => typeof x === "string").slice(0, 10) };
	} catch {
		return null;
	}
}

/**
 * Stop the holder and wait for it to go.
 *
 * It is asked, not killed: `POST /control/shutdown` with the lock's nonce. The holder drains its
 * in-flight commands, closes its relay sockets with a code that says it was replaced locally,
 * releases its lock and exits. If it has not gone within {@link REPLACE_EXIT_TIMEOUT_MS} we say so
 * and stop — this command never escalates to a signal on its own.
 */
export async function replaceHolder(lock: RunnerLockFile, opts: { now?: boolean } = {}, deps: ReplaceDeps = {}): Promise<ReplaceOutcome> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const alive = deps.alive ?? pidAlive;
	const now = deps.now ?? Date.now;

	const work = await holderWork(lock, deps);
	const verdict = replaceVerdict(lock, work, opts);
	if (!verdict.allowed) return { ok: false, lines: verdict.lines };

	if (!lock.port) {
		return { ok: false, lines: [`The runner holding this machine (pid ${lock.pid}) does not say which port it is on, so it cannot be asked to stop.`, "Stop it where it is running, then try again."] };
	}
	try {
		const res = await fetchImpl(`http://127.0.0.1:${lock.port}/control/shutdown`, {
			method: "POST",
			// The runner authorises every request, and the nonce authorises THIS one: the token says
			// "I may talk to you", the nonce says "I hold your lock" (#896).
			headers: { "Content-Type": "application/json", ...(lock.runnerToken ? { Authorization: `Bearer ${lock.runnerToken}` } : {}) },
			body: JSON.stringify({ nonce: lock.nonce, reason: "replaced" }),
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return { ok: false, lines: [`The runner on pid ${lock.pid} refused the stop request (HTTP ${res.status}).`, "Stop it where it is running, then try again."] };
	} catch (e) {
		return { ok: false, lines: [`The runner on pid ${lock.pid} could not be asked to stop: ${e instanceof Error ? e.message : String(e)}.`, "Stop it where it is running, then try again."] };
	}

	const until = now() + REPLACE_EXIT_TIMEOUT_MS;
	while (now() < until) {
		if (!alive(lock.pid)) return { ok: true, lines: [`Replaced the \`pags up\` on pid ${lock.pid}`] };
		await sleep(500);
	}
	return {
		ok: false,
		lines: [
			`The runner on pid ${lock.pid} was asked to stop but is still running after ${Math.round(REPLACE_EXIT_TIMEOUT_MS / 1000)}s.`,
			"It may be finishing something. Wait and try again, or stop it where it is running — this command will not kill it for you.",
		],
	};
}
