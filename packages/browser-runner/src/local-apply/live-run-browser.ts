import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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

/**
 * Launch a browser the runner itself owns and attach `McpRuntime` to it over CDP (#1419: every
 * browser the runner drives is launched BY the runner — `@playwright/mcp` only ever attaches, it
 * never launches or owns a profile directory). Shared by the persistent `isolated` apply profile
 * and any throwaway caller; the caller decides whether `profileDir` survives `stop()`.
 *
 * A persistent-context launch (not `.launch()`) either way: `launchPersistentContext` is what
 * exposes `--remote-debugging-port=0` + a `DevToolsActivePort` file to read back, which is how a
 * SEPARATE process (`@playwright/mcp`'s own Node process boundary inside `McpRuntime`) attaches to
 * THIS browser rather than launching its own. A throwaway caller just uses a fresh temp dir and
 * deletes it in its own `stop()`; nothing here assumes the dir is reused.
 */
export async function launchCdpBrowser(profileDir: string, headless: boolean): Promise<{
	context: BrowserContext;
	mcp: McpRuntime;
	/** The currently live page in this context, or null — tracks the newest page, never falls back to another tab once it closes (a lost page is terminal for a handoff). */
	activePage(): Page | null;
	stop(): Promise<void>;
}> {
	const playwright = await import("playwright");
	let context: BrowserContext | undefined;
	let mcp: McpRuntime | undefined;
	try {
		mkdirSync(profileDir, { recursive: true, mode: 0o700 });
		// A persistent profile keeps the LAST launch's port file; read before Chrome rewrites it, the
		// tools would attach to a dead port. Chrome writes a fresh one on every start.
		rmSync(join(profileDir, "DevToolsActivePort"), { force: true });
		context = await playwright.chromium.launchPersistentContext(profileDir, {
			headless,
			acceptDownloads: true,
			viewport: null,
			args: [
				"--disable-blink-features=AutomationControlled",
				"--start-maximized",
				"--window-size=1512,982",
				"--remote-debugging-port=0",
				"--use-fake-ui-for-media-stream",
				"--use-fake-device-for-media-stream",
			],
		});
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
		await mcp.start({ cdpEndpoint: await cdpEndpoint(profileDir) });
		const ctx = context;
		const startedMcp = mcp;
		let stopped = false;
		return {
			context: ctx,
			mcp: startedMcp,
			activePage: () => (activePage && !activePage.isClosed() ? activePage : null),
			stop: async () => {
				if (stopped) return;
				stopped = true;
				activePage = null;
				await startedMcp.stop().catch(() => undefined);
				await ctx.close().catch(() => undefined);
			},
		};
	} catch (error) {
		await mcp?.stop().catch(() => undefined);
		await context?.close().catch(() => undefined);
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
}): (profile: LocalApplyProfile, runDir: string) => Promise<RunBrowser> {
	return async (profile, runDir) => {
		const ledgerPath = join(applicationProfileDir(options.dataDir, profile), "site-sessions.json");
		if (profile === "isolated") return createPersistentApplyBrowser(join(applicationProfileDir(options.dataDir, profile), "browser"), ledgerPath, options.headless);
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
}): {
	browserFor(profile: LocalApplyProfile, runDir: string): Promise<RunBrowser>;
	applyBrowserFor(profile: LocalApplyProfile, runDir: string): Promise<RunBrowser>;
} {
	const browserFor = async (profile: LocalApplyProfile, runDir: string): Promise<RunBrowser> => {
		if (profile === "default") return { tools: await options.defaultTools(), handoffPage: options.sharedPage, stop: async () => undefined };
		// A throwaway browser for this run alone (#1419): a fresh temp dir, launched and attached
		// over CDP exactly like the persistent `isolated` profile above, deleted on stop — never
		// launched BY `@playwright/mcp` itself (the `McpRuntime.start` branch that did that, and its
		// own #274 orphan-cleanup, are gone; `reaper.ts` stays for other people's leftovers).
		const profileDir = join(runDir, "profile");
		const launched = await launchCdpBrowser(profileDir, options.headless);
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
export async function createPersistentApplyBrowser(profileDir: string, ledgerPath: string, headless: boolean): Promise<RunBrowser> {
	if (inUse.has(profileDir)) throw new Error("This machine's application browser profile is in use by another run; try again when it ends.");
	inUse.add(profileDir);
	try {
		const launched = await launchCdpBrowser(profileDir, headless);
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

async function cdpEndpoint(profileDir: string): Promise<string> {
	const portFile = join(profileDir, "DevToolsActivePort");
	for (let i = 0; i < 50; i++) {
		if (existsSync(portFile)) {
			const text = await import("node:fs/promises").then(({ readFile }) => readFile(portFile, "utf8"));
			const port = text.split("\n", 1)[0]?.trim();
			if (port) return `http://127.0.0.1:${port}`;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("could not read the local application browser CDP port");
}
