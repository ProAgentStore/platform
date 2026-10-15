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
		if (profile === "default") return { tools: await options.defaultTools(), stop: async () => undefined };
		const mcp = new McpRuntime();
		await mcp.start({ userDataDir: join(runDir, "profile"), headless: options.headless });
		return { tools: mcp, stop: () => mcp.stop() };
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
	const playwright = await import("playwright");
	let context: BrowserContext | undefined;
	let mcp: McpRuntime | undefined;
	let activePage: Page | null = null;
	let stopped = false;
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
		return {
			tools: mcp,
			handoffPage: () => activePage && !activePage.isClosed() ? activePage : null,
			sessions: new SiteSessionLedger(ledgerPath, async () => (await ctx.cookies()).map((c) => ({ name: c.name, domain: c.domain, expires: c.expires }))),
			stop: async () => {
				if (stopped) return;
				stopped = true;
				activePage = null;
				await mcp!.stop().catch(() => undefined);
				await context!.close().catch(() => undefined);
				inUse.delete(profileDir);
			},
		};
	} catch (error) {
		await mcp?.stop().catch(() => undefined);
		await context?.close().catch(() => undefined);
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
