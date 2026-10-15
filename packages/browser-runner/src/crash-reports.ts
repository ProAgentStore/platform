/**
 * Durable crash reports for the local runner and the CLI that supervises it (#1087).
 *
 * Kept BYTE-IDENTICAL at
 *
 *   packages/browser-runner/src/crash-reports.ts
 *   packages/cli/src/crash-reports.ts
 *
 * (`packages/cli/src/crash-reports.test.ts` fails the moment they differ) and imports only Node
 * built-ins, so the CLI — which bundles the runner but cannot import its source — carries a copy.
 *
 * ── What it is for
 *
 * A runner crash used to be a line on stderr and nothing else: the runtime's `uncaughtException`
 * handler printed and moved on, a request that threw answered 500 and was forgotten, and a runtime
 * killed by a signal made `runner connect` exit with no record of the signal. This keeps a BOUNDED,
 * SANITIZED record of each on disk — so it survives the process, an offline stretch and a restart —
 * until the CLI, which holds the account token, has delivered it to the platform (`deliver.ts`
 * there; `POST /v1/runner/crash-reports`, idempotent by `id`). There it is an `error_log` row that
 * MCP `list_errors(source: "runner-crash")` reads.
 *
 * ── One writer per file
 *
 * The runtime writes `<dataDir>/crash-reports.json`; the CLI writes its own file. Nobody else writes
 * either: the CLI records what it has DELIVERED in its own ledger rather than editing the runtime's
 * file, so two processes never race on one file. A report delivered twice is harmless — the
 * platform keeps one row per id.
 *
 * ── Atomic writes, and what they do not cover
 *
 * Every write goes to a temp file in the same directory, is fsync'd, then renamed over the target.
 * A rename within one filesystem is atomic, so a reader sees the old file or the new one, never half
 * of either; an interrupted write leaves a stray `*.tmp`, which is removed the next time the file is
 * opened. LIMITS, stated rather than hidden:
 *   - a hard kill or power loss BEFORE the rename loses that one write (the file keeps its previous
 *     contents) — a crash that kills the process before `record` returns is not recorded;
 *   - the directory entry is not fsync'd, so a power loss just after the rename can still roll the
 *     file back to its previous version on some filesystems;
 *   - SIGKILL and an OOM kill run no handler in the dying process at all — only its PARENT can see
 *     the signal, which is why the CLI records `runner_exit` itself.
 *
 * ── Corruption is evidence, not an empty file
 *
 * A file that cannot be parsed is MOVED to `<file>.corrupt-<timestamp>` and reported, never read as
 * empty and overwritten. Quarantined copies are bounded too ({@link MAX_QUARANTINED}).
 *
 * ── Bounds
 *
 * At most {@link MAX_REPORTS} reports per file (oldest dropped first, and COUNTED in `dropped`);
 * a message is clipped to 1000 characters and a stack to 4000, marked as cut; credential-shaped
 * text is masked. Metadata only (ADR 0004): no request or response bodies, no environment.
 */
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const MAX_REPORTS = 100;
export const MAX_QUARANTINED = 5;
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;

export type CrashKind =
	| "uncaught_exception"
	| "unhandled_rejection"
	| "startup_failure"
	| "request_failure"
	| "runner_exit"
	| "connect_exit"
	| "store_corrupt";

export interface CrashReport {
	/** Stable for the life of the report: the platform's idempotency key. */
	id: string;
	at: string;
	/** Which process wrote it. */
	source: "runtime" | "cli";
	kind: CrashKind;
	message: string;
	stack?: string;
	cause?: string;
	exitCode?: number | null;
	signal?: string | null;
	/** The CLI release the runtime ships in. */
	build?: string;
	/**
	 * Whose runner this was: {@link crashAccountKey} of the signed-in login. The CLI delivers a
	 * report only under the SAME account — a laptop shared by two accounts must not file one's crash
	 * in the other's log. A report with no account (a bare `pags runner start`) stays local.
	 */
	account?: string;
	instanceId?: string;
	sessionId?: string;
	taskId?: string;
	/** A request boundary's method + path — never its body. */
	route?: string;
	/** The last lines a dying child printed, sanitized and bounded. */
	tail?: string[];
}

export interface CrashFile {
	reports: CrashReport[];
	/** Reports dropped to stay inside {@link MAX_REPORTS}, ever — the truncation is counted, not silent. */
	dropped: number;
}

/** Mask credential-shaped text: bearer tokens, API keys, JWTs, `token=…` pairs. */
export function maskSecrets(text: string): string {
	return text
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
		.replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abp]-[A-Za-z0-9-]{8,}|pags_runner_[A-Za-z0-9-]{8,})/g, "[redacted]")
		.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]")
		.replace(/\b((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)("?)[^\s"&]{4,}\2/gi, "$1[redacted]");
}

/** A stable, non-identifying key for an account — the same as the runner lock's (`runner-lock.ts`). */
export function crashAccountKey(login: string): string {
	return createHash("sha256").update(login.trim().toLowerCase()).digest("hex").substring(0, 12);
}

/** Clip VISIBLY: a cut value says it was cut and by how much. */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.substring(0, max)}\n[cut: showing the first ${max} of ${text.length} characters]`;
}

const clean = (value: unknown, max: number): string => clip(maskSecrets(String(value ?? "")), max);
const shortId = (value: unknown): string | undefined => (typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined);

/** The error's message, stack and cause, sanitized and bounded. */
export function describeError(error: unknown): { message: string; stack?: string; cause?: string } {
	if (error instanceof Error) {
		const cause = (error as { cause?: unknown }).cause;
		return {
			message: clean(`${error.name}: ${error.message}`, MAX_MESSAGE),
			stack: error.stack ? clean(error.stack, MAX_STACK) : undefined,
			cause: cause === undefined ? undefined : clean(cause instanceof Error ? `${cause.name}: ${cause.message}` : cause, MAX_MESSAGE),
		};
	}
	return { message: clean(error, MAX_MESSAGE) };
}

/**
 * The runtime's own identity for its reports: the build and account `runner connect` passes it in
 * `PAGS_RUNNER_BUILD` / `PAGS_RUNNER_ACCOUNT`. Absent for a bare `pags runner start`.
 */
export function runtimeCrashIdentity(env: NodeJS.ProcessEnv = process.env): Pick<CrashReport, "source" | "build" | "account"> {
	return { source: "runtime", build: env.PAGS_RUNNER_BUILD || undefined, account: env.PAGS_RUNNER_ACCOUNT || undefined };
}

/** Build a report from what is known — every field bounded, ids id-shaped or dropped. */
export function crashReport(input: Omit<CrashReport, "id" | "at"> & { id?: string; at?: string }): CrashReport {
	return {
		id: shortId(input.id) ?? `crash_${randomUUID()}`,
		at: input.at ?? new Date().toISOString(),
		source: input.source,
		kind: input.kind,
		message: clean(input.message, MAX_MESSAGE),
		...(input.stack ? { stack: clean(input.stack, MAX_STACK) } : {}),
		...(input.cause ? { cause: clean(input.cause, MAX_MESSAGE) } : {}),
		...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
		...(input.signal !== undefined ? { signal: input.signal } : {}),
		...(shortId(input.build) ? { build: input.build } : {}),
		...(shortId(input.account) ? { account: input.account } : {}),
		...(shortId(input.instanceId) ? { instanceId: input.instanceId } : {}),
		...(shortId(input.sessionId) ? { sessionId: input.sessionId } : {}),
		...(shortId(input.taskId) ? { taskId: input.taskId } : {}),
		...(input.route ? { route: clean(input.route, 200) } : {}),
		...(input.tail?.length ? { tail: input.tail.slice(-20).map((line) => clean(line, 300)) } : {}),
	};
}

/**
 * Write `data` as JSON atomically: temp file in the same directory, fsync, rename. Throws on
 * failure — the caller decides whether that may surface.
 */
export function writeJsonAtomic(path: string, data: unknown, mode = 0o600): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const fd = openSync(tmp, "w", mode);
	try {
		writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// The temp file is already gone; the rename's own error is the one that matters.
		}
		throw error;
	}
}

/** Remove temp files an interrupted {@link writeJsonAtomic} left beside `path`. */
export function removeStaleTemps(path: string): void {
	const dir = dirname(path);
	const prefix = `${basename(path)}.`;
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
		try {
			unlinkSync(join(dir, name));
		} catch {
			// Another process may own it; a temp file is never read, so leaving it is safe.
		}
	}
}

export type JsonRead<T> = { status: "missing" } | { status: "ok"; value: T } | { status: "quarantined"; quarantinedTo: string; error: string };

/**
 * Read a JSON file. A file that does not parse is MOVED aside to `<path>.corrupt-<timestamp>` —
 * kept as evidence, and out of the way so the next write cannot overwrite it — and reported as
 * `quarantined`. At most {@link MAX_QUARANTINED} quarantined copies are kept per file.
 */
export function readJsonOrQuarantine<T>(path: string): JsonRead<T> {
	removeStaleTemps(path);
	if (!existsSync(path)) return { status: "missing" };
	try {
		return { status: "ok", value: JSON.parse(readFileSync(path, "utf-8")) as T };
	} catch (error) {
		const quarantinedTo = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
		try {
			renameSync(path, quarantinedTo);
		} catch {
			// Could not move it: keep a COPY instead, so the caller's next write cannot destroy the
			// only evidence. If even that fails the report says so.
			try {
				copyFileSync(path, quarantinedTo);
			} catch (copyError) {
				return { status: "quarantined", quarantinedTo: "(not preserved)", error: `${describeError(error).message}; preserving it failed: ${describeError(copyError).message}` };
			}
		}
		pruneQuarantine(path);
		return { status: "quarantined", quarantinedTo, error: describeError(error).message };
	}
}

function pruneQuarantine(path: string): void {
	const dir = dirname(path);
	const prefix = `${basename(path)}.corrupt-`;
	const copies = readdirSync(dir).filter((name) => name.startsWith(prefix)).sort();
	const excess = copies.length - MAX_QUARANTINED;
	for (const name of excess > 0 ? copies.slice(0, excess) : []) {
		try {
			unlinkSync(join(dir, name));
		} catch {
			// Best-effort pruning; an extra copy is a bounded cost.
		}
	}
}

/**
 * One process's crash-report file. Synchronous throughout: it is called from `uncaughtException`
 * and from an `exit` listener, where nothing asynchronous is guaranteed to run.
 */
export class CrashLog {
	/** `base` stamps the reports this log writes about ITSELF (a quarantined file). */
	constructor(
		readonly path: string,
		private readonly base: Pick<CrashReport, "source" | "build" | "account"> = { source: "runtime" },
	) {}

	/** Everything still on disk, oldest first. A corrupt file is quarantined and reported, then read as a fresh file. */
	read(): CrashFile {
		const got = readJsonOrQuarantine<Partial<CrashFile>>(this.path);
		if (got.status === "ok") {
			const reports = Array.isArray(got.value.reports) ? got.value.reports.filter((r): r is CrashReport => !!r && typeof r.id === "string") : [];
			return { reports, dropped: Number(got.value.dropped) || 0 };
		}
		if (got.status === "missing") return { reports: [], dropped: 0 };
		// The quarantine itself is a report in the fresh file, so the evidence is pointed at, not lost.
		const file: CrashFile = {
			reports: [crashReport({ ...this.base, kind: "store_corrupt", message: `crash-report file was unreadable and was moved to ${basename(got.quarantinedTo)}: ${got.error}` })],
			dropped: 0,
		};
		this.write(file);
		return file;
	}

	/** Append a report (bounded). Never throws: a crash path must not crash on its own record. */
	record(report: CrashReport): boolean {
		try {
			const file = this.read();
			if (file.reports.some((r) => r.id === report.id)) return true;
			file.reports.push(report);
			const over = file.reports.length - MAX_REPORTS;
			if (over > 0) {
				file.reports = file.reports.slice(over);
				file.dropped += over;
			}
			this.write(file);
			return true;
		} catch (error) {
			process.stderr.write(`[crash-reports] could not record ${report.kind}: ${describeError(error).message}\n`);
			return false;
		}
	}

	/** Drop reports by id — only by this file's own writer. */
	remove(ids: readonly string[]): void {
		if (!ids.length) return;
		const file = this.read();
		const gone = new Set(ids);
		file.reports = file.reports.filter((r) => !gone.has(r.id));
		this.write(file);
	}

	private write(file: CrashFile): void {
		writeJsonAtomic(this.path, file);
	}
}

/**
 * Record process-level crashes in `log`. The process keeps running afterwards (a runner that died on
 * every stray error would drop its relay), so `onCrash` is where a caller adds its own line.
 */
export function installCrashHandlers(log: CrashLog, base: Pick<CrashReport, "source" | "build" | "account">, onCrash?: (report: CrashReport) => void): void {
	process.on("uncaughtException", (error) => {
		const report = crashReport({ ...base, kind: "uncaught_exception", ...describeError(error) });
		log.record(report);
		onCrash?.(report);
	});
	process.on("unhandledRejection", (reason) => {
		const report = crashReport({ ...base, kind: "unhandled_rejection", ...describeError(reason) });
		log.record(report);
		onCrash?.(report);
	});
}
