/**
 * `checkWorkdir` — the question nobody was asking about a local repo (#405).
 * `parseSshIdentity` — the deploy-key vs user-account discriminator (#684).
 *
 * Run against the REAL filesystem, deliberately: the whole value of this function is that it
 * reports what is actually on the machine, and a mocked `fs` would only pin that the mock agrees
 * with itself. The one case that needs a real git process is the one the bug turns on — a
 * subdirectory of a checkout has no `.git` of its own and must still be usable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkWorkdir, ensureRepo, parseSshIdentity } from "./repo.js";

const tmp = mkdtempSync(join(tmpdir(), "pags-workdir-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const dir = (name: string) => {
	const d = join(tmp, name);
	mkdirSync(d, { recursive: true });
	return d;
};

describe("checkWorkdir", () => {
	it("reports a path that does not exist", () => {
		const c = checkWorkdir(join(tmp, "never-created"));
		expect(c).toMatchObject({ checked: true, exists: false, isDirectory: false, entryCount: 0, insideWorkTree: false });
	});

	it("reports a file as existing but not a directory", () => {
		const f = join(tmp, "notes.md");
		writeFileSync(f, "hi");
		expect(checkWorkdir(f)).toMatchObject({ exists: true, isDirectory: false });
	});

	// The measured state in #405: created the minute the repo row was, still empty two days later.
	it("reports an EMPTY directory as existing, a directory, and holding nothing", () => {
		expect(checkWorkdir(dir("empty"))).toMatchObject({ exists: true, isDirectory: true, entryCount: 0, insideWorkTree: false });
	});

	it("counts dotfiles — a directory holding only `.git` is not empty", () => {
		const d = dir("dotted");
		mkdirSync(join(d, ".git"));
		expect(checkWorkdir(d).entryCount).toBe(1);
	});

	it("reports a folder full of files that is not a checkout", () => {
		const d = dir("plain");
		writeFileSync(join(d, "a.txt"), "x");
		expect(checkWorkdir(d)).toMatchObject({ exists: true, isDirectory: true, entryCount: 1, insideWorkTree: false });
	});

	/**
	 * The distinction an existence test on `.git` cannot make. This repo IS a checkout, and
	 * `packages/browser-runner/src` has no `.git` in it — pointing an engine at a package inside
	 * a monorepo is an ordinary thing to do, and calling it "not a repo" would condemn it.
	 */
	it("calls a SUBDIRECTORY of a work tree a work tree", () => {
		const here = fileURLToPath(new URL(".", import.meta.url));
		const c = checkWorkdir(here);
		expect(c.exists).toBe(true);
		expect(c.gitChecked).toBe(true);
		expect(c.insideWorkTree).toBe(true);
	});

	it("resolves nothing and throws nothing — every failure is a false", () => {
		expect(() => checkWorkdir("/proc/definitely/not/here")).not.toThrow();
	});
});

/**
 * `parseSshIdentity` is pure, so it can be exercised without a network or a git binary.
 *
 * The deploy-key vs user-account distinction (#684) is structural: GitHub encodes deploy keys
 * as `<org>/<repo>` in the welcome banner, while user accounts are bare login names. A slash
 * is the load-bearing discriminator and the only one this function uses — it must not change
 * without a test failing.
 */
describe("parseSshIdentity", () => {
	it("extracts a user-account login from the GitHub welcome banner", () => {
		expect(parseSshIdentity("Hi serge-ivo! You've successfully authenticated, but GitHub does not provide shell access."))
			.toBe("serge-ivo");
	});

	it("extracts a deploy-key identity (org/repo) from the GitHub welcome banner", () => {
		// Deploy keys arrive as `<org>/<repo>` — the slash is what makes them deploy keys.
		expect(parseSshIdentity("Hi jobsearch-works/shared! You've successfully authenticated, but GitHub does not provide shell access."))
			.toBe("jobsearch-works/shared");
	});

	it("handles ANSI escape sequences some SSH versions prepend", () => {
		expect(parseSshIdentity("\x1b[32mHi serge-ivo! You've successfully authenticated, but GitHub does not provide shell access.\x1b[0m"))
			.toBe("serge-ivo");
	});

	it("returns null when authentication failed (wrong key, no key)", () => {
		// GitHub answers with a permission-denied error, no `Hi` banner.
		expect(parseSshIdentity("git@github.com: Permission denied (publickey).")).toBeNull();
		expect(parseSshIdentity("")).toBeNull();
	});

	it("returns null for unrecognised output", () => {
		expect(parseSshIdentity("Connection refused")).toBeNull();
		expect(parseSshIdentity("ssh: connect to host github.com port 22: Network is unreachable")).toBeNull();
	});

	it("correctly identifies deploy keys by the presence of a slash", () => {
		// Deploy key → isDeployKey should be derivable as identity.includes("/")
		const deployKey = parseSshIdentity("Hi myorg/my-deploy-repo! You've successfully authenticated, but GitHub does not provide shell access.");
		expect(deployKey).not.toBeNull();
		expect(deployKey?.includes("/")).toBe(true);

		const userAccount = parseSshIdentity("Hi octocat! You've successfully authenticated, but GitHub does not provide shell access.");
		expect(userAccount).not.toBeNull();
		expect(userAccount?.includes("/")).toBe(false);
	});
});

/**
 * `ensureRepo` against a REAL upstream (#828). The cloud now sends a clone URL for a repo that is
 * empty or absent on the machine; this is the half that has to turn that into a checkout — and
 * leave every other state exactly as it found it.
 */
describe("ensureRepo — a never-cloned checkout is cloned into; nothing else is touched (#828)", () => {
	const root = mkdtempSync(join(tmpdir(), "pags-ensure-"));
	const upstream = join(root, "upstream");
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
	mkdirSync(upstream);
	git(upstream, "init", "-q", "-b", "main");
	writeFileSync(join(upstream, "README.md"), "hello\n");
	git(upstream, "add", ".");
	git(upstream, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
	const url = `file://${upstream}`;
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("clones into an EMPTY folder", () => {
		const dir = join(root, "empty");
		mkdirSync(dir);
		ensureRepo(dir, { cloneUrl: url });
		expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("hello\n");
		expect(checkWorkdir(dir)).toMatchObject({ checked: true, insideWorkTree: true });
	});

	it("clones into an ABSENT folder, creating its parents", () => {
		const dir = join(root, "nested", "never", "cloned");
		ensureRepo(dir, { cloneUrl: url });
		expect(existsSync(join(dir, ".git"))).toBe(true);
	});

	it("leaves an existing checkout exactly as it is", () => {
		const dir = join(root, "existing");
		ensureRepo(dir, { cloneUrl: url });
		writeFileSync(join(dir, "local-edit.txt"), "mine\n");
		ensureRepo(dir, { cloneUrl: url });
		expect(readFileSync(join(dir, "local-edit.txt"), "utf8")).toBe("mine\n");
	});

	it("refuses a non-empty folder with no .git, and deletes nothing", () => {
		const dir = join(root, "plain");
		mkdirSync(dir);
		writeFileSync(join(dir, "notes.txt"), "keep\n");
		expect(() => ensureRepo(dir, { cloneUrl: url })).toThrow(/Refusing to clone into non-empty directory/);
		expect(readdirSync(dir)).toEqual(["notes.txt"]);
	});

	it("with no clone URL, only makes the folder — which is why the cloud must send one", () => {
		const dir = join(root, "no-url");
		ensureRepo(dir, {});
		expect(readdirSync(dir)).toEqual([]);
	});
});
