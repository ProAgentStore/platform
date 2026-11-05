import { RunnerInputError } from "../errors.js";
import type { TakeoverInput } from "../types.js";
import type { Page } from "playwright";
import type { LocalApplyTaskEnvelope } from "./contract.js";
import type { LocalApplyHandoffRequest, LocalApplyHandoffStatus, LocalApplyHandoffTerminalReason } from "./handoff-contract.js";

export interface LocalApplyTakeoverAdapter {
	/** The caller supplies the page retained by this exact run/profile. */
	open(request: Pick<LocalApplyHandoffRequest, "handoffId">, page: Page): Promise<void>;
	state(handoffId: string): Promise<"ready" | "page_lost">;
	frame(handoffId: string): Promise<{ frame: string; width: number; height: number }>;
	input(handoffId: string, input: TakeoverInput): Promise<void>;
	end(handoffId: string): Promise<void>;
}

interface LocalApplyHandoffRun {
	envelope: Pick<LocalApplyTaskEnvelope, "runId" | "applicationId" | "browserProfile">;
	state: "running" | "paused" | "ended";
	pause?: { handoffRequestId?: string; reason?: string };
	ownerPauseReady?: boolean;
	browser?: { handoffPage?(): Page | null };
	handoff?: { handoffRequestId?: string; handoffId: string; expiresAt: number; state: "ready" | "closed"; terminalReason?: LocalApplyHandoffTerminalReason };
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,300}$/;
const HANDOFF_TTL_MS = 10 * 60 * 1000;

export interface LocalApplyHandoffHost {
	get(runId: string): LocalApplyHandoffRun;
	now(): number;
	takeover?: LocalApplyTakeoverAdapter;
	handoffTtlMs?: number;
}

/** Exact-page lifecycle only. It deliberately has no access to a bridge, browser credentials, or run output. */
export class LocalApplyHandoffRuntime<T extends LocalApplyHandoffRun> {
	private readonly opening = new Map<string, { handoffId: string; promise: Promise<LocalApplyHandoffStatus> }>();
	private readonly closing = new Map<string, Promise<void>>();
	private readonly inputs = new Map<string, Set<Promise<void>>>();
	constructor(private readonly host: Omit<LocalApplyHandoffHost, "get"> & { get(runId: string): T }) {}
	isBusy(run: T): boolean { return this.opening.has(run.envelope.runId) || this.closing.has(run.envelope.runId) || !!this.inputs.get(run.envelope.runId)?.size; }

	async handoff(raw: unknown): Promise<LocalApplyHandoffStatus> {
		const request = this.parse(raw);
		this.assertBinding(this.host.get(request.runId), request);
		const pending = this.opening.get(request.runId);
		if (pending) {
			if (pending.handoffId !== request.handoffId) throw new RunnerInputError("A handoff is being opened for this application run", 409);
			return pending.promise;
		}
		const promise = this.open(request);
		this.opening.set(request.runId, { handoffId: request.handoffId, promise });
		try { return await promise; } finally { this.opening.delete(request.runId); }
	}

	private async open(request: LocalApplyHandoffRequest): Promise<LocalApplyHandoffStatus> {
		const run = this.host.get(request.runId);
		this.assertBinding(run, request);
		if (run.state === "ended") return this.closed(run, request.handoffId, "run_ended");
		if (run.state !== "paused" || run.pause?.reason === "owner_requested" && !run.ownerPauseReady) throw new RunnerInputError("Owner control requires a paused run with settled native dispatch", 409);
		if (run.handoff?.handoffId === request.handoffId) return this.status(request);
		if (request.handoffRequestId && (run.state !== "paused" || request.handoffRequestId !== run.pause?.handoffRequestId)) throw new RunnerInputError("The handoff does not match the current pause", 409);
		if (run.pause?.handoffRequestId && request.handoffRequestId !== run.pause.handoffRequestId) throw new RunnerInputError("The handoff does not match the current pause", 409);
		if (run.handoff) {
			if (!request.handoffRequestId || request.handoffRequestId === run.handoff.handoffRequestId) throw new RunnerInputError("A handoff already exists for this application run", 409);
			await this.close(run, "unavailable");
		}
		if (!this.host.takeover) return this.closed(run, request.handoffId, "unavailable");
		const page = run.browser?.handoffPage?.();
		if (!page || page.isClosed()) return this.closed(run, request.handoffId, "page_lost");
		try {
			await this.host.takeover.open(request, page);
		} catch {
			return this.closed(run, request.handoffId, "profile_unavailable");
		}
		if (run.state !== "paused" || run.pause?.handoffRequestId !== request.handoffRequestId || page.isClosed()) {
			await this.host.takeover.end(request.handoffId).catch(() => undefined);
			return this.closed(run, request.handoffId, "unavailable");
		}
		run.handoff = { handoffId: request.handoffId, ...(request.handoffRequestId ? { handoffRequestId: request.handoffRequestId } : {}), expiresAt: this.host.now() + (this.host.handoffTtlMs ?? HANDOFF_TTL_MS), state: "ready" };
		return this.status(request);
	}

	async status(raw: unknown): Promise<LocalApplyHandoffStatus> {
		const request = this.parse(raw);
		const run = this.host.get(request.runId);
		this.assertBinding(run, request);
		if (run.state === "ended") return this.closed(run, request.handoffId, "run_ended");
		const handoff = run.handoff;
		if (!handoff || handoff.handoffId !== request.handoffId) return this.closed(run, request.handoffId, "unavailable");
		const current = () => run.handoff === handoff && run.state === "paused" && (!handoff.handoffRequestId || handoff.handoffRequestId === run.pause?.handoffRequestId);
		if (!current()) { await this.closeCaptured(run, handoff, "unavailable"); return this.response(run, handoff); }
		if (handoff.state === "closed") return this.response(run, handoff);
		if (handoff.expiresAt <= this.host.now()) await this.close(run, "expired");
		else {
			const state = await this.host.takeover?.state(handoff.handoffId);
			if (!current()) { await this.closeCaptured(run, handoff, "unavailable"); return this.response(run, handoff); }
			if (state !== "ready") await this.close(run, "page_lost");
		}
		return this.response(run, handoff);
	}

	async frame(raw: unknown): Promise<{ frame: string; width: number; height: number }> {
		const { run, handoff } = await this.live(raw);
		try {
			return await this.host.takeover!.frame(handoff.handoffId);
		} catch {
			await this.closeCaptured(run, handoff, "page_lost");
			throw new RunnerInputError("The handoff page is no longer available", 409);
		}
	}

	async input(raw: unknown): Promise<void> {
		const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
		const { run, handoff } = await this.live(o);
		const key = run.envelope.runId;
		if (run.state !== "paused" || run.handoff !== handoff || handoff.state !== "ready" || this.closing.has(key)) throw new RunnerInputError("The owner handoff changed before input dispatch", 409);
		if (!o.input || typeof o.input !== "object") throw new RunnerInputError("handoff input is required");
		let finish!: () => void;
		const pending = new Promise<void>(done => { finish = done; });
		const inputs = this.inputs.get(key) ?? new Set<Promise<void>>();
		this.inputs.set(key, inputs); inputs.add(pending);
		try {
			await this.host.takeover!.input(handoff.handoffId, o.input as TakeoverInput);
		} catch {
			void this.closeCaptured(run, handoff, "page_lost");
			throw new RunnerInputError("The handoff page is no longer available", 409);
		} finally { inputs.delete(pending); if (!inputs.size) this.inputs.delete(key); finish(); }
	}

	async end(raw: unknown): Promise<LocalApplyHandoffStatus> {
		const request = this.parse(raw);
		const run = this.host.get(request.runId);
		this.assertBinding(run, request);
		if (!run.handoff || run.handoff.handoffId !== request.handoffId) return this.closed(run, request.handoffId, "unavailable");
		await this.close(run, "unavailable");
		return this.response(run, run.handoff);
	}

	private parse(raw: unknown): LocalApplyHandoffRequest {
		const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
		const handoffId = typeof o.handoffId === "string" ? o.handoffId : "";
		const runId = typeof o.runId === "string" ? o.runId : "";
		const applicationId = typeof o.applicationId === "string" ? o.applicationId : "";
		const browserProfile = o.browserProfile === "default" || o.browserProfile === "isolated" ? o.browserProfile : null;
		if (!SAFE_ID.test(handoffId) || !SAFE_ID.test(runId) || !SAFE_ID.test(applicationId) || !browserProfile) throw new RunnerInputError("handoff needs opaque handoffId, runId, applicationId, and browserProfile");
		const handoffRequestId = typeof o.handoffRequestId === "string" && SAFE_ID.test(o.handoffRequestId) ? o.handoffRequestId : undefined;
		return { handoffId, runId, applicationId, browserProfile, ...(handoffRequestId ? { handoffRequestId } : {}) };
	}

	private assertBinding(run: LocalApplyHandoffRun, request: LocalApplyHandoffRequest): void {
		if (run.envelope.applicationId !== request.applicationId || run.envelope.browserProfile !== request.browserProfile) throw new RunnerInputError("The handoff does not match this application run", 403);
	}

	private response(run: LocalApplyHandoffRun, handoff: NonNullable<LocalApplyHandoffRun["handoff"]>): LocalApplyHandoffStatus {
		return { handoffId: handoff.handoffId, runId: run.envelope.runId, applicationId: run.envelope.applicationId, browserProfile: run.envelope.browserProfile, state: handoff.state, expiresAt: new Date(handoff.expiresAt).toISOString(), ...(handoff.terminalReason ? { terminalReason: handoff.terminalReason } : {}) };
	}

	private closed(run: LocalApplyHandoffRun, handoffId: string, terminalReason: LocalApplyHandoffTerminalReason): LocalApplyHandoffStatus {
		const handoff = { handoffId, expiresAt: this.host.now(), state: "closed" as const, terminalReason };
		if (run.handoff?.handoffId === handoffId) run.handoff = handoff;
		return this.response(run, handoff);
	}

	async close(run: T, reason: LocalApplyHandoffTerminalReason): Promise<void> {
		const key = run.envelope.runId;
		const previous = this.closing.get(key);
		if (previous) return previous;
		const handoff = run.handoff;
		if (!handoff || handoff.state === "closed") return;
		handoff.state = "closed";
		handoff.terminalReason = reason;
		const closing = (async () => {
			await Promise.all([...(this.inputs.get(key) ?? [])]);
			if (this.host.takeover) await this.host.takeover.end(handoff.handoffId).catch(() => undefined);
		})();
		this.closing.set(key, closing);
		try { await closing; } finally { this.closing.delete(key); }
	}
	private async closeCaptured(run: T, handoff: NonNullable<LocalApplyHandoffRun["handoff"]>, reason: LocalApplyHandoffTerminalReason): Promise<void> {
		if (run.handoff === handoff) return this.close(run, reason);
		handoff.state = "closed"; handoff.terminalReason = reason;
		await this.host.takeover?.end(handoff.handoffId).catch(() => undefined);
	}

	private async live(raw: unknown): Promise<{ run: T; handoff: NonNullable<LocalApplyHandoffRun["handoff"]> }> {
		const request = this.parse(raw);
		const status = await this.status(raw);
		if (status.state !== "ready") throw new RunnerInputError(`The handoff is closed (${status.terminalReason ?? "unavailable"})`, 409);
		const run = this.host.get(status.runId);
		if (run.state !== "paused" || run.handoff?.state !== "ready" || run.handoff.handoffId !== request.handoffId || run.handoff.handoffRequestId !== request.handoffRequestId || run.pause?.handoffRequestId !== request.handoffRequestId) throw new RunnerInputError("The exact owner handoff changed before use", 409);
		return { run, handoff: run.handoff! };
	}
}
