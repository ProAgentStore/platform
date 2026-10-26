/**
 * The `pags` bootstrap stub (#862): run a cached CLI release. The connected runner's updater
 * fetches new releases only under the authoritative Auto-update policy.
 *
 * A remote update (`runner_update`, #859) cannot reach a CLI that predates it, so every machine that
 * fell behind before it had the command needed a person at the keyboard. Installed once by hand
 * (`npm i -g @proagentstore/cli`), this stable stub can load newer verified payloads without
 * replacing the global package. It never fetches at boot, where the account policy is unavailable.
 *
 * It stays deliberately small and stable — choose and run — so it never needs replacing:
 * everything else is the payload's, which is what both the stub and `runner_update` replace.
 *
 * "Run" is an in-process `import()`, not a child: the payload keeps this process's terminal, signals
 * and exit code, and `process.argv[1]` stays the stub — so every `pags` the payload spawns (the
 * `runner connect` child, the `r` restart) comes back through here. An Actions service loads only
 * a relay-proven cached payload; it keeps its current release until a job-safe handoff.
 *
 * A newly installed version runs on TRIAL (#1141, trial.ts): one that crashes on import is given up
 * on and the previous version is run in its place, in the same process; one that has not registered
 * with the platform within its window is given up on and — when something restarts this process —
 * left with the restart code, so the next start runs the previous version.
 */
import { pathToFileURL } from "node:url";
import { approvedActionsPayload, BOOTSTRAP_ENV, cachedPayloads, newestPayload, payloadRoot, type Payload } from "./payload.js";
import { activatedVersion, badVersions, markBad, noteTrialStart, readTrial, TRIAL_MS } from "./trial.js";
import { logUpdateStep } from "./update-log.js";

/** `runner connect`'s ask-for-a-respawn exit code (self-update.ts `RUNNER_RESTART_EXIT_CODE`), restated: the stub imports nothing else. */
export const STUB_RESTART_EXIT_CODE = 75;
/** Set when something starts this process again after it exits: `pags up` for its runner, a `pags up` launcher, a service. */
const RESTARTED_BY = ["PAGS_UP_SUPERVISED", "PAGS_UP_LAUNCHER", "PAGS_SERVICE"];

export interface StubDeps {
	/** The CLI published alongside this stub, `dist/index.js` beside it. */
	bundled: Payload | null;
	/** The CLI arguments, without node and the script. */
	args: string[];
	/** Path of the stub itself, handed to the payload in {@link BOOTSTRAP_ENV}. */
	self: string;
	/** Running from a source checkout — never self-updated, it moves with git. */
	fromSource: boolean;
	cached?: () => Payload[];
	latest?: () => Promise<string | null>;
	install?: (version: string) => Promise<Payload>;
	load?: (entry: string) => Promise<unknown>;
	log?: (line: string) => void;
	/** The payload cache (trial records live beside the payloads). Default {@link payloadRoot}. */
	root?: string;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
	/** The trial watchdog's timer and exit — injectable so a test can expire the window. */
	setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
	exit?: (code: number) => void;
}

/** Only the long-lived commands are judged by whether they register: `pags up` and its `runner` child. */
export function trialApplies(args: string[]): boolean {
	const command = args.find((a) => !a.startsWith("-"));
	return command === "up" || command === "runner";
}

/** A long-lived Actions service must never import a candidate that the relay has not proven. */
export function isActionsSupervisor(args: string[]): boolean {
	return args.find((a) => !a.startsWith("-")) === "actions" && args.includes("supervise");
}

/** Choose the payload — fetching a newer release first when this is `pags up` — and run it. Answers the one run. */
export async function runStub(deps: StubDeps): Promise<Payload> {
	// Every line the stub says is a step of an update — into the update log too (#1151).
	const log = deps.log ?? ((line: string) => {
		process.stderr.write(`${line}\n`);
		logUpdateStep(`stub: ${line}`);
	});
	const root = deps.root ?? payloadRoot();
	const now = deps.now ?? Date.now;
	const env = deps.env ?? process.env;
	const all = () => [...(deps.bundled ? [deps.bundled] : []), ...(deps.cached ?? cachedPayloads)()];
	// A version given up on is never picked again — unless it is all there is, which beats running nothing.
	const local = (without: string[] = []) => {
		const trial = readTrial(root);
		const unactivated = trial?.version !== activatedVersion(root) ? trial?.version : null;
		const available = all().filter((p) => p.version !== unactivated && !without.includes(p.version));
		const skip = new Set(Object.keys(badVersions(root)));
		return newestPayload(available.filter((p) => !skip.has(p.version))) ?? (without.length ? null : newestPayload(available));
	};
	let chosen = isActionsSupervisor(deps.args) ? approvedActionsPayload(root, deps.bundled) : local();
	if (!chosen) throw new Error("pags: no CLI to run — reinstall with `npm i -g @proagentstore/cli`");
	if (trialApplies(deps.args)) {
		const verdict = noteTrialStart(root, chosen.version, now());
		if (verdict.kind === "give-up") {
			const fallback = local([chosen.version]);
			markBad(root, chosen.version, verdict.reason, fallback?.version ?? null, now());
			log(`pags: giving up on ${chosen.version} — ${verdict.reason}; rolling back to ${fallback?.version ?? "nothing"}`);
			if (fallback) chosen = fallback;
		} else if (verdict.kind === "trial") {
			watchTrial(root, chosen.version, deps, log, now, env);
		}
	}
	if (trialApplies(deps.args)) logUpdateStep(`stub: running ${chosen.version} for pags ${deps.args.find((a) => !a.startsWith("-"))}`);
	env[BOOTSTRAP_ENV] = deps.self;
	const load = deps.load ?? ((entry: string) => import(pathToFileURL(entry).href));
	try {
		await load(chosen.entry);
	} catch (e) {
		// Crashed on start. A version on trial is given up on and the one before it runs in its place, here and now.
		const fallback = readTrial(root)?.version === chosen.version ? local([chosen.version]) : null;
		if (!fallback) throw e;
		const why = `it crashed on start: ${e instanceof Error ? e.message : String(e)}`;
		markBad(root, chosen.version, why, fallback.version, now());
		log(`pags: giving up on ${chosen.version} — ${why}; rolling back to ${fallback.version}`);
		chosen = fallback;
		await load(chosen.entry);
	}
	return chosen;
}

/**
 * The trial window (#1141): if `version` has not registered by the end of it, give it up — and, when
 * something will start this process again, leave with the restart code so that start runs the previous
 * version. Unsupervised, it only records the verdict: the next `pags` runs the previous version.
 */
function watchTrial(root: string, version: string, deps: StubDeps, log: (line: string) => void, now: () => number, env: NodeJS.ProcessEnv): void {
	const startedAt = readTrial(root)?.startedAt ?? now();
	const timer = (deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
		const given = badVersions(root)[version];
		if (readTrial(root)?.version !== version && !given) return; // proven: its relay registered
		const reason = `it did not register with the platform within ${TRIAL_MS / 60_000} minutes of first starting`;
		if (!given) markBad(root, version, reason, readTrial(root)?.previous ?? null, now());
		const supervised = RESTARTED_BY.some((k) => !!env[k]);
		log(`pags: giving up on ${version} — ${given ?? reason}.${supervised ? " Restarting on the previous version." : ' The next "pags up" runs the previous version.'}`);
		if (supervised) (deps.exit ?? ((code: number) => process.exit(code)))(STUB_RESTART_EXIT_CODE);
	}, Math.max(0, startedAt + TRIAL_MS - now()));
	timer.unref?.();
}
