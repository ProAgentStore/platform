/**
 * #1459: a `.git` directory and an `origin` are not proof a background clone finished — this is
 * what the live failure described (a reconciled job judged from disk) actually checks.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectCloneEvidence } from "./clone-evidence.js";

const tmp = mkdtempSync(join(tmpdir(), "pags-clone-evidence-"));
const upstream = join(tmp, "upstream.git");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

beforeAll(() => {
	const seed = join(tmp, "seed");
	mkdirSync(seed);
	git(seed, "init", "-q", "-b", "main");
	git(seed, "config", "user.email", "t@t");
	git(seed, "config", "user.name", "t");
	writeFileSync(join(seed, "README.md"), "evidence\n");
	git(seed, "add", ".");
	git(seed, "commit", "-q", "-m", "init");
	git(tmp, "clone", "-q", "--bare", seed, upstream);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("inspectCloneEvidence (#1459)", () => {
	it("is `incomplete` when the destination does not exist at all", () => {
		expect(inspectCloneEvidence(join(tmp, "nope"), "acme/gk")).toBe("incomplete");
	});

	it("is `completed` for a real, finished clone whose origin names the requested repo", () => {
		const dir = join(tmp, "finished");
		git(tmp, "clone", "-q", upstream, dir);
		git(dir, "remote", "set-url", "origin", "https://github.com/acme/gk.git");
		expect(inspectCloneEvidence(dir, "acme/gk")).toBe("completed");
	});

	it("is `completed` when origin was set over SSH instead", () => {
		const dir = join(tmp, "finished-ssh");
		git(tmp, "clone", "-q", upstream, dir);
		git(dir, "remote", "set-url", "origin", "git@github.com:acme/gk.git");
		expect(inspectCloneEvidence(dir, "acme/gk")).toBe("completed");
	});

	it("is `incomplete` when a lock file is present — some operation never finished writing", () => {
		const dir = join(tmp, "locked");
		git(tmp, "clone", "-q", upstream, dir);
		git(dir, "remote", "set-url", "origin", "https://github.com/acme/gk.git");
		writeFileSync(join(dir, ".git", "index.lock"), "");
		expect(inspectCloneEvidence(dir, "acme/gk")).toBe("incomplete");
	});

	it("is `incomplete` when there is no .git at all — the clone never got that far", () => {
		const dir = join(tmp, "bare-folder");
		mkdirSync(dir);
		writeFileSync(join(dir, "placeholder"), "");
		expect(inspectCloneEvidence(dir, "acme/gk")).toBe("incomplete");
	});

	it("is `incomplete` when HEAD does not resolve — a git init with no commit transferred yet", () => {
		const dir = join(tmp, "no-head");
		mkdirSync(dir);
		git(dir, "init", "-q");
		git(dir, "remote", "add", "origin", "https://github.com/acme/gk.git");
		expect(inspectCloneEvidence(dir, "acme/gk")).toBe("incomplete");
	});

	it("is `incomplete` when origin names a DIFFERENT repo — this directory proves nothing about the job in question", () => {
		const dir = join(tmp, "wrong-origin");
		git(tmp, "clone", "-q", upstream, dir);
		git(dir, "remote", "set-url", "origin", "https://github.com/acme/some-other-repo.git");
		expect(inspectCloneEvidence(dir, "acme/gk")).toBe("incomplete");
	});

	it("is `incomplete` when there is no origin remote at all", () => {
		const dir = join(tmp, "no-origin");
		git(tmp, "clone", "-q", "--no-local", upstream, dir);
		git(dir, "remote", "remove", "origin");
		expect(inspectCloneEvidence(dir, "acme/gk")).toBe("incomplete");
	});
});
