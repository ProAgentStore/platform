import { BROWSER_ENGINES, type BrowserEngine, type BrowserLaunchReceipt, type BrowserProfilePolicy } from "./browser-launch.js";
import { seedAgentBrowserProfiles } from "./browser-profile.js";
import { BrowserCallRecorder } from "./browser-call-recorder.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { McpRuntime } from "./mcp-runtime.js";
import { RunnerInputError } from "./errors.js";
import { createConfiguredRunBrowser, createRunnerBrowserFactories } from "./local-apply/live-run-browser.js";
import type { LocalApplyProfile } from "./local-apply/contract.js";
import type { RunBrowser } from "./local-apply/runtime.js";

export type BrowserMode = "headed" | "headless";
export interface BrowserSession {
	instanceId?: string;
	dataDir: string;
	headless: boolean;
	engine?: BrowserEngine;
	profilePolicy?: BrowserProfilePolicy;
	launch?: BrowserLaunchReceipt;
	stopBrowser?: () => Promise<void>;
	context: BrowserContext | null;
	/** The brain and human takeover follow the same live tab within this agent. */
	activePage: Page | null;
	/** Standard Playwright MCP attaches directly to this session's browser. */
	mcp: McpRuntime | null;
	applyResumePath: string | null;
	resumeTaskId?: string;
	suppressAutoAttach: boolean;
	launching?: Promise<BrowserContext>;
	startingMcp?: Promise<McpRuntime>;
	taskIds: Set<string>;
	leases: number;
	calls: BrowserCallRecorder;
}

/** Each agent owns its browser and launch mode; process flags are only the legacy fallback (#1429). */
export class BrowserSessions {
	private readonly scope = new AsyncLocalStorage<BrowserSession>();
	private readonly sessions = new Map<string, BrowserSession>();
	private readonly pending = new Map<string, Promise<unknown>>();
	constructor(private readonly dataDir: string, private readonly fallbackHeadless: boolean, private readonly taskLive: (id: string) => boolean, private readonly localLive: (instanceId?: string) => boolean = () => false) {}

	get current(): BrowserSession { return this.scope.getStore() ?? this.session(); }
	private session(instanceId?: string): BrowserSession {
		const key = instanceId ?? "";
		let session = this.sessions.get(key);
		if (!session) {
			session = { instanceId, dataDir: instanceId ? join(this.dataDir, "agent-browsers", createHash("sha256").update(instanceId).digest("hex")) : this.dataDir, headless: this.fallbackHeadless, context: null, activePage: null, mcp: null, stopBrowser: undefined, applyResumePath: null, suppressAutoAttach: false, taskIds: new Set(), leases: 0, calls: new BrowserCallRecorder() };
			this.sessions.set(key, session);
		}
		return session;
	}

	/** Serialize each agent's browser requests; different agents remain independent. */
	run<T>(instanceId: string | undefined, mode: unknown, newRun: boolean, fn: () => Promise<T>, configure = true, settings: { engine?: unknown; profilePolicy?: unknown } = {}): Promise<T> {
		if (mode !== undefined && mode !== "headed" && mode !== "headless") return Promise.reject(new RunnerInputError("Browser mode must be headed or headless"));
		if (settings.engine !== undefined && !BROWSER_ENGINES.includes(settings.engine as BrowserEngine)) return Promise.reject(new RunnerInputError("Unsupported browser engine"));
		if (settings.profilePolicy !== undefined && settings.profilePolicy !== "persistent" && settings.profilePolicy !== "ephemeral") return Promise.reject(new RunnerInputError("Browser profile policy must be persistent or ephemeral"));
		const key = instanceId ?? "";
		if (!configure) return this.scope.run(this.session(instanceId), fn);
		const next = (this.pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
			const state = this.session(instanceId);
			const desired = mode === undefined ? this.fallbackHeadless : mode === "headless";
			const busy = this.localLive(instanceId) || state.leases > 0 || [...state.taskIds].some(this.taskLive);
			const changed = desired !== state.headless || settings.engine !== state.engine || settings.profilePolicy !== state.profilePolicy;
			if (busy && newRun) throw new RunnerInputError("This agent's browser is still in use. A new run can start after the current task finishes.", 409, "busy");
			if (newRun && !busy && !changed && state.profilePolicy === "ephemeral") await this.closeSession(state);
			if (changed && !busy) { await this.closeSession(state); state.headless = desired; state.engine = settings.engine as BrowserEngine | undefined; state.profilePolicy = settings.profilePolicy as BrowserProfilePolicy | undefined; }

			return this.scope.run(state, fn);
		});
		this.pending.set(key, next);
		void next.finally(() => { if (this.pending.get(key) === next) this.pending.delete(key); }).catch(() => undefined);
		return next;
	}

	bind<T extends unknown[], R>(fn: (...args: T) => R): (...args: T) => R {
		const state = this.current;
		return (...args) => this.scope.run(state, () => fn(...args));
	}

	/** Every legacy tool request must belong to the task holding this browser, including chat. */
	assertTaskAccess(taskId?: string): void {
		const state = this.current;
		if (state.leases > 0 || this.localLive(state.instanceId) || [...state.taskIds].some((id) => this.taskLive(id) && id !== taskId)) {
			throw new RunnerInputError("This agent's browser is owned by another active task. Unattributed or unrelated browser calls cannot use it.", 409);
		}
	}

	/** Local engines retain their launch scope across bridge requests and later resumes. */
	async browserFor(profile: LocalApplyProfile, runDir: string, apply: boolean, tools: () => Promise<McpRuntime>, context: () => Promise<BrowserContext>): Promise<RunBrowser> {
		const state = this.current;
		if (state.leases > 0 || [...state.taskIds].some(this.taskLive)) throw new RunnerInputError("This agent's browser is still in use by another task.", 409, "busy");
		state.leases++;
		try {
			let browser: RunBrowser;
			if (state.engine || state.profilePolicy) {
				await this.closeSession(state);
				const policy = state.profilePolicy ?? (profile === "isolated" && !apply ? "ephemeral" : "persistent");
				browser = await createConfiguredRunBrowser({ headless: state.headless, engine: state.engine, profilePolicy: policy, preference: profile === "default" ? "default" : "isolated", profileRoot: state.dataDir, onLaunch: (receipt) => { state.launch = receipt; } }, apply);
			} else {
				if (profile === "default" || apply) seedAgentBrowserProfiles(this.dataDir, state.dataDir, profile);
				const factories = createRunnerBrowserFactories({ headless: state.headless, dataDir: state.dataDir, defaultTools: this.bind(tools), defaultCookies: this.bind(async () => (await (await context()).cookies()).map((c) => ({ name: c.name, domain: c.domain, expires: c.expires }))), sharedPage: () => state.activePage, onLaunch: (receipt) => { state.launch = receipt; } });
				browser = await (apply ? factories.applyBrowserFor : factories.browserFor)(profile, runDir);
			}

			let stopped = false;
			return { ...browser, stop: async () => {
				if (stopped) return; stopped = true;
				try { await browser.stop(); }
				catch (error) {
					// A failed borrowed-runtime reset must not leave a dead/full cached client for the next task.
					if (state.mcp === browser.tools) await this.closeSession(state).catch(() => undefined);
					throw error;
				} finally { state.leases--; }
			} };
		} catch (error) { state.leases--; throw error; }
	}

	private async closeSession(state: BrowserSession): Promise<void> {
		await state.startingMcp?.catch(() => undefined);
		await state.launching?.catch(() => undefined);
		const mcp = state.mcp;
		const stopBrowser = state.stopBrowser;
		const context = state.context;
		// Detach once before close events fire. MCP teardown can wait on a live page;
		// closing its caller-owned browser concurrently releases that wait.
		Object.assign(state, { context: null, activePage: null, mcp: null, stopBrowser: undefined, applyResumePath: null, resumeTaskId: undefined, suppressAutoAttach: false });
		await Promise.allSettled([mcp?.stop(), stopBrowser ? stopBrowser() : context?.close()]);
	}
	/** A terminal workflow releases its ephemeral profile; waiting/human handoffs retain it. */
	async finish(): Promise<void> {
		const state = this.current;
		if (![...state.taskIds].some(this.taskLive)) { state.applyResumePath = null; state.resumeTaskId = undefined; }
		if (state.profilePolicy === "ephemeral" && state.leases === 0 && ![...state.taskIds].some(this.taskLive)) await this.closeSession(state);
	}
	managed(): boolean { return !!(this.current.engine || this.current.profilePolicy); }
	sessionReceipt(): { launch: BrowserLaunchReceipt | null } { return { launch: this.current.launch ?? null }; }
	async close(): Promise<void> { await Promise.all([...this.sessions.values()].map((state) => this.closeSession(state))); }
}
