import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parkRef, parkRestore, parkSnapshot } from "./park-snapshot.js";

/**
 * #1077 — a parked run's work set aside and put back, on REAL temporary repositories. The property
 * under test is that no byte is lost on any path: the save is git's own, the commit stays reachable
 * on its own ref, and a restore that would conflict changes nothing.
 */

const RUN = "11111111-2222-4333-8444-555555555555";
function git(dir: string, ...argv: string[]): string {
	return execFileSync("git", argv, { cwd: dir, encoding: "utf-8" }).toString();
}
const read = (dir: string, p: string) => readFileSync(join(dir, p), "utf-8");

describe("parkSnapshot / parkRestore", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-park-"));
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "user.email", "t@example.com");
		git(dir, "config", "user.name", "T");
		writeFileSync(join(dir, ".gitignore"), "secret.env\n");
		writeFileSync(join(dir, "a.txt"), "one\n");
		git(dir, "add", "-A");
		git(dir, "commit", "-qm", "first");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** A parked run's tree: an edit, a staged edit, a new file — and an ignored file nobody may touch. */
	function dirty() {
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
		writeFileSync(join(dir, "new.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "secret.env"), "KEY=1\n");
	}

	it("saves tracked and untracked work, pins it on its own ref, leaves the tree clean and ignored files alone", () => {
		dirty();
		const r = parkSnapshot(dir, RUN);
		expect(r).toMatchObject({ files: 2, clean: true, ref: parkRef(RUN) });
		expect(git(dir, "rev-parse", parkRef(RUN)).trim()).toBe(r.snapshot);
		expect(git(dir, "status", "--porcelain")).toBe("");
		expect(existsSync(join(dir, "new.ts"))).toBe(false);
		expect(read(dir, "secret.env")).toBe("KEY=1\n");
		// The stash entry is left as a visible second copy, named for the run.
		expect(git(dir, "stash", "list")).toContain(`pags-park ${RUN}`);
	});

	it("puts the work back by its exact id, then drops only its own ref", () => {
		dirty();
		const { snapshot } = parkSnapshot(dir, RUN);
		expect(parkRestore(dir, RUN, snapshot as string)).toEqual({ restored: true });
		expect(read(dir, "a.txt")).toBe("one\ntwo\n");
		expect(read(dir, "new.ts")).toBe("export const x = 1;\n");
		expect(() => git(dir, "rev-parse", "--verify", "--quiet", parkRef(RUN))).toThrow();
		expect(git(dir, "stash", "list")).toContain(`pags-park ${RUN}`);
	});

	it("a clean tree has nothing to save; a replayed park reports the save it already made", () => {
		expect(parkSnapshot(dir, RUN)).toEqual({ snapshot: null, files: 0, clean: true, ref: null });
		dirty();
		const first = parkSnapshot(dir, RUN);
		expect(parkSnapshot(dir, RUN).snapshot).toBe(first.snapshot);
		expect(git(dir, "stash", "list").split("\n").filter(Boolean)).toHaveLength(1);
	});

	it("never identifies its entry by position: another stash pushed on top does not confuse it", () => {
		dirty();
		const { snapshot } = parkSnapshot(dir, RUN);
		writeFileSync(join(dir, "a.txt"), "someone else\n");
		git(dir, "stash", "push", "-m", "the owner's own");
		expect(parkRestore(dir, RUN, snapshot as string)).toEqual({ restored: true });
		expect(read(dir, "a.txt")).toBe("one\ntwo\n");
		expect(git(dir, "stash", "list")).toContain("the owner's own");
	});

	it("refuses — changing nothing — onto a dirty tree, onto a conflicting checkout, or over a file that now exists", () => {
		dirty();
		const { snapshot } = parkSnapshot(dir, RUN);
		const id = snapshot as string;

		writeFileSync(join(dir, "other.txt"), "run 2 left this\n");
		expect(parkRestore(dir, RUN, id)).toMatchObject({ restored: false, refused: expect.stringMatching(/not clean/) });
		rmSync(join(dir, "other.txt"));

		// Run 2 committed a conflicting edit to the same line while run 1 was parked.
		writeFileSync(join(dir, "a.txt"), "ONE\n");
		git(dir, "commit", "-qam", "run 2");
		expect(parkRestore(dir, RUN, id)).toMatchObject({ restored: false, refused: expect.stringMatching(/no longer applies cleanly/) });
		expect(git(dir, "status", "--porcelain")).toBe("");
		expect(git(dir, "rev-parse", parkRef(RUN)).trim()).toBe(id);

		git(dir, "reset", "-q", "--hard", "HEAD~1");
		writeFileSync(join(dir, "new.ts"), "run 2's own new.ts\n");
		git(dir, "add", "new.ts");
		git(dir, "commit", "-qm", "run 2 adds new.ts");
		expect(parkRestore(dir, RUN, id)).toMatchObject({ restored: false });
		expect(read(dir, "new.ts")).toBe("run 2's own new.ts\n");
	});

	it("refuses a run id or snapshot id that is not one", () => {
		expect(() => parkSnapshot(dir, "--all")).toThrow(/unusable run id/);
		expect(() => parkRestore(dir, RUN, "HEAD")).toThrow(/unusable snapshot id/);
	});
});
