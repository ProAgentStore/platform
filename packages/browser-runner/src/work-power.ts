/** #1486: keep owned work running through macOS network DarkWake, without changing power settings. */
import { spawn, type ChildProcess } from "node:child_process";

export interface WorkPowerOptions {
	hasWork: () => boolean;
	platform?: NodeJS.Platform;
	pid?: number;
	spawn?: (file: string, args: string[]) => ChildProcess;
	now?: () => number;
	pollMs?: number;
	retryMs?: number;
	warn?: (message: string) => void;
}

/** One assertion shared by concurrent requests and background jobs; no assertion while idle. */
export class WorkPower {
	private readonly options: WorkPowerOptions;
	private requests = 0;
	private helper: ChildProcess | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private retryAt = 0;
	private closed = false;

	constructor(options: WorkPowerOptions) { this.options = options; }

	/** Acquire before starting owned work. Release is idempotent, including after runtime shutdown. */
	begin(): () => void {
		if (this.closed || (this.options.platform ?? process.platform) !== "darwin") return () => undefined;
		this.requests++;
		this.reconcile();
		if (!this.timer) {
			this.timer = setInterval(() => this.reconcile(), this.options.pollMs ?? 1000);
			this.timer.unref?.();
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.requests--;
			this.reconcile();
		};
	}

	private warn(error: unknown): void {
		(this.options.warn ?? console.warn)(`[runner] Sleep prevention unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}

	private stopHelper(): void {
		const helper = this.helper;
		this.helper = null;
		if (helper) { try { helper.kill("SIGTERM"); } catch (error) { this.warn(error); } }
	}

	private reconcile(): void {
		if (this.closed) return;
		let work = this.requests > 0;
		try { work ||= this.options.hasWork(); } catch { work = true; } // preserve a job whose state cannot currently be observed
		if (!work) {
			this.stopHelper();
			this.retryAt = 0;
			if (this.timer) clearInterval(this.timer);
			this.timer = null;
			return;
		}
		const now = (this.options.now ?? Date.now)();
		if (this.helper || now < this.retryAt) return;
		this.retryAt = now + (this.options.retryMs ?? 5000);
		try {
			// -s prevents SYSTEM sleep on AC power only. No display/user-active assertion and no
			// -i (which would also prevent idle sleep on battery). -w binds cleanup to this exact
			// runtime process even if it crashes or is SIGKILLed before close() can run.
			const child = (this.options.spawn ?? ((file, args) => spawn(file, args, { stdio: "ignore" })))("/usr/bin/caffeinate", ["-s", "-w", String(this.options.pid ?? process.pid)]);
			this.helper = child;
			child.unref();
			const gone = (error?: Error) => {
				if (this.helper !== child) return;
				this.helper = null;
				this.retryAt = (this.options.now ?? Date.now)() + (this.options.retryMs ?? 5000);
				this.warn(error ?? new Error("the keep-awake helper exited while work was active; retrying"));
			};
			child.once("error", gone);
			child.once("exit", () => gone());
		} catch (error) { this.warn(error); }
	}

	close(): void {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.stopHelper();
	}
}
