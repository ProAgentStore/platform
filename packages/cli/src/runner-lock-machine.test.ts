/**
 * #1180 — the one-runner lock is the MACHINE's, and every `runner connect` takes it.
 *
 * Before: the lock sat under PAGS_CONFIG_DIR, so a dev runner with its own config dir got a slot of its own and ran beside `pags up`
 * under the same hostname and machine identity (4409 / --force fights); and a bare `runner connect` took no lock at all unless
 * PAGS_LOCK_ACCOUNT was set. The first is behavioural (real files, a real pid); the second is pinned on the source, as the other
 * connect wiring is (`up-single-instance.test.ts`), because the action is a long-running process.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, lockPath, releaseLock, UNKNOWN_LOCK_ACCOUNT } from "./runner-lock.js";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pags-machine-lock-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const input = (env: NodeJS.ProcessEnv, account = "serge-ivo") => ({ account, node: "mac-mini", machineId: "m-mini", version: "0.4.170", port: null, env });

describe("the lock does not move with PAGS_CONFIG_DIR (#1180)", () => {
	it("a dev runner with its own config dir meets the installed runner's lock and is refused, naming the holder", async () => {
		const installed = { HOME: home } as NodeJS.ProcessEnv;
		const dev = { HOME: home, PAGS_CONFIG_DIR: join(home, "dev-config") } as NodeJS.ProcessEnv;
		const first = await acquireLock(input(installed));
		expect(first.ok).toBe(true);
		const second = await acquireLock(input(dev));
		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.path).toBe(first.path);
			// Alive pid, no /health to answer (port null): never taken automatically.
			expect(second.verdict).not.toBe("dead");
			expect(second.lock?.rsid).toBe(first.ok ? first.lock.rsid : "");
		}
		// And it left no second lock behind in its own directory.
		expect(() => readdirSync(join(home, "dev-config"))).toThrow();
		if (first.ok) releaseLock(first.path, first.lock.rsid);
	});

	it("the other way round too: the dev runner holds it first, and the installed one is the one refused", async () => {
		const dev = { HOME: home, PAGS_CONFIG_DIR: join(home, "dev-config") } as NodeJS.ProcessEnv;
		const first = await acquireLock(input(dev));
		expect(first.ok).toBe(true);
		expect((await acquireLock(input({ HOME: home } as NodeJS.ProcessEnv))).ok).toBe(false);
		if (first.ok) releaseLock(first.path, first.lock.rsid);
	});

	it("still per ACCOUNT: a second account on the machine has its own slot, whatever its config dir", async () => {
		const a = await acquireLock(input({ HOME: home } as NodeJS.ProcessEnv, "alice"));
		const b = await acquireLock(input({ HOME: home, PAGS_CONFIG_DIR: join(home, "x") } as NodeJS.ProcessEnv, "bob"));
		expect([a.ok, b.ok]).toEqual([true, true]);
		expect(lockPath("alice", { HOME: home } as NodeJS.ProcessEnv)).not.toBe(lockPath("bob", { HOME: home } as NodeJS.ProcessEnv));
		for (const r of [a, b]) if (r.ok) releaseLock(r.path, r.lock.rsid);
	});

	it("a released lock frees the slot for either", async () => {
		const first = await acquireLock(input({ HOME: home } as NodeJS.ProcessEnv));
		if (first.ok) releaseLock(first.path, first.lock.rsid);
		expect((await acquireLock(input({ HOME: home, PAGS_CONFIG_DIR: join(home, "dev-config") } as NodeJS.ProcessEnv))).ok).toBe(true);
	});
});

describe("a bare `runner connect` takes the lock (#1180)", () => {
	const connect = readFileSync(new URL("./commands/runner/command.ts", import.meta.url), "utf-8");
	/** Code with comments stripped. */
	const code = connect.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

	it("acquires unconditionally - no `if (lockAccount)` around it", () => {
		expect(code).not.toMatch(/if \(lockAccount\)\s*\{/);
		expect(code).toMatch(/acquireLock\(\{ account: lockAccount,/);
	});

	it("names the account from PAGS_LOCK_ACCOUNT, else the signed-in session, else the unknown-account slot", () => {
		expect(code).toMatch(/const lockAccount = clean\(process\.env\.PAGS_LOCK_ACCOUNT\) \|\| loadSession\(\)\?\.user\.login\?\.trim\(\) \|\| UNKNOWN_LOCK_ACCOUNT;/);
		expect(UNKNOWN_LOCK_ACCOUNT).toBe("(unknown account)");
	});

	it("an account that is not known is not stamped onto crash reports", () => {
		expect(code).toMatch(/lockAccount === UNKNOWN_LOCK_ACCOUNT \? "" : lockAccount/);
	});

	it("a refused connect prints who holds it and exits non-zero, before anything is spawned", () => {
		expect(code).toMatch(/holderMessage\(taken\.lock, taken\.verdict\)[\s\S]{0,300}process\.exit\(RUNNER_ALREADY_RUNNING_EXIT_CODE\)/); // #1295: non-zero, but not the crash code
		expect(code.indexOf("acquireLock(")).toBeLessThan(code.indexOf("spawn(spec.command"));
	});
});
