import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { launchRunnerBrowser, type BrowserLaunchOptions, type BrowserLaunchReceipt } from "../browser-launch.js";
import type { BrowserContext, Page } from "playwright";
import { McpRuntime } from "../mcp-runtime.js";
import type { LocalApplyProfile } from "./contract.js";
import type { RunBrowser } from "./runtime.js";
import { type CookieReader, SiteSessionLedger } from "./site-session.js";

/**
 * Where an application profile lives on this machine (#1094) — documented in
 * `APPLICATION_PROFILES.md` so the owner can find and inspect it:
 *
 *   <dataDir>/application-profiles/<profile>/site-sessions.json   which sites it is signed in to (no values)
 *   <dataDir>/application-profiles/isolated/browser/              the `isolated` profile's browser data
 *
 * The `default` profile's browser data is the runner's own browser (`<dataDir>/chrome-profile`, or
 * the private real-profile copy), which already persisted; only its ledger lives here.
 */
export function applicationProfileDir(dataDir: string, profile: LocalApplyProfile): string {
	return join(dataDir, "application-profiles", profile);
}

/**
 * One run at a time per on-disk profile. Chrome locks a user-data-dir to one process, so a second
 * launch on the same directory would fail obscurely; this says what is happening instead.
 */
const inUse = new Set<string>();

/** Runner-owned browser attached directly to MCP. The legacy export name remains for callers (#1431). */
export async function launchCdpBrowser(profileDir: string, headless: boolean, options?: Partial<BrowserLaunchOptions>): Promise<{
	context: BrowserContext;
	profileDir: string;
	receipt: BrowserLaunchReceipt;
	mcp: McpRuntime;
	/** The currently live page in this context, or null — tracks the newest page, never falls back to another tab once it closes (a lost page is terminal for a handoff). */
	activePage(): Page | null;
	stop(): Promise<void>;
}> {
	let launched: Awaited<ReturnType<typeof launchRunnerBrowser>> | undefined;
	let context: BrowserContext | undefined;
	let mcp: McpRuntime | undefined;
	try {
		launched = await launchRunnerBrowser({ headless, profilePolicy: "persistent", preference: "isolated", profileRoot: dirname(profileDir), persistentDir: profileDir, ...options });
		context = launched.context;
		await context.addInitScript(() => {
			Object.defineProperty(navigator, "webdriver", { get: () => undefined });
		}).catch(() => undefined);
		let activePage: Page | null = null;
		const track = (page: Page) => {
			activePage = page;
			// Never fall back to another tab after the exact page closes: that would hand a
			// person a different site/page. A lost page is terminal for this handoff.
			page.once("close", () => {
				if (activePage === page) activePage = null;
			});
		};
		context.on("page", track);
		const initial = context.pages().at(-1) ?? await context.newPage();
		track(initial);
		mcp = new McpRuntime();
		await mcp.start({ context });
		const ctx = context;
		const owned = launched;
		const startedMcp = mcp;
		let stopped = false;
		return {
			context: ctx,
			profileDir: owned.profileDir,
			receipt: owned.receipt,
			mcp: startedMcp,
			activePage: () => (activePage && !activePage.isClosed() ? activePage : null),
			stop: async () => {
				if (stopped) return;
				stopped = true;
				activePage = null;
				await startedMcp.stop().catch(() => undefined);
				await owned.stop();
			},
		};
	} catch (error) {
		await mcp?.stop().catch(() => undefined);
		await launched?.stop().catch(() => undefined);
		throw error;
	}
}

/** Bind application handoff to the run browser, not to the runner-wide active page. */
export function createLocalApplyBrowserFactory(options: {
	headless: boolean;
	dataDir: string;
	defaultBrowser(profile: "default", runDir: string): Promise<RunBrowser>;
	defaultCookies: CookieReader;
	sharedPage(): Page | null;
	onLaunch?: (receipt: BrowserLaunchReceipt) => void;
}): (profile: LocalApplyProfile, runDir: string) => Promise<RunBrowser> {
	return async (profile, runDir) => {
		const ledgerPath = join(applicationProfileDir(options.dataDir, profile), "site-sessions.json");
		if (profile === "isolated") return createPersistentApplyBrowser(join(applicationProfileDir(options.dataDir, profile), "browser"), ledgerPath, options.headless, options.onLaunch);
		const browser = await options.defaultBrowser(profile, runDir);
		return { ...browser, handoffPage: options.sharedPage, sessions: new SiteSessionLedger(ledgerPath, options.defaultCookies) };
	};
}

/**
 * Keep local-apply's browser construction out of `runner.ts`: research uses the generic factory,
 * while application runs get a page-owning persistent context for the scoped handoff.
 */
export function createRunnerBrowserFactories(options: {
	headless: boolean;
	dataDir: string;
	defaultTools(): Promise<RunBrowser["tools"]>;
	defaultCookies: CookieReader;
	sharedPage(): Page | null;
	onLaunch?: (receipt: BrowserLaunchReceipt) => void;
}): {
	browserFor(profile: LocalApplyProfile, runDir: string): Promise<RunBrowser>;
	applyBrowserFor(profile: LocalApplyProfile, runDir: string): Promise<RunBrowser>;
} {
	const browserFor = async (profile: LocalApplyProfile, runDir: string): Promise<RunBrowser> => {
		if (profile === "default") return { tools: await options.defaultTools(), handoffPage: options.sharedPage, stop: async () => undefined };
		// A throwaway browser for this run alone (#1419): a fresh temp dir, launched and attached
		// directly to MCP like the persistent `isolated` profile above, deleted on stop — never
		// launched BY `@playwright/mcp` itself (the `McpRuntime.start` branch that did that, and its
		// own #274 orphan-cleanup, are gone; `reaper.ts` stays for other people's leftovers).
		const profileDir = join(runDir, "profile");
		const launched = await launchCdpBrowser(profileDir, options.headless, { profilePolicy: "ephemeral", profileRoot: runDir, persistentDir: undefined, onLaunch: options.onLaunch });
		return {
			tools: launched.mcp,
			secrets: launched.mcp,
			handoffPage: launched.activePage,
			stop: async () => {
				await launched.stop();
				rmSync(profileDir, { recursive: true, force: true });
			},
		};
	};
	return {
		browserFor,
		applyBrowserFor: createLocalApplyBrowserFactory({
			headless: options.headless,
			dataDir: options.dataDir,
			defaultBrowser: browserFor,
			defaultCookies: options.defaultCookies,
			sharedPage: options.sharedPage,
			onLaunch: options.onLaunch,
		}),
	};
}

/**
 * Start the application browser on this machine's PERSISTENT `isolated` profile (#1094) and retain
 * only its current live page for the bounded takeover adapter.
 *
 * Until #1094 this was the run's throwaway `runDir/profile`, deleted with the run, so a sign-in the
 * owner completed in one run was gone by the next and every SEEK run bounced to its sign-in page.
 * The profile is still never seeded from, copied to, or shared with the owner's everyday browser: it
 * is a dedicated application browser that now remembers its own sign-ins, like a normal browser.
 */
export async function createPersistentApplyBrowser(profileDir: string, ledgerPath: string, headless: boolean, onLaunch?: (receipt: BrowserLaunchReceipt) => void): Promise<RunBrowser> {
	if (inUse.has(profileDir)) throw new Error("This machine's application browser profile is in use by another run; try again when it ends.");
	inUse.add(profileDir);
	try {
		const launched = await launchCdpBrowser(profileDir, headless, { onLaunch });
		const context = launched.context;
		return {
			tools: launched.mcp,
			secrets: launched.mcp,
			handoffPage: launched.activePage,
			sessions: new SiteSessionLedger(ledgerPath, async () => (await context.cookies()).map((c) => ({ name: c.name, domain: c.domain, expires: c.expires }))),
			stop: async () => {
				await launched.stop();
				inUse.delete(profileDir);
			},
		};
	} catch (error) {
		inUse.delete(profileDir);
		throw error;
	}
}


/** Explicit settings use a clean managed profile; the caller resolves legacy profile aliases first. */
export async function createConfiguredRunBrowser(options: BrowserLaunchOptions, withLedger = false): Promise<RunBrowser> {
	const launched = await launchCdpBrowser(join(options.profileRoot, "managed"), options.headless, { ...options, persistentDir: undefined });
	return {
		tools: launched.mcp,
		secrets: launched.mcp,
		handoffPage: launched.activePage,
		...(withLedger ? { sessions: new SiteSessionLedger(join(launched.profileDir, "pags-site-sessions.json"), async () => (await launched.context.cookies()).map((c) => ({ name: c.name, domain: c.domain, expires: c.expires }))) } : {}),
		stop: () => launched.stop(),
	};
}
