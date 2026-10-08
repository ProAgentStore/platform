/**
 * #896 — one `pags up` per machine per account, and who is allowed to take over.
 *
 * The live failure these hold the line on: three `pags up` processes on one laptop, only one
 * owning the relay link, that link wedged, and `pkill -f` as the only "protection" — which kills
 * any matching process of this OS user, including another account's runner, a service-managed one,
 * and (since the local runtimes shipped) a Codex turn, a research run or an application fill
 * mid-flight.
 *
 * The rule most of this file defends is "slow is not dead": a sleeping laptop, a SIGSTOPped
 * process and a machine at 6× load are indistinguishable from each other, and all three are
 * legitimate holders. Only a pid that is GONE (or reused) may be taken automatically.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	accountKey,
	acquireLock,
	classifyHolder,
	configDir,
	detectLaunch,
	type HolderFacts,
	holderMessage,
	holderWhere,
	isTakeable,
	lockPath,
	pidStartedAt,
	readLock,
	releaseLock,
	type RunnerLockFile,
	updateLock,
} from "./runner-lock.js";

const LOCK = (over: Partial<RunnerLockFile> = {}): RunnerLockFile => ({
	v: 1,
	rsid: "rsid-A",
	pid: 4121,
	pidStartedAt: "Wed Oct  1 09:12:03 2026",
	startedAt: Date.parse("2026-10-01T09:12:03Z"),
	port: 4000,
	node: "pink-laptop",
	machineId: "m-pink",
	account: "serge-ivo",
	version: "0.4.87",
	launch: "tty",
	launchDetail: "ttys003",
	childPids: [4122],
	nonce: "nonce-A",
	runnerToken: "runner-token",
	heartbeatAt: Date.parse("2026-10-01T09:12:33Z"),
	...over,
});
const facts = (over: Partial<HolderFacts> = {}): HolderFacts => ({ lock: LOCK(), pidAlive: true, pidStartedAt: "Wed Oct  1 09:12:03 2026", healthRsid: "rsid-A", ...over });

describe("who holds the lock (#896)", () => {
	it("LIVE: the pid is alive and /health answers with the same rsid", () => {
		expect(classifyHolder(facts())).toBe("live");
		expect(isTakeable("live"), "a live runner is never taken without the owner saying so").toBe(false);
	});

	it("DEAD: the pid is gone", () => {
		expect(classifyHolder(facts({ pidAlive: false, healthRsid: null }))).toBe("dead");
		expect(isTakeable("dead")).toBe(true);
	});

	it("DEAD: the pid is alive but is a DIFFERENT process — the pid was reused", () => {
		expect(classifyHolder(facts({ pidStartedAt: "Thu Oct  8 11:00:00 2026", healthRsid: null }))).toBe("dead");
	});

	it("UNRESPONSIVE, never takeable: alive, not answering — asleep, stopped, or overloaded", () => {
		// This is the case the whole file exists for. A laptop at 6 per core answers nothing and is
		// perfectly alive; taking its slot is how the 2026-10-01 state was produced.
		const v = classifyHolder(facts({ healthRsid: null }));
		expect(v).toBe("unresponsive");
		expect(isTakeable(v)).toBe(false);
	});

	it("a port answering with SOMEBODY ELSE's rsid proves nothing about our holder", () => {
		// A recycled port, or another account's runner. It must not read as "live" (that would be a
		// false identity) nor as "dead" (the pid is right there) — the pid's own liveness decides.
		expect(classifyHolder(facts({ healthRsid: "rsid-OTHER" }))).toBe("unresponsive");
		expect(classifyHolder(facts({ healthRsid: "rsid-OTHER", pidAlive: false }))).toBe("dead");
	});

	it("when EITHER start time is unknown the pid stands — 'cannot tell' is not 'dead'", () => {
		expect(classifyHolder(facts({ pidStartedAt: "", healthRsid: null }))).toBe("unresponsive");
		expect(classifyHolder(facts({ lock: LOCK({ pidStartedAt: "" }), healthRsid: null }))).toBe("unresponsive");
	});

	it("UNKNOWN is treated as live: an unreadable lock, or one from a newer CLI", () => {
		expect(classifyHolder(facts({ lock: null }))).toBe("unknown");
		expect(classifyHolder(facts({ lock: { ...LOCK(), v: 2 as never } }))).toBe("unknown");
		expect(classifyHolder(facts({ lock: LOCK({ pid: 0 }) }))).toBe("unknown");
		for (const v of ["unknown", "live", "unresponsive"] as const) expect(isTakeable(v)).toBe(false);
	});
});

describe("what a refused `pags up` says", () => {
	it("names the holder, where it is, and the ways out", () => {
		const lines = holderMessage(LOCK(), "live").join("\n");
		expect(lines).toMatch(/already running for this account on this machine/);
		expect(lines).toMatch(/pid 4121/);
		expect(lines).toMatch(/CLI 0\.4\.87/);
		expect(lines).toMatch(/terminal ttys003/);
		expect(lines).toMatch(/pags status/);
		expect(lines).toMatch(/pags up --replace/);
	});

	it("offers `tmux attach` when that is where the holder lives", () => {
		expect(holderWhere(LOCK({ launch: "tmux", launchDetail: "pags" }))).toBe("tmux session pags");
		expect(holderMessage(LOCK({ launch: "tmux", launchDetail: "pags" }), "live").join("\n")).toMatch(/tmux attach -t pags/);
	});

	it("does NOT offer --replace against a service runner — the unit would just restart it (Q2)", () => {
		const lines = holderMessage(LOCK({ launch: "service" }), "live").join("\n");
		expect(lines).toMatch(/background service/);
		expect(lines).toMatch(/stop its launchd\/systemd unit/);
		expect(lines).not.toMatch(/pags up --replace/);
	});

	it("says so when the holder is not answering, instead of implying it is gone", () => {
		expect(holderMessage(LOCK(), "unresponsive").join("\n")).toMatch(/NOT answering its health check/);
		expect(holderMessage(LOCK(), "unknown").join("\n")).toMatch(/could not be read/);
	});
});

describe("where the lock lives", () => {
	it("is per ACCOUNT, so two accounts can each run one runner here (Q1)", () => {
		const a = lockPath("serge-ivo", { HOME: "/home/x" } as NodeJS.ProcessEnv);
		const b = lockPath("someone-else", { HOME: "/home/x" } as NodeJS.ProcessEnv);
		expect(a).not.toBe(b);
		expect(a).toMatch(/up-[0-9a-f]{12}\.lock$/);
		// The account is hashed, not spelled out, and the same account always resolves the same way.
		expect(a).not.toContain("serge-ivo");
		expect(accountKey("Serge-Ivo")).toBe(accountKey("serge-ivo "));
	});

	it("follows PAGS_CONFIG_DIR, which is how a dev runner stays out of the installed one's way", () => {
		expect(configDir({ PAGS_CONFIG_DIR: "/tmp/alt" } as NodeJS.ProcessEnv)).toBe("/tmp/alt");
		expect(lockPath("a", { PAGS_CONFIG_DIR: "/tmp/alt" } as NodeJS.ProcessEnv)).toMatch(/^\/tmp\/alt\/up-/);
	});
});

describe("how the launch is recognised", () => {
	it.each([
		[{ PAGS_SERVICE: "1", PAGS_SERVICE_NAME: "com.pags.runner" }, true, "service", "com.pags.runner"],
		[{ TMUX: "/tmp/tmux-501/pags,1234,0", TMUX_PANE: "%7" }, true, "tmux", "%7"],
		[{}, false, "headless", ""],
		[{ TERM_SESSION_ID: "w0t1p0" }, true, "tty", "w0t1p0"],
	] as const)("%o → %s", (env, isTty, launch, detail) => {
		expect(detectLaunch(env as NodeJS.ProcessEnv, isTty)).toEqual({ launch, detail });
	});

	it("a service wins over a tmux pane — what may replace it is decided by the service, not the pane", () => {
		expect(detectLaunch({ PAGS_SERVICE: "1", TMUX: "/tmp/t,1,0" } as NodeJS.ProcessEnv, true).launch).toBe("service");
	});
});

describe("taking and releasing the lock, on a real filesystem", () => {
	let dir: string;
	let env: NodeJS.ProcessEnv;
	const input = () => ({ account: "serge-ivo", node: "pink-laptop", machineId: "m-pink", version: "0.4.87", port: null, env });

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-lock-"));
		env = { PAGS_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("takes a free lock, recording this process and a nonce only it can read", async () => {
		const got = await acquireLock({ ...input(), rsid: "mine" });
		expect(got.ok).toBe(true);
		if (!got.ok) return;
		expect(got.tookOver).toBe("none");
		expect(got.lock).toMatchObject({ v: 1, rsid: "mine", pid: process.pid, account: "serge-ivo", node: "pink-laptop" });
		expect(got.lock.nonce, "the shutdown credential is generated, not blank").toMatch(/[0-9a-f-]{36}/);
		expect(readLock(got.path)?.rsid).toBe("mine");
	});

	it("REFUSES while a live holder exists — this process is its own witness", async () => {
		// The lock names THIS pid, which is alive; /health cannot answer on a port nobody serves, so
		// the verdict is `unresponsive` — and an unresponsive holder is never taken.
		const first = await acquireLock({ ...input(), rsid: "first" });
		expect(first.ok).toBe(true);
		const second = await acquireLock({ ...input(), rsid: "second" });
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.verdict).toBe("unresponsive");
		expect(second.lock?.rsid).toBe("first");
		expect(readLock(second.path)?.rsid, "the incumbent's lock is untouched").toBe("first");
	});

	it("TAKES OVER a stale lock automatically: the pid is gone", async () => {
		// pid 2**31-1 cannot be running; nothing is killed and nothing is asked.
		writeFileSync(lockPath("serge-ivo", env), JSON.stringify(LOCK({ pid: 2147483647, rsid: "ghost", port: null })), { mode: 0o600 });
		const got = await acquireLock({ ...input(), rsid: "mine" });
		expect(got.ok).toBe(true);
		if (!got.ok) return;
		expect(got.tookOver).toBe("stale");
		expect(readLock(got.path)?.rsid).toBe("mine");
		// The dead lock is kept beside it, named after its pid, for anybody debugging the machine.
		expect(existsSync(`${got.path}.stale-2147483647`)).toBe(true);
	});

	it("TAKES OVER when the pid was REUSED: alive, but a different process", async () => {
		writeFileSync(lockPath("serge-ivo", env), JSON.stringify(LOCK({ pid: process.pid, rsid: "ghost", pidStartedAt: "Wed Jan  1 00:00:00 2020", port: null })), { mode: 0o600 });
		const got = await acquireLock({ ...input(), rsid: "mine" });
		expect(got.ok, "a recorded start time that no longer matches means the pid was recycled").toBe(true);
		if (got.ok) expect(readLock(got.path)?.rsid).toBe("mine");
	});

	it("TWO STARTS AT ONCE: exactly one wins, and the loser is told who holds it", async () => {
		const [a, b] = await Promise.all([acquireLock({ ...input(), rsid: "A" }), acquireLock({ ...input(), rsid: "B" })]);
		const winners = [a, b].filter((r) => r.ok);
		expect(winners, "O_EXCL gives one winner — never two runners under one node name").toHaveLength(1);
		const loser = [a, b].find((r) => !r.ok);
		expect(loser && !loser.ok && loser.lock?.rsid).toBe(winners[0].ok ? winners[0].lock.rsid : "");
	});

	it("TWO CONTENDERS FOR ONE STALE LOCK: one takeover, not two", async () => {
		writeFileSync(lockPath("serge-ivo", env), JSON.stringify(LOCK({ pid: 2147483647, rsid: "ghost", port: null })), { mode: 0o600 });
		const [a, b] = await Promise.all([acquireLock({ ...input(), rsid: "A" }), acquireLock({ ...input(), rsid: "B" })]);
		expect([a, b].filter((r) => r.ok), "the rename is the one-winner gate").toHaveLength(1);
	});

	it("a SUPERVISED RESTART inherits the slot from the exact process that handed it over", async () => {
		// `runner_update` / the self-update path: the old process is still recorded, and only the
		// handoff rsid may take it. Anything else still refuses.
		writeFileSync(lockPath("serge-ivo", env), JSON.stringify(LOCK({ pid: process.pid, pidStartedAt: pidStartedAt(process.pid), rsid: "outgoing", port: null })), { mode: 0o600 });
		const stranger = await acquireLock({ ...input(), rsid: "stranger" });
		expect(stranger.ok, "no handoff id — refused").toBe(false);
		const heir = await acquireLock({ ...input(), rsid: "incoming", handoffFrom: "outgoing" });
		expect(heir.ok).toBe(true);
		if (heir.ok) {
			expect(heir.tookOver).toBe("handoff");
			expect(readLock(heir.path)?.rsid).toBe("incoming");
		}
		// …and a handoff id that does not match the incumbent is not a licence to take it.
		writeFileSync(lockPath("serge-ivo", env), JSON.stringify(LOCK({ pid: process.pid, pidStartedAt: pidStartedAt(process.pid), rsid: "someone", port: null })), { mode: 0o600 });
		expect((await acquireLock({ ...input(), rsid: "x", handoffFrom: "not-someone" })).ok).toBe(false);
	});

	it("the handoff can also arrive in the environment, which is how the supervisor passes it", async () => {
		writeFileSync(lockPath("serge-ivo", env), JSON.stringify(LOCK({ pid: process.pid, pidStartedAt: pidStartedAt(process.pid), rsid: "outgoing", port: null })), { mode: 0o600 });
		const heir = await acquireLock({ ...input(), rsid: "incoming", env: { ...env, PAGS_LOCK_HANDOFF: "outgoing" } });
		expect(heir.ok).toBe(true);
	});

	it("RELEASES only when the lock is still mine", async () => {
		const got = await acquireLock({ ...input(), rsid: "mine" });
		expect(got.ok).toBe(true);
		if (!got.ok) return;
		// A process that was replaced must not unlock the machine for everybody on its way out.
		expect(releaseLock(got.path, "somebody-else")).toBe(false);
		expect(existsSync(got.path)).toBe(true);
		expect(releaseLock(got.path, "mine")).toBe(true);
		expect(existsSync(got.path)).toBe(false);
		// Releasing twice is harmless.
		expect(releaseLock(got.path, "mine")).toBe(false);
	});

	it("updates the port, children and heartbeat in place — and only for the holder", async () => {
		const got = await acquireLock({ ...input(), rsid: "mine" });
		if (!got.ok) return;
		expect(updateLock(got.path, "mine", { port: 4123, childPids: [991, 992] })?.port).toBe(4123);
		expect(readLock(got.path)).toMatchObject({ rsid: "mine", port: 4123, childPids: [991, 992], pid: process.pid });
		expect(updateLock(got.path, "not-mine", { port: 9999 }), "another process cannot rewrite my lock").toBeNull();
		expect(readLock(got.path)?.port).toBe(4123);
	});

	it("an unreadable lock is left alone, not stamped over", async () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(lockPath("serge-ivo", env), "{ this is not json", { mode: 0o600 });
		const got = await acquireLock({ ...input(), rsid: "mine" });
		expect(got.ok, "assumed live: guessing the other way is how a working runner gets killed").toBe(false);
		if (!got.ok) expect(got.verdict).toBe("unknown");
		expect(readFileSync(lockPath("serge-ivo", env), "utf-8")).toBe("{ this is not json");
	});

	it("keeps the two accounts' locks apart on the same machine", async () => {
		const mine = await acquireLock({ ...input(), rsid: "mine" });
		const theirs = await acquireLock({ account: "other-account", node: "pink-laptop", machineId: "m-pink", version: "0.4.87", port: null, env, rsid: "theirs" });
		expect(mine.ok && theirs.ok, "one runner each, not one runner total").toBe(true);
	});
});
