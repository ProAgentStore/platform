/** #1446: exercise the actual runtime boundary that cold-start API mocks used to skip. */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneIntoOwnFolder, liveCloneDeps } from "./repo-clone-job.js";
import { CodingRuntime } from "./runtime.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "pags-runtime-clone-")));
const upstream = join(base, "upstream.git");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
let home: string;
let runtime: CodingRuntime;

beforeAll(() => {
	const seed = join(base, "seed");
	mkdirSync(seed);
	git(seed, "init", "-q", "-b", "main");
	git(seed, "config", "user.name", "Runtime fixture");
	git(seed, "config", "user.email", "fixture@example.invalid");
	// Keep the byte-level fixture invariant even when Windows Git enables core.autocrlf.
	writeFileSync(join(seed, ".gitattributes"), "README.md text eol=lf\n");
	writeFileSync(join(seed, "README.md"), "offline fixture\n");
	git(seed, "add", ".");
	git(seed, "commit", "-q", "-m", "fixture");
	git(base, "clone", "-q", "--bare", seed, upstream);
});

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(base, "home-")));
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	runtime = new CodingRuntime(join(home, ".config", "proagentstore", "repos"));
	// Even a regression that wrongly admits a negative case must never contact GitHub.
	vi.spyOn(liveCloneDeps, "clone").mockRejectedValue(new Error("fixture transport disabled"));
	vi.spyOn(liveCloneDeps, "sshIdentity").mockReturnValue(null);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("cold-start cloning through CodingRuntime (#1446)", () => {
	it.each(["missing", "empty"])("checks, clones and verifies a %s home-relative checkout without registered roots", async (kind) => {
		const target = join(home, "dev", kind, "chinese");
		if (kind === "empty") mkdirSync(target, { recursive: true });
		const workDir = `~/dev/${kind}/chinese`;
		const clone = vi.spyOn(liveCloneDeps, "clone").mockImplementation(async (dir, url) => {
			await cloneIntoOwnFolder(dir, upstream);
			git(dir, "remote", "set-url", "origin", url);
		});
		expect(runtime.checkRepo({ workDir })).toMatchObject({ checked: true, exists: kind === "empty", entryCount: 0, homeRelative: workDir });
		expect(runtime.cloneStatus({ workDir })).toMatchObject({ state: "none" });
		expect(() => runtime.readFile({ workDir, path: "README.md" })).toThrow();
		expect(() => runtime.tree({ workDir })).toThrow();
		runtime.startClone({ workDir, slug: "acme/chinese", protocol: "https" });
		await vi.waitFor(() => expect(runtime.cloneStatus({ workDir })).toMatchObject({ state: "done", via: "https" }), { timeout: 30_000 });
		expect(clone).toHaveBeenCalledExactlyOnceWith(target, "https://github.com/acme/chinese.git");
		expect(runtime.checkRepo({ workDir })).toMatchObject({ checked: true, exists: true, insideWorkTree: true, homeRelative: workDir });
		expect(runtime.gitRemote({ workDir })).toEqual({ remote: "https://github.com/acme/chinese.git" });
		expect(readFileSync(join(target, "README.md"), "utf8")).toBe("offline fixture\n");
		expect(existsSync(join(home, ".config", "proagentstore", "runner-roots.json"))).toBe(false);
	});

	it.each(["missing", "empty"])("legacy clone also provisions a %s target through the runtime", (kind) => {
		const target = join(home, "legacy", kind);
		if (kind === "empty") mkdirSync(target, { recursive: true });
		expect(runtime.cloneRepo({ workDir: target, cloneUrl: upstream })).toMatchObject({ cloned: true, path: target });
		expect(runtime.checkRepo({ workDir: target })).toMatchObject({ insideWorkTree: true });
	});

	it.each(["missing", "empty"])("keeps a %s child of the managed clone root usable", (kind) => {
		const workDir = `~/.config/proagentstore/repos/${kind}`;
		const target = join(home, ".config", "proagentstore", "repos", kind);
		if (kind === "empty") mkdirSync(target, { recursive: true });
		expect(runtime.checkRepo({ workDir })).toMatchObject({ checked: true, exists: kind === "empty" });
		expect(runtime.cloneStatus({ workDir })).toMatchObject({ state: "none" });
		expect(runtime.cloneRepo({ workDir, cloneUrl: upstream })).toMatchObject({ cloned: true });
		expect(runtime.checkRepo({ workDir })).toMatchObject({ insideWorkTree: true });
	});

	it("joins an in-flight job even after it has written non-git partial files", async () => {
		const target = join(home, "dev", "pending");
		let finish!: () => void;
		const clone = vi.spyOn(liveCloneDeps, "clone").mockImplementation(async () => {
			mkdirSync(target, { recursive: true });
			writeFileSync(join(target, "partial"), "unfinished clone");
			await new Promise<void>((resolve) => { finish = resolve; });
		});
		const input = { workDir: target, slug: "acme/chinese", protocol: "https" as const };
		const first = runtime.startClone(input);
		try {
			expect(runtime.cloneStatus({ workDir: target })).toMatchObject({ state: "cloning" });
			expect(runtime.startClone(input)).toBe(first);
			expect(() => runtime.startClone({ ...input, slug: "other/repository" })).toThrow();
			expect(clone).toHaveBeenCalledTimes(1);
			expect(() => runtime.tree({ workDir: target })).toThrow();
		} finally {
			finish();
		}
		await vi.waitFor(() => expect(runtime.cloneStatus({ workDir: target })).toMatchObject({ state: "done" }));
	});

	it("reports a failed job with partial files without authorizing their contents", async () => {
		const target = join(home, "dev", "failed");
		vi.spyOn(liveCloneDeps, "clone").mockImplementation(async () => {
			mkdirSync(target, { recursive: true });
			writeFileSync(join(target, "partial"), "do not read");
			throw new Error("fixture transport failed");
		});
		runtime.startClone({ workDir: target, slug: "acme/chinese", protocol: "https" });
		await vi.waitFor(() => expect(runtime.cloneStatus({ workDir: target })).toMatchObject({ state: "failed", error: expect.stringContaining("fixture transport failed") }));
		expect(() => runtime.readFile({ workDir: target, path: "partial" })).toThrow();
		expect(() => runtime.startClone({ workDir: target, slug: "acme/chinese" })).toThrow();
		expect(readFileSync(join(target, "partial"), "utf8")).toBe("do not read");
	});
});

describe("provisioning does not widen filesystem read or clone access", () => {
	it.skipIf(process.platform !== "win32")("refuses an absent managed root even with different Windows path casing", () => {
		const managed = join(home, "managed-not-created");
		const rt = new CodingRuntime(managed);
		const workDir = join(home, "MANAGED-NOT-CREATED");
		vi.spyOn(liveCloneDeps, "clone").mockResolvedValue(undefined);
		expect(() => rt.cloneStatus({ workDir })).toThrow();
		expect(() => rt.startClone({ workDir, slug: "acme/chinese" })).toThrow();
		expect(() => rt.cloneRepo({ workDir, cloneUrl: upstream })).toThrow();
	});
	it.each(["~", "~/.ssh/new", "~/.config/proagentstore/session/new", "~/.aws/new"])("refuses protected target %s in every provisioning operation", (workDir) => {
		const clone = vi.spyOn(liveCloneDeps, "clone");
		expect(() => runtime.checkRepo({ workDir })).toThrow();
		expect(() => runtime.cloneStatus({ workDir })).toThrow();
		expect(() => runtime.startClone({ workDir, slug: "acme/chinese" })).toThrow();
		expect(() => runtime.cloneRepo({ workDir, cloneUrl: upstream })).toThrow();
		expect(clone).not.toHaveBeenCalled();
	});

	it.each(["~/.config", "~/Library"])("refuses credential ancestor %s even before its protected descendants exist", (workDir) => {
		expect(() => runtime.checkRepo({ workDir })).toThrow();
		expect(() => runtime.cloneStatus({ workDir })).toThrow();
		expect(() => runtime.startClone({ workDir, slug: "acme/chinese" })).toThrow();
		expect(() => runtime.cloneRepo({ workDir, cloneUrl: upstream })).toThrow();
	});

	it("refuses to clone into the managed root itself", () => {
		const workDir = "~/.config/proagentstore/repos";
		mkdirSync(join(home, ".config", "proagentstore", "repos"), { recursive: true });
		expect(() => runtime.startClone({ workDir, slug: "acme/chinese" })).toThrow();
		expect(() => runtime.cloneRepo({ workDir, cloneUrl: upstream })).toThrow();
		expect(() => runtime.cloneStatus({ workDir })).toThrow();
	});

	it.each(["home", "managed"])("does not skip a symlink that resolves exactly to the %s boundary", (kind) => {
		const destination = kind === "home" ? home : join(home, ".config", "proagentstore", "repos");
		mkdirSync(destination, { recursive: true });
		mkdirSync(join(home, "dev"));
		symlinkSync(destination, join(home, "dev", "back"), process.platform === "win32" ? "junction" : "dir");
		const workDir = "~/dev/back/new";
		expect(() => runtime.startClone({ workDir, slug: "acme/chinese" })).toThrow();
		expect(() => runtime.cloneRepo({ workDir, cloneUrl: upstream })).toThrow();
		expect(() => runtime.cloneStatus({ workDir })).toThrow();
		expect(existsSync(join(destination, "new"))).toBe(false);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("does not mistake an unreadable directory for an empty clone target", () => {
		const target = join(home, "dev", "unreadable");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "keep.txt"), "owner content");
		chmodSync(target, 0o000);
		try {
			expect(() => runtime.checkRepo({ workDir: target })).toThrow();
			expect(() => runtime.startClone({ workDir: target, slug: "acme/chinese" })).toThrow();
			expect(() => runtime.cloneRepo({ workDir: target, cloneUrl: upstream })).toThrow();
			expect(liveCloneDeps.clone).not.toHaveBeenCalled();
		} finally {
			chmodSync(target, 0o700);
		}
		expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("owner content");
	});

	it("refuses a link into credentials, including a missing child beyond the link", () => {
		mkdirSync(join(home, ".ssh"));
		mkdirSync(join(home, "dev"));
		symlinkSync(join(home, ".ssh"), join(home, "dev", "linked"), process.platform === "win32" ? "junction" : "dir");
		const workDir = "~/dev/linked/new";
		expect(() => runtime.checkRepo({ workDir })).toThrow();
		expect(() => runtime.startClone({ workDir, slug: "acme/chinese" })).toThrow();
		expect(() => runtime.cloneRepo({ workDir, cloneUrl: upstream })).toThrow();
		expect(existsSync(join(home, ".ssh", "new"))).toBe(false);
	});

	it.each(["existing", "dangling"])("does not replace or follow a %s symlink during cloning", (kind) => {
		const destination = join(home, "dev", "actual");
		mkdirSync(dirname(destination), { recursive: true });
		if (kind === "existing") mkdirSync(destination);
		const workDir = join(home, "dev", "alias");
		symlinkSync(destination, workDir, process.platform === "win32" ? "junction" : "dir");
		expect(() => runtime.startClone({ workDir, slug: "acme/chinese" })).toThrow();
		expect(() => runtime.cloneRepo({ workDir, cloneUrl: upstream })).toThrow();
		expect(existsSync(join(destination, ".git"))).toBe(false);
	});

	it("does not expose an unrelated plain directory while allowing empty preflight", () => {
		const target = join(home, "Documents");
		mkdirSync(target);
		writeFileSync(join(target, "private.txt"), "private content");
		expect(() => runtime.checkRepo({ workDir: target })).toThrow();
		expect(() => runtime.readFile({ workDir: target, path: "private.txt" })).toThrow();
		expect(() => runtime.tree({ workDir: target })).toThrow();
		expect(() => runtime.startClone({ workDir: target, slug: "acme/chinese" })).toThrow();
		expect(() => runtime.cloneRepo({ workDir: target, cloneUrl: upstream })).toThrow();
		expect(readFileSync(join(target, "private.txt"), "utf8")).toBe("private content");
	});

	it.each(["missing", "empty"])("refuses a %s clone nested in another checkout", (kind) => {
		const parent = join(home, "existing");
		mkdirSync(parent);
		git(parent, "init", "-q");
		const workDir = join(parent, kind);
		if (kind === "empty") mkdirSync(workDir);
		expect(() => runtime.startClone({ workDir, slug: "acme/chinese" })).toThrow();
		expect(() => runtime.cloneRepo({ workDir, cloneUrl: upstream })).toThrow();
		expect(existsSync(join(workDir, ".git"))).toBe(false);
	});

	it("refuses git administration destinations even when their parent is a checkout", () => {
		const parent = join(home, "existing");
		mkdirSync(parent);
		git(parent, "init", "-q");
		const workDir = join(parent, ".git", "new-repository");
		expect(() => runtime.startClone({ workDir, slug: "acme/chinese" })).toThrow();
		expect(() => runtime.cloneRepo({ workDir, cloneUrl: upstream })).toThrow();
		expect(existsSync(workDir)).toBe(false);
	});

	it("refuses fresh clone targets outside the home without an explicit registered root", () => {
		const target = join(base, "outside", "chinese");
		expect(dirname(target)).not.toBe(home);
		expect(() => runtime.startClone({ workDir: target, slug: "acme/chinese" })).toThrow();
		expect(() => runtime.cloneRepo({ workDir: target, cloneUrl: upstream })).toThrow();
		expect(existsSync(target)).toBe(false);
	});

	it("retains explicit owner-root provisioning outside the home", () => {
		const root = mkdtempSync(join(base, "owner-root-"));
		const config = join(home, ".config", "proagentstore");
		mkdirSync(config, { recursive: true });
		writeFileSync(join(config, "runner-roots.json"), JSON.stringify({ v: 1, roots: [root] }));
		const workDir = join(root, "chinese");
		expect(runtime.checkRepo({ workDir })).toMatchObject({ exists: false });
		expect(runtime.cloneRepo({ workDir, cloneUrl: upstream })).toMatchObject({ cloned: true });
		expect(runtime.checkRepo({ workDir })).toMatchObject({ insideWorkTree: true });
	});

	it("continues checking an existing external checkout without registering a root", () => {
		const target = mkdtempSync(join(base, "external-checkout-"));
		git(target, "init", "-q");
		expect(runtime.checkRepo({ workDir: target })).toMatchObject({ checked: true, insideWorkTree: true });
	});
});
