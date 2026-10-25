/**
 * #1165 — a caller-supplied `workDir` cannot make the inspection routes read the owner's home or
 * credentials. `{ workDir: "~", path: ".ssh/id_ed25519" }` used to be a perfectly CONFINED read of a
 * private key, because the confinement was to whatever `workDir` the request named.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CodingRuntime } from "./runtime.js";
import { readRoots, rootsPath } from "./runner-roots.js";
import { CREDENTIAL_DIRS, confineWorkDir } from "./workdir-guard.js";

const HOME = mkdtempSync(join(tmpdir(), "pags-guard-home-"));
mkdirSync(join(HOME, ".ssh"), { recursive: true });
writeFileSync(join(HOME, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
mkdirSync(join(HOME, "dev", "app", ".git"), { recursive: true });
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const refusal = (fn: () => unknown): string => {
	try {
		fn();
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	throw new Error("expected a refusal");
};

describe("confineWorkDir (#1165)", () => {
	it("refuses the home folder and everything above it", () => {
		for (const raw of ["~", HOME, `${HOME}/`, "/", join(HOME, "..")]) expect(refusal(() => confineWorkDir(raw, { home: HOME })), raw).toMatch(/home folder/);
	});

	it("refuses a folder inside a credential directory", () => {
		for (const raw of ["~/.ssh", join(HOME, ".ssh"), "~/.config/proagentstore", "~/.aws/sso"]) expect(refusal(() => confineWorkDir(raw, { home: HOME })), raw).toMatch(/holds credentials/);
		expect(CREDENTIAL_DIRS).toContain(".ssh");
	});

	it("follows a symlink: an innocent-looking folder that points into ~/.ssh is ~/.ssh", () => {
		symlinkSync(join(HOME, ".ssh"), join(HOME, "dev", "innocent"));
		expect(refusal(() => confineWorkDir("~/dev/innocent", { home: HOME }))).toMatch(/\.ssh/);
	});

	it("keeps a real repository folder, and the runner's own managed clones under ~/.config/proagentstore", () => {
		expect(confineWorkDir("~/dev/app", { home: HOME })).toMatch(/dev[\\/]app$/);
		const managed = join(HOME, ".config", "proagentstore", "repos");
		mkdirSync(join(managed, "r1"), { recursive: true });
		expect(confineWorkDir(join(managed, "r1"), { home: HOME, allow: [managed] })).toMatch(/repos[\\/]r1$/);
	});

	it("a folder a clone has not created yet is judged by where it would be", () => {
		// Under a repository's tree it would be inside one; beside the repositories, not.
		expect(confineWorkDir("~/dev/app/not-created-yet", { home: HOME })).toMatch(/not-created-yet$/);
		expect(refusal(() => confineWorkDir("~/dev/not-cloned-yet", { home: HOME }))).toMatch(/not a git repository/);
		expect(refusal(() => confineWorkDir("~/.ssh/new-repo", { home: HOME }))).toMatch(/holds credentials/);
	});
});

/** #1193 — an ALLOW-list: a folder must be a git working tree, or one the owner registered on this machine. */
describe("confineWorkDir is an allow-list (#1193)", () => {
	mkdirSync(join(HOME, "Documents", "taxes"), { recursive: true });
	mkdirSync(join(HOME, "Downloads"), { recursive: true });
	mkdirSync(join(HOME, ".myapp-tokens"), { recursive: true }); // an app's own token store the deny-list never heard of
	mkdirSync(join(HOME, ".password-store", ".git"), { recursive: true }); // a credential directory that is ALSO a repository
	mkdirSync(join(HOME, "dev", "app", "src", "deep"), { recursive: true });
	mkdirSync(join(HOME, "work", "notes"), { recursive: true });
	mkdirSync(join(HOME, "wt"), { recursive: true });
	writeFileSync(join(HOME, "wt", ".git"), "gitdir: ../dev/app/.git/worktrees/wt\n"); // a worktree/submodule has a .git FILE
	const none = { home: HOME, roots: [] as string[] };

	it("refuses a registered or forged folder that is not a repository — the issue's ~/Documents and ~/Downloads", () => {
		for (const raw of ["~/Documents", "~/Documents/taxes", "~/Downloads", "~/.myapp-tokens", join(HOME, "work", "notes")]) {
			const why = refusal(() => confineWorkDir(raw, none));
			expect(why, raw).toMatch(/not a git repository or a folder you have allowed on this machine/);
			expect(why, raw).toContain("pags runner roots add");
		}
	});
	it("allows a git working tree, and any folder inside it", () => {
		for (const raw of ["~/dev/app", "~/dev/app/src", "~/dev/app/src/deep"]) expect(confineWorkDir(raw, none), raw).toMatch(/app/);
		expect(confineWorkDir("~/wt", none)).toMatch(/wt$/);
	});
	it("a git repository at the home folder itself (dotfiles) does not make everything in the home folder a repository", () => {
		const home2 = mkdtempSync(join(tmpdir(), "pags-guard-home2-"));
		try {
			mkdirSync(join(home2, ".git"), { recursive: true });
			mkdirSync(join(home2, "Documents"), { recursive: true });
			mkdirSync(join(home2, "dev", "app", ".git"), { recursive: true });
			expect(refusal(() => confineWorkDir("~/Documents", { home: home2, roots: [] }))).toMatch(/not a git repository/);
			expect(confineWorkDir("~/dev/app", { home: home2, roots: [] })).toMatch(/app$/);
		} finally {
			rmSync(home2, { recursive: true, force: true });
		}
	});
	it("a credential directory that is itself a repository is still a credential directory", () => {
		expect(refusal(() => confineWorkDir("~/.password-store", none))).toMatch(/holds credentials/);
	});
	it("allows a folder the owner registered, and what is inside it — and nothing beside it", () => {
		const roots = [join(HOME, "work", "notes")];
		expect(confineWorkDir(join(HOME, "work", "notes"), { home: HOME, roots })).toMatch(/notes$/);
		mkdirSync(join(HOME, "work", "notes", "2026"), { recursive: true });
		expect(confineWorkDir(join(HOME, "work", "notes", "2026"), { home: HOME, roots })).toMatch(/2026$/);
		expect(refusal(() => confineWorkDir(join(HOME, "work"), { home: HOME, roots }))).toMatch(/not a git repository/);
		expect(refusal(() => confineWorkDir("~/Documents", { home: HOME, roots }))).toMatch(/not a git repository/);
	});
	it("a root can be written as ~/…, and one outside the home folder works", () => {
		expect(confineWorkDir("~/work/notes", { home: HOME, roots: ["~/work/notes"] })).toMatch(/notes$/);
		const elsewhere = mkdtempSync(join(tmpdir(), "pags-guard-elsewhere-"));
		try {
			expect(confineWorkDir(elsewhere, { home: HOME, roots: [elsewhere] })).toBeTruthy();
			expect(refusal(() => confineWorkDir(elsewhere, none))).toMatch(/not a git repository/);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});
	it("a root cannot widen past the rules: not the home folder or above it, not a credential directory, not a link into one", () => {
		for (const roots of [[HOME], ["~"], ["/"], [join(HOME, "..")]]) {
			expect(refusal(() => confineWorkDir("~/Documents", { home: HOME, roots })), JSON.stringify(roots)).toMatch(/not a git repository/);
		}
		expect(refusal(() => confineWorkDir("~/.ssh", { home: HOME, roots: ["~/.ssh"] }))).toMatch(/holds credentials/);
		expect(refusal(() => confineWorkDir("~/.config/proagentstore/x", { home: HOME, roots: ["~/.config/proagentstore"] }))).toMatch(/holds credentials/);
		symlinkSync(join(HOME, ".ssh"), join(HOME, "work", "link-to-ssh"));
		expect(refusal(() => confineWorkDir("~/work/link-to-ssh", { home: HOME, roots: [join(HOME, "work")] }))).toMatch(/holds credentials/);
	});
	it("the runner's managed clones stay usable without a root or a .git of their own", () => {
		const managed = join(HOME, ".config", "proagentstore", "repos");
		mkdirSync(join(managed, "r2"), { recursive: true });
		expect(confineWorkDir(join(managed, "r2"), { home: HOME, allow: [managed], roots: [] })).toMatch(/r2$/);
	});
});

describe("the roots file (#1193)", () => {
	const home = mkdtempSync(join(tmpdir(), "pags-roots-home-"));
	afterAll(() => rmSync(home, { recursive: true, force: true }));
	const write = (content: string) => {
		mkdirSync(join(home, ".config", "proagentstore"), { recursive: true });
		writeFileSync(rootsPath(home), content);
	};
	it("no file, a malformed one, a wrong version or the wrong shape all mean no roots — never more", () => {
		expect(readRoots(home)).toEqual([]);
		for (const bad of ["{not json", "[]", '{"v":2,"roots":["/x"]}', '{"v":1,"roots":"/x"}', '{"v":1}']) {
			write(bad);
			expect(readRoots(home), bad).toEqual([]);
		}
	});
	it("reads the roots, dropping anything that is not a plain path", () => {
		write(JSON.stringify({ v: 1, roots: ["/a", "", 5, null, "  ", "/b"] }));
		expect(readRoots(home)).toEqual(["/a", "/b"]);
	});
	it("is what confineWorkDir reads by default, from the machine's home", () => {
		const project = join(home, "projects", "notes");
		mkdirSync(project, { recursive: true });
		write(JSON.stringify({ v: 1, roots: [project] }));
		expect(confineWorkDir(project, { home })).toMatch(/notes$/);
		write(JSON.stringify({ v: 1, roots: [] }));
		expect(refusal(() => confineWorkDir(project, { home }))).toMatch(/not a git repository/);
	});
});

describe("the runtime's inspection routes refuse a workDir that would escape (#1165)", () => {
	const rt = new CodingRuntime(join(HOME, ".config", "proagentstore", "repos"));

	it("read-file into ~/.ssh — the issue's exact request — is refused before anything is read", () => {
		expect(refusal(() => rt.readFile({ workDir: "~", path: ".ssh/id_ed25519" }))).toMatch(/home folder/);
		expect(refusal(() => rt.readFile({ workDir: homedir(), path: ".ssh/id_ed25519" }))).toMatch(/home folder/);
		expect(refusal(() => rt.readFile({ workDir: "~/.ssh", path: "id_ed25519" }))).toMatch(/holds credentials/);
	});

	it("and a plain folder such as ~/Documents is refused by every inspection route, not only the home folder (#1193)", () => {
		mkdirSync(join(HOME, "Documents"), { recursive: true });
		const noRoots = new CodingRuntime(join(HOME, ".config", "proagentstore", "repos"));
		const dir = join(HOME, "Documents");
		const prev = process.env.HOME;
		// The runtime reads the real machine's roots file; Documents is under a throwaway home, outside any repo.
		try {
			process.env.HOME = HOME;
			expect(refusal(() => noRoots.readFile({ workDir: dir, path: "x" }))).toMatch(/not a git repository|home folder/);
			expect(refusal(() => noRoots.tree({ workDir: dir }))).toMatch(/not a git repository|home folder/);
			expect(refusal(() => noRoots.search({ workDir: dir, pattern: "x" }))).toMatch(/not a git repository|home folder/);
			expect(refusal(() => noRoots.git({ workDir: dir, cmd: "status" }))).toMatch(/not a git repository|home folder/);
		} finally {
			if (prev === undefined) delete process.env.HOME;
			else process.env.HOME = prev;
		}
	});

	it("so are tree, search and git on the home folder", () => {
		expect(refusal(() => rt.tree({ workDir: "~" }))).toMatch(/home folder/);
		expect(refusal(() => rt.search({ workDir: "~", pattern: "BEGIN OPENSSH" }))).toMatch(/home folder/);
		expect(refusal(() => rt.git({ workDir: "~", cmd: "status" }))).toMatch(/home folder/);
	});
});
