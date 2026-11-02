import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { BrowserContext } from "playwright";
import { resolveRealChromeProfileDir, seedAgentBrowserProfiles, seedProfileCopy } from "./browser-profile.js";

export const BROWSER_ENGINES = ["chrome", "msedge", "chromium", "firefox", "webkit"] as const;
export type BrowserEngine = typeof BROWSER_ENGINES[number];
export type BrowserProfilePolicy = "persistent" | "ephemeral";
export interface BrowserLaunchReceipt {
	engine: BrowserEngine;
	requestedEngine: BrowserEngine | null;
	fallbackReason: string | null;
	browserType: "chromium" | "firefox" | "webkit";
	channel: string | null;
	version: string;
	/** Public Playwright exposes bundled paths, not the installed branded channel's resolved executable. */
	executable: string | null;
	mode: "headed" | "headless";
	profilePolicy: BrowserProfilePolicy;
	profileSource: "managed" | "legacy-agent" | "legacy-personal-copy";
	profileId: string;
	transport: "playwright";
	launchedAt: string;
	active: boolean;
}
export interface BrowserLaunchOptions {
	headless: boolean;
	engine?: BrowserEngine;
	profilePolicy: BrowserProfilePolicy;
	/** The existing default workflow prefers installed Chrome; isolated local workflows use bundled Chromium. */
	preference: "default" | "isolated";
	profileRoot: string;
	/** Legacy application profile, used only when both new settings are unset. */
	persistentDir?: string;
	/** Legacy default profiles may retain the owner's existing opt-in Chrome seed. Explicit settings never set this. */
	legacy?: { rootDir: string; instanceDir: string };
	onLaunch?: (receipt: BrowserLaunchReceipt) => void;
}
function launchErrorSummary(error: unknown): string | null {
	if (!error) return null;
	const message = error instanceof Error ? error.message : String(error);
	return message.split("\n", 1)[0];
}
const installs = new Map<string, Promise<void>>();
async function ensureInstalled(engine: BrowserEngine): Promise<void> {
	if (engine === "chrome" || engine === "msedge" || process.env.PAGS_SKIP_PLAYWRIGHT_INSTALL === "1") return;
	let pending = installs.get(engine);
	if (!pending) {
		const cli = join(dirname(createRequire(import.meta.url).resolve("playwright")), "cli.js");
		pending = promisify(execFile)(process.execPath, [cli, "install", engine], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }).then(() => undefined).catch((error) => { installs.delete(engine); throw new Error(`Could not install Playwright ${engine}. Run playwright install ${engine} on this machine. ${error instanceof Error ? error.message : String(error)}`); });
		installs.set(engine, pending);
	}
	await pending;
}

/** Runner-owned native contexts for every supported engine; an explicit engine never falls back (#1431). */
export async function launchRunnerBrowser(options: BrowserLaunchOptions): Promise<{ context: BrowserContext; profileDir: string; receipt: BrowserLaunchReceipt; stop(): Promise<void> }> {
	const playwright = await import("playwright");
	const candidates: BrowserEngine[] = options.engine ? [options.engine] : options.preference === "isolated" || process.env.PAGS_RUNNER_CHROMIUM === "1" ? ["chromium"] : ["chrome", "chromium"];
	let lastError: unknown;
	for (const engine of candidates) {
		const browserType = engine === "firefox" || engine === "webkit" ? engine : "chromium";
		const channel = engine === "chrome" || engine === "msedge" || engine === "chromium" ? engine : null;
		let profileDir: string | undefined;
		let context: BrowserContext | undefined;
		let profileSource: BrowserLaunchReceipt["profileSource"] = options.legacy || options.persistentDir ? "legacy-agent" : "managed";
		try {
			await ensureInstalled(engine);
			if (options.profilePolicy === "ephemeral") {
				profileSource = "managed";
				const root = join(options.profileRoot, "sessions");
				mkdirSync(root, { recursive: true, mode: 0o700 });
				profileDir = mkdtempSync(join(root, `${engine}-`));
			} else if (options.legacy) {
				seedAgentBrowserProfiles(options.legacy.rootDir, options.legacy.instanceDir);
				const real = engine === "chrome" ? resolveRealChromeProfileDir() : null;
				if (real) {
					profileSource = "legacy-personal-copy";
					const dest = join(options.legacy.instanceDir, "real-profile-copy");
					if (process.env.PAGS_RUNNER_REFRESH_PROFILE === "1") rmSync(dest, { recursive: true, force: true });
					profileDir = seedProfileCopy(real, dest) ?? undefined;
					if (!profileDir) throw new Error("Could not read the opted-in Chrome profile");
				} else profileDir = join(options.legacy.instanceDir, engine === "chrome" ? "chrome-profile" : "browser-profile");
			} else profileDir = options.persistentDir ?? join(options.profileRoot, "profiles", engine, "persistent");
			mkdirSync(profileDir, { recursive: true, mode: 0o700 });
			context = await playwright[browserType].launchPersistentContext(profileDir, {
				headless: options.headless,
				...(channel ? { channel } : {}),
				acceptDownloads: true,
				viewport: null,
				...(browserType === "chromium" ? { args: ["--disable-blink-features=AutomationControlled", "--start-maximized", "--window-size=1512,982", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } : {}),
			});
			const receipt: BrowserLaunchReceipt = { engine, requestedEngine: options.engine ?? null, fallbackReason: launchErrorSummary(lastError), browserType, channel, version: context.browser()?.version() ?? "unknown", executable: engine === "chrome" || engine === "msedge" ? null : playwright[browserType].executablePath(), mode: options.headless ? "headless" : "headed", profilePolicy: options.profilePolicy, profileSource, profileId: createHash("sha256").update(profileDir).digest("hex"), transport: "playwright", launchedAt: new Date().toISOString(), active: true };
			const ownedDir = profileDir;
			const ownedContext = context;
			context.on("close", () => { receipt.active = false; if (options.profilePolicy === "ephemeral") rmSync(ownedDir, { recursive: true, force: true }); });
			let stopping: Promise<void> | undefined;
			options.onLaunch?.(receipt);
			return { context: ownedContext, profileDir: ownedDir, receipt, stop: () => stopping ??= (async () => { try { await ownedContext.close(); } finally { receipt.active = false; if (options.profilePolicy === "ephemeral") rmSync(ownedDir, { recursive: true, force: true }); } })() };
		} catch (error) {
			await context?.close().catch(() => undefined);
			if (options.profilePolicy === "ephemeral" && profileDir) rmSync(profileDir, { recursive: true, force: true });
			lastError = error;
			if (options.engine) throw new Error(`Could not launch selected ${engine} browser in ${options.headless ? "headless" : "headed"} mode. ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw lastError;
}
