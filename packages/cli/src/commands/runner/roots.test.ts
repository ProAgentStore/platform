/** #1193 — `pags runner roots`: the owner, at the machine, registers the folders the runner may read; the runner reads the same file. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRoots } from "../../../../browser-runner/src/coding/runner-roots.js";
import { confineWorkDir } from "../../../../browser-runner/src/coding/workdir-guard.js";
import { addRoot, readRootsFile, removeRoot, resolveRoot, rootsFile } from "./roots.js";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pags-roots-"));
	mkdirSync(join(home, "projects", "notes"), { recursive: true });
	mkdirSync(join(home, "Documents"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("add / list / remove", () => {
	it("registers a folder by the real path it resolves to, once", () => {
		const r = addRoot("~/projects/notes", home);
		expect(r).toMatchObject({ ok: true, added: true });
		expect(readRootsFile(home)).toHaveLength(1);
		expect(readRootsFile(home)[0]).toMatch(/projects[\\/]notes$/);
		expect(addRoot(join(home, "projects", "notes"), home)).toMatchObject({ ok: true, added: false });
		expect(readRootsFile(home)).toHaveLength(1);
	});
	it("stores a link as the folder it points at, so the registered path is the real one", () => {
		symlinkSync(join(home, "projects", "notes"), join(home, "link"));
		const r = addRoot(join(home, "link"), home);
		expect(r.ok && r.path).toMatch(/projects[\\/]notes$/);
	});
	it("refuses what can never be a root: missing, a file, empty, the home folder or above", () => {
		writeFileSync(join(home, "a-file"), "x");
		expect(resolveRoot(join(home, "nope"), home)).toMatchObject({ ok: false, reason: expect.stringContaining("does not exist") });
		expect(resolveRoot(join(home, "a-file"), home)).toMatchObject({ ok: false, reason: expect.stringContaining("not a folder") });
		expect(resolveRoot("  ", home)).toMatchObject({ ok: false });
		for (const raw of ["~", home, join(home, ".."), "/"]) expect(resolveRoot(raw, home), raw).toMatchObject({ ok: false, reason: expect.stringContaining("home folder") });
		expect(readRootsFile(home)).toEqual([]);
	});
	it("removes by what was typed or by the real path, and says when it was not there", () => {
		addRoot("~/projects/notes", home);
		expect(removeRoot("~/projects/notes", home)).toMatchObject({ removed: true, roots: [] });
		expect(removeRoot("~/projects/notes", home).removed).toBe(false);
		addRoot("~/Documents", home);
		rmSync(join(home, "Documents"), { recursive: true });
		expect(removeRoot(join(home, "Documents"), home).removed).toBe(true); // a folder that is gone can still be removed
	});
	it("writes the file private to the owner", () => {
		addRoot("~/projects/notes", home);
		if (process.platform !== "win32") expect((statSync(rootsFile(home)).mode & 0o777).toString(8)).toBe("600");
		expect(JSON.parse(readFileSync(rootsFile(home), "utf8"))).toMatchObject({ v: 1 });
	});
});

describe("the CLI writes what the runner reads", () => {
	it("a folder registered here is allowed by the runner's guard, and removing it takes it away", () => {
		const project = join(home, "projects", "notes");
		const r = addRoot(project, home);
		expect(r.ok).toBe(true);
		expect(readRoots(home)).toEqual(readRootsFile(home));
		expect(confineWorkDir(project, { home })).toMatch(/notes$/);
		removeRoot(project, home);
		expect(() => confineWorkDir(project, { home })).toThrow(/not a git repository/);
	});
	it("a plain folder that was never registered is refused by the guard", () => {
		expect(() => confineWorkDir(join(home, "Documents"), { home })).toThrow(/pags runner roots add/);
	});
});
