import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admitSharedCheckout, parkRef, parkRestore, parkSnapshot } from "./park-snapshot.js";

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
		const r = parkSnapshot(dir, RUN, { exclusive: true });
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
		const { snapshot } = parkSnapshot(dir, RUN, { exclusive: true });
		expect(parkRestore(dir, RUN, snapshot as string)).toEqual({ restored: true });
		expect(read(dir, "a.txt")).toBe("one\ntwo\n");
		expect(read(dir, "new.ts")).toBe("export const x = 1;\n");
		expect(() => git(dir, "rev-parse", "--verify", "--quiet", parkRef(RUN))).toThrow();
		expect(git(dir, "stash", "list")).toContain(`pags-park ${RUN}`);
	});

	it("a clean tree has nothing to save; a replayed park reports the save it already made", () => {
		expect(parkSnapshot(dir, RUN, { exclusive: true })).toEqual({ snapshot: null, files: 0, clean: true, ref: null, pushed: null });
		dirty();
		const first = parkSnapshot(dir, RUN, { exclusive: true });
		expect(parkSnapshot(dir, RUN, { exclusive: true }).snapshot).toBe(first.snapshot);
		expect(git(dir, "stash", "list").split("\n").filter(Boolean)).toHaveLength(1);
	});

	it("never identifies its entry by position: another stash pushed on top does not confuse it", () => {
		dirty();
		const { snapshot } = parkSnapshot(dir, RUN, { exclusive: true });
		writeFileSync(join(dir, "a.txt"), "someone else\n");
		git(dir, "stash", "push", "-m", "the owner's own");
		expect(parkRestore(dir, RUN, snapshot as string)).toEqual({ restored: true });
		expect(read(dir, "a.txt")).toBe("one\ntwo\n");
		expect(git(dir, "stash", "list")).toContain("the owner's own");
	});

	it("refuses — changing nothing — onto a dirty tree, onto a conflicting checkout, or over a file that now exists", () => {
		dirty();
		const { snapshot } = parkSnapshot(dir, RUN, { exclusive: true });
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
		return parkSnapshot(x, RUN, { exclusive: true });
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
		const saved = parkSnapshot(x, RUN, { exclusive: true });
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

/**
 * #1547 / #1670 — a shared checkout can hold SOMEBODY ELSE'S work. With a verified `owned` list parking captures only the
 * run's own paths; everything else stays exactly where it was and is reported. Real temporary repositories only.
 */
describe("parkSnapshot with verified ownership (#1547)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-own-"));
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "user.email", "t@example.com");
		git(dir, "config", "user.name", "T");
		writeFileSync(join(dir, "mine.txt"), "m\n");
		writeFileSync(join(dir, "theirs.txt"), "t\n");
		git(dir, "add", "-A");
		git(dir, "commit", "-qm", "first");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("captures only the run's own tracked and untracked paths and leaves another editor's work in place", () => {
		writeFileSync(join(dir, "mine.txt"), "m\nrun edit\n");
		writeFileSync(join(dir, "mine-new.ts"), "export const r = 1;\n");
		writeFileSync(join(dir, "theirs.txt"), "t\nsomeone else\n");
		writeFileSync(join(dir, "theirs-new.ts"), "export const o = 1;\n");
		const r = parkSnapshot(dir, RUN, { owned: ["mine.txt", "mine-new.ts"] });
		expect(r).toMatchObject({ files: 2, clean: false });
		expect([...(r.unowned ?? [])].sort()).toEqual(["theirs-new.ts", "theirs.txt"]);
		// Unrelated edits are untouched, byte for byte; the run's own are on the ref.
		expect(read(dir, "theirs.txt")).toBe("t\nsomeone else\n");
		expect(read(dir, "theirs-new.ts")).toBe("export const o = 1;\n");
		expect(existsSync(join(dir, "mine-new.ts"))).toBe(false);
		expect(read(dir, "mine.txt")).toBe("m\n");
		expect(git(dir, "rev-parse", parkRef(RUN)).trim()).toBe(r.snapshot);
		// The saved commit holds the run's work and NOT the other editor's.
		expect(git(dir, "show", "--name-only", "--format=", r.snapshot as string).split("\n").filter(Boolean)).toContain("mine.txt");
		expect(git(dir, "show", "--name-only", "--format=", r.snapshot as string)).not.toContain("theirs.txt");
	});

	it("with nothing of the run's own dirty it changes nothing at all and reports the conflict", () => {
		writeFileSync(join(dir, "theirs.txt"), "t\nsomeone else\n");
		const r = parkSnapshot(dir, RUN, { owned: ["mine.txt"] });
		expect(r).toMatchObject({ snapshot: null, files: 0, clean: false, unowned: ["theirs.txt"] });
		expect(read(dir, "theirs.txt")).toBe("t\nsomeone else\n");
		expect(git(dir, "stash", "list")).toBe("");
		expect(() => git(dir, "rev-parse", "--verify", "--quiet", parkRef(RUN))).toThrow();
	});

	it("a write that lands between the ownership check and the park, on a path that is not the run's, stays untouched", () => {
		writeFileSync(join(dir, "mine.txt"), "m\nrun\n");
		const owned = ["mine.txt"];
		writeFileSync(join(dir, "late-concurrent.ts"), "written by another process\n"); // arrives after `owned` was decided
		const r = parkSnapshot(dir, RUN, { owned });
		expect(r.unowned).toEqual(["late-concurrent.ts"]);
		expect(read(dir, "late-concurrent.ts")).toBe("written by another process\n");
	});

	it("restoring onto a checkout with someone else's edits refuses, names the blocking paths and cleans nothing", () => {
		writeFileSync(join(dir, "mine.txt"), "m\nrun\n");
		writeFileSync(join(dir, "theirs.txt"), "t\nother\n");
		const r = parkSnapshot(dir, RUN, { owned: ["mine.txt"] });
		const back = parkRestore(dir, RUN, r.snapshot as string);
		expect(back).toMatchObject({ restored: false, blocking: ["theirs.txt"] });
		expect(read(dir, "theirs.txt")).toBe("t\nother\n");
		expect(read(dir, "mine.txt")).toBe("m\n");
	});

	it("an explicit exclusive assertion (the isolated worktree mode) keeps the whole-tree behaviour", () => {
		writeFileSync(join(dir, "mine.txt"), "m\nrun\n");
		writeFileSync(join(dir, "new.ts"), "x\n");
		expect(parkSnapshot(dir, RUN, { exclusive: true })).toMatchObject({ files: 2, clean: true });
	});

	it("admitSharedCheckout names every blocking path and modifies nothing", () => {
		expect(admitSharedCheckout(dir)).toEqual({ ok: true, blocking: [] });
		writeFileSync(join(dir, "theirs.txt"), "t\nedit\n");
		writeFileSync(join(dir, "scratch dir with space.txt"), "u\n");
		const a = admitSharedCheckout(dir);
		expect(a.ok).toBe(false);
		expect([...a.blocking].sort()).toEqual(["scratch dir with space.txt", "theirs.txt"]);
		expect(read(dir, "theirs.txt")).toBe("t\nedit\n");
		expect(git(dir, "stash", "list")).toBe("");
	});
});

/**
 * #1547 — the incident, on a real temporary repository. Another active editor's tracked, staged and untracked application
 * fixes sit in a SHARED checkout; a run parks. Before: `stash push --include-untracked` over the whole tree captured them and
 * the checkout was cleaned (reflog "reset: moving to HEAD"). Now ownership is unknown, so nothing is captured or cleaned.
 */
describe("parking a shared checkout whose ownership is unknown (#1547)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-shared-"));
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "user.email", "t@example.com");
		git(dir, "config", "user.name", "T");
		writeFileSync(join(dir, ".gitignore"), "secret.env\n");
		writeFileSync(join(dir, "application.ts"), "export const apply = 0;\n");
		writeFileSync(join(dir, "staged.ts"), "export const staged = 0;\n");
		git(dir, "add", "-A");
		git(dir, "commit", "-qm", "base");
		// Somebody else's work: a tracked edit, a staged edit edited again, an untracked file, and an ignored secret.
		writeFileSync(join(dir, "application.ts"), "export const apply = 1; // another editor's fix\n");
		writeFileSync(join(dir, "staged.ts"), "export const staged = 1;\n");
		git(dir, "add", "staged.ts");
		writeFileSync(join(dir, "staged.ts"), "export const staged = 2; // unstaged on top\n");
		writeFileSync(join(dir, "new-fix.ts"), "export const fix = true;\n");
		writeFileSync(join(dir, "secret.env"), "KEY=1\n");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** Everything that must not move: bytes, the index, the status, every ref and the stash. */
	const state = () => ({
		files: Object.fromEntries(["application.ts", "staged.ts", "new-fix.ts", "secret.env"].map((f) => [f, read(dir, f)])),
		index: git(dir, "ls-files", "-s"),
		status: git(dir, "status", "--porcelain=v1", "--untracked-files=all"),
		refs: git(dir, "for-each-ref"),
		stash: git(dir, "stash", "list"),
		head: git(dir, "rev-parse", "HEAD"),
		reflog: git(dir, "reflog", "-n", "20"),
	});

	it("FAIL-BEFORE: asserting the whole tree captures the other editor's work and cleans it away — the reported loss", () => {
		const r = parkSnapshot(dir, RUN, { exclusive: true });
		expect(r).toMatchObject({ clean: true, files: 3 });
		expect(read(dir, "application.ts")).toBe("export const apply = 0;\n");
		expect(existsSync(join(dir, "new-fix.ts"))).toBe(false);
	});

	it("PASS-AFTER: with ownership unknown, every unrelated edit stays in place, byte for byte, and nothing in git moves", () => {
		const before = state();
		const r = parkSnapshot(dir, RUN);
		expect(state()).toEqual(before);
		expect(r).toMatchObject({ snapshot: null, files: 0, clean: false, ref: null, pushed: null, conflict: "ownership_unknown" });
		expect([...(r.unowned ?? [])].sort()).toEqual(["application.ts", "new-fix.ts", "staged.ts"]);
		// No stash entry, no ref under refs/pags, no reset in the reflog.
		expect(git(dir, "stash", "list")).toBe("");
		expect(git(dir, "for-each-ref", "refs/pags")).toBe("");
		expect(git(dir, "reflog", "-n", "20")).not.toMatch(/reset/);
	});

	it("never pushes a ref to origin for work it did not take: nothing was captured, so nothing is sent", () => {
		const origin = mkdtempSync(join(tmpdir(), "pags-origin-"));
		try {
			git(origin, "init", "-q", "--bare");
			git(dir, "remote", "add", "origin", origin);
			git(dir, "push", "-q", "origin", "main");
			const r = parkSnapshot(dir, RUN);
			expect(r.pushed).toBeNull();
			expect(git(origin, "for-each-ref", "refs/pags")).toBe("");
		} finally {
			rmSync(origin, { recursive: true, force: true });
		}
	});

	it("is idempotent: a second park of the same run changes nothing either, and still reports the conflict", () => {
		const first = parkSnapshot(dir, RUN);
		const before = state();
		expect(parkSnapshot(dir, RUN)).toEqual(first);
		expect(state()).toEqual(before);
	});

	it("a write that lands while the run is parking is just as untouched", () => {
		const r1 = parkSnapshot(dir, RUN);
		writeFileSync(join(dir, "late.ts"), "written by another process, mid-park\n");
		writeFileSync(join(dir, "application.ts"), "export const apply = 3; // edited again\n");
		const r2 = parkSnapshot(dir, RUN);
		expect(read(dir, "late.ts")).toBe("written by another process, mid-park\n");
		expect(read(dir, "application.ts")).toBe("export const apply = 3; // edited again\n");
		expect(r1.unowned).not.toContain("late.ts");
		expect(r2.unowned).toContain("late.ts");
		expect(r2.conflict).toBe("ownership_unknown");
	});

	it("a clean checkout is still released: only dirt of unknown ownership blocks", () => {
		git(dir, "add", "-A");
		git(dir, "commit", "-qm", "the editor committed their work");
		expect(parkSnapshot(dir, RUN)).toEqual({ snapshot: null, files: 0, clean: true, ref: null, pushed: null });
	});

	it("a run's OWN verified paths are still set aside, while the other editor's stay: the owned route is unchanged", () => {
		const r = parkSnapshot(dir, RUN, { owned: ["new-fix.ts"] });
		expect(r).toMatchObject({ files: 1, clean: false });
		expect(existsSync(join(dir, "new-fix.ts"))).toBe(false);
		expect(read(dir, "application.ts")).toBe("export const apply = 1; // another editor's fix\n");
		expect([...(r.unowned ?? [])].sort()).toEqual(["application.ts", "staged.ts"]);
	});

	it("the unknown-ownership park never restores or applies anything either: a later restore onto this tree still refuses and names the paths", () => {
		const r = parkSnapshot(dir, RUN);
		expect(r.snapshot).toBeNull();
		const before = state();
		expect(parkRestore(dir, RUN, "0".repeat(40))).toMatchObject({ restored: false });
		expect(state()).toEqual(before);
	});

	it("the runner's HTTP verb reads only `owned` from a request: a caller cannot assert exclusive use", () => {
		const src = readFileSync(new URL("./runtime.ts", import.meta.url), "utf-8");
		const verb = src.slice(src.indexOf("parkSnapshot(input:"));
		expect(verb.slice(0, 600)).toContain("owned");
		expect(verb.slice(0, 600)).not.toMatch(/exclusive/);
	});
});
