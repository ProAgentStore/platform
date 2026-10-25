/**
 * Try a freshly installed payload BESIDE the running one before anything is swapped (#1148).
 *
 * The install used to put the new release on trial and swap at once; a release that crashed on start or could not reach the
 * platform was found out only after the running `pags up` had left. Here the running process starts the candidate's own entry
 * point as a separate, short-lived child — `pags runner probe`, which holds no lock and no relay slot (commands/runner/probe.ts)
 * — and the swap goes ahead only if that child says it passed. The trial window (trial.ts) stays as the second line of defence.
 *
 * Node builtins only, like the rest of the bootstrap: it must keep working when the payload it is trying is broken.
 */
import { spawn } from "node:child_process";

export const PROBE_TIMEOUT_MS = 60_000;
/** Set in the child's environment, so a probe never starts probing. */
export const PROBE_ENV = "PAGS_PROBE";
/** Skips the probe (`PAGS_NO_UPDATE_PROBE=1`): the swap goes ahead on trial alone, as before #1148. */
export const NO_PROBE_ENV = "PAGS_NO_UPDATE_PROBE";
const MARKER = "PAGS_PROBE ";

export type ProbeVerdict =
	| { state: "passed"; detail: string }
	/** `permanent`: the candidate itself is broken (it will not start, or is not the release asked for). Otherwise the failure may
	 *  be this machine or the network (no sign-in, the API or relay unreachable), and a later attempt can pass. */
	| { state: "failed"; detail: string; permanent: boolean }
	/** The candidate has no probe to run (a release older than this feature), or probing is switched off: nothing was learned. */
	| { state: "skipped"; detail: string };

export interface ProbeSpawnDeps {
	/** Run `node <entry> …args` and collect what it printed; rejects on a spawn failure, resolves with the exit code otherwise. */
	run?: (file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }>;
	node?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

const realRun: NonNullable<ProbeSpawnDeps["run"]> = (file, args, env, timeoutMs) =>
	new Promise((resolve, reject) => {
		const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.on("data", (d) => { stdout = (stdout + String(d)).slice(-8_000); });
		child.stderr.on("data", (d) => { stderr = (stderr + String(d)).slice(-8_000); });
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
		child.on("error", (e) => { clearTimeout(timer); reject(e); });
		child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }); });
	});

/** The line that says what went wrong: the first `…Error: message` (a Node crash ends in a version banner), else the last line. */
const firstLine = (s: string) => {
	const lines = s.trim().split(/\r?\n/).filter(Boolean);
	return (lines.find((l) => /^\w*Error\b/.test(l.trim())) ?? lines.at(-1) ?? "").trim().slice(0, 240);
};

/** Run `entry` (the candidate's `dist/index.js`) as `runner probe --expect <version>` and read its verdict. Never throws. */
export async function probePayload(entry: string, version: string, deps: ProbeSpawnDeps = {}): Promise<ProbeVerdict> {
	const env = deps.env ?? process.env;
	if (env[NO_PROBE_ENV] === "1") return { state: "skipped", detail: `${NO_PROBE_ENV}=1` };
	if (env[PROBE_ENV] === "1") return { state: "skipped", detail: "already inside a probe" };
	let out: Awaited<ReturnType<NonNullable<ProbeSpawnDeps["run"]>>>;
	try {
		out = await (deps.run ?? realRun)(deps.node ?? process.execPath, [entry, "runner", "probe", "--expect", version], { ...env, [PROBE_ENV]: "1" }, deps.timeoutMs ?? PROBE_TIMEOUT_MS);
	} catch (e) {
		return { state: "failed", permanent: false, detail: `could not start it: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (out.timedOut) return { state: "failed", permanent: false, detail: `it did not finish its start-up check within ${Math.round((deps.timeoutMs ?? PROBE_TIMEOUT_MS) / 1000)}s` };
	const line = out.stdout.split(/\r?\n/).reverse().find((l) => l.startsWith(MARKER));
	if (line) {
		try {
			const result = JSON.parse(line.slice(MARKER.length)) as { ok?: boolean; steps?: Array<{ name?: string; ok?: boolean; detail?: string }> };
			if (result.ok === true) return { state: "passed", detail: (result.steps ?? []).map((s) => `${s.name}: ${s.detail}`).join("; ") };
			const bad = (result.steps ?? []).filter((s) => s.ok === false);
			return { state: "failed", permanent: bad.some((s) => s.name === "loads"), detail: bad.map((s) => `${s.name}: ${s.detail}`).join("; ") || "its start-up check failed" };
		} catch {
			return { state: "failed", permanent: true, detail: "its start-up check answered with something unreadable" };
		}
	}
	// No verdict printed. A release that predates the probe says "unknown command" — nothing learned, not a failure of the release.
	if (/unknown command ['"`]?(?:probe|runner)/i.test(out.stderr)) return { state: "skipped", detail: "that release has no start-up check" };
	const why = firstLine(out.stderr) || firstLine(out.stdout) || (out.signal ? `killed by ${out.signal}` : `exited ${out.code}`);
	return { state: "failed", permanent: true, detail: `it did not start: ${why}` };
}
