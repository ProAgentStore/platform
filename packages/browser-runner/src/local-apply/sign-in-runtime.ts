/**
 * A post-run site sign-in in this machine's application browser profile (#1100).
 *
 * #1094 made the profile persistent and pauses a fill `login_required` before an uncertain press, so
 * the owner signs in once through the fill's handoff. But that handoff exists only while the fill is
 * paused. The reported run (9a7d9e85) paused at 11:32, nobody reached it before the run's 20-minute
 * limit, and it ended `blocked` at 11:53; the owner asked to take over at 11:57 — when there was no
 * paused fill, no retained page, and so nothing to stream. Every later fill would bounce off the same
 * sign-in, because the only way to sign in had closed with the run.
 *
 * This opens the profile itself at the job's site, with no run: the owner signs in there, and `end`
 * with `complete` records the sign-in in the profile's ledger (names and expiry only) so the next
 * fill's session gate passes. It has no engine, no bridge, no source and no submit gate — the page is
 * for a person, and nothing here fills or presses anything.
 */
import { join } from "node:path";
import type { Page } from "playwright";
import { RunnerInputError } from "../errors.js";
import type { TakeoverInput } from "../types.js";
import type { LocalApplyHandoffTerminalReason, LocalApplyProfile, LocalApplySignInRequest, LocalApplySignInStatus } from "./contract.js";
import type { RunBrowser } from "./runtime.js";
import type { LocalApplyTakeoverAdapter } from "./runtime-handoff.js";
import { siteKeyOf } from "./site-session.js";

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,300}$/;
/** As long as the durable takeover it serves (`TAKEOVER_TTL_MS` in the Worker). */
const TTL_MS = 60 * 60_000;

type Session = {
	request: LocalApplySignInRequest;
	site: string;
	browser: RunBrowser;
	state: "ready" | "closed";
	expiresAt: number;
	terminalReason?: LocalApplyHandoffTerminalReason;
	signedIn?: { fingerprint: number; verifiable: boolean };
	cancelDeadline?: () => void;
};

export interface SignInRuntimeDeps {
	dataDir: string;
	browserFor(profile: LocalApplyProfile, runDir: string): Promise<RunBrowser>;
	takeover?: LocalApplyTakeoverAdapter;
	/** True while an application run owns this machine's application browser. */
	busy(): boolean;
	now?: () => number;
	/** Injectable so the deadline can be exercised without waiting an hour in tests. */
	schedule?: (task: () => void, delayMs: number) => () => void;
}

export class LocalApplySignInRuntime {
	private readonly sessions = new Map<string, Session>();
	private readonly now: () => number;
	private readonly schedule: (task: () => void, delayMs: number) => () => void;
	constructor(private readonly deps: SignInRuntimeDeps) {
		this.now = deps.now ?? (() => Date.now());
		this.schedule = deps.schedule ?? ((task, delayMs) => {
			const timer = setTimeout(task, delayMs);
			return () => clearTimeout(timer);
		});
	}

	/**
	 * Open the profile at the job's site, or read back the one already open under this id. Idempotent,
	 * so the cloud may call it whenever a frame finds no live page: a page the owner closed is reported
	 * closed, and a runner restart (nothing in memory) simply opens it again.
	 */
	async open(raw: unknown): Promise<LocalApplySignInStatus> {
		const request = parseRequest(raw);
		const existing = this.sessions.get(request.signInId);
		if (existing) {
			if (existing.request.browserProfile !== request.browserProfile || existing.request.url !== request.url) throw new RunnerInputError("The sign-in id is already bound to another profile or site", 409);
			if (existing.state === "ready" && !(await this.pageLive(existing))) await this.close(existing, "page_lost");
			// A finished sign-in is an answer and is read back; one that closed without one (the owner
			// closed the tab, the deadline passed) opens again — the cloud asks only under a live takeover.
			if (existing.state === "ready" || existing.signedIn) return this.view(existing);
			this.sessions.delete(request.signInId);
		}
		for (const [id, s] of this.sessions) if (s.state === "closed" && s.expiresAt <= this.now()) this.sessions.delete(id);
		if ([...this.sessions.values()].some((s) => s.state === "ready" && s.request.browserProfile === request.browserProfile)) throw new RunnerInputError("Another sign-in is already open in this application browser; finish it first.", 409);
		// The `default` profile's page is the runner's own browser page; never navigate it from under a run.
		if (this.deps.busy()) throw new RunnerInputError("An application run is using this machine's application browser; sign in when it ends.", 409);
		const site = siteKeyOf(new URL(request.url).hostname);
		const takeover = this.deps.takeover;
		let browser: RunBrowser;
		try {
			if (!takeover) throw new Error("no takeover");
			browser = await this.deps.browserFor(request.browserProfile, join(this.deps.dataDir, "sign-in", request.signInId));
		} catch {
			return this.closedView(request, site, "profile_unavailable");
		}
		const session: Session = { request, site, browser, state: "ready", expiresAt: this.now() + TTL_MS };
		this.sessions.set(request.signInId, session);
		session.cancelDeadline = this.schedule(() => void this.close(session, "expired"), TTL_MS);
		const page = this.page(session);
		if (!page) {
			await this.close(session, "profile_unavailable");
			return this.view(session);
		}
		await browser.sessions?.beginSignIn(site).catch(() => undefined);
		// A slow or redirecting site still leaves a page the owner can use; only a lost page is terminal.
		await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
		try {
			await takeover!.open({ handoffId: request.signInId }, page);
		} catch {
			await this.close(session, "page_lost");
		}
		return this.view(session);
	}

	async frame(raw: unknown): Promise<{ frame: string; width: number; height: number }> {
		const session = await this.live(raw);
		try {
			return await this.deps.takeover!.frame(session.request.signInId);
		} catch {
			await this.close(session, "page_lost");
			throw new RunnerInputError("The sign-in page is no longer available", 409);
		}
	}

	async input(raw: unknown): Promise<void> {
		const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const session = await this.live(o);
		if (!o.input || typeof o.input !== "object") throw new RunnerInputError("sign-in input is required");
		try {
			await this.deps.takeover!.input(session.request.signInId, o.input as TakeoverInput);
		} catch {
			await this.close(session, "page_lost");
			throw new RunnerInputError("The sign-in page is no longer available", 409);
		}
	}

	/** Close it. `complete: true` is the owner saying they signed in: the ledger records it first. */
	async end(raw: unknown): Promise<LocalApplySignInStatus> {
		const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const session = this.require(o);
		if (session.state === "ready" && o.complete === true) {
			const recorded = await session.browser.sessions?.completeSignIn(session.site).catch(() => null);
			if (recorded) session.signedIn = recorded;
		}
		await this.close(session, session.signedIn ? undefined : "unavailable");
		return this.view(session);
	}

	liveWork(): string[] {
		return [...this.sessions.values()].filter((s) => s.state === "ready").map((s) => `sign-in:${s.request.signInId}`);
	}

	closeAll(): void {
		for (const session of this.sessions.values()) void this.close(session, "runner_restarted");
	}

	private async close(session: Session, reason: LocalApplyHandoffTerminalReason | undefined): Promise<void> {
		if (session.state === "closed") return;
		// Terminal synchronously, so a deadline racing an `end` cannot tear down twice.
		session.state = "closed";
		session.terminalReason = reason;
		session.cancelDeadline?.();
		session.cancelDeadline = undefined;
		await this.deps.takeover?.end(session.request.signInId).catch(() => undefined);
		await session.browser.stop().catch(() => undefined);
	}

	private async live(raw: unknown): Promise<Session> {
		const session = this.require(raw);
		if (session.state === "ready" && session.expiresAt <= this.now()) await this.close(session, "expired");
		if (session.state === "ready" && !(await this.pageLive(session))) await this.close(session, "page_lost");
		if (session.state !== "ready") throw new RunnerInputError(`The sign-in is closed (${session.terminalReason ?? "finished"})`, 409);
		return session;
	}

	private async pageLive(session: Session): Promise<boolean> {
		return !!this.page(session) && (await this.deps.takeover?.state(session.request.signInId)) === "ready";
	}

	private page(session: Session): Page | null {
		const page = session.browser.handoffPage?.();
		return page && !page.isClosed() ? page : null;
	}

	private require(raw: unknown): Session {
		const id = (raw as Record<string, unknown> | null)?.signInId;
		if (typeof id !== "string" || !SAFE_ID.test(id)) throw new RunnerInputError("signInId is required");
		const session = this.sessions.get(id);
		if (!session) throw new RunnerInputError("Sign-in not found", 404);
		return session;
	}

	private view(session: Session): LocalApplySignInStatus {
		return {
			signInId: session.request.signInId,
			browserProfile: session.request.browserProfile,
			site: session.site,
			state: session.state,
			expiresAt: new Date(session.expiresAt).toISOString(),
			...(session.terminalReason ? { terminalReason: session.terminalReason } : {}),
			...(session.signedIn ? { signedIn: session.signedIn } : {}),
		};
	}

	private closedView(request: LocalApplySignInRequest, site: string, terminalReason: LocalApplyHandoffTerminalReason): LocalApplySignInStatus {
		return { signInId: request.signInId, browserProfile: request.browserProfile, site, state: "closed", expiresAt: new Date(this.now()).toISOString(), terminalReason };
	}
}

/** Separate from the fill's handoff and from reconciliation: this surface has no fill or submit operation. */
export async function routeLocalApplySignIn(runtime: LocalApplySignInRuntime, method: string | undefined, path: string, read: () => Promise<unknown>): Promise<unknown | undefined> {
	if (method !== "POST") return undefined;
	if (path === "/local-apply/sign-in") return runtime.open(await read());
	if (path === "/local-apply/sign-in/frame") return runtime.frame(await read());
	if (path === "/local-apply/sign-in/input") {
		await runtime.input(await read());
		return { ok: true };
	}
	if (path === "/local-apply/sign-in/end") return runtime.end(await read());
	return undefined;
}

function parseRequest(raw: unknown): LocalApplySignInRequest {
	const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const signInId = typeof o.signInId === "string" ? o.signInId : "";
	const browserProfile = o.browserProfile === "default" || o.browserProfile === "isolated" ? o.browserProfile : null;
	const url = typeof o.url === "string" ? o.url : "";
	let ok = false;
	try {
		const u = new URL(url);
		ok = u.protocol === "https:" || u.protocol === "http:";
	} catch {
		ok = false;
	}
	if (!SAFE_ID.test(signInId) || !browserProfile || !ok) throw new RunnerInputError("sign-in needs an opaque signInId, a browserProfile and an http(s) url");
	return { signInId, browserProfile, url };
}
