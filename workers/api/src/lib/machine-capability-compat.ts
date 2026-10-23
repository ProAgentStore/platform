/**
 * Can this machine run what a job needs? (#1312)
 *
 * Two sources, in this order: a real launch PROBE the runner ran (it launched, or it did not and said why),
 * then the OS rule table below, which answers before any probe has run and explains a failed one. A probe
 * that succeeded always wins over a rule — the rules are predictions, the probe is a measurement.
 *
 * A requirement the platform cannot verify (the machine has never reported, or reported without the field)
 * is a failure, not a pass: sending work to a machine "probably" able to run it is the incident this exists for.
 */
import { clipMarked } from "./clip-marked.js";
import { BROWSER_ENGINES, type BrowserEngine, type MachineCapabilities } from "./machine-capability-schema.js";

export interface PlaywrightOsRule {
	os: "darwin" | "win32" | "linux";
	/** The rule applies up to and including this OS major version (macOS marketing version, e.g. 12). */
	osMaxMajor: number;
	/** …when Playwright is at least this version. */
	playwrightMin: string;
	unsupported: readonly BrowserEngine[];
	why: string;
}

/**
 * Known incompatibilities. Observed: Playwright 1.58.2 cannot run WebKit or Chromium on macOS 12 ("does not
 * support chromium on mac12"). Add a row when a new one is measured; a row that turns out too broad is
 * overridden on the machine by a successful probe, so the cost of a wrong row is a explained probe, not a block.
 */
export const PLAYWRIGHT_OS_COMPAT: readonly PlaywrightOsRule[] = [
	{ os: "darwin", osMaxMajor: 12, playwrightMin: "1.58.0", unsupported: ["webkit", "chromium"], why: "Playwright dropped WebKit and Chromium builds for macOS 12 (observed on 1.58.2)" },
];

export function compareVersions(a: string, b: string): number {
	const parts = (v: string) => v.replace(/^v/, "").split(/[.+-]/).filter((_, i) => i < 3).map((x) => Number.parseInt(x, 10) || 0);
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
	return 0;
}

const osKey = (caps: MachineCapabilities): PlaywrightOsRule["os"] | null => {
	const n = caps.os.name.toLowerCase();
	return n.startsWith("mac") || n === "darwin" ? "darwin" : n.startsWith("win") ? "win32" : n === "linux" ? "linux" : null;
};
const osLabel = (caps: MachineCapabilities) => `${caps.os.name} ${caps.os.version}`.trim();

export function checkBrowserCompatibility(caps: MachineCapabilities, browser: string): { supported: boolean; reason?: string } {
	const engine = BROWSER_ENGINES.find((b) => b === browser);
	if (!engine) return { supported: false, reason: `"${browser}" is not a browser engine this platform tracks (${BROWSER_ENGINES.join(", ")})` };
	const probe = caps.playwright.probes.find((p) => p.browser === engine);
	if (probe?.success) return { supported: true };
	const pw = caps.playwright.version;
	if (probe && !probe.success) return { supported: false, reason: `${engine} failed to launch on ${osLabel(caps)}${pw ? ` with Playwright ${pw}` : ""}${probe.error ? `: ${probe.error}` : ""}` };
	if (!pw) return { supported: false, reason: `Playwright is not installed on this machine, so ${engine} cannot be launched` };
	const key = osKey(caps);
	const major = Number.parseInt(caps.os.version, 10);
	for (const rule of PLAYWRIGHT_OS_COMPAT) {
		if (rule.os === key && Number.isFinite(major) && major <= rule.osMaxMajor && compareVersions(pw, rule.playwrightMin) >= 0 && rule.unsupported.includes(engine)) {
			return { supported: false, reason: `${engine} is not supported: ${osLabel(caps)} is incompatible with Playwright ${pw} — ${rule.why}` };
		}
	}
	return { supported: false, reason: `${engine} was not probed on this machine (browser probing was skipped), so it cannot be confirmed` };
}

type Op = ">=" | ">" | "<=" | "<" | "=";
const REQ = /^([A-Za-z0-9][A-Za-z0-9._+-]*?)(?:(>=|<=|>|<|=)(\d[\w.+-]*))?$/;

function holds(op: Op, have: string, want: string): boolean {
	const c = compareVersions(have, want);
	return op === ">=" ? c >= 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : op === "<" ? c < 0 : c === 0;
}

/** Parse `needs` like ["webkit", "node>=22", "wrangler", "docker"] and check each against the record. */
export function checkCapabilityRequirements(caps: MachineCapabilities | null, needs: readonly string[]): { satisfied: boolean; failures: string[] } {
	const failures: string[] = [];
	if (needs.length === 0) return { satisfied: true, failures };
	if (!caps) return { satisfied: false, failures: [`this machine has not reported its capabilities (update the runner with \`pags update\`), so ${needs.join(", ")} cannot be verified`] };
	for (const raw of needs) {
		const need = String(raw).trim();
		const m = REQ.exec(need);
		if (!m) {
			failures.push(`"${clipMarked(need, 60, { within: true })}" is not a requirement the platform understands (use e.g. webkit, node>=22, wrangler, docker, ios, android)`);
			continue;
		}
		const name = m[1].toLowerCase();
		const op = m[2] as Op | undefined;
		const want = m[3];
		if ((BROWSER_ENGINES as readonly string[]).includes(name) && !op) {
			const r = checkBrowserCompatibility(caps, name);
			if (!r.supported) failures.push(`needs ${name}: ${r.reason}`);
		} else if (name === "docker" || name === "ios" || name === "android") {
			if (!caps[name]) failures.push(`needs ${name}: it is not available on ${osLabel(caps)}`);
			else if (op) failures.push(`needs ${need}: version requirements are not tracked for ${name}`);
		} else if (name === "playwright" || name === "node") {
			const have = name === "node" ? caps.nodeVersion : caps.playwright.version;
			if (!have) failures.push(`needs ${need}: ${name} is not installed`);
			else if (op && !holds(op, have, want)) failures.push(`needs ${need}: this machine has ${name} ${have}`);
		} else {
			const item = caps.inventory.find((i) => i.name.toLowerCase() === name);
			if (!item) failures.push(`needs ${need}: ${name} is not in this machine's inventory`);
			else if (op && !holds(op, item.version, want)) failures.push(`needs ${need}: this machine has ${name} ${item.version}`);
		}
	}
	return { satisfied: failures.length === 0, failures };
}
