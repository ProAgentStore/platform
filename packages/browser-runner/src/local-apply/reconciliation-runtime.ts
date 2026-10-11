/**
 * Read-only reconciliation for an ended `submit_unconfirmed` attempt.
 *
 * This is intentionally independent of ApplyBridge: it launches no CLI, receives no source or
 * artifact paths and has no action surface capable of filling, uploading or submitting.  The only
 * page inspection remains in this process and returns a closed evidence vocabulary to PAGS.
 */
import { join } from "node:path";
import type { Page } from "playwright";
import { RunnerInputError } from "../errors.js";
import { domainWithin } from "../local-browser/bridge.js";
import type { TakeoverInput } from "../types.js";
import type { LocalApplyHandoffTerminalReason, LocalApplyProfile, LocalApplyReconciliationEnvelope, LocalApplyReconciliationHandoffRequest, LocalApplyReconciliationStatus } from "./contract.js";
import type { RunBrowser } from "./runtime.js";
import type { LocalApplyTakeoverAdapter } from "./runtime-handoff.js";

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,300}$/;
const TTL_MS = 10 * 60_000;

type Session = {
	envelope: LocalApplyReconciliationEnvelope;
	browser: RunBrowser;
	state: "running" | "paused" | "ended";
	expiresAt: number;
	pauseReason?: "login_required" | "captcha";
	result?: NonNullable<LocalApplyReconciliationStatus["result"]>;
	handoff?: { id: string; expiresAt: number; state: "ready" | "closed"; reason?: LocalApplyHandoffTerminalReason };
	cancelDeadline?: () => void;
	finishing?: Promise<LocalApplyReconciliationStatus>;
};

export interface ReconciliationRuntimeDeps {
	dataDir: string;
	browserFor(profile: LocalApplyProfile, runDir: string): Promise<RunBrowser>;
	takeover?: LocalApplyTakeoverAdapter;
	now?: () => number;
	/** Injectable so the deadline can be exercised without waiting ten minutes in tests. */
	schedule?: (task: () => void, delayMs: number) => () => void;
}

/** Dedicated runtime; there is deliberately no bridge, engine, or generic browser-task fallback. */
export class LocalApplyReconciliationRuntime {
	private readonly sessions = new Map<string, Session>();
	private readonly now: () => number;
	private readonly schedule: (task: () => void, delayMs: number) => () => void;
	constructor(private readonly deps: ReconciliationRuntimeDeps) {
		this.now = deps.now ?? (() => Date.now());
		this.schedule = deps.schedule ?? ((task, delayMs) => {
			const timer = setTimeout(task, delayMs);
			return () => clearTimeout(timer);
		});
	}

	async start(raw: unknown): Promise<LocalApplyReconciliationStatus> {
		const envelope = parseEnvelope(raw);
		const existing = this.sessions.get(envelope.reconciliationId);
		if (existing) {
			if (existing.envelope.runId !== envelope.runId || existing.envelope.applicationId !== envelope.applicationId || existing.envelope.instanceId !== envelope.instanceId || existing.envelope.browserProfile !== envelope.browserProfile) throw new RunnerInputError("The reconciliation id is already bound to another attempt", 409);
			return this.view(existing);
		}
		const browser = await this.deps.browserFor(envelope.browserProfile, join(this.deps.dataDir, "reconciliation", envelope.reconciliationId));
		const session: Session = { envelope, browser, state: "running", expiresAt: this.now() + TTL_MS };
		this.sessions.set(envelope.reconciliationId, session);
		// The deadline belongs to the Runner, not to Console polling.  It is installed before
		// navigation so an abandoned client cannot retain an owned browser/liveWork indefinitely.
		session.cancelDeadline = this.schedule(() => { void this.expire(session); }, TTL_MS);
		try {
			const page = this.page(session);
			if (!page) return await this.finish(session, { state: "unavailable", proofKind: "authorized_profile_unavailable" });
			await page.goto(envelope.applicationUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
			return await this.inspect(session);
		} catch {
			return this.finish(session, { state: "unavailable", proofKind: "authorized_profile_unavailable" });
		}
	}

	async status(raw: unknown): Promise<LocalApplyReconciliationStatus> {
		const session = this.require(raw);
		if (session.state === "ended") return this.view(session);
		if (session.expiresAt <= this.now()) return this.finish(session, { state: "ambiguous", proofKind: "ambiguous_site_history" });
		if (!this.page(session)) return this.finish(session, { state: "unavailable", proofKind: "authorized_profile_unavailable" });
		if (session.handoff?.state === "ready" && (session.handoff.expiresAt <= this.now() || !this.deps.takeover || await this.deps.takeover.state(session.handoff.id) !== "ready")) {
			await this.closeHandoff(session, session.handoff.expiresAt <= this.now() ? "expired" : "page_lost");
			return this.finish(session, { state: "unavailable", proofKind: "authorized_profile_unavailable" });
		}
		return this.view(session);
	}

	async handoff(raw: unknown): Promise<LocalApplyReconciliationStatus> {
		const request = this.handoffRequest(raw);
		const session = this.require(request);
		this.assertHandoffBinding(session, request);
		if (session.state !== "paused" || !session.pauseReason) throw new RunnerInputError("Reconciliation handoff is available only for a live login or CAPTCHA pause", 409);
		if (session.handoff) throw new RunnerInputError("A reconciliation handoff already exists", 409);
		const page = this.page(session);
		if (!page || !this.deps.takeover) return this.closedHandoff(session, request.handoffId, "profile_unavailable");
		try { await this.deps.takeover.open(request, page); }
		catch { return this.closedHandoff(session, request.handoffId, "page_lost"); }
		session.handoff = { id: request.handoffId, expiresAt: this.now() + TTL_MS, state: "ready" };
		return this.view(session);
	}

	async handoffFrame(raw: unknown): Promise<{ frame: string; width: number; height: number }> {
		const session = await this.liveHandoff(raw);
		try { return await this.deps.takeover!.frame(session.handoff!.id); }
		catch { await this.closeHandoff(session, "page_lost"); await this.finish(session, { state: "unavailable", proofKind: "authorized_profile_unavailable" }); throw new RunnerInputError("The reconciliation page is no longer available", 409); }
	}

	async handoffInput(raw: unknown): Promise<void> {
		const request = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
		const session = await this.liveHandoff(request);
		if (!request.input || typeof request.input !== "object") throw new RunnerInputError("handoff input is required");
		// A person may authenticate/solve a CAPTCHA, but once that wall is gone this session accepts
		// no further controls. It can never become an application fill/submit surface.
		const blocker = await this.blocker(this.page(session));
		if (!blocker) throw new RunnerInputError("The read-only reconciliation handoff no longer accepts browser input", 409);
		try { await this.deps.takeover!.input(session.handoff!.id, request.input as TakeoverInput); }
		catch { await this.closeHandoff(session, "page_lost"); await this.finish(session, { state: "unavailable", proofKind: "authorized_profile_unavailable" }); throw new RunnerInputError("The reconciliation page is no longer available", 409); }
	}

	async resume(raw: unknown): Promise<LocalApplyReconciliationStatus> {
		const session = await this.liveHandoff(raw);
		return this.inspect(session);
	}

	async end(raw: unknown): Promise<LocalApplyReconciliationStatus> {
		const request = this.handoffRequest(raw);
		const session = this.require(request);
		this.assertHandoffBinding(session, request);
		if (session.handoff?.id !== request.handoffId) throw new RunnerInputError("The reconciliation handoff is closed", 409);
		if (session.handoff?.state === "ready") await this.closeHandoff(session, "unavailable");
		return this.finish(session, { state: "ambiguous", proofKind: "ambiguous_site_history" });
	}

	liveWork(): string[] { return [...this.sessions.values()].filter((s) => s.state !== "ended").map((s) => `reconciliation:${s.envelope.reconciliationId}`); }
	closeAll(): void { for (const session of this.sessions.values()) void this.finish(session, { state: "unavailable", proofKind: "authorized_profile_unavailable" }); }

	private async inspect(session: Session): Promise<LocalApplyReconciliationStatus> {
		const page = this.page(session);
		if (!page) return this.finish(session, { state: "unavailable", proofKind: "authorized_profile_unavailable" });
		const state = await this.pageState(page).catch(() => null);
		if (!state || !this.permitted(session, state.url)) return this.finish(session, { state: "ambiguous", proofKind: "ambiguous_site_history" });
		if (state.login || state.captcha) { session.state = "paused"; session.pauseReason = state.captcha ? "captcha" : "login_required"; return this.view(session); }
		// A handoff which has just cleared authentication is the one case where we retain the
		// bounded browser.  It lets the owner inspect their authenticated account/job view without
		// turning generic page prose into an outcome.  Explicit end or the ten-minute deadline
		// resolves it as ambiguous unless a future provider-specific verifier supplies exact proof.
		if (session.handoff?.state === "ready") { session.state = "running"; session.pauseReason = undefined; return this.view(session); }
		// SEEK has no validated account/job receipt or history contract in this runtime. Generic
		// prose, receipt-like URLs, unauthenticated pages and absent receipts prove nothing.
		return this.finish(session, { state: "ambiguous", proofKind: "ambiguous_site_history" });
	}

	private async expire(session: Session): Promise<void> {
		if (session.state !== "ended" && session.expiresAt <= this.now()) await this.finish(session, { state: "ambiguous", proofKind: "ambiguous_site_history" });
	}

	private async finish(session: Session, result: NonNullable<LocalApplyReconciliationStatus["result"]>): Promise<LocalApplyReconciliationStatus> {
		if (session.finishing) return session.finishing;
		if (session.state === "ended") return this.view(session);
		// Set terminal state synchronously, before any async teardown.  Concurrent End/timeout/page
		// loss callers then converge on the same result and liveWork stops advertising ownership.
		session.state = "ended"; session.pauseReason = undefined; session.result = result;
		session.cancelDeadline?.(); session.cancelDeadline = undefined;
		session.finishing = (async () => {
			if (session.handoff?.state === "ready") await this.closeHandoff(session, "unavailable");
			await session.browser.stop().catch(() => undefined);
			return this.view(session);
		})();
		return session.finishing;
	}

	private async closeHandoff(session: Session, reason: LocalApplyHandoffTerminalReason): Promise<void> {
		if (!session.handoff || session.handoff.state === "closed") return;
		session.handoff.state = "closed"; session.handoff.reason = reason;
		await this.deps.takeover?.end(session.handoff.id).catch(() => undefined);
	}
	private async closedHandoff(session: Session, id: string, reason: LocalApplyHandoffTerminalReason): Promise<LocalApplyReconciliationStatus> {
		session.handoff = { id, expiresAt: this.now(), state: "closed", reason };
		return this.finish(session, { state: "unavailable", proofKind: "authorized_profile_unavailable" });
	}
	private page(session: Session): Page | null { const page = session.browser.handoffPage?.(); return page && !page.isClosed() ? page : null; }
	private permitted(session: Session, raw: string): boolean { try { const host = new URL(raw).hostname.toLowerCase(); return session.envelope.allowDomains.some((d) => domainWithin(host, d)); } catch { return false; } }
	private async blocker(page: Page | null): Promise<boolean> { const state = page ? await this.pageState(page).catch(() => null) : null; return !!state && (state.login || state.captcha); }
	private async pageState(page: Page): Promise<{ url: string; login: boolean; captcha: boolean }> {
		return page.evaluate(() => {
			const text = (document.body?.innerText ?? "").toLowerCase();
			const captcha = !!document.querySelector('iframe[src*="hcaptcha.com"], .h-captcha, iframe[src*="challenges.cloudflare.com"], .cf-turnstile, iframe[src*="arkoselabs"], .geetest_holder') || /confirm (that )?you('?re| are) not a robot|i'?m not a robot|verify (that )?you('?re| are) (a )?human|checking (if the site connection is secure|your browser)/.test(text);
			// Kept in the page: site prose never crosses the runner boundary.  This is deliberately
			// narrower than a guess; anything unrecognised becomes `ambiguous`.
			const password = !!document.querySelector("input[type=password]");
			const otp = !!document.querySelector("input[autocomplete='one-time-code'], input[name*='otp' i], input[name*='verification' i], input[id*='otp' i], input[id*='verification' i]");
			const emailSignIn = !!document.querySelector("form[action*='login' i] input[type=email], form[action*='sign-in' i] input[type=email], [data-auth-screen] input[type=email]");
			return { url: location.href, login: password || otp || emailSignIn, captcha };
		});
	}
	private require(raw: unknown): Session { const id = typeof (raw as Record<string, unknown> | null)?.reconciliationId === "string" ? (raw as Record<string, unknown>).reconciliationId as string : ""; if (!SAFE_ID.test(id)) throw new RunnerInputError("reconciliationId is required"); const session = this.sessions.get(id); if (!session) throw new RunnerInputError("Reconciliation session not found", 404); return session; }
	private handoffRequest(raw: unknown): LocalApplyReconciliationHandoffRequest { const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}; const handoffId = typeof o.handoffId === "string" ? o.handoffId : ""; const runId = typeof o.runId === "string" ? o.runId : ""; const applicationId = typeof o.applicationId === "string" ? o.applicationId : ""; const reconciliationId = typeof o.reconciliationId === "string" ? o.reconciliationId : ""; const browserProfile = o.browserProfile === "isolated" || o.browserProfile === "default" ? o.browserProfile : null; if (![handoffId, runId, applicationId, reconciliationId].every((v) => SAFE_ID.test(v)) || !browserProfile) throw new RunnerInputError("reconciliation handoff needs opaque ids and browserProfile"); return { handoffId, runId, applicationId, reconciliationId, browserProfile }; }
	private assertHandoffBinding(session: Session, request: LocalApplyReconciliationHandoffRequest): void { const e = session.envelope; if (e.reconciliationId !== request.reconciliationId || e.runId !== request.runId || e.applicationId !== request.applicationId || e.browserProfile !== request.browserProfile) throw new RunnerInputError("The reconciliation handoff does not match this exact attempt", 403); }
	private async liveHandoff(raw: unknown): Promise<Session> { const request = this.handoffRequest(raw); const session = this.require(request); this.assertHandoffBinding(session, request); if ((session.state !== "paused" && session.state !== "running") || session.handoff?.id !== request.handoffId || session.handoff.state !== "ready") throw new RunnerInputError("The reconciliation handoff is closed", 409); if (session.handoff.expiresAt <= this.now()) { await this.closeHandoff(session, "expired"); await this.finish(session, { state: "ambiguous", proofKind: "ambiguous_site_history" }); throw new RunnerInputError("The reconciliation handoff is closed", 409); } return session; }
	private view(session: Session): LocalApplyReconciliationStatus { const e = session.envelope; return { reconciliationId: e.reconciliationId, runId: e.runId, applicationId: e.applicationId, browserProfile: e.browserProfile, context: "separate_read_only_context", state: session.state, ...(session.pauseReason ? { pauseReason: session.pauseReason } : {}), ...(session.result ? { result: session.result } : {}) }; }
}

function parseEnvelope(raw: unknown): LocalApplyReconciliationEnvelope {
	const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
	const ids = ["reconciliationId", "runId", "instanceId", "applicationId"] as const;
	for (const key of ids) if (typeof o[key] !== "string" || !SAFE_ID.test(o[key] as string)) throw new RunnerInputError(`Invalid reconciliation: ${key} is required`);
	if (o.type !== "local_browser.apply.reconciliation" || (o.browserProfile !== "isolated" && o.browserProfile !== "default") || typeof o.applicationUrl !== "string" || !/^https?:\/\/[^\s/]+/i.test(o.applicationUrl)) throw new RunnerInputError("Invalid read-only reconciliation envelope");
	const allowDomains = Array.isArray(o.allowDomains) ? o.allowDomains.filter((d): d is string => typeof d === "string" && /^[a-z0-9.-]+$/i.test(d)).map((d) => d.toLowerCase()) : [];
	if (!allowDomains.length || typeof o.jobIdentity !== "string" || !o.materialFingerprint || typeof o.materialFingerprint !== "object") throw new RunnerInputError("Invalid reconciliation binding");
	return { type: o.type, reconciliationId: o.reconciliationId as string, runId: o.runId as string, instanceId: o.instanceId as string, applicationId: o.applicationId as string, browserProfile: o.browserProfile, applicationUrl: o.applicationUrl, allowDomains, jobIdentity: o.jobIdentity, materialFingerprint: o.materialFingerprint as LocalApplyReconciliationEnvelope["materialFingerprint"] };
}
