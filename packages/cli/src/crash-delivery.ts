/**
 * Deliver the runner's and the CLI's crash reports to the platform (#1087).
 *
 * The local runtime holds no account token, so its crash reports wait on disk
 * (`<runner data dir>/crash-reports.json`, written by the runtime alone) until the CLI — which does
 * hold one — sends them. The CLI keeps its OWN reports (a runtime that died of a signal, a supervised
 * `runner connect` that exited) in its own file. Both are sent to `POST /v1/errors/runner-crashes`,
 * which files each under the signed-in account, once, by report id; MCP `list_errors(source:
 * "runner-crash")` then reads them.
 *
 * At least once, and safe to repeat: after an offline stretch or a restart every report not yet
 * acknowledged is sent again, and the platform keeps one row per id. The CLI never writes the
 * runtime's file — it remembers what was acknowledged in a ledger of its own — so the two processes
 * never race on one file. Its own acknowledged reports it simply removes.
 *
 * Account isolation: a report carries the key of the account whose runner wrote it, and is sent only
 * under that account. A machine shared by two accounts never files one's crash in the other's log;
 * a report with no account (a bare `pags runner start`) is never sent.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CrashLog, type CrashReport, crashAccountKey, crashReport, readJsonOrQuarantine, writeJsonAtomic } from "./crash-reports.js";

/** Reports per request — the platform's limit (`RUNNER_CRASH_BATCH`). */
const BATCH = 50;
/** Acknowledged ids remembered — far above the two files' combined 200 reports. */
const LEDGER_MAX = 1000;
const TIMEOUT_MS = 10_000;

/** Where the runtime keeps its data when `--data-dir` is not given (`browser-runner/src/index.ts`). */
export function runnerDataDir(dataDir?: string, env: NodeJS.ProcessEnv = process.env): string {
	return dataDir || env.PAGS_RUNNER_DATA_DIR || join(homedir(), ".config", "proagentstore", "browser-runner");
}

export interface CrashPaths {
	/** The runtime's file — read only, never written here. */
	runtimeFile: string;
	/** The CLI's own crash reports, per account. */
	cliFile: string;
	/** Ids the platform has acknowledged, per account. */
	ledgerFile: string;
}

export function crashPaths(configDir: string, account: string, dataDir?: string): CrashPaths {
	const key = crashAccountKey(account);
	return {
		runtimeFile: join(runnerDataDir(dataDir), "crash-reports.json"),
		cliFile: join(configDir, `runner-crashes-${key}.json`),
		ledgerFile: join(configDir, `crash-delivered-${key}.json`),
	};
}

/** The runtime's reports, read without writing: a file it cannot parse is the runtime's to quarantine. */
function readRuntimeReports(path: string): CrashReport[] {
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { reports?: unknown };
		return Array.isArray(parsed.reports) ? (parsed.reports as CrashReport[]).filter((r) => r && typeof r.id === "string") : [];
	} catch {
		return [];
	}
}

function readLedger(path: string): string[] {
	const got = readJsonOrQuarantine<{ ids?: unknown }>(path);
	return got.status === "ok" && Array.isArray(got.value.ids) ? got.value.ids.filter((id): id is string => typeof id === "string") : [];
}

export interface DeliveryResult {
	delivered: number;
	/** Still waiting — offline, refused, or over this call's work. */
	pending: number;
	/** Why the last attempt stopped early, if it did. */
	error?: string;
}

/**
 * Send every report for `account` the platform has not acknowledged. Never throws; an offline
 * platform leaves everything pending for the next call.
 */
export async function deliverCrashReports(opts: {
	apiBase: string;
	token: string;
	account: string;
	paths: CrashPaths;
	fetchImpl?: typeof fetch;
}): Promise<DeliveryResult> {
	const key = crashAccountKey(opts.account);
	const cliLog = new CrashLog(opts.paths.cliFile, { source: "cli", account: key });
	const acked = new Set(readLedger(opts.paths.ledgerFile));
	const mine = (r: CrashReport) => r.account === key && !acked.has(r.id);
	const pending = [...readRuntimeReports(opts.paths.runtimeFile).filter(mine), ...cliLog.read().reports.filter(mine)];
	if (!pending.length) return { delivered: 0, pending: 0 };

	const doFetch = opts.fetchImpl ?? fetch;
	const accepted: string[] = [];
	let error: string | undefined;
	for (let i = 0; i < pending.length; i += BATCH) {
		const batch = pending.slice(i, i + BATCH);
		try {
			const res = await doFetch(`${opts.apiBase.replace(/\/$/, "")}/v1/errors/runner-crashes`, {
				method: "POST",
				headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ reports: batch }),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!res.ok) {
				error = `the platform answered ${res.status}`;
				break;
			}
			const body = (await res.json().catch(() => ({}))) as { accepted?: unknown };
			if (Array.isArray(body.accepted)) accepted.push(...body.accepted.filter((id): id is string => typeof id === "string"));
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			break;
		}
	}
	if (accepted.length) {
		const ledger = [...acked, ...accepted];
		writeJsonAtomic(opts.paths.ledgerFile, { ids: ledger.slice(Math.max(0, ledger.length - LEDGER_MAX)) });
		cliLog.remove(accepted);
	}
	return { delivered: accepted.length, pending: pending.length - accepted.length, ...(error ? { error } : {}) };
}

/**
 * The last lines a child process printed — a bounded ring, for its exit report. Bytes arrive in
 * arbitrary chunks, so a partial line is held until its newline.
 */
export class OutputTail {
	private buffer: string[] = [];
	private partial = "";
	constructor(private readonly max: number) {}

	push(chunk: Buffer | string): void {
		const parts = (this.partial + chunk.toString()).split("\n");
		this.partial = parts.pop() ?? "";
		for (const line of parts) {
			if (!line.trim()) continue;
			this.buffer.push(line);
			if (this.buffer.length > this.max) this.buffer.shift();
		}
	}

	lines(): string[] {
		return this.partial.trim() ? [...this.buffer, this.partial].slice(-this.max) : [...this.buffer];
	}
}

/**
 * Record a supervised child's unexpected exit in the CLI's own file — the dying process ran no
 * handler of its own when a SIGNAL ended it, so its parent is the only one that can. `signal` is
 * kept: a SIGKILL or OOM kill has `code === null`, and used to be reported as nothing at all.
 */
export function recordChildExit(o: {
	paths: CrashPaths;
	account: string;
	build: string;
	kind: "runner_exit" | "connect_exit";
	what: string;
	code: number | null;
	signal: string | null;
	tail: string[];
}): CrashReport {
	const account = crashAccountKey(o.account);
	const how = o.signal ? `was killed by ${o.signal}` : `exited unexpectedly${o.code !== null ? ` (code ${o.code})` : ""}`;
	const report = crashReport({ source: "cli", account, build: o.build, kind: o.kind, message: `${o.what} ${how}`, exitCode: o.code, signal: o.signal, tail: o.tail });
	new CrashLog(o.paths.cliFile, { source: "cli", account }).record(report);
	return report;
}
