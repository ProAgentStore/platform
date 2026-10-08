/**
 * #896 — what `pags up` and `pags down` no longer do, and what they do instead.
 *
 * Checked on the source, as the console's wiring tests are: `up.ts` is a TUI whose action blocks on
 * a keypress loop, so what matters here is that the destructive paths are GONE and the lock paths
 * are in place. The behaviour behind them is tested where it lives — `runner-lock.test.ts` for the
 * verdicts, `runner-replace.test.ts` for the refusals, `health-identity.test.ts` for the runner's
 * side.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const up = readFileSync(new URL("./up.ts", import.meta.url), "utf-8");
const connect = readFileSync(new URL("./runner/command.ts", import.meta.url), "utf-8");
/** Code with comments stripped, so a `pkill` named in an explanation is not read as a call. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the pkill is gone (#896)", () => {
	it("`pags up` kills nothing by name — not a runner, not a pattern, not a pid", () => {
		const src = code(up);
		expect(src).not.toMatch(/pkill/);
		expect(src).not.toMatch(/stopRunnerProcesses/);
		expect(src).not.toMatch(/dist\/browser-runner\/index\.js/);
		// The deletion is explained where it stood, so the next person does not put it back.
		expect(up).toMatch(/`stopRunnerProcesses\(\)` — `pkill -f` over three name patterns — was deleted here \(#896\)/);
	});

	it("`pags down` stops THE LOCK HOLDER, and works on Windows too (Q6)", () => {
		const src = code(up);
		expect(src).toMatch(/downCommand[\s\S]*readLock\(lockPath\(/);
		expect(src).toMatch(/downCommand[\s\S]*replaceHolder\(/);
		// The old Windows branch said "press Ctrl+C in the other window" because `pkill` did not
		// exist there. Asking a process to stop needs no signals, so that branch is gone.
		expect(src).not.toMatch(/switch to the 'pags up' window/);
	});
});

describe("the hollow supervisor (#896 F1/F2)", () => {
	it("a child killed by a SIGNAL is reported as killed, not as a clean exit", () => {
		// `if (code && code !== 0)` treated `code === null` — a SIGTERM — as success, which is how a
		// five-day-old terminal kept showing "connected" after its runner had been killed.
		expect(code(up)).toMatch(/if \(code === null\)[\s\S]{0,400}Runner stopped by another process \(signal\)/);
		expect(code(up)).not.toMatch(/if \(code && code !== 0\)/);
	});

	it("`r` re-checks the lock and refuses while another process holds it", () => {
		const src = code(up);
		expect(src).toMatch(/key === "r"[\s\S]{0,600}inspectHolder\(lockFile\)/);
		// The source escapes its backticks inside a template literal.
		expect(src).toMatch(/Another .`pags up.` holds this machine/);
		// It compares against OUR child's id, so restarting our own dead runner still works.
		expect(src).toMatch(/other\.lock\.rsid !== childRsid/);
	});
});

describe("the lock, and the flags that act on it", () => {
	it("checks the lock BEFORE spawning, and refuses with who holds it", () => {
		const src = code(up);
		expect(src).toMatch(/inspectHolder\(lockFile\)/);
		expect(src).toMatch(/isTakeable\(held\.verdict\)/);
		expect(src).toMatch(/holderMessage\(held\.lock, held\.verdict\)/);
		expect(src).toMatch(/process\.exit\(1\)/);
	});

	it("`--replace` is its own flag, NOT folded into `--force`", () => {
		// `--force` already means "take this agent's relay slot from another MACHINE". Replacing a
		// process on THIS machine is a different act, and one flag for both would hide that.
		expect(up).toMatch(/\.option\("--replace"/);
		expect(up).toMatch(/\.option\("--now"/);
		expect(up).toMatch(/\.option\("--force", "Take over from another connected machine"\)/);
		expect(up).toMatch(/Deliberately NOT `--force`/);
	});

	it("the CHILD holds the lock, because it owns the relay sockets", () => {
		const src = code(connect);
		expect(src).toMatch(/acquireLock\(\{ account: lockAccount/);
		expect(src).toMatch(/PAGS_LOCK_ACCOUNT/);
		// It announces its id so the supervisor knows which process is its own child.
		expect(src).toMatch(/STATUS runner-session=/);
		// …and hands the runtime what it needs to answer for itself.
		expect(src).toMatch(/PAGS_RUNNER_RSID: lockHeld\.rsid/);
		expect(src).toMatch(/PAGS_RUNNER_CONTROL_NONCE: lockHeld\.nonce/);
	});

	it("releases the lock on the way out — before stopping the child", () => {
		const src = code(connect);
		expect(src).toMatch(/releaseHeldLock\(\);[\s\S]{0,120}runner\.kill\("SIGTERM"\)/);
		expect(src).toMatch(/releaseLock\(lockHeld\.path, lockHeld\.rsid\)/);
	});
});
