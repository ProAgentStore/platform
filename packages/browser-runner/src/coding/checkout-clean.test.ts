import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanCheckout } from "./checkout-clean.js";

const git = (dir: string, ...argv: string[]) => execFileSync("git", argv, { cwd: dir, encoding: "utf-8" });

let root: string;
let origin: string;
let work: string;

/** A bare origin with one commit, a clone of it, and a second clone used to push new commits. */
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pags-checkout-clean-"));
	origin = join(root, "origin.git");
	work = join(root, "work");
	execFileSync("git", ["init", "--bare", "-b", "main", origin]);
	const seed = join(root, "seed");
	execFileSync("git", ["clone", "-q", origin, seed]);
	for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"]]) git(seed, "config", k, v);
	writeFileSync(join(seed, "a.txt"), "one\n");
	writeFileSync(join(seed, ".gitignore"), "ignored.log\n");
	git(seed, "add", ".");
	git(seed, "commit", "-q", "-m", "init");
	git(seed, "push", "-q", "origin", "HEAD:main");
	execFileSync("git", ["clone", "-q", origin, work]);
	for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"]]) git(work, "config", k, v);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Push a commit to origin touching a.txt, so `work` is one behind and a local edit to a.txt blocks the pull. */
function originMoves() {
	const other = join(root, "other");
	execFileSync("git", ["clone", "-q", origin, other]);
	for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"]]) git(other, "config", k, v);
	writeFileSync(join(other, "a.txt"), "one\ntwo\n");
	git(other, "commit", "-qam", "upstream edit");
	git(other, "push", "-q", "origin", "HEAD:main");
	return git(other, "rev-parse", "HEAD").trim();
}

function dirty() {
	writeFileSync(join(work, "a.txt"), "local edit\n");
	writeFileSync(join(work, "new.txt"), "untracked\n");
	writeFileSync(join(work, "ignored.log"), "keep me\n");
}

describe("cleanCheckout", () => {
	it("stash: saves tracked and untracked work on a ref, leaves the tree clean, never touches ignored files", () => {
		dirty();
		const r = cleanCheckout(work, { action: "stash", label: "run 0c59a0bf" });
		expect(r).toMatchObject({ ok: true, action: "stash", files: 2, clean: true });
		expect(r.backup).toMatchObject({ kind: "stash" });
		const b = r.backup as { ref: string; commit: string };
		expect(git(work, "rev-parse", b.ref).trim()).toBe(b.commit);
		expect(git(work, "stash", "list")).toContain("pags-stash");
		expect(git(work, "status", "--porcelain").trim()).toBe("");
		expect(existsSync(join(work, "new.txt"))).toBe(false);
		expect(readFileSync(join(work, "ignored.log"), "utf-8")).toBe("keep me\n");
		// the saved commit really holds the work
		expect(git(work, "show", `${b.commit}:a.txt`)).toBe("local edit\n");
	});

	it("discard: writes a backup patch and an untracked list FIRST, then resets and cleans (never -x)", () => {
		dirty();
		const r = cleanCheckout(work, { action: "discard", label: "owner decision" });
		expect(r).toMatchObject({ ok: true, action: "discard", files: 2, clean: true });
		const b = r.backup as { kind: string; path: string; untrackedList: string; untracked: number };
		expect(b.kind).toBe("patch");
		expect(readFileSync(b.path, "utf-8")).toContain("+local edit");
		expect(readFileSync(b.untrackedList, "utf-8")).toBe("new.txt\n");
		expect(b.untracked).toBe(1);
		expect(readFileSync(join(work, "a.txt"), "utf-8")).toBe("one\n");
		expect(existsSync(join(work, "new.txt"))).toBe(false);
		expect(readFileSync(join(work, "ignored.log"), "utf-8")).toBe("keep me\n");
	});

	it("a dirty tree that blocks the fast-forward becomes current after stash + pull (the #462 case)", () => {
		const upstream = originMoves();
		dirty();
		git(work, "fetch", "-q");
		// without the action, git refuses
		expect(() => git(work, "pull", "--ff-only")).toThrow();
		const r = cleanCheckout(work, { action: "stash", label: "pull-before-run", pull: true, branch: "main" });
		expect(r.ok).toBe(true);
		expect(r.head).toBe(upstream);
		expect(r.clean).toBe(true);
		expect(r.pulled).toMatchObject({ changed: true, commits: 1 });
	});

	it("discard + pull brings a behind checkout current with a backup of what was thrown away", () => {
		const upstream = originMoves();
		dirty();
		const r = cleanCheckout(work, { action: "discard", label: "owner decision", pull: true, branch: "main" });
		expect(r).toMatchObject({ ok: true, clean: true, head: upstream });
		expect(readFileSync((r.backup as { path: string }).path, "utf-8")).toContain("+local edit");
	});

	it("a clean tree has nothing to keep: no backup, still pulls", () => {
		const upstream = originMoves();
		const r = cleanCheckout(work, { action: "stash", label: "x", pull: true, branch: "main" });
		expect(r).toMatchObject({ ok: true, files: 0, backup: null, head: upstream });
	});

	it("reports a failed fast-forward after the clean-up instead of claiming success", () => {
		dirty();
		git(work, "remote", "set-url", "origin", join(root, "missing.git"));
		const r = cleanCheckout(work, { action: "stash", label: "x", pull: true, branch: "main" });
		expect(r.ok).toBe(false);
		expect(r.clean).toBe(true);
		expect(r.backup).not.toBeNull();
		expect(r.error).toMatch(/stashed but the fast-forward/);
	});

	it("refuses an unusable label, an unknown action and a non-checkout", () => {
		expect(() => cleanCheckout(work, { action: "stash", label: "a; rm -rf /" })).toThrow(/unusable label/);
		expect(() => cleanCheckout(work, { action: "stash", label: "" })).toThrow(/unusable label/);
		expect(() => cleanCheckout(work, { action: "wipe" as never, label: "x" })).toThrow(/unsupported/);
		expect(() => cleanCheckout(root, { action: "stash", label: "x" })).toThrow(/not a git checkout/);
	});
});

/**
 * #1514 — a stash whose reply was lost must be settleable. A retry carrying the same label is answered with the first
 * call's receipt and never stashes a second time; real temporary repositories only.
 */
describe("cleanCheckout stash is idempotent by label (#1514)", () => {
	const stashes = () => git(work, "stash", "list").split("\n").filter(Boolean);
	const refs = () => git(work, "for-each-ref", "--format=%(refname)", "refs/pags/stash/").split("\n").filter(Boolean);
	const dirty = () => {
		writeFileSync(join(work, "a.txt"), "one\nlocal edit\n");
		writeFileSync(join(work, "new-untracked.ts"), "export const x = 1;\n");
		writeFileSync(join(work, "ignored.log"), "never touched\n");
	};

	it("a retry after the first call landed returns that receipt and changes nothing", () => {
		dirty();
		const first = cleanCheckout(work, { action: "stash", label: "FAS 349 recovery", now: Date.UTC(2026, 10, 4, 12, 0, 0) });
		expect(first).toMatchObject({ ok: true, files: 2, clean: true });
		expect(first.reconciled).toBeUndefined();
		// The reply was lost; the caller repeats the SAME call a minute later.
		const retry = cleanCheckout(work, { action: "stash", label: "FAS 349 recovery", now: Date.UTC(2026, 10, 4, 12, 1, 0) });
		expect(retry).toMatchObject({ ok: true, clean: true, reconciled: true, files: 0 });
		expect(retry.backup).toEqual(first.backup); // the same ref and commit — the receipt
		expect(stashes()).toHaveLength(1); // not stashed twice
		expect(refs()).toHaveLength(1);
	});

	it("the receipt really holds the tracked edit AND the untracked file, and the ignored file was left alone", () => {
		dirty();
		const r = cleanCheckout(work, { action: "stash", label: "keep all" });
		const commit = (r.backup as { commit: string }).commit;
		expect(git(work, "show", `${commit}:a.txt`)).toContain("local edit");
		expect(git(work, "show", `${commit}^3:new-untracked.ts`)).toContain("export const x");
		expect(existsSync(join(work, "new-untracked.ts"))).toBe(false);
		expect(readFileSync(join(work, "ignored.log"), "utf-8")).toBe("never touched\n");
	});

	it("a retry over NEWER edits leaves them in place, says so, and does not stash a second time", () => {
		dirty();
		cleanCheckout(work, { action: "stash", label: "same label" });
		writeFileSync(join(work, "later.ts"), "written after the first call\n");
		const retry = cleanCheckout(work, { action: "stash", label: "same label" });
		expect(retry).toMatchObject({ ok: false, reconciled: true, clean: false });
		expect(retry.error).toMatch(/already stashed.*newer.*use a new label/s);
		expect(readFileSync(join(work, "later.ts"), "utf-8")).toBe("written after the first call\n");
		expect(stashes()).toHaveLength(1);
	});

	it("a different label stashes the newer edits as its own entry", () => {
		dirty();
		const a = cleanCheckout(work, { action: "stash", label: "first", now: Date.UTC(2026, 10, 4, 12, 0, 0) });
		writeFileSync(join(work, "later.ts"), "newer\n");
		const b = cleanCheckout(work, { action: "stash", label: "second", now: Date.UTC(2026, 10, 4, 12, 5, 0) });
		expect(b).toMatchObject({ ok: true, clean: true });
		expect(b.reconciled).toBeUndefined();
		expect((b.backup as { commit: string }).commit).not.toBe((a.backup as { commit: string }).commit);
		expect(stashes()).toHaveLength(2);
	});

	it("matches the label exactly: a longer label that merely ends with it, or a prefix of it, is a different stash", () => {
		dirty();
		cleanCheckout(work, { action: "stash", label: "recovery" });
		writeFileSync(join(work, "x.ts"), "x\n");
		const longer = cleanCheckout(work, { action: "stash", label: "FAS recovery" });
		expect(longer).toMatchObject({ ok: true, clean: true });
		expect(longer.reconciled).toBeUndefined();
		writeFileSync(join(work, "y.ts"), "y\n");
		const prefix = cleanCheckout(work, { action: "stash", label: "recov" });
		expect(prefix.reconciled).toBeUndefined();
		expect(stashes()).toHaveLength(3);
	});

	it("a reconciled retry still fast-forwards when asked, since that step is itself idempotent", () => {
		dirty();
		cleanCheckout(work, { action: "stash", label: "with pull" });
		originMoves();
		const retry = cleanCheckout(work, { action: "stash", label: "with pull", pull: true, branch: "main" });
		expect(retry).toMatchObject({ ok: true, reconciled: true, clean: true });
		expect(retry.pulled?.changed).toBe(true);
		expect(stashes()).toHaveLength(1);
	});

	it("a discard is never answered from a stash with the same label", () => {
		dirty();
		cleanCheckout(work, { action: "stash", label: "shared label" });
		writeFileSync(join(work, "keep-me.ts"), "x\n");
		const r = cleanCheckout(work, { action: "discard", label: "shared label" });
		expect(r.reconciled).toBeUndefined();
		expect(r.backup).toMatchObject({ kind: "patch" });
	});
});
