/** #1103: the pre-commit ratchet measures the index, so a fix left unstaged cannot pass for the commit. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stagedContents } from "./staged-contents.mjs";

let dir;
const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "staged-"));
	git("init", "-q");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("stagedContents", () => {
	it("reads what is staged, not what is on disk, for every file in one batch", () => {
		writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
		writeFileSync(join(dir, "b.ts"), "x\n");
		git("add", "a.ts", "b.ts");
		writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\nfour\n"); // grown, but not staged
		const got = stagedContents(["a.ts", "b.ts"], { cwd: dir });
		expect(got.get("a.ts")).toBe("one\ntwo\n");
		expect(got.get("b.ts")).toBe("x\n");
	});

	it("keeps multi-byte content intact and skips a path with nothing staged", () => {
		writeFileSync(join(dir, "c.ts"), "héllo — ✓\n");
		git("add", "c.ts");
		const got = stagedContents(["c.ts", "never-added.ts"], { cwd: dir });
		expect(got.get("c.ts")).toBe("héllo — ✓\n");
		expect(got.has("never-added.ts")).toBe(false);
	});
});
