/**
 * The `pags` bootstrap stub (#862): pick the newest CLI this machine has, fetching a newer one first
 * on `pags up`, and run it.
 *
 * A remote update (`runner_update`, #859) cannot reach a CLI that predates it, so every machine that
 * fell behind before it had the command needed a person at the keyboard. The stub closes that for
 * good: installed once by hand (`npm i -g @proagentstore/cli`), it asks npm for the latest release on
 * every `pags up` and moves onto it by itself — whatever version it was installed at, and whether or
 * not the payload it was running knows about `runner_update`.
 *
 * It stays deliberately small and stable — version check, fetch, run — so it never needs replacing:
 * everything else is the payload's, which is what both the stub and `runner_update` replace.
 *
 * "Run" is an in-process `import()`, not a child: the payload keeps this process's terminal, signals
 * and exit code, and `process.argv[1]` stays the stub — so every `pags` the payload spawns (the
 * `runner connect` child, the `r` restart) comes back through here and gets the newest payload too.
 */
import { pathToFileURL } from "node:url";
import { BOOTSTRAP_ENV, cachedPayloads, installPayload, latestPublishedVersion, NO_SELF_UPDATE_ENV, newestPayload, olderThan, type Payload } from "./payload.js";

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
}

/** Only `pags up` checks: it is the long-lived command a machine starts, and one npm call is cheap beside it. */
export function checksForUpdate(args: string[]): boolean {
	return args.find((a) => !a.startsWith("-")) === "up";
}

/** Choose the payload — fetching a newer release first when this is `pags up` — and run it. Answers the one run. */
export async function runStub(deps: StubDeps): Promise<Payload> {
	const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const local = () => newestPayload([...(deps.bundled ? [deps.bundled] : []), ...(deps.cached ?? cachedPayloads)()]);
	let chosen = local();
	if (checksForUpdate(deps.args) && !deps.fromSource && process.env[NO_SELF_UPDATE_ENV] !== "1") {
		// Short: a `pags up` on a machine with no network must still start on what it has.
		const latest = await (deps.latest ?? (() => latestPublishedVersion(15_000)))();
		if (latest && (!chosen || olderThan(chosen.version, latest))) {
			log(`pags: updating ${chosen?.version ?? "(none)"} → ${latest}…`);
			try {
				chosen = await (deps.install ?? ((v: string) => installPayload(v)))(latest);
				log(`pags: now on ${chosen.version}`);
			} catch (e) {
				log(`pags: could not fetch ${latest} (${e instanceof Error ? e.message : String(e)}) — starting ${chosen?.version ?? "nothing"} instead`);
			}
		}
	}
	if (!chosen) throw new Error("pags: no CLI to run — reinstall with `npm i -g @proagentstore/cli`");
	process.env[BOOTSTRAP_ENV] = deps.self;
	await (deps.load ?? ((entry: string) => import(pathToFileURL(entry).href)))(chosen.entry);
	return chosen;
}
