/**
 * `checkWorkdir` — the question nobody was asking about a local repo (#405).
 *
 * Run against the REAL filesystem, deliberately: the whole value of this function is that it
 * reports what is actually on the machine, and a mocked `fs` would only pin that the mock agrees
 * with itself. The one case that needs a real git process is the one the bug turns on — a
 * subdirectory of a checkout has no `.git` of its own and must still be usable.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkWorkdir } from "./repo.js";

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
