/**
 * Background cold-start clones over https or SSH (#858).
 *
 * The transport choice is driven with injected fakes, so each arm says exactly which URL was tried and
 * whether the SSH probe ran. The clone itself runs against real git and a real temp upstream, because
 * what matters there is what lands on disk and that the folder guards hold.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CloneJobs, type CloneJob, cloneIntoOwnFolder, runCloneJob } from "./repo-clone-job.js";
import { readReceipt, writeReceipt } from "./clone-receipt-store.js";

const job = (): CloneJob => ({ path: "/w/grass-karma", slug: "acme/grass-karma", state: "cloning", attempts: [], startedAt: 1 });

describe("which transport a cold-start clone uses (#858)", () => {
	it("https first — and when it works, the SSH probe never runs", async () => {
		const clone = vi.fn(async () => undefined);
		const sshIdentity = vi.fn(() => "serge-ivo");
		const out = await runCloneJob(job(), "auto", { clone, sshIdentity, now: () => 2 });
		expect(out).toMatchObject({ state: "done", via: "https", finishedAt: 2 });
		expect(clone).toHaveBeenCalledWith("/w/grass-karma", "https://github.com/acme/grass-karma.git");
		expect(sshIdentity).not.toHaveBeenCalled();
	});

	it("an SSH-ONLY machine: https refused, the machine has a key github.com accepts — cloned over SSH", async () => {
		const clone = vi.fn(async (_dir: string, url: string) => {
			if (url.startsWith("https://")) throw new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
		});
		const out = await runCloneJob(job(), "auto", { clone, sshIdentity: () => "serge-ivo", now: () => 2 });
		expect(out).toMatchObject({ state: "done", via: "ssh" });
		expect(clone.mock.calls.map(([, url]) => url)).toEqual(["https://github.com/acme/grass-karma.git", "git@github.com:acme/grass-karma.git"]);
		expect(out.attempts[0]).toMatch(/^https: fatal: could not read Username/);
	});

	it("https refused and NO SSH key — failed, with every reason and both fixes named", async () => {
		const clone = vi.fn(async () => {
			throw new Error("remote: Repository not found.");
		});
		const out = await runCloneJob(job(), "auto", { clone, sshIdentity: () => null, now: () => 2 });
		expect(out.state).toBe("failed");
		expect(clone).toHaveBeenCalledTimes(1);
		expect(out.error).toMatch(/https: remote: Repository not found\. \| ssh: not tried — this machine has no SSH key/);
		expect(out.error).toMatch(/gh auth login.*SSH key that github\.com accepts/);
	});

	it("protocol pins the transport: ssh tries only SSH, https only https — and neither probes", async () => {
		const clone = vi.fn(async () => undefined);
		const sshIdentity = vi.fn(() => null);
		await runCloneJob(job(), "ssh", { clone, sshIdentity, now: () => 2 });
		expect(clone).toHaveBeenLastCalledWith("/w/grass-karma", "git@github.com:acme/grass-karma.git");
		clone.mockImplementationOnce(async () => {
			throw new Error("denied");
		});
		expect((await runCloneJob(job(), "https", { clone, sshIdentity, now: () => 2 })).state).toBe("failed");
		expect(sshIdentity).not.toHaveBeenCalled();
	});
});

describe("CloneJobs — one clone per folder, answered at once (#858)", () => {
	it("returns immediately with the job cloning, and asking again JOINS it rather than cloning twice", async () => {
		let finish: () => void = () => undefined;
		const clone = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
		const jobs = new CloneJobs({ clone, sshIdentity: () => null, now: () => 5 });
		const first = jobs.start("/w/gk", "acme/gk");
		expect(first.state).toBe("cloning");
		expect(jobs.start("/w/gk", "acme/gk")).toBe(first);
		expect(clone).toHaveBeenCalledTimes(1);
		finish();
		await vi.waitFor(() => expect(jobs.status("/w/gk")).toMatchObject({ state: "done", via: "https" }));
	});

	it("a failed job is replaced by the next start — which is how a clone is retried", async () => {
		const clone = vi.fn(async () => {
			throw new Error("nope");
		});
		const jobs = new CloneJobs({ clone, sshIdentity: () => null, now: () => 5 });
		jobs.start("/w/gk", "acme/gk");
		await vi.waitFor(() => expect(jobs.status("/w/gk").state).toBe("failed"));
		expect(jobs.start("/w/gk", "acme/gk").state).toBe("cloning");
		expect(clone).toHaveBeenCalledTimes(2);
	});

	it("reports a folder nobody asked to clone as none", () => {
		expect(new CloneJobs().status("/w/other")).toEqual({ path: "/w/other", state: "none" });
	});
});

describe("cloneIntoOwnFolder — real git, the owner-folder guards (#858)", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pags-clonejob-"));
	const upstream = join(tmp, "upstream.git");
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
	beforeAll(() => {
		const seed = join(tmp, "seed");
		mkdirSync(seed);
		git(seed, "init", "-q", "-b", "main");
		git(seed, "config", "user.email", "t@t");
		git(seed, "config", "user.name", "t");
		writeFileSync(join(seed, "README.md"), "grass-karma\n");
		git(seed, "add", ".");
		git(seed, "commit", "-q", "-m", "init");
		git(tmp, "clone", "-q", "--bare", seed, upstream);
	});
	afterAll(() => rmSync(tmp, { recursive: true, force: true }));

	it("clones into an absent folder without blocking — a full checkout whose origin is the URL used", async () => {
		const dir = join(tmp, "absent", "gk");
		const pending = cloneIntoOwnFolder(dir, upstream);
		// Async: control returns before git has finished, so the runner keeps serving its relay.
		expect(pending).toBeInstanceOf(Promise);
		await pending;
		expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("grass-karma\n");
		expect(git(dir, "remote", "get-url", "origin")).toBe(upstream);
	});

	it("clones into an EMPTY folder", async () => {
		const dir = join(tmp, "empty");
		mkdirSync(dir);
		await cloneIntoOwnFolder(dir, upstream);
		expect(existsSync(join(dir, ".git"))).toBe(true);
	});

	it("never clones into a folder with anything in it", async () => {
		const dir = join(tmp, "notes");
		mkdirSync(dir);
		writeFileSync(join(dir, "todo.txt"), "x");
		await expect(cloneIntoOwnFolder(dir, upstream)).rejects.toThrow(/not empty — never cloned into/);
		expect(existsSync(join(dir, ".git"))).toBe(false);
	});

	it("never clones inside a bare repository's administration directory", async () => {
		const dir = join(upstream, "objects", "nested", "clone");
		await expect(cloneIntoOwnFolder(dir, upstream)).rejects.toThrow(/git administration/);
		expect(existsSync(dir)).toBe(false);
	});

	it("fails with git's reason for a repository it cannot reach", async () => {
		await expect(cloneIntoOwnFolder(join(tmp, "missing"), join(tmp, "no-such.git"))).rejects.toThrow(/repository|does not exist|not found/i);
	});
});

describe("CloneJobs durability across a runner crash or forced restart (#1459)", () => {
	const store = () => join(mkdtempSync(join(tmpdir(), "pags-clone-receipts-")), "receipts.json");

	it("persists a receipt before contacting the machine, so a crash mid-clone leaves something to reconcile", async () => {
		const receiptsPath = store();
		let finish: () => void = () => undefined;
		const clone = vi.fn((_dir: string, _url: string, onPid?: (pid: number) => void) => {
			onPid?.(4242);
			return new Promise<void>((resolve) => (finish = resolve));
		});
		const jobs = new CloneJobs({ clone, sshIdentity: () => null, now: () => 5 }, { receiptsPath, runnerInstanceId: "r1" });
		jobs.start("/w/gk", "acme/gk");
		await vi.waitFor(() => expect(readReceipt(receiptsPath, "/w/gk")).toMatchObject({ slug: "acme/gk", runnerInstanceId: "r1", pid: 4242 }));
		finish();
		await vi.waitFor(() => expect(jobs.status("/w/gk")).toMatchObject({ state: "done" }));
		// Finished and acknowledged within this same process: nothing left to reconcile later.
		expect(readReceipt(receiptsPath, "/w/gk")).toBeNull();
	});

	it("never adopts its OWN receipt as an orphan — a job missing from memory under the SAME runner instance already finished", () => {
		const receiptsPath = store();
		writeReceipt(receiptsPath, { path: "/w/gk", slug: "acme/gk", protocol: "auto", jobId: "j1", runnerInstanceId: "r1", pid: 999, startedAt: 1 });
		const jobs = new CloneJobs(undefined, { receiptsPath, runnerInstanceId: "r1", isAlive: () => true });
		expect(jobs.status("/w/gk")).toEqual({ path: "/w/gk", state: "none" });
		expect(readReceipt(receiptsPath, "/w/gk")).toBeNull();
	});

	it("adopts an orphaned clone left by a DIFFERENT (crashed/restarted) runner instance, and reports it still cloning", () => {
		const receiptsPath = store();
		writeReceipt(receiptsPath, { path: "/w/gk", slug: "acme/gk", protocol: "auto", jobId: "j1", runnerInstanceId: "old-process", pid: 999, startedAt: 1 });
		const jobs = new CloneJobs(undefined, { receiptsPath, runnerInstanceId: "new-process", isAlive: () => true, pollIntervalMs: 100_000 });
		expect(jobs.status("/w/gk")).toMatchObject({ path: "/w/gk", slug: "acme/gk", state: "cloning" });
	});

	it("resolves an adopted orphan to `done` once it exits over a genuinely completed checkout", async () => {
		const receiptsPath = store();
		writeReceipt(receiptsPath, { path: "/w/gk", slug: "acme/gk", protocol: "auto", jobId: "j1", runnerInstanceId: "old-process", pid: 999, startedAt: 1 });
		let alive = true;
		const jobs = new CloneJobs(undefined, { receiptsPath, runnerInstanceId: "new-process", isAlive: () => alive, inspectEvidence: () => "completed", pollIntervalMs: 2 });
		expect(jobs.status("/w/gk")).toMatchObject({ state: "cloning" });
		alive = false;
		await vi.waitFor(() => expect(jobs.status("/w/gk")).toMatchObject({ state: "done" }));
		expect(readReceipt(receiptsPath, "/w/gk")).toBeNull();
	});

	it("resolves an adopted orphan to `failed` once it exits over a genuinely incomplete checkout — a partial checkout, never deleted", async () => {
		const receiptsPath = store();
		const dir = mkdtempSync(join(tmpdir(), "pags-clone-partial-"));
		writeFileSync(join(dir, "partial-marker"), "whatever git had written");
		writeReceipt(receiptsPath, { path: dir, slug: "acme/gk", protocol: "auto", jobId: "j1", runnerInstanceId: "old-process", pid: 999, startedAt: 1 });
		let alive = true;
		const jobs = new CloneJobs(undefined, { receiptsPath, runnerInstanceId: "new-process", isAlive: () => alive, inspectEvidence: () => "incomplete", pollIntervalMs: 2 });
		expect(jobs.status(dir)).toMatchObject({ state: "cloning" });
		alive = false;
		await vi.waitFor(() => expect(jobs.status(dir)).toMatchObject({ state: "failed" }));
		expect(jobs.status(dir)).toMatchObject({ error: expect.stringMatching(/restarted|retry is refused/) });
		// Never deleted: the owner's (or git's partial) file is exactly as it was.
		expect(existsSync(join(dir, "partial-marker"))).toBe(true);
	});

	it("judges a dead orphan's outcome immediately, without ever polling, when the pid was already gone at reconciliation time", () => {
		const receiptsPath = store();
		writeReceipt(receiptsPath, { path: "/w/gk", slug: "acme/gk", protocol: "auto", jobId: "j1", runnerInstanceId: "old-process", pid: 999, startedAt: 1 });
		const jobs = new CloneJobs(undefined, { receiptsPath, runnerInstanceId: "new-process", isAlive: () => false, inspectEvidence: () => "completed" });
		expect(jobs.status("/w/gk")).toMatchObject({ state: "done" });
		expect(readReceipt(receiptsPath, "/w/gk")).toBeNull();
	});

	it("a legacy receipt with no recorded pid is judged from evidence right away — nothing to poll for liveness", () => {
		const receiptsPath = store();
		writeReceipt(receiptsPath, { path: "/w/gk", slug: "acme/gk", protocol: "auto", jobId: "j1", runnerInstanceId: "old-process", pid: null, startedAt: 1 });
		const isAlive = vi.fn(() => true);
		const jobs = new CloneJobs(undefined, { receiptsPath, runnerInstanceId: "new-process", isAlive, inspectEvidence: () => "completed" });
		expect(jobs.status("/w/gk")).toMatchObject({ state: "done" });
		expect(isAlive).not.toHaveBeenCalled();
	});

	it("a duplicate start() while an adopted orphan is still being watched JOINS it — never a second clone into the same destination", () => {
		const receiptsPath = store();
		writeReceipt(receiptsPath, { path: "/w/gk", slug: "acme/gk", protocol: "auto", jobId: "j1", runnerInstanceId: "old-process", pid: 999, startedAt: 1 });
		const clone = vi.fn(async () => undefined);
		const jobs = new CloneJobs({ clone, sshIdentity: () => null, now: () => 5 }, { receiptsPath, runnerInstanceId: "new-process", isAlive: () => true, pollIntervalMs: 100_000 });
		const adopted = jobs.status("/w/gk");
		const retried = jobs.start("/w/gk", "acme/gk");
		expect(retried).toEqual(adopted);
		expect(clone).not.toHaveBeenCalled();
	});

	it("bounds how long a reused pid can be trusted — past maxOrphanWaitMs it is judged from evidence regardless of `isAlive`", async () => {
		const receiptsPath = store();
		writeReceipt(receiptsPath, { path: "/w/gk", slug: "acme/gk", protocol: "auto", jobId: "j1", runnerInstanceId: "old-process", pid: 999, startedAt: 1_000 });
		let now = 1_000;
		const jobs = new CloneJobs(
			{ clone: vi.fn(async () => undefined), sshIdentity: () => null, now: () => now },
			{ receiptsPath, runnerInstanceId: "new-process", isAlive: () => true, inspectEvidence: () => "completed", pollIntervalMs: 2, maxOrphanWaitMs: 50 },
		);
		expect(jobs.status("/w/gk")).toMatchObject({ state: "cloning" });
		now += 1_000; // well past maxOrphanWaitMs, with `isAlive` still (falsely) saying it's running
		await vi.waitFor(() => expect(jobs.status("/w/gk")).toMatchObject({ state: "done" }));
	});

	it("without a receiptsPath, behaves exactly as before #1459 — a crash is simply unseen, same as always", () => {
		const jobs = new CloneJobs(undefined, {});
		expect(jobs.status("/w/gk")).toEqual({ path: "/w/gk", state: "none" });
	});
});
