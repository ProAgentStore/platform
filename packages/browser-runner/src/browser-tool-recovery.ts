import { cpus, freemem, loadavg, totalmem } from "node:os";

export interface BrowserToolDiagnostic {
	kind: "request_deadline" | "transport_failure" | "page_operation_failure" | "browser_process_lost" | "quarantined";
	phase: "native_request" | "native_response" | "recovery";
	tool: string;
	execution: "pending" | "settled" | "unknown" | "not_dispatched";
	recoverable: boolean;
	message: string;
	originalError?: string;
	elapsedMs: number;
	machine: { load1: number | null; loadPerCpu: number | null; cpus: number; freeMemoryBytes: number; totalMemoryBytes: number };
}

export interface BrowserRecoveryStatus {
	diagnostic: BrowserToolDiagnostic;
	deadlineCount: number;
	/** A response proves the handler returned, not that the website accepted its action. */
	canResume: boolean;
}

export function browserMachineEvidence(): BrowserToolDiagnostic["machine"] {
	const count = cpus().length || 1;
	const load1 = process.platform === "win32" ? null : loadavg()[0];
	return { load1, loadPerCpu: load1 === null ? null : load1 / count, cpus: count, freeMemoryBytes: freemem(), totalMemoryBytes: totalmem() };
}

export function diagnosticMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 2000 ? `${message.substring(0, 1900)} [error truncated: ${message.length} characters]` : message;
}

type Pending<T> = { tool: string; started: number; execution: "pending" | "settled" | "unknown"; reply?: T; error?: string; machine: BrowserToolDiagnostic["machine"]; lost: boolean; quarantined: boolean; callerDone: Promise<void>; finishCaller(): void };
export type NativeRequestOutcome<T> = { reply: T; diagnostic?: never } | { diagnostic: BrowserToolDiagnostic; reply?: never };

/**
 * A caller deadline never claims to cancel the upstream action. Keep its actual RPC
 * promise until a response arrives. A transport rejection cannot establish settlement.
 * No later native request is admitted until explicit recovery acknowledges a response.
 */
export class BrowserToolRecovery<T> {
	private pending: Pending<T> | null = null;
	private retired = false;
	private deadlines = 0;
	constructor(readonly requestDeadlineMs = 60_000, readonly wireDeadlineMs = 600_000) {
		if (!(requestDeadlineMs > 0) || !(wireDeadlineMs > requestDeadlineMs) || wireDeadlineMs > 2_147_483_647) throw new Error("Browser request deadlines must be finite, positive and ordered");
	}
	private diagnostic(pending: Pending<T>, kind?: BrowserToolDiagnostic["kind"]): BrowserToolDiagnostic {
		const settled = pending.execution === "settled";
		return {
			kind: kind ?? (this.retired ? "quarantined" : pending.lost ? "browser_process_lost" : pending.error ? "transport_failure" : "request_deadline"),
			phase: kind === "quarantined" ? "recovery" : "native_response", tool: pending.tool,
			execution: pending.execution, recoverable: settled && !this.retired && !pending.lost,
			message: settled ? "The delayed native response arrived. Inspect its result and current page through browser_recover before any further native action. No action was replayed."
				: "The native response is unavailable and the action may still execute. Native tools are quarantined; do not replay it. Independent screenshots may remain available. Recovery requires an actual response; otherwise stop and retire this browser session.",
			// A later refused call has different arguments/redaction context; retain the
			// original error only on the original operation's diagnostic/recovery status.
			...(pending.error && kind !== "quarantined" ? { originalError: pending.error } : {}), elapsedMs: Date.now() - pending.started, machine: pending.machine,
		};
	}
	status(): BrowserRecoveryStatus | null {
		return this.pending?.quarantined ? { diagnostic: this.diagnostic(this.pending), deadlineCount: this.deadlines, canResume: this.pending.execution === "settled" && !this.retired && !this.pending.lost } : null;
	}
	/** Defer a first dispatch behind ordinary work, never behind uncertain execution.
	 * The caller must perform its normal authorization checks after this wait. */
	async waitForIdle(): Promise<void> {
		while (this.pending && !this.pending.quarantined && !this.retired) await this.pending.callerDone;
	}
	blocked(): BrowserToolDiagnostic | null {
		if (this.pending) return this.diagnostic(this.pending, "quarantined");
		return this.retired ? { kind: "quarantined", phase: "recovery", tool: "none", execution: "not_dispatched", recoverable: false, message: "This browser runtime was retired and cannot be reused. Start a new runner-owned browser session.", elapsedMs: 0, machine: browserMachineEvidence() } : null;
	}
	/** Only an actual response can release the fence. The caller verifies run/page ownership too. */
	release(): T | undefined {
		if (this.pending?.execution !== "settled" || this.retired || this.pending.lost) return undefined;
		const reply = this.pending.reply;
		this.pending = null;
		return reply;
	}
	settledReply(): T | undefined { return this.pending?.execution === "settled" ? this.pending.reply : undefined; }
	retire(): void { this.retired = true; if (this.pending) { this.pending.quarantined = true; this.pending.finishCaller(); } }
	async request(tool: string, operation: () => Promise<T>, processLost: () => boolean): Promise<NativeRequestOutcome<T>> {
		const blocked = this.blocked();
		if (blocked) return { diagnostic: blocked };
		let finishCaller!: () => void;
		const callerDone = new Promise<void>(resolve => { finishCaller = resolve; });
		const pending: Pending<T> = { tool, started: Date.now(), execution: "pending", machine: browserMachineEvidence(), lost: false, quarantined: false, callerDone, finishCaller };
		this.pending = pending;
		// Rejection is observed even after the caller deadline; no unhandled late promise.
		const completion = Promise.resolve().then(operation).then(reply => {
			pending.execution = "settled"; pending.reply = reply; return true;
		}, error => {
			pending.execution = "unknown"; pending.error = diagnosticMessage(error);
			try { pending.lost = processLost(); } catch { /* A failed health read proves nothing about quiescence. */ }
			return true;
		});
		let timer: NodeJS.Timeout | undefined;
		try {
			const completed = await Promise.race([completion, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), this.requestDeadlineMs); })]);
			if (!completed) { this.deadlines++; pending.quarantined = true; return { diagnostic: this.diagnostic(pending) }; }
			if (pending.execution === "unknown") { pending.quarantined = true; return { diagnostic: this.diagnostic(pending) }; }
			this.pending = null;
			return { reply: pending.reply as T };
		} finally { if (timer) clearTimeout(timer); finishCaller(); }
	}
}
