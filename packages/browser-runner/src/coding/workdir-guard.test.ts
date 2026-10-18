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
		expect(confineWorkDir("~/dev/not-cloned-yet", { home: HOME })).toMatch(/not-cloned-yet$/);
		expect(refusal(() => confineWorkDir("~/.ssh/new-repo", { home: HOME }))).toMatch(/holds credentials/);
	});
});

describe("the runtime's inspection routes refuse a workDir that would escape (#1165)", () => {
	const rt = new CodingRuntime(join(HOME, ".config", "proagentstore", "repos"));

	it("read-file into ~/.ssh — the issue's exact request — is refused before anything is read", () => {
		expect(refusal(() => rt.readFile({ workDir: "~", path: ".ssh/id_ed25519" }))).toMatch(/home folder/);
		expect(refusal(() => rt.readFile({ workDir: homedir(), path: ".ssh/id_ed25519" }))).toMatch(/home folder/);
		expect(refusal(() => rt.readFile({ workDir: "~/.ssh", path: "id_ed25519" }))).toMatch(/holds credentials/);
	});

	it("so are tree, search and git on the home folder", () => {
		expect(refusal(() => rt.tree({ workDir: "~" }))).toMatch(/home folder/);
		expect(refusal(() => rt.search({ workDir: "~", pattern: "BEGIN OPENSSH" }))).toMatch(/home folder/);
		expect(refusal(() => rt.git({ workDir: "~", cmd: "status" }))).toMatch(/home folder/);
	});
});
