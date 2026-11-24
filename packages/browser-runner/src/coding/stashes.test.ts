import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanCheckout } from "./checkout-clean.js";
import { parkSnapshot } from "./park-snapshot.js";
import { dropStash, inspectStash, listStashes } from "./stashes.js";

const git = (dir: string, ...argv: string[]) => execFileSync("git", argv, { cwd: dir, encoding: "utf-8" }).trim();
const ident = (dir: string) => {
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "T");
};

let root: string;
let origin: string;
let work: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pags-stashes-"));
	origin = join(root, "origin.git");
	work = join(root, "work");
	execFileSync("git", ["init", "--bare", "-b", "main", origin]);
	const seed = join(root, "seed");
	execFileSync("git", ["clone", "-q", origin, seed]);
	ident(seed);
	writeFileSync(join(seed, "a.txt"), "one\n");
	git(seed, "add", ".");
	git(seed, "commit", "-q", "-m", "init");
	git(seed, "push", "-q", "origin", "HEAD:main");
	execFileSync("git", ["clone", "-q", origin, work]);
	ident(work);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Stash a tracked edit and one untracked file under a hand-written message; returns the stash commit. */
function stashWith(message: string, content: string, extra?: [string, string]): string {
	writeFileSync(join(work, "a.txt"), content);
	if (extra) writeFileSync(join(work, extra[0]), extra[1]);
	git(work, "stash", "push", "--include-untracked", "-m", message);
	return git(work, "rev-parse", "stash@{0}");
}

describe("listStashes", () => {
	it("returns each entry's immutable sha, date, message, base, branch and file count; unknown attribution stays unknown", () => {
		const sha = stashWith("some hand stash", "edit\n", ["u.txt", "u\n"]);
		const l = listStashes(work, { now: () => new Date("2026-01-01T00:00:00Z") });
		expect(l).toMatchObject({ total: 1, truncated: false, readAt: "2026-01-01T00:00:00.000Z" });
		expect(l.stashes[0]).toMatchObject({ sha, index: 0, message: "On main: some hand stash", branch: "main", base: git(work, "rev-parse", "HEAD"), filesTotal: 2, attribution: { kind: "unknown" }, pins: [] });
	});

	it("attributes only what the message says: a parked run and a checkout stash, with their pins", () => {
		writeFileSync(join(work, "a.txt"), "parked\n");
		const parked = parkSnapshot(work, "0a1b2c3d-0000-4000-8000-000000000042", { exclusive: true });
		writeFileSync(join(work, "a.txt"), "cleaned\n");
		const cleaned = cleanCheckout(work, { action: "stash", label: "unblock #12" });
		const l = listStashes(work);
		const byKind = (k: string) => l.stashes.find((s) => s.attribution.kind === k)!;
		expect(byKind("run").attribution).toEqual({ kind: "run", runId: "0a1b2c3d-0000-4000-8000-000000000042" });
		expect(byKind("run").pins).toEqual(["refs/pags/parked/0a1b2c3d-0000-4000-8000-000000000042"]);
		expect(byKind("checkout-stash").attribution).toMatchObject({ kind: "checkout-stash", label: "unblock #12" });
		expect(byKind("checkout-stash").sha).toBe(cleaned.backup && cleaned.backup.kind === "stash" ? cleaned.backup.commit : "");
		expect(parked).toBeTruthy();
	});

	it("is the same from a linked worktree (stashes belong to the repository)", () => {
		const sha = stashWith("shared", "x\n");
		const linked = join(root, "linked");
		git(work, "worktree", "add", "-q", linked, "-b", "side");
		expect(listStashes(linked).stashes.map((s) => s.sha)).toEqual([sha]);
	});

	it("keeps two repositories apart", () => {
		stashWith("only here", "x\n");
		const second = join(root, "second");
		execFileSync("git", ["clone", "-q", origin, second]);
		expect(listStashes(second).total).toBe(0);
		expect(listStashes(work).total).toBe(1);
	});

	it("rejects a non-checkout", () => {
		expect(() => listStashes(root)).toThrow(/not a git checkout/);
	});
});

describe("inspectStash", () => {
	it("lists changed tracked and untracked paths and marks what main already holds", () => {
		// a.txt on main gets the SAME content the stash holds, so that path is not unique
		const sha = stashWith("overlap", "two\n", ["u.txt", "u\n"]);
		const other = join(root, "other");
		execFileSync("git", ["clone", "-q", origin, other]);
		ident(other);
		writeFileSync(join(other, "a.txt"), "two\n");
		git(other, "commit", "-qam", "same edit on main");
		git(other, "push", "-q", "origin", "HEAD:main");
		git(work, "fetch", "-q", "origin");
		const i = inspectStash(work, sha)!;
		expect(i.defaultBranch).toBe("main");
		expect(i.defaultAheadOfBase).toBe(1);
		expect(i.files).toEqual([
			{ status: "M", path: "a.txt", untracked: false, onDefault: true },
			{ status: "A", path: "u.txt", untracked: true, onDefault: false },
		]);
		expect(i.uniqueFiles).toBe(1);
		expect(i.shortstat).toMatch(/1 file changed/);
	});

	it("returns null for an unknown sha and rejects a non-sha", () => {
		stashWith("x", "x\n");
		expect(inspectStash(work, "0".repeat(40))).toBeNull();
		expect(() => inspectStash(work, "stash@{0}")).toThrow(/40-character/);
	});
});

describe("dropStash", () => {
	it("previews with the unique changes and drops nothing", () => {
		const sha = stashWith("keep", "x\n", ["u.txt", "u\n"]);
		const r = dropStash(work, { sha, dryRun: true });
		expect(r).toMatchObject({ ok: true, dryRun: true, stashesBefore: 1 });
		expect(r.stash?.files.map((f) => f.path)).toEqual(["a.txt", "u.txt"]);
		expect(listStashes(work).total).toBe(1);
	});

	it("drops exactly the entry whose sha was given even when the indexes shifted since the preview", () => {
		const first = stashWith("first", "1\n");
		const second = stashWith("second", "2\n");
		const third = stashWith("third", "3\n");
		// at preview time `first` was stash@{0}; it is stash@{2} now
		expect(listStashes(work).stashes.map((s) => [s.sha, s.index])).toEqual([[third, 0], [second, 1], [first, 2]]);
		const r = dropStash(work, { sha: first, dryRun: false }, { now: () => new Date("2026-01-01T00:00:00Z") });
		expect(r.ok).toBe(true);
		expect(r.stashesBefore).toBe(3);
		expect(r.stashesAfter).toBe(2);
		expect(r.receipt).toMatchObject({ sha: first, message: "On main: first", at: "2026-01-01T00:00:00.000Z" });
		expect(listStashes(work).stashes.map((s) => s.sha)).toEqual([third, second]);
		// and the receipt's recovery line really restores it
		git(work, "stash", "store", "-m", "On main: first", first);
		expect(listStashes(work).stashes.map((s) => s.sha)).toContain(first);
	});

	it("is a no-op, said so, when the entry is already gone — and never touches a different one", () => {
		const keep = stashWith("keep", "k\n");
		const gone = "1".repeat(40);
		const r = dropStash(work, { sha: gone, dryRun: false });
		expect(r).toMatchObject({ ok: true, alreadyGone: true, stashesBefore: 1, stashesAfter: 1 });
		expect(listStashes(work).stashes.map((s) => s.sha)).toEqual([keep]);
	});

	it("leaves a pin on the commit in place and reports it", () => {
		writeFileSync(join(work, "a.txt"), "pinned\n");
		const r0 = cleanCheckout(work, { action: "stash", label: "pinned one" });
		const sha = r0.backup && r0.backup.kind === "stash" ? r0.backup.commit : "";
		const r = dropStash(work, { sha, dryRun: false });
		expect(r.ok).toBe(true);
		expect(r.receipt?.pinsKept).toEqual([r0.backup && r0.backup.kind === "stash" ? r0.backup.ref : ""]);
		expect(git(work, "rev-parse", r.receipt!.pinsKept[0])).toBe(sha);
	});

	it("rejects a short sha or an index", () => {
		stashWith("x", "x\n");
		expect(() => dropStash(work, { sha: "stash@{0}", dryRun: false })).toThrow(/40-character/);
		expect(() => dropStash(work, { sha: "abc123", dryRun: true })).toThrow(/40-character/);
	});
});
