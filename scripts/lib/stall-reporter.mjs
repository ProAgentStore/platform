/**
 * stall-reporter.mjs — turn a hung test file into a named failure (#1665).
 *
 * Vitest's test timeout is a timer INSIDE the worker. A worker blocked in a synchronous call
 * (`spawnSync` on a child that never exits, `execFileSync`, `node:sqlite`) never turns its event
 * loop, so that timer never fires: the run sits at zero CPU, prints no failure and never ends.
 * This reporter runs in the MAIN process, which is not blocked. It notes every report a running
 * test file sends and, when one has been silent for longer than any test here may take, says
 * which file and which test, kills the workers and exits non-zero.
 */
import { spawnSync } from "node:child_process";
import { relative } from "node:path";

/** Longest legitimate budget in the repo is 125s (one test) — 5 minutes of silence is a hang. */
export const DEFAULT_STALL_MS = 5 * 60_000;

/** The running files that have reported nothing for `limitMs`. `running` maps a file to `{ lastEventAt, lastTest }`. */
export function findStalled(running, now, limitMs) {
	return [...running].filter(([, state]) => now - state.lastEventAt >= limitMs).map(([file, state]) => ({ file, lastTest: state.lastTest, silentMs: now - state.lastEventAt }));
}

export function stallMessage({ file, lastTest, silentMs }) {
	const where = lastTest ? `Last test it reported starting: "${lastTest}" — the stall is in that test or the one after it.` : "It reported no test starting, so the stall is in one of its first tests or a beforeAll.";
	return [
		`STALLED  ${file} has reported nothing for ${Math.round(silentMs / 1000)}s.`,
		`  ${where}`,
		"  Its worker is not answering, so vitest's own test timeout cannot fire. The usual cause is a synchronous call that never returns",
		"  (spawnSync/execFileSync on a process that waits forever). Give that call a `timeout`, or make it asynchronous.",
	].join("\n");
}

/** Workers blocked in a synchronous call ignore a polite shutdown, so they are killed outright. */
function killWorkers() {
	if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(process.pid), "/T", "/F"]);
	else spawnSync("pkill", ["-KILL", "-P", String(process.pid)]);
}

export default class StallReporter {
	running = new Map();
	/**
	 * Modules that have ended (#1690). Vitest handles each batch of worker events in its own async call, so a test's
	 * "ready" from one batch can be delivered after the module's "end" from the next. That re-added a finished file,
	 * nothing removed it again, and the watchdog failed the run five minutes later. Keyed by the module object, so a
	 * re-run in watch mode (a new module object) is watched afresh.
	 */
	ended = new WeakSet();
	limitMs = Number(process.env.VITEST_STALL_MS) || DEFAULT_STALL_MS;

	onInit() {
		this.timer = setInterval(() => this.check(), Math.min(this.limitMs, 15_000));
		this.timer.unref();
	}

	touch(testModule, lastTest) {
		if (this.ended.has(testModule)) return;
		const file = relative(process.cwd(), testModule.moduleId);
		this.running.set(file, { lastEventAt: Date.now(), lastTest: lastTest ?? this.running.get(file)?.lastTest });
	}

	onTestModuleStart(testModule) {
		this.touch(testModule);
	}

	onTestSuiteReady(testSuite) {
		this.touch(testSuite.module);
	}

	onTestSuiteResult(testSuite) {
		this.touch(testSuite.module);
	}

	onTestCaseReady(testCase) {
		this.touch(testCase.module, testCase.fullName);
	}

	onTestCaseResult(testCase) {
		this.touch(testCase.module);
	}

	onTestModuleEnd(testModule) {
		this.ended.add(testModule);
		this.running.delete(relative(process.cwd(), testModule.moduleId));
	}

	onTestRunEnd() {
		clearInterval(this.timer);
	}

	check() {
		const stalled = findStalled(this.running, Date.now(), this.limitMs);
		if (!stalled.length) return;
		console.error(`\n${stalled.map(stallMessage).join("\n")}\n`);
		killWorkers();
		process.exit(1);
	}
}
