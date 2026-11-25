import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerInputError } from "../errors.js";
import { startIsolatedCheckout, worktreeRootFor } from "./isolated-start.js";
import { CodingRuntime } from "./runtime.js";

/** #1708 — a session whose repository is isolated starts in a managed worktree; every other session keeps the shared folder. Real temporary repositories only. */

const SESSION = "csess_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const git = (cwd: string, ...argv: string[]) => execFileSync("git", argv, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

describe("isolated start (#1708)", () => {
	let base: string;
	let shared: string;
	let reposBase: string;
	let rt: CodingRuntime | undefined;
	beforeEach(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "pags-iso-")));
		const origin = join(base, "origin.git");
		shared = join(base, "shared");
		reposBase = join(base, "config", "repos");
		mkdirSync(reposBase, { recursive: true });
		git(base, "init", "-q", "--bare", "-b", "main", origin);
		git(base, "clone", "-q", origin, shared);
		git(shared, "config", "user.email", "t@example.com");
		git(shared, "config", "user.name", "T");
		git(shared, "checkout", "-q", "-b", "main");
		writeFileSync(join(shared, "a.txt"), "one\n");
		git(shared, "add", "-A");
		git(shared, "commit", "-qm", "first");
		git(shared, "push", "-q", "origin", "main");
	});
	afterEach(() => {
		rt?.closeAll();
		rt = undefined;
		rmSync(base, { recursive: true, force: true });
	});

	it("a repository with no strategy, or shared/direct, gets no worktree", () => {
		const root = worktreeRootFor(reposBase);
		expect(startIsolatedCheckout(shared, root, { sessionId: SESSION })).toBeNull();
		expect(startIsolatedCheckout(shared, root, { sessionId: SESSION, strategy: "shared-direct" })).toBeNull();
		expect(existsSync(root)).toBe(false);
	});

	it("isolated-direct cuts a worktree at the LATEST target commit and leaves the shared folder alone", () => {
		const other = join(base, "other");
		git(base, "clone", "-q", join(base, "origin.git"), other);
		git(other, "config", "user.email", "t@example.com");
		git(other, "config", "user.name", "T");
		writeFileSync(join(other, "b.txt"), "two\n");
		git(other, "add", "-A");
		git(other, "commit", "-qm", "second");
		git(other, "push", "-q", "origin", "main");
		writeFileSync(join(shared, "wip.txt"), "someone's edit\n");

		const got = startIsolatedCheckout(shared, worktreeRootFor(reposBase), { sessionId: SESSION, strategy: "isolated-direct", branch: "main" });
		expect(got).toMatchObject({ mode: "worktree", target: "main", publish: "direct", created: true });
		expect(git(got?.path ?? "", "rev-parse", "HEAD").trim()).toBe(git(other, "rev-parse", "HEAD").trim());
		expect(existsSync(join(got?.path ?? "", "b.txt"))).toBe(true);
		expect(existsSync(join(shared, "wip.txt"))).toBe(true); // the shared folder was not touched
		expect(git(shared, "rev-parse", "HEAD").trim()).not.toBe(got?.base);
		expect(startIsolatedCheckout(shared, worktreeRootFor(reposBase), { sessionId: SESSION, strategy: "isolated-direct", branch: "main" })).toMatchObject({ created: false, path: got?.path });
	});

	it("isolated-pr runs on the run branch", () => {
		const got = startIsolatedCheckout(shared, worktreeRootFor(reposBase), { sessionId: SESSION, strategy: "isolated-pr", branch: "main" });
		expect(got?.publish).toBe("pr");
		expect(git(got?.path ?? "", "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("pags/run/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
	});

	it("falls back to the shared folder's branch when the cloud names none, and refuses what it cannot place", () => {
		expect(startIsolatedCheckout(shared, worktreeRootFor(reposBase), { sessionId: SESSION, strategy: "isolated-direct" })?.target).toBe("main");
		expect(() => startIsolatedCheckout(shared, worktreeRootFor(reposBase), { sessionId: "not-a-uuid", strategy: "isolated-direct", branch: "main" })).toThrow(RunnerInputError);
		expect(() => startIsolatedCheckout(shared, worktreeRootFor(reposBase), { sessionId: "csess_cccccccc-3333-4333-8333-cccccccccccc", strategy: "isolated-direct", branch: "nope" })).toThrow(/could not fetch the target/);
	});

	it("the runtime runs the engine in the worktree, reports it, and an unaware request still uses the shared folder", () => {
		const bin = join(base, "idle-engine");
		writeFileSync(bin, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
		chmodSync(bin, 0o755);
		rt = new CodingRuntime(reposBase);
		const iso = rt.start({ sessionId: SESSION, repoId: "r1", workDir: shared, clientType: "claude", bin, branch: "main", strategy: "isolated-direct" });
		expect(iso.checkout?.path).toBe(join(worktreeRootFor(reposBase), iso.checkout?.path.split("/").slice(-2)[0] ?? "", "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"));
		expect(rt.diagnostics().find((d: { sessionId: string }) => d.sessionId === SESSION)).toBeDefined();
		const plain = rt.start({ sessionId: "csess_bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", repoId: "r1", workDir: shared, clientType: "claude", bin, branch: "main" });
		expect(plain.checkout).toBeUndefined();
	});
});
