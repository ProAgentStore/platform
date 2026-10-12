/**
 * Auto-update that is ON but silently not happening (#1034).
 *
 * A runner's own `auto_update_status` is its record, so a controller that has wedged keeps reporting
 * `waiting_for_idle` with a fresh heartbeat for as long as it runs: on 2026-10-12 a machine sat on
 * 0.4.94 while 0.4.111 was published, showing "auto-update: on". Controllers before 0.4.101 can
 * reach that state (#1020: a refused final admission from a deferred callback re-armed no timer),
 * and only a manual `runner_update` gets them out. The platform can see it from outside, by
 * comparing what the machine runs — and what its own check last saw — with the registry.
 */
import type { MachinePolicy } from "./machine-policy.js";
import { cliAtLeast } from "./runner-upgrade.js";

/** How long a connected, ON machine may stay behind a published release before it reads as stuck. */
export const AUTO_UPDATE_STUCK_AFTER_MS = 24 * 60 * 60_000;

/** The published `@proagentstore/cli` releases: the `latest` tag and each version's publish time (ms). */
export interface PublishedCli {
	latest: string;
	published: Record<string, number>;
}

export interface AutoUpdateStuck {
	/**
	 * `behind_published`: the machine has run an outdated release for longer than the threshold.
	 * `stale_latest`: it is behind by less than that, but its own registry check stopped advancing
	 * long ago, so it will not catch up by itself.
	 * `cannot_fetch_update` (#1054): a Windows runner on CLI ≤ {@link LAST_SHELLLESS_NPM_CLI} whose npm call cannot
	 * start, so neither its updater nor `runner_update` can ever reach the release that fixed it.
	 */
	reason: "behind_published" | "stale_latest" | "cannot_fetch_update";
	/** Publish time of the first release the machine (or its check) has not caught up with. */
	behind_since: string;
	published_version: string;
	releases_behind: number;
	/** `manual_npm_install`: only a one-time install AT the machine helps — runner_update uses the same broken npm call. */
	remedy: "runner_update" | "manual_npm_install";
	detail: string;
}

/**
 * The last CLI whose npm calls ran `npm` with no shell (#1020): on Windows that is `npm.cmd`, which cannot start that way,
 * so the release check failed and was reported `unsupported` with this reason. 0.4.117 fixed it — on the machine.
 */
export const LAST_SHELLLESS_NPM_CLI = "0.4.116";
const NPM_REFUSAL = /^npm could not be asked for the latest /;

const RELEASE = /^\d+\.\d+\.\d+$/;
const isRelease = (v: string | null | undefined): v is string => typeof v === "string" && RELEASE.test(v.trim().replace(/^v/, ""));

/** Publish time of the earliest release newer than `version`, or null when none is. */
function firstNewerAt(published: PublishedCli, version: string): number | null {
	let first: number | null = null;
	for (const [v, at] of Object.entries(published.published)) {
		if (!cliAtLeast(version, v) && (first === null || at < first)) first = at;
	}
	return first;
}

export function assessAutoUpdateStuck(input: {
	autoUpdate: boolean;
	status: string | null | undefined;
	connected: boolean;
	runnerVersion: string | null | undefined;
	reportedLatest: string | null | undefined;
	published: PublishedCli | null;
	now: number;
	/** The runner's own stored reason (`last_error`) and the machine's OS, from its last heartbeat (#1054). */
	lastError?: string | null;
	platform?: string | null;
}): AutoUpdateStuck | null {
	const { published, runnerVersion, now } = input;
	if (!input.autoUpdate || !input.connected || !published) return null;
	if (!isRelease(runnerVersion) || cliAtLeast(runnerVersion, published.latest)) return null;
	// `unsupported` is honest about a PERMANENT refusal (a source checkout, nothing to restart the runner), so it hides
	// nothing. Before 0.4.117 a release check that could not run was ALSO `unsupported` (#1054) — that one is not permanent,
	// and on Windows it is not fixable remotely either: it is the stuck machine this check exists to show.
	const npmRefusal = NPM_REFUSAL.test(input.lastError ?? "");
	if (input.status === "unsupported" && !npmRefusal) return null;
	if (npmRefusal && input.platform === "win32" && !cliAtLeast(runnerVersion, "0.4.117")) {
		const since = firstNewerAt(published, runnerVersion) ?? now;
		const behind = Object.keys(published.published).filter((v) => !cliAtLeast(runnerVersion, v) && cliAtLeast(published.latest, v)).length;
		return {
			reason: "cannot_fetch_update",
			behind_since: new Date(since).toISOString(),
			published_version: published.latest,
			releases_behind: behind,
			remedy: "manual_npm_install",
			detail: `This Windows machine runs ${runnerVersion}, whose npm calls cannot start on Windows (fixed in 0.4.117), so it cannot fetch ${published.latest} itself and runner_update cannot reach it either. Its updater said: ${input.lastError} Once, at the machine: run \`npm i -g @proagentstore/cli\`, then restart the "pags up" scheduled task (Stop-ScheduledTask -TaskName "pags up"; Start-ScheduledTask -TaskName "pags up"). Auto-update carries it forward from there.`,
		};
	}

	const behindAt = firstNewerAt(published, runnerVersion);
	const checkAt = isRelease(input.reportedLatest) ? firstNewerAt(published, input.reportedLatest) : null;
	let reason: AutoUpdateStuck["reason"];
	let since: number;
	if (behindAt !== null && now - behindAt >= AUTO_UPDATE_STUCK_AFTER_MS) {
		reason = "behind_published";
		since = behindAt;
	} else if (checkAt !== null && now - checkAt >= AUTO_UPDATE_STUCK_AFTER_MS) {
		reason = "stale_latest";
		since = checkAt;
	} else {
		return null;
	}
	const releasesBehind = Object.keys(published.published).filter((v) => !cliAtLeast(runnerVersion, v) && cliAtLeast(published.latest, v)).length;
	const date = new Date(since).toISOString();
	const seen = isRelease(input.reportedLatest) ? ` Its own release check last saw ${input.reportedLatest}.` : "";
	const detail = reason === "behind_published"
		? `Auto-update is on, but this machine still runs ${runnerVersion} while ${published.latest} is published: ${releasesBehind} release(s) behind since ${date}.${seen} Its updater is not making progress, whatever its status says. Run runner_update once for this machine.`
		: `Auto-update is on, but this machine's own release check stopped advancing: it last saw ${input.reportedLatest}, and newer releases have been published since ${date}. It runs ${runnerVersion}; ${published.latest} is published. Run runner_update once for this machine.`;
	return { reason, behind_since: date, published_version: published.latest, releases_behind: releasesBehind, remedy: "runner_update", detail };
}

const REGISTRY_URL = "https://registry.npmjs.org/@proagentstore%2fcli";

/** Parse the registry document; anything not shaped like one is null, never a guess. */
export function parsePublishedCli(doc: unknown): PublishedCli | null {
	if (!doc || typeof doc !== "object") return null;
	const d = doc as { "dist-tags"?: { latest?: unknown }; time?: Record<string, unknown> };
	const latest = d["dist-tags"]?.latest;
	if (!isRelease(typeof latest === "string" ? latest : null)) return null;
	const published: Record<string, number> = {};
	for (const [v, at] of Object.entries(d.time ?? {})) {
		const ms = typeof at === "string" ? Date.parse(at) : Number.NaN;
		if (isRelease(v) && Number.isFinite(ms)) published[v] = ms;
	}
	return { latest: latest as string, published };
}

export async function fetchPublishedCli(fetcher: typeof fetch = fetch): Promise<PublishedCli | null> {
	try {
		const res = await fetcher(REGISTRY_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4_000) });
		return res.ok ? parsePublishedCli(await res.json()) : null;
	} catch {
		return null;
	}
}

let cached: { at: number; value: PublishedCli | null } | null = null;

/**
 * The registry answer, memoised per isolate: 10 minutes when it answered, 1 minute when it did not.
 * Unknown is not stuck — a registry outage only means no machine is flagged.
 */
export async function publishedCli(now = Date.now()): Promise<PublishedCli | null> {
	if (cached && now - cached.at < (cached.value ? 10 * 60_000 : 60_000)) return cached.value;
	cached = { at: now, value: await fetchPublishedCli() };
	return cached.value;
}

type StuckMachine = { connected: boolean; runnerVersion: string | null | undefined; resources?: { platform?: string | null } | null };

/** One machine's verdict from its live connection fact and stored policy. */
export function machineAutoUpdateStuck(machine: StuckMachine, policy: MachinePolicy, published: PublishedCli | null): AutoUpdateStuck | null {
	return assessAutoUpdateStuck({ autoUpdate: policy.autoUpdate, status: policy.status, connected: machine.connected, runnerVersion: machine.runnerVersion, reportedLatest: policy.latestVersion, published, now: Date.now(), lastError: policy.lastError, platform: machine.resources?.platform ?? null });
}

/** The registry is asked only when the answer could be "stuck": policy ON and connected. */
export async function stuckNow(machine: StuckMachine, policy: MachinePolicy, published: () => Promise<PublishedCli | null>): Promise<AutoUpdateStuck | null> {
	return policy.autoUpdate && machine.connected ? machineAutoUpdateStuck(machine, policy, await published()) : null;
}
