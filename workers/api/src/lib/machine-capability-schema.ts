/**
 * What a machine reports about itself for runner selection (#1312): a bounded, privacy-conscious record.
 *
 * The runner sends this at registration and when it changes; the platform VALIDATES it here and stores only
 * what survives. Every string is clipped, every list is capped, and nothing path-, user- or secret-shaped
 * is kept: versions are matched against a conservative character set, a probe's error text has any path
 * replaced, and the software inventory is NAMES AND VERSIONS of a fixed set of tools — never a directory
 * listing, a package manifest, an environment or a username. The runner's own hash is not trusted; the
 * platform computes its own over the validated record.
 */

import { clipMarked } from "./clip-marked.js";

export const CAPABILITY_SCHEMA_VERSION = 1;
export const BROWSER_ENGINES = ["chromium", "firefox", "webkit"] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];

/** Caps, stated once. */
export const CAPS = { osName: 32, osVersion: 64, arch: 16, version: 64, probeError: 200, inventory: 40, toolName: 40, probes: 3 } as const;

export interface BrowserProbe {
	browser: BrowserEngine;
	/** Did the engine actually launch and close? A probe result, not a guess from the OS. */
	success: boolean;
	/** Why not, with any path removed. Absent on success. */
	error?: string;
	durationMs: number;
}

export interface InventoryItem {
	name: string;
	version: string;
}

export interface MachineCapabilities {
	schemaVersion: number;
	detectedAt: string;
	os: { name: string; version: string; arch: string };
	cpuCount: number | null;
	memoryGb: number | null;
	diskGb: number | null;
	nodeVersion: string | null;
	playwright: { version: string | null; /** Empty when probing was skipped: then only the OS rule table speaks. */ probes: BrowserProbe[] };
	ios: boolean;
	android: boolean;
	docker: boolean;
	inventory: InventoryItem[];
}

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$/;
const TOOL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
// A path in free text: anything rooted at / or ~/ or a drive letter. Replaced, never kept.
const PATHY = /(?:[A-Za-z]:\\[^\s'"]*|(?:~|\.{0,2})\/[^\s'"]+)/g;

/** Free text with paths removed and length capped. */
export function scrub(text: unknown, max: number): string {
	return clipMarked(String(text ?? "").replace(PATHY, "<path>").replace(/\s+/g, " ").trim(), max, { within: true });
}
const version = (v: unknown): string | null => (typeof v === "string" && VERSION.test(v.trim()) ? v.trim() : null);
const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 100) / 100 : null);
const word = (v: unknown, max: number): string => clipMarked(String(typeof v === "string" ? v : "").replace(/[^A-Za-z0-9._ +-]/g, "").trim(), max, { within: true });

/** Validate a record from a runner. Null when it is not a capability record at all; otherwise a fully clamped one. */
export function parseMachineCapabilities(raw: unknown): MachineCapabilities | null {
	const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
	if (!r) return null;
	const os = r.os && typeof r.os === "object" ? (r.os as Record<string, unknown>) : null;
	if (!os) return null;
	const name = word(os.name, CAPS.osName);
	const osVersion = word(os.version, CAPS.osVersion);
	const arch = word(os.arch, CAPS.arch);
	if (!name || !arch) return null;
	const pw = r.playwright && typeof r.playwright === "object" ? (r.playwright as Record<string, unknown>) : {};
	const seen = new Set<string>();
	const probes: BrowserProbe[] = [];
	for (const p of Array.isArray(pw.probes) ? pw.probes : []) {
		const q = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
		const browser = BROWSER_ENGINES.find((b) => b === q.browser);
		if (!browser || seen.has(browser) || probes.length >= CAPS.probes) continue;
		seen.add(browser);
		const success = q.success === true;
		const error = success ? "" : scrub(q.error, CAPS.probeError);
		probes.push({ browser, success, ...(error ? { error } : {}), durationMs: num(q.durationMs, 0, 600_000) ?? 0 });
	}
	const names = new Set<string>();
	const inventory: InventoryItem[] = [];
	for (const i of Array.isArray(r.inventory) ? r.inventory : []) {
		const q = i && typeof i === "object" ? (i as Record<string, unknown>) : {};
		const n = typeof q.name === "string" ? q.name.trim() : "";
		const v = version(q.version);
		if (!TOOL.test(n) || !v || names.has(n.toLowerCase()) || inventory.length >= CAPS.inventory) continue;
		names.add(n.toLowerCase());
		inventory.push({ name: n, version: v });
	}
	const detected = typeof r.detectedAt === "string" && Number.isFinite(Date.parse(r.detectedAt)) ? new Date(r.detectedAt).toISOString() : new Date().toISOString();
	return {
		schemaVersion: CAPABILITY_SCHEMA_VERSION,
		detectedAt: detected,
		os: { name, version: osVersion, arch },
		cpuCount: num(r.cpuCount, 1, 4096),
		memoryGb: num(r.memoryGb, 0, 65_536),
		diskGb: num(r.diskGb, 0, 1_048_576),
		nodeVersion: version(r.nodeVersion),
		playwright: { version: version(pw.version), probes },
		ios: r.ios === true,
		android: r.android === true,
		docker: r.docker === true,
		inventory,
	};
}

/** Canonical JSON of everything that is a FACT about the machine (not when it was measured). */
function canonical(c: MachineCapabilities): string {
	const { detectedAt: _d, ...facts } = c;
	// Probe timings vary run to run; only the verdict is a fact worth a "changed" flag.
	const probes = c.playwright.probes.map(({ browser, success, error }) => ({ browser, success, error: error ?? null })).sort((a, b) => a.browser.localeCompare(b.browser));
	const inventory = [...c.inventory].sort((a, b) => a.name.localeCompare(b.name));
	return JSON.stringify({ ...facts, playwright: { version: c.playwright.version, probes }, inventory });
}

export async function capabilityHash(c: MachineCapabilities): Promise<string> {
	const bytes = new TextEncoder().encode(canonical(c));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What changed between two records, as short facts. Bounded. */
export function diffCapabilities(before: MachineCapabilities | null, after: MachineCapabilities): string[] {
	if (!before) return ["first report"];
	const out: string[] = [];
	const cmp = (label: string, a: unknown, b: unknown) => {
		if (a !== b) out.push(`${label}: ${a ?? "none"} → ${b ?? "none"}`);
	};
	cmp("os", `${before.os.name} ${before.os.version}`, `${after.os.name} ${after.os.version}`);
	cmp("arch", before.os.arch, after.os.arch);
	cmp("node", before.nodeVersion, after.nodeVersion);
	cmp("playwright", before.playwright.version, after.playwright.version);
	for (const b of BROWSER_ENGINES) {
		const x = before.playwright.probes.find((p) => p.browser === b);
		const y = after.playwright.probes.find((p) => p.browser === b);
		cmp(b, x ? (x.success ? "launches" : "fails") : "unprobed", y ? (y.success ? "launches" : "fails") : "unprobed");
	}
	cmp("ios", before.ios, after.ios);
	cmp("android", before.android, after.android);
	cmp("docker", before.docker, after.docker);
	const was = new Map(before.inventory.map((i) => [i.name, i.version]));
	const now = new Map(after.inventory.map((i) => [i.name, i.version]));
	for (const [n, v] of now) if (was.get(n) !== v) out.push(`${n}: ${was.get(n) ?? "none"} → ${v}`);
	for (const n of was.keys()) if (!now.has(n)) out.push(`${n}: removed`);
	return out.filter((_, i) => i < 40).map((s) => clipMarked(s, 160, { within: true }));
}
