/**
 * What a machine is doing, said on its card (#929 findings 6 and 13).
 *
 * `GET /v1/terminals/nodes` has reported each machine's load, memory, disk, relay round trip and
 * high-water `warnings` since #924, and the features its CLI is too old for since #859 — and the
 * console rendered none of it. So "why is this machine flaky" had an answer only over MCP. Pure, so
 * every sentence below is asserted directly.
 */
/** A machine's `resources`, as `/v1/terminals/nodes` reports it (worker: `RunnerResourcesView`). */
export interface MachineResources {
	load1: number;
	cpus: number;
	loadPerCpu: number;
	memUsedPct: number;
	platform: string;
	/** ISO time of the sample. A stale one means the heartbeat stopped, not that the machine is idle. */
	sampledAt: string;
	activeSessions: number | null;
	recommendedMaxSessions: number;
	disk: { usedPct: number; inodesUsedPct: number } | null;
	runner: { uptimeSec: number; starts24h: number; relayReconnects: number } | null;
	relayRttMs: number | null;
	/** High-water marks crossed, each a sentence. `[]` when the machine looks fine. */
	warnings: string[];
}

/** Older than this, the numbers are the last thing the machine said — not what it is doing now. */
export const STALE_SAMPLE_MS = 3 * 60_000;

function duration(sec: number): string {
	if (sec < 3600) return `${Math.max(1, Math.floor(sec / 60))}m`;
	if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
	return `${Math.floor(sec / 86_400)}d`;
}

/**
 * The facts, short enough for one line. Memory carries "incl. cache" off Linux: there free memory
 * excludes reclaimable cache, so a healthy Mac reads 95% — the server withholds the alarm for that
 * reason, and the console must not raise it by printing a bare number.
 */
export function resourceFacts(r: MachineResources): string[] {
	const facts = [`load ${r.loadPerCpu}/core (${r.cpus} cores)`, `memory ${r.memUsedPct}%${r.platform === "linux" ? "" : " incl. cache"}`];
	if (r.disk) facts.push(`disk ${r.disk.usedPct}%`);
	if (r.activeSessions !== null) facts.push(`${r.activeSessions} of ~${r.recommendedMaxSessions} sessions`);
	if (r.relayRttMs !== null) facts.push(`relay ${r.relayRttMs} ms`);
	if (r.runner) facts.push(`up ${duration(r.runner.uptimeSec)}${r.runner.starts24h > 1 ? `, ${r.runner.starts24h} starts today` : ""}`);
	return facts;
}

/** Said when the sample is old, so a stopped heartbeat never reads as an idle machine. Null when fresh. */
export function staleSample(r: MachineResources, now = Date.now()): string | null {
	const at = Date.parse(r.sampledAt);
	if (!Number.isFinite(at) || now - at < STALE_SAMPLE_MS) return null;
	return `Last sample ${duration((now - at) / 1000)} ago — the heartbeat stopped, so these numbers are old.`;
}

/** A warning's head ("CPU saturated"), for a tile with no room for the sentence. */
export function warningHead(w: string): string {
	const i = w.indexOf(":");
	return (i > 0 && i <= 40 ? w.slice(0, i) : w.split(/[.—]/)[0]).trim();
}

/** The one-line summary a "Runs on" tile has room for, or "" when the machine reported nothing. */
export function tileHealth(r: MachineResources | null | undefined): string {
	if (!r) return "";
	return [`load ${r.loadPerCpu}/core`, r.activeSessions !== null ? `${r.activeSessions} of ~${r.recommendedMaxSessions} sessions` : ""].filter(Boolean).join(" · ");
}

/** Why the CLI should be updated, or null when it is current (or reported no version). */
export function behindLine(behind: string[] | null | undefined): string | null {
	if (!behind?.length) return null;
	return `This machine's \`pags\` CLI is too old for: ${behind.join(", ")}.`;
}
