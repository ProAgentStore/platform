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
		expect(parkSnapshot(dir, RUN)).toEqual({ snapshot: null, files: 0, clean: true, ref: null, pushed: null });
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
		expect(parkRestore(dir, RUN, id)).toMatchObject({ restored: false, refused: expect.stringMatching(/no longer applies cleanly/), conflicts: ["a.txt"] });
		expect(git(dir, "status", "--porcelain")).toBe("");
		expect(git(dir, "rev-parse", parkRef(RUN)).trim()).toBe(id);

		git(dir, "reset", "-q", "--hard", "HEAD~1");
		writeFileSync(join(dir, "new.ts"), "run 2's own new.ts\n");
		git(dir, "add", "new.ts");
		git(dir, "commit", "-qm", "run 2 adds new.ts");
		expect(parkRestore(dir, RUN, id)).toMatchObject({ restored: false, conflicts: ["new.ts"] });
		expect(read(dir, "new.ts")).toBe("run 2's own new.ts\n");
	});

	it("refuses a run id or snapshot id that is not one", () => {
		expect(() => parkSnapshot(dir, "--all")).toThrow(/unusable run id/);
		expect(() => parkRestore(dir, RUN, "HEAD")).toThrow(/unusable snapshot id/);
	});
});

/**
 * #1242 — parked work is pushed to origin, and the object (not a ref) decides whether it is here.
 * Two clones of one bare origin stand in for two machines: X parks, Y has never seen the commit.
 */
describe("parked work across machines (#1242)", () => {
	let root: string;
	let origin: string;
	let x: string;
	let y: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pags-park-1242-"));
		origin = join(root, "origin.git");
		git(root, "init", "-q", "--bare", "-b", "main", origin);
		x = join(root, "x");
		git(root, "clone", "-q", origin, x);
		for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"]]) git(x, "config", k, v);
		writeFileSync(join(x, "a.txt"), "one\n");
		git(x, "add", "-A");
		git(x, "commit", "-qm", "first");
		git(x, "push", "-q", "origin", "main");
		y = join(root, "y");
		git(root, "clone", "-q", origin, y);
		for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"]]) git(y, "config", k, v);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function parkOnX() {
		writeFileSync(join(x, "a.txt"), "one\ntwo\n");
		writeFileSync(join(x, "spec.ts"), "test('analytics', () => {});\n");
		return parkSnapshot(x, RUN);
	}

	it("pushes the parked ref to origin, so the work outlives the machine", () => {
		const saved = parkOnX();
		expect(saved).toMatchObject({ clean: true, pushed: true, ref: parkRef(RUN) });
		expect(git(origin, "rev-parse", parkRef(RUN)).trim()).toBe(saved.snapshot);
	});

	it("park on X, resume on Y: refused as MISSING — never 'set aside here' — and nothing changes on Y", () => {
		const saved = parkOnX();
		const r = parkRestore(y, RUN, saved.snapshot as string);
		expect(r).toMatchObject({ restored: false, missing: true });
		expect(r.refused).toMatch(/is not in this machine's checkout/);
		expect(existsSync(join(y, "spec.ts"))).toBe(false);
	});

	it("an owner-asked move fetches the ref from origin first and puts the work back on Y", () => {
		const saved = parkOnX();
		expect(parkRestore(y, RUN, saved.snapshot as string, { fetch: true })).toEqual({ restored: true, fetched: true });
		expect(read(y, "a.txt")).toBe("one\ntwo\n");
		expect(read(y, "spec.ts")).toContain("analytics");
	});

	it("a move whose origin never got the ref says so, and changes nothing", () => {
		writeFileSync(join(x, "a.txt"), "one\ntwo\n");
		git(x, "remote", "set-url", "origin", join(root, "nowhere.git")); // the push cannot land
		const saved = parkSnapshot(x, RUN);
		expect(saved).toMatchObject({ clean: true, pushed: false });
		expect(saved.pushError).not.toMatch(/\//); // no path or URL — a credential could ride on one
		const r = parkRestore(y, RUN, saved.snapshot as string, { fetch: true });
		expect(r).toMatchObject({ restored: false, missing: true });
		expect(r.refused).toMatch(/fetching refs\/pags\/parked\/.* from origin failed/);
	});

	it("a runner restart on the parking machine (same checkout, ref still local) restores without asking origin", () => {
		const saved = parkOnX();
		git(x, "remote", "set-url", "origin", join(root, "nowhere.git")); // origin unreachable: must not matter
		expect(parkRestore(x, RUN, saved.snapshot as string)).toEqual({ restored: true });
		expect(read(x, "spec.ts")).toContain("analytics");
	});

	it("work whose ref was dropped by hand but whose commit is still here is put back — the object decides", () => {
		const saved = parkOnX();
		git(x, "update-ref", "-d", parkRef(RUN));
		expect(parkRestore(x, RUN, saved.snapshot as string)).toEqual({ restored: true });
	});
});
