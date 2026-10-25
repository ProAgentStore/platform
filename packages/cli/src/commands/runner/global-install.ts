/**
 * The in-place update, with a way back (#1147).
 *
 * Under the bootstrap stub (#862) a new release is installed beside the running one and falls back to it if it fails. A runner
 * that is NOT under the stub — a global install started by a path other than the stub — has no such copy: `npm i -g` replaces the
 * one it has. So a broken release there used to be final. Here the replaced release is tried before the update goes on, exactly
 * as a stub payload is (#1148): the global package is started as `pags runner probe`, and if that fails the PREVIOUS release is
 * installed again, so the machine is left on what was running and the update fails with the reason.
 */
import { join } from "node:path";
import { CLI_PACKAGE, type Payload, payloadAt, payloadRoot } from "../../bootstrap/payload.js";
import { probePayload } from "../../bootstrap/start-probe.js";
import { markBad } from "../../bootstrap/trial.js";
import { logUpdateStep } from "../../bootstrap/update-log.js";

export interface GlobalInstallDeps {
	/** `npm <args>` — rejects with npm's own stderr on `.stderr`. */
	npm: (args: string[], timeoutMs: number) => Promise<{ stdout?: unknown } | undefined>;
	payloadAt?: (dir: string) => Payload | null;
	probe?: typeof probePayload;
	mark?: (version: string, reason: string, to: string | null) => void;
	log?: (line: string) => void;
}

const NPM_TIMEOUT_MS = 5 * 60_000;
const reason = (e: unknown) => {
	const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
	return (stderr || (e instanceof Error ? e.message : String(e))).slice(-400);
};

export async function installGlobalWithRollback(version: string, current: string | null, deps: GlobalInstallDeps): Promise<void> {
	const log = deps.log ?? logUpdateStep;
	await deps.npm(["i", "-g", `${CLI_PACKAGE}@${version}`], NPM_TIMEOUT_MS).catch((e: unknown) => {
		throw new Error(reason(e));
	});
	// Where npm put it. Not being able to say is not a failure of the release: nothing was learned, the update goes on as it always did.
	let installed: Payload | null = null;
	try {
		const { stdout } = (await deps.npm(["root", "-g"], 30_000)) ?? {};
		const root = String(stdout ?? "").trim();
		installed = root ? (deps.payloadAt ?? payloadAt)(join(root, ...CLI_PACKAGE.split("/"))) : null;
	} catch {
		installed = null;
	}
	if (!installed || installed.version !== version) {
		log(`probe: ${version} skipped — the global install could not be located`);
		return;
	}
	const verdict = await (deps.probe ?? probePayload)(installed.entry, version);
	log(`probe: ${version} ${verdict.state} — ${verdict.detail}`);
	if (verdict.state !== "failed") return;

	if (verdict.permanent) (deps.mark ?? ((v, r, to) => markBad(payloadRoot(), v, r, to, Date.now(), { notice: false })))(version, `its start-up check failed: ${verdict.detail}`, current);
	let restored = "";
	if (current) {
		try {
			await deps.npm(["i", "-g", `${CLI_PACKAGE}@${current}`], NPM_TIMEOUT_MS);
			restored = `this machine is back on ${current}`;
			log(`rollback: ${current} installed again after ${version} failed its start-up check`);
		} catch (e) {
			restored = `putting ${current} back FAILED (${reason(e)}) — run \`npm i -g ${CLI_PACKAGE}@${current}\` at the machine`;
			log(`rollback: reinstalling ${current} FAILED — ${reason(e)}`);
		}
	} else restored = "the release it replaced is not known, so nothing was put back";
	throw new Error(`${version} failed its start-up check after the in-place install (${verdict.detail}); ${restored}${verdict.permanent ? "" : " — it will be tried again"}`);
}
