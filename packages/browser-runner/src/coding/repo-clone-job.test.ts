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

	it("fails with git's reason for a repository it cannot reach", async () => {
		await expect(cloneIntoOwnFolder(join(tmp, "missing"), join(tmp, "no-such.git"))).rejects.toThrow(/repository|does not exist|not found/i);
	});
});
