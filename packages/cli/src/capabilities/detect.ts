/**
 * Detect what THIS machine can do, for runner selection (#1312).
 *
 * Reported at registration and refreshed on a slow interval; the platform validates, hashes and stores it
 * (`workers/api/src/lib/machine-capability-schema.ts` is the authority on shape and caps — this file mirrors it
 * and the API re-clamps everything). What is collected, and what is not:
 *
 *   • collected: OS name/version/arch, CPU count, memory and disk size in GB, the Node and Playwright versions,
 *     a launch probe per browser engine (launched or not, and why, with any path removed), whether iOS
 *     simulators / adb / Docker answer, and `name + version` of a fixed list of developer tools;
 *   • never collected: paths, usernames, hostnames, environment variables, file or directory listings, the
 *     contents of any package manifest, credentials of any kind. The tool list is FIXED here — nothing is
 *     discovered by walking the disk — and a tool's output is reduced to a version token.
 *
 * Everything that touches the machine goes through {@link DetectDeps}, so tests drive it with synthetic
 * fixtures and never launch a browser or a child process.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { statfsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";

export const CAPABILITY_SCHEMA_VERSION = 1;
export const BROWSER_ENGINES = ["chromium", "firefox", "webkit"] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];
export const PROBE_TIMEOUT_MS = 10_000;
const CMD_TIMEOUT_MS = 4_000;
export const INVENTORY_CAP = 40;
export const SKIP_PROBE_ENV = "PROAGENTSTORE_SKIP_BROWSER_PROBE";

export interface BrowserProbe {
	browser: BrowserEngine;
	success: boolean;
	error?: string;
	durationMs: number;
}
export interface MachineCapabilities {
	schemaVersion: number;
	detectedAt: string;
	os: { name: string; version: string; arch: string };
	cpuCount: number | null;
	memoryGb: number | null;
	diskGb: number | null;
	nodeVersion: string | null;
	playwright: { version: string | null; probes: BrowserProbe[] };
	ios: boolean;
	android: boolean;
	docker: boolean;
	inventory: Array<{ name: string; version: string }>;
}

/** The fixed inventory: [name reported, binary, args]. Names and versions only ever leave the machine. */
export const INVENTORY_TOOLS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
	["git", "git", ["--version"]],
	["gh", "gh", ["--version"]],
	["npm", "npm", ["--version"]],
	["pnpm", "pnpm", ["--version"]],
	["yarn", "yarn", ["--version"]],
	["bun", "bun", ["--version"]],
	["nvm", "nvm", ["--version"]],
	["fnm", "fnm", ["--version"]],
	["volta", "volta", ["--version"]],
	["python3", "python3", ["--version"]],
	["ruby", "ruby", ["--version"]],
	["go", "go", ["version"]],
	["java", "java", ["-version"]],
	["rustc", "rustc", ["--version"]],
	["dotnet", "dotnet", ["--version"]],
	["wrangler", "wrangler", ["--version"]],
	["pags", "pags", ["--version"]],
	["claude", "claude", ["--version"]],
	["codex", "codex", ["--version"]],
	["grok", "grok", ["--version"]],
	["docker", "docker", ["--version"]],
	["xcodebuild", "xcodebuild", ["-version"]],
	["fastlane", "fastlane", ["--version"]],
	["gcloud", "gcloud", ["--version"]],
	["firebase", "firebase", ["--version"]],
	["az", "az", ["--version"]],
	["brew", "brew", ["--version"]],
	["tmux", "tmux", ["-V"]],
];

export interface DetectDeps {
	platform: NodeJS.Platform;
	arch: string;
	release: string;
	cpuCount: number;
	totalMemBytes: number;
	diskTotalBytes: () => number | null;
	nodeVersion: string;
	env: Record<string, string | undefined>;
	now: () => Date;
	/** Run a binary with no shell. Resolves to its combined output; rejects when it fails, is absent or times out. */
	run: (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;
	/** The installed Playwright package version, or null when it is not installed. */
	playwrightVersion: () => string | null;
	/** Launch an engine headless and close it. Rejects with the launch error. */
	launch: (browser: BrowserEngine) => Promise<void>;
}

const run = (file: string, args: readonly string[], timeoutMs: number) =>
	new Promise<string>((resolve, reject) => {
		execFile(file, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => (err ? reject(err) : resolve(`${stdout}\n${stderr}`)));
	});

export function realDeps(): DetectDeps {
	const require = createRequire(import.meta.url);
	return {
		platform: process.platform,
		arch: os.arch(),
		release: os.release(),
		cpuCount: os.cpus().length,
		totalMemBytes: os.totalmem(),
		diskTotalBytes: () => {
			try {
				const s = statfsSync(os.homedir());
				return s.blocks * s.bsize;
			} catch {
				return null;
			}
		},
		nodeVersion: process.versions.node,
		env: process.env,
		now: () => new Date(),
		run,
		playwrightVersion: () => {
			try {
				return String((require("playwright/package.json") as { version?: unknown }).version ?? "") || null;
			} catch {
				return null;
			}
		},
		launch: async (browser) => {
			// A computed specifier: the package is optional at runtime, so it is neither bundled nor required to type-check.
			const name = "playwright";
			const pw = (await import(name)) as unknown as Record<string, { launch: (o: { headless: boolean }) => Promise<{ close: () => Promise<void> }> }>;
			const b = await pw[browser].launch({ headless: true });
			await b.close();
		},
	};
}

const PATHY = /(?:[A-Za-z]:\\[^\s'"]*|(?:~|\.{0,2})\/[^\s'"]+)/g;
export const scrub = (text: unknown, max: number): string => String(text ?? "").replace(PATHY, "<path>").replace(/\s+/g, " ").trim().slice(0, max);

/** The first version-looking token in a tool's output (keeps `-rc.1` style suffixes), or null. */
export function versionToken(output: string): string | null {
	const m = /\d+(?:\.\d+){1,3}(?:[-+.~][0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?/.exec(output);
	return m ? m[0].slice(0, 64) : null;
}

/** Darwin kernel major → macOS marketing major, for when `sw_vers` is not available. */
const DARWIN_TO_MACOS: Record<number, string> = { 20: "11", 21: "12", 22: "13", 23: "14", 24: "15", 25: "26" };

export async function detectOs(d: DetectDeps): Promise<{ name: string; version: string; arch: string }> {
	if (d.platform === "darwin") {
		const v = await d.run("sw_vers", ["-productVersion"], CMD_TIMEOUT_MS).then((o) => versionToken(o)).catch(() => null);
		const kernel = Number.parseInt(d.release, 10);
		return { name: "macOS", version: v ?? DARWIN_TO_MACOS[kernel] ?? `darwin-${kernel}`, arch: d.arch };
	}
	if (d.platform === "win32") return { name: "Windows", version: scrub(d.release, 64), arch: d.arch };
	if (d.platform === "linux") return { name: "Linux", version: scrub(d.release, 64), arch: d.arch };
	return { name: scrub(d.platform, 32), version: scrub(d.release, 64), arch: d.arch };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let t: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms); })]);
	} finally {
		if (t) clearTimeout(t);
	}
}

export async function probeBrowsers(d: DetectDeps): Promise<BrowserProbe[]> {
	if (d.env[SKIP_PROBE_ENV] === "1" || !d.playwrightVersion()) return [];
	const out: BrowserProbe[] = [];
	for (const browser of BROWSER_ENGINES) {
		const started = Date.now();
		try {
			await withTimeout(d.launch(browser), PROBE_TIMEOUT_MS);
			out.push({ browser, success: true, durationMs: Date.now() - started });
		} catch (e) {
			out.push({ browser, success: false, error: scrub(e instanceof Error ? e.message : e, 200), durationMs: Date.now() - started });
		}
	}
	return out;
}

const answers = (d: DetectDeps, file: string, args: readonly string[]) => d.run(file, args, CMD_TIMEOUT_MS).then(() => true, () => false);

export async function detectInventory(d: DetectDeps): Promise<Array<{ name: string; version: string }>> {
	const found: Array<{ name: string; version: string }> = [];
	for (let i = 0; i < INVENTORY_TOOLS.length; i += 7) {
		const batch = await Promise.all(
			INVENTORY_TOOLS.slice(i, i + 7).map(async ([name, file, args]) => {
				const v = await d.run(file, args, CMD_TIMEOUT_MS).then((o) => versionToken(o), () => null);
				return v ? { name, version: v } : null;
			}),
		);
		for (const b of batch) if (b && found.length < INVENTORY_CAP) found.push(b);
	}
	return found;
}

export async function detectMachineCapabilities(d: DetectDeps = realDeps()): Promise<MachineCapabilities> {
	const [osInfo, probes, ios, android, docker, inventory] = await Promise.all([
		detectOs(d),
		probeBrowsers(d),
		d.platform === "darwin" ? answers(d, "xcrun", ["simctl", "list", "devices", "available"]) : Promise.resolve(false),
		answers(d, "adb", ["devices"]),
		answers(d, "docker", ["info", "--format", "{{.ServerVersion}}"]),
		detectInventory(d),
	]);
	const disk = d.diskTotalBytes();
	return {
		schemaVersion: CAPABILITY_SCHEMA_VERSION,
		detectedAt: d.now().toISOString(),
		os: osInfo,
		cpuCount: d.cpuCount || null,
		memoryGb: Math.round((d.totalMemBytes / 2 ** 30) * 10) / 10,
		diskGb: disk == null ? null : Math.round((disk / 2 ** 30) * 10) / 10,
		nodeVersion: d.nodeVersion,
		playwright: { version: d.playwrightVersion(), probes },
		ios,
		android,
		docker,
		inventory,
	};
}

/**
 * The hash of the FACTS in a record — the same canonical form the platform hashes, so "unchanged" can be said
 * on the heartbeat without resending the record. A test holds the two implementations to the same answer.
 */
export function capabilityHash(c: MachineCapabilities): string {
	const { detectedAt: _d, ...facts } = c;
	const probes = c.playwright.probes.map(({ browser, success, error }) => ({ browser, success, error: error ?? null })).sort((a, b) => a.browser.localeCompare(b.browser));
	const inventory = [...c.inventory].sort((a, b) => a.name.localeCompare(b.name));
	return createHash("sha256").update(JSON.stringify({ ...facts, playwright: { version: c.playwright.version, probes }, inventory })).digest("hex");
}

export const CAPABILITY_REFRESH_MS = 10 * 60_000;

/**
 * Holds the latest record between heartbeats. The full record is sent only when the platform does not have this
 * hash (first report, a change, or the platform asking); every other beat carries the hash alone.
 */
export class CapabilityReporter {
	private caps: MachineCapabilities | null = null;
	private hash: string | null = null;
	private acknowledged: string | null = null;
	private detectedAt = 0;
	private running: Promise<void> | null = null;
	constructor(
		private readonly detect: () => Promise<MachineCapabilities> = () => detectMachineCapabilities(),
		private readonly clock: () => number = Date.now,
	) {}

	/** Start (or re-run, when due) detection without blocking the caller. Never throws. */
	refreshIfDue(): void {
		if (this.running || (this.caps && this.clock() - this.detectedAt < CAPABILITY_REFRESH_MS)) return;
		this.running = this.detect()
			.then((c) => {
				this.caps = c;
				this.hash = capabilityHash(c);
				this.detectedAt = this.clock();
			})
			.catch(() => undefined)
			.finally(() => {
				this.running = null;
			});
	}

	/** Awaitable for tests and startup logging. */
	settled(): Promise<void> {
		return this.running ?? Promise.resolve();
	}

	/** Fields to add to a heartbeat body. Empty until the first detection finishes. */
	payload(): { capabilityHash?: string; capabilities?: MachineCapabilities } {
		this.refreshIfDue();
		if (!this.caps || !this.hash) return {};
		return this.acknowledged === this.hash ? { capabilityHash: this.hash } : { capabilityHash: this.hash, capabilities: this.caps };
	}

	/** Read the platform's answer: stored means the hash is known; `capabilitiesWanted` asks for the record again. */
	accept(response: Record<string, unknown> | null | undefined): void {
		if (!this.hash || !response) return;
		if (response.capabilitiesWanted === true) this.acknowledged = null;
		else if (response.capabilitiesStored === true) this.acknowledged = this.hash;
	}
}
