/**
 * One `pags up` per machine, per account — the local lock and who holds it (#896).
 *
 * ── What went wrong without it
 *
 * On 2026-10-01 three `pags up` processes were running on one laptop: one five days old in a
 * Terminal tab, one in a hidden tmux session, one a day old in another tab. Only one owned the
 * relay link for the coders, and that link wedged: `relayConnected: true` while the health check
 * timed out, every coding call 504, a run failed and the work queue lost an entry. Nothing had
 * prevented the duplicates and nothing reported them.
 *
 * Nothing could, because no process had an identity. `pags up` "handled" duplicates by running
 * `pkill -f` over three name patterns — which kills ANY matching process of this OS user: a
 * deliberate scoped `runner connect`, a dev runner from the monorepo, a runner signed in as a
 * DIFFERENT account, and a launchd/systemd-managed one that the service manager then restarts, so
 * the two fight in a loop. Worse, since the local runtimes shipped, that kill ends real work: a
 * Codex or Grok turn, a local browser research run, a Tailor run, an Application Runner fill —
 * each lost, with the owner told nothing until the cloud gave up on it minutes later.
 *
 * ── What this is
 *
 * An exclusive file, created with `O_CREAT|O_EXCL` (atomic on macOS, Linux and Windows; Node has
 * no portable `flock` without a native module), holding WHO holds the slot: the process's own id
 * (`rsid`), its pid, the pid's OS-reported start time, where it was launched from, and the nonce
 * that authorises a graceful shutdown. Per ACCOUNT, so two accounts may each run one runner on one
 * machine, which is what the issue asks for.
 *
 * ── The rules, and why each one is what it is
 *
 * {@link classifyHolder} is the whole decision, and it is PURE so the table can be tested without
 * processes or a filesystem:
 *
 *  - **dead** — the pid is gone, or it is alive but its start time is not the one recorded (the pid
 *    was reused). Taken over automatically: there is nobody to interrupt.
 *  - **live** — the pid is alive and the runner's own `/health` answers with the SAME `rsid`. We
 *    refuse, and name the holder. Only a process that can read this mode-600 file could know its
 *    nonce, which is what makes `--replace` an authorisation rather than a guess.
 *  - **unresponsive** — the pid is alive and `/health` says nothing. NEVER taken over
 *    automatically. A slept laptop, a SIGSTOPped process and a machine at 6× load all look exactly
 *    like this, and all three are legitimate holders that will answer again (#913, #922, #924).
 *    "Slow is not dead" is the rule that most of this file exists to honour.
 *  - **unknown** — the file is unreadable, or written by a newer version. Treated as live, because
 *    guessing the other way is how a working runner gets killed.
 *
 * Staleness is never decided by a timestamp. `heartbeatAt` is written for a human reading the file;
 * no verdict reads it, because a sleeping laptop's lock is old and perfectly valid.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where a runner process was started from — it decides what `--replace` may do to it. */
export type RunnerLaunch = "tty" | "tmux" | "service" | "headless";

/** The lock's shape. `v` is first so a future version can be recognised and refused politely. */
export interface RunnerLockFile {
	v: 1;
	/** This runner PROCESS's id — minted once per `runner connect`, carried to the cloud too. */
	rsid: string;
	pid: number;
	/**
	 * The pid's start time as the OS reports it, verbatim. Compared as a STRING: the point is only
	 * whether it is the same process, and parsing `ps` output into a date adds a locale bug for no
	 * gain. Empty when the platform would not say.
	 */
	pidStartedAt: string;
	/** When the lock was taken (ms epoch). */
	startedAt: number;
	/** The local runner's HTTP port, so a contender can ask `/health` who is really there. */
	port: number | null;
	node: string;
	machineId: string | null;
	/** Which account this runner serves — the lock is per account, and this says which. */
	account: string;
	version: string;
	launch: RunnerLaunch;
	/** The tmux session or TTY name, so the refusal can tell the owner WHERE the holder is. */
	launchDetail: string;
	/** The runner's children, so a stale takeover cleans up by id and never by name pattern. */
	childPids: number[];
	/** Authorises `POST /control/shutdown` on the holder. Mode 600; never sent to the cloud. */
	nonce: string;
	/**
	 * The holder's own runner bearer token, so a contender can TALK to it.
	 *
	 * The runner authorises every request (`server.ts` `authorize`), and the token is minted per
	 * process — so without it here, a contender's `/health` probe gets a 401, reads as "not
	 * answering", and a live holder is misreported as unresponsive. It belongs in the same mode-600
	 * file as the nonce and for the same reason: being able to read the owner's own lock is what
	 * entitles a process to ask anything of the runner it describes.
	 */
	runnerToken: string;
	/** For a human reading the file. NO verdict reads it — see the header. */
	heartbeatAt: number;
}

export type HolderVerdict = "dead" | "live" | "unresponsive" | "unknown";

/** Everything {@link classifyHolder} is allowed to know. Gathered by the caller; pure here. */
export interface HolderFacts {
	/** The parsed lock, or null when the file could not be read or parsed. */
	lock: RunnerLockFile | null;
	/** Is the recorded pid running at all? */
	pidAlive: boolean;
	/** The pid's CURRENT OS start time, or "" when unknown. A mismatch means the pid was reused. */
	pidStartedAt: string;
	/** The `rsid` the local `/health` answered with, or null when it did not answer. */
	healthRsid: string | null;
}

/** The config directory the lock lives in, beside `machine.json`. `PAGS_CONFIG_DIR` separates a dev runner. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PAGS_CONFIG_DIR?.trim() || join(homedir(), ".config", "proagentstore");
}

/** A stable, non-identifying file-name component for an account. */
export const accountKey = (account: string): string => createHash("sha256").update(account.trim().toLowerCase()).digest("hex").slice(0, 12);

/**
 * One lock per (machine, account) — Q1's answer.
 *
 * Per account rather than per machine, because two people (or one person's two accounts) sharing a
 * laptop are not competing for anything: their runners serve different agents and different relay
 * slots. One lock for the machine would make the second account's runner unstartable for no safety
 * gain.
 */
export const lockPath = (account: string, env: NodeJS.ProcessEnv = process.env): string => join(configDir(env), `up-${accountKey(account)}.lock`);

/**
 * The verdict on the process named in a lock file. PURE.
 *
 * Order is the specification: a pid that is gone or reused is dead whatever else is true, and an
 * identity match on `/health` is the only thing that proves "live" — a port answering with a
 * DIFFERENT rsid is somebody else's runner on a recycled port, which tells us nothing about our
 * holder, so it falls through to the pid's own liveness.
 */
export function classifyHolder(facts: HolderFacts): HolderVerdict {
	const lock = facts.lock;
	if (!lock) return "unknown";
	if (lock.v !== 1) return "unknown";
	if (!lock.pid || !Number.isInteger(lock.pid)) return "unknown";
	if (!facts.pidAlive) return "dead";
	// A reused pid: same number, different process. Only decidable when BOTH sides have a start
	// time — when either is unknown the pid stands, because "we cannot tell" must not read as "dead".
	if (lock.pidStartedAt && facts.pidStartedAt && lock.pidStartedAt !== facts.pidStartedAt) return "dead";
	if (facts.healthRsid && facts.healthRsid === lock.rsid) return "live";
	// Alive, but it did not identify itself: asleep, stopped, or simply very busy. Never taken.
	return "unresponsive";
}

/** Can a contender take this slot without the owner saying so? Only a dead holder. */
export const isTakeable = (verdict: HolderVerdict): boolean => verdict === "dead";

/** Where the holder is, in words — a tmux session the owner can attach to, or a terminal. */
export function holderWhere(lock: RunnerLockFile): string {
	if (lock.launch === "tmux") return `tmux session ${lock.launchDetail || "?"}`;
	if (lock.launch === "service") return "a background service (launchd/systemd)";
	if (lock.launch === "headless") return "headless";
	return lock.launchDetail ? `terminal ${lock.launchDetail}` : "a terminal";
}

/**
 * What a refused `pags up` prints. The whole point of the lock: say who holds it and what to do,
 * never just "already running".
 */
export function holderMessage(lock: RunnerLockFile, verdict: HolderVerdict): string[] {
	const since = new Date(lock.startedAt).toLocaleString();
	const lines = [
		`A \`pags up\` is already running for this account on this machine.`,
		`  pid ${lock.pid}, started ${since}, CLI ${lock.version || "?"}, in ${holderWhere(lock)}.`,
	];
	if (verdict === "unresponsive") {
		lines.push(`  It is NOT answering its health check — it may be asleep, stopped, or the machine may be overloaded.`);
	}
	if (verdict === "unknown") {
		lines.push(`  Its lock file could not be read (a newer CLI may have written it), so it is assumed to be running.`);
	}
	lines.push("", "  What you can do:");
	if (lock.launch === "tmux" && lock.launchDetail) lines.push(`    tmux attach -t ${lock.launchDetail}   — go to the one that is running`);
	lines.push(
		`    pags status                      — what it is doing, and anything else running here`,
		lock.launch === "service"
			? `    (this one is a service — stop its launchd/systemd unit rather than replacing it)`
			: `    pags up --replace                — stop that one gracefully, then take over`,
	);
	return lines;
}

/** Where the runner was launched from, which is what `--replace` is allowed to act on. */
export function detectLaunch(env: NodeJS.ProcessEnv = process.env, isTty = Boolean(process.stdout.isTTY)): { launch: RunnerLaunch; detail: string } {
	if (env.PAGS_SERVICE === "1") return { launch: "service", detail: env.PAGS_SERVICE_NAME?.trim() || "" };
	if (env.TMUX) return { launch: "tmux", detail: env.TMUX_PANE?.trim() || env.TMUX.split(",")[0]?.split("/").pop() || "" };
	if (!isTty) return { launch: "headless", detail: "" };
	return { launch: "tty", detail: env.TERM_SESSION_ID?.trim() || env.WINDOWID?.trim() || "" };
}

// ── The side-effecting half: pids, the file, and acquiring it ────────────────────────────────

/** Is this pid running? Signal 0 asks the kernel without touching the process. */
export function pidAlive(pid: number): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM means it exists and belongs to somebody else — still alive, and still not ours to kill.
		return (e as { code?: string }).code === "EPERM";
	}
}

/**
 * The pid's start time as the OS states it, or "" when it will not say.
 *
 * The one defence against a reused pid, and it has to be cheap: this runs on every `pags up`. On
 * Windows there is no `ps`, so `wmic` is tried and an empty answer is accepted — the pid then
 * stands on its own, which is the safe direction (a live holder is never mistaken for a dead one).
 */
export function pidStartedAt(pid: number): string {
	if (!pidAlive(pid)) return "";
	try {
		if (process.platform === "win32") {
			const out = execFileSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"], { encoding: "utf-8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
			return (out.match(/CreationDate=(\S+)/)?.[1] ?? "").trim();
		}
		return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

/** Ask the local runner who it is. Short and bounded: this is in the start path of every `pags up`. */
export async function healthRsid(port: number | null, token = "", timeoutMs = 5000, fetchImpl: typeof fetch = fetch): Promise<string | null> {
	if (!port) return null;
	try {
		const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return null;
		const body = (await res.json()) as { rsid?: unknown };
		return typeof body.rsid === "string" && body.rsid ? body.rsid : null;
	} catch {
		return null;
	}
}

export function readLock(path: string): RunnerLockFile | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as RunnerLockFile;
		return parsed && typeof parsed === "object" && typeof parsed.rsid === "string" ? parsed : null;
	} catch {
		return null;
	}
}

/** Everything a contender needs to decide, in one call. */
export async function inspectHolder(path: string, opts: { fetchImpl?: typeof fetch; healthTimeoutMs?: number } = {}): Promise<{ lock: RunnerLockFile | null; verdict: HolderVerdict }> {
	const lock = readLock(path);
	if (!lock) return { lock: null, verdict: "unknown" };
	const alive = pidAlive(lock.pid);
	const facts: HolderFacts = {
		lock,
		pidAlive: alive,
		pidStartedAt: alive ? pidStartedAt(lock.pid) : "",
		healthRsid: alive ? await healthRsid(lock.port, lock.runnerToken ?? "", opts.healthTimeoutMs ?? 5000, opts.fetchImpl ?? fetch) : null,
	};
	return { lock, verdict: classifyHolder(facts) };
}

export interface AcquireInput {
	account: string;
	node: string;
	machineId: string | null;
	version: string;
	port: number | null;
	rsid?: string;
	/** The holder's runner bearer token — see {@link RunnerLockFile.runnerToken}. */
	runnerToken?: string;
	env?: NodeJS.ProcessEnv;
	/** The rsid this process is allowed to take the lock FROM (a supervised restart, #859/#860). */
	handoffFrom?: string;
}

export type AcquireResult =
	| { ok: true; lock: RunnerLockFile; path: string; tookOver: "none" | "stale" | "handoff" }
	| { ok: false; lock: RunnerLockFile | null; path: string; verdict: HolderVerdict };

/**
 * Take the lock, or report who has it.
 *
 * A dead holder is taken over by RENAMING its file aside first: rename succeeds for exactly one
 * contender, so two `pags up` started in the same second cannot both decide the lock was stale.
 * The winner then creates the new file with `O_EXCL`, which is the same one-winner guarantee for
 * the empty case. Neither path ever kills anything by name.
 */
export async function acquireLock(input: AcquireInput): Promise<AcquireResult> {
	const env = input.env ?? process.env;
	const path = lockPath(input.account, env);
	const rsid = input.rsid ?? randomUUID();
	const handoff = input.handoffFrom?.trim() || env.PAGS_LOCK_HANDOFF?.trim() || "";
	mkdirSync(configDir(env), { recursive: true });

	for (let attempt = 0; attempt < 3; attempt++) {
		const written = tryWrite(path, buildLock(input, rsid, env));
		if (written) return { ok: true, lock: written, path, tookOver: attempt === 0 ? "none" : "stale" };

		const { lock, verdict } = await inspectHolder(path);
		// A supervised restart inherits the slot from the exact process that handed it over (#860).
		if (handoff && lock?.rsid === handoff) {
			renameAside(path, lock.pid);
			const taken = tryWrite(path, buildLock(input, rsid, env));
			if (taken) return { ok: true, lock: taken, path, tookOver: "handoff" };
			continue;
		}
		if (!isTakeable(verdict)) return { ok: false, lock, path, verdict };
		// Dead: move it aside — but only the file we actually judged. Renaming blind loses a race
		// that matters: two contenders both read the same stale lock, the first takes it and writes
		// its own, and the second's rename would then move THAT live lock away and write over it,
		// producing exactly the two-runners-one-node state this file exists to prevent.
		if (!takeAsideIfStill(path, lock?.rsid ?? "", lock?.pid ?? 0)) continue;
	}
	const { lock, verdict } = await inspectHolder(path);
	return { ok: false, lock, path, verdict };
}

function buildLock(input: AcquireInput, rsid: string, env: NodeJS.ProcessEnv): RunnerLockFile {
	const { launch, detail } = detectLaunch(env);
	const now = Date.now();
	return {
		v: 1,
		rsid,
		pid: process.pid,
		pidStartedAt: pidStartedAt(process.pid),
		startedAt: now,
		port: input.port,
		node: input.node,
		machineId: input.machineId,
		account: input.account,
		version: input.version,
		launch,
		launchDetail: detail,
		childPids: [],
		nonce: randomUUID(),
		runnerToken: input.runnerToken ?? "",
		heartbeatAt: now,
	};
}

/** `O_EXCL` create + write, or false when somebody already holds it. Mode 600: the nonce is in here. */
function tryWrite(path: string, lock: RunnerLockFile): RunnerLockFile | null {
	let fd: number | null = null;
	try {
		fd = openSync(path, "wx", 0o600);
		writeSync(fd, JSON.stringify(lock, null, 2));
		return lock;
	} catch (e) {
		if ((e as { code?: string }).code === "EEXIST") return null;
		throw e;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

function renameAside(path: string, pid: number): string | null {
	const aside = `${path}.stale-${pid || "unknown"}`;
	try {
		renameSync(path, aside);
		return aside;
	} catch {
		// Somebody else won the rename, or it is already gone — the caller re-reads and decides again.
		return null;
	}
}

/**
 * Move a stale lock aside, and prove afterwards that it was the stale one.
 *
 * `rename` is atomic but it is not conditional: between classifying a lock as dead and moving it,
 * another contender can have taken the slot and written a LIVE lock in its place. So the moved file
 * is read back, and if it is not the one we judged it is put back and we start over. Without this,
 * the second contender silently evicts the first — the duplicate this module is for.
 */
function takeAsideIfStill(path: string, deadRsid: string, pid: number): boolean {
	const aside = renameAside(path, pid);
	if (!aside) return false;
	const moved = readLock(aside);
	if (moved && deadRsid && moved.rsid !== deadRsid) {
		try {
			renameSync(aside, path);
		} catch {
			/* the slot was re-created meanwhile; the next inspect sees whatever is there now */
		}
		return false;
	}
	return true;
}

/** Rewrite the lock, keeping it mine. Used for the port, the child pids and `heartbeatAt`. */
export function updateLock(path: string, rsid: string, patch: Partial<RunnerLockFile>): RunnerLockFile | null {
	const current = readLock(path);
	if (!current || current.rsid !== rsid) return null;
	const next = { ...current, ...patch, v: 1 as const, rsid, pid: current.pid };
	try {
		const fd = openSync(path, "w", 0o600);
		try {
			writeSync(fd, JSON.stringify(next, null, 2));
		} finally {
			closeSync(fd);
		}
		return next;
	} catch {
		return null;
	}
}

/**
 * Give up the lock — only if it is still MINE.
 *
 * The rsid check is the whole safety: a process that was replaced, and then exits later, must not
 * delete the lock the replacement is holding. Without it, a slow shutdown unlocks the machine for
 * anybody and the duplicate this file exists to prevent walks straight back in.
 */
export function releaseLock(path: string, rsid: string): boolean {
	const current = readLock(path);
	if (!current || current.rsid !== rsid) return false;
	try {
		unlinkSync(path);
		return true;
	} catch {
		return false;
	}
}
