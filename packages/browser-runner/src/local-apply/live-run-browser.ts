import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { McpRuntime } from "../mcp-runtime.js";
import type { LocalApplyProfile } from "./contract.js";
import type { RunBrowser } from "./runtime.js";

/** Bind application handoff to the run browser, not to the runner-wide active page. */
export function createLocalApplyBrowserFactory(options: {
	headless: boolean;
	defaultBrowser(profile: "default", runDir: string): Promise<RunBrowser>;
	sharedPage(): Page | null;
}): (profile: LocalApplyProfile, runDir: string) => Promise<RunBrowser> {
	return async (profile, runDir) => {
		if (profile === "isolated") return createIsolatedApplyBrowser(runDir, options.headless);
		const browser = await options.defaultBrowser(profile, runDir);
		return { ...browser, handoffPage: options.sharedPage };
	};
}

/**
 * Keep local-apply's browser construction out of `runner.ts`: research uses the generic factory,
 * while application runs get a page-owning isolated context for the scoped handoff.
 */
export function createRunnerBrowserFactories(options: {
	headless: boolean;
	defaultTools(): Promise<RunBrowser["tools"]>;
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
	return { browserFor, applyBrowserFor: createLocalApplyBrowserFactory({ headless: options.headless, defaultBrowser: browserFor, sharedPage: options.sharedPage }) };
}

/**
 * Start the disposable browser context for one application run and retain only its current live
 * page for the bounded takeover adapter.  This deliberately does not seed, copy, or persist an
 * owner profile: the profile remains the run's existing throwaway `runDir/profile` directory.
 */
export async function createIsolatedApplyBrowser(runDir: string, headless: boolean): Promise<RunBrowser> {
	const playwright = await import("playwright");
	const profileDir = join(runDir, "profile");
	let context: BrowserContext | undefined;
	let mcp: McpRuntime | undefined;
	let activePage: Page | null = null;
	let stopped = false;
	try {
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
		return {
			tools: mcp,
			handoffPage: () => activePage && !activePage.isClosed() ? activePage : null,
			stop: async () => {
				if (stopped) return;
				stopped = true;
				activePage = null;
				await mcp!.stop().catch(() => undefined);
				await context!.close().catch(() => undefined);
			},
		};
	} catch (error) {
		await mcp?.stop().catch(() => undefined);
		await context?.close().catch(() => undefined);
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
