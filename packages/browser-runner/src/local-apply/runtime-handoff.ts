import { RunnerInputError } from "../errors.js";
import type { TakeoverInput } from "../types.js";
import type { LocalApplyHandoffRequest, LocalApplyHandoffStatus, LocalApplyHandoffTerminalReason, LocalApplyTaskEnvelope } from "./contract.js";

export interface LocalApplyTakeoverAdapter {
	open(request: LocalApplyHandoffRequest): Promise<void>;
	state(handoffId: string): Promise<"ready" | "page_lost">;
	frame(handoffId: string): Promise<{ frame: string; width: number; height: number }>;
	input(handoffId: string, input: TakeoverInput): Promise<void>;
	end(handoffId: string): Promise<void>;
}

interface LocalApplyHandoffRun {
	envelope: Pick<LocalApplyTaskEnvelope, "runId" | "applicationId" | "browserProfile">;
	state: "running" | "paused" | "ended";
	handoff?: { handoffId: string; expiresAt: number; state: "ready" | "closed"; terminalReason?: LocalApplyHandoffTerminalReason };
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
	constructor(private readonly host: Omit<LocalApplyHandoffHost, "get"> & { get(runId: string): T }) {}

	async handoff(raw: unknown): Promise<LocalApplyHandoffStatus> {
		const request = this.parse(raw);
		const run = this.host.get(request.runId);
		this.assertBinding(run, request);
		if (run.state === "ended") return this.closed(run, request.handoffId, "run_ended");
		if (run.handoff) throw new RunnerInputError("A handoff already exists for this application run", 409);
		if (!this.host.takeover) return this.closed(run, request.handoffId, "unavailable");
		try {
			await this.host.takeover.open(request);
		} catch {
			return this.closed(run, request.handoffId, "profile_unavailable");
		}
		run.handoff = { handoffId: request.handoffId, expiresAt: this.host.now() + (this.host.handoffTtlMs ?? HANDOFF_TTL_MS), state: "ready" };
		return this.status(request);
	}

	async status(raw: unknown): Promise<LocalApplyHandoffStatus> {
		const request = this.parse(raw);
		const run = this.host.get(request.runId);
		this.assertBinding(run, request);
		if (run.state === "ended") return this.closed(run, request.handoffId, "run_ended");
		const handoff = run.handoff;
		if (!handoff || handoff.handoffId !== request.handoffId) return this.closed(run, request.handoffId, "unavailable");
		if (handoff.state === "closed") return this.response(run, handoff);
		if (handoff.expiresAt <= this.host.now()) await this.close(run, "expired");
		else if (!this.host.takeover || (await this.host.takeover.state(handoff.handoffId)) !== "ready") await this.close(run, "page_lost");
		return this.response(run, run.handoff!);
	}

	async frame(raw: unknown): Promise<{ frame: string; width: number; height: number }> {
		const { run, handoff } = await this.live(raw);
		try {
			return await this.host.takeover!.frame(handoff.handoffId);
		} catch {
			await this.close(run, "page_lost");
			throw new RunnerInputError("The handoff page is no longer available", 409);
		}
	}

	async input(raw: unknown): Promise<void> {
		const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
		const { run, handoff } = await this.live(o);
		if (!o.input || typeof o.input !== "object") throw new RunnerInputError("handoff input is required");
		try {
			await this.host.takeover!.input(handoff.handoffId, o.input as TakeoverInput);
		} catch {
			await this.close(run, "page_lost");
			throw new RunnerInputError("The handoff page is no longer available", 409);
		}
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
		return { handoffId, runId, applicationId, browserProfile };
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
		const handoff = run.handoff;
		if (!handoff || handoff.state === "closed") return;
		handoff.state = "closed";
		handoff.terminalReason = reason;
		if (this.host.takeover) await this.host.takeover.end(handoff.handoffId).catch(() => undefined);
	}

	private async live(raw: unknown): Promise<{ run: T; handoff: NonNullable<LocalApplyHandoffRun["handoff"]> }> {
		const status = await this.status(raw);
		if (status.state !== "ready") throw new RunnerInputError(`The handoff is closed (${status.terminalReason ?? "unavailable"})`, 409);
		const run = this.host.get(status.runId);
		return { run, handoff: run.handoff! };
	}
}
