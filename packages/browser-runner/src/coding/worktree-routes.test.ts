import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunWorktree, discardedRef } from "./run-worktree.js";
import { handleWorktreeRoute, type WorktreeRouteDeps } from "./worktree-routes.js";

// #1709: the owner's discard of one run's isolated worktree, on REAL temporary repositories.
const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function git(dir: string, ...argv: string[]): string {
	return execFileSync("git", argv, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}
const write = (dir: string, p: string, body: string) => {
	mkdirSync(join(dir, p, ".."), { recursive: true });
	writeFileSync(join(dir, p), body);
};

describe("POST /coding/worktree-discard (#1709)", () => {
	let base: string;
	let shared: string;
	let root: string;
	let live: string[];
	const deps = (): WorktreeRouteDeps => ({ repoWorkDir: () => shared, worktreeRoot: () => root, list: () => live.map((sessionId) => ({ sessionId, alive: true })) });
	const call = async (body: Record<string, unknown>) => (await handleWorktreeRoute("POST", "/coding/worktree-discard", deps(), async () => body))?.body as Record<string, unknown>;
	beforeEach(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "pags-wtr-")));
		const origin = join(base, "origin.git");
		shared = join(base, "shared");
		root = join(base, "managed");
		live = [];
		git(base, "init", "-q", "--bare", "-b", "main", origin);
		git(base, "clone", "-q", origin, shared);
		git(shared, "config", "user.email", "t@example.com");
		git(shared, "config", "user.name", "T");
		git(shared, "checkout", "-q", "-b", "main");
		write(shared, "a.txt", "one\n");
		git(shared, "add", "-A");
		git(shared, "commit", "-qm", "first");
		git(shared, "push", "-q", "origin", "main");
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("ignores any other path and method", async () => {
		expect(await handleWorktreeRoute("GET", "/coding/worktree-discard", deps(), async () => ({}))).toBeNull();
		expect(await handleWorktreeRoute("POST", "/coding/branch-delete", deps(), async () => ({}))).toBeNull();
	});

	it("previews by default and changes nothing", async () => {
		const wt = createRunWorktree(shared, { root, runId: A, target: "main" }).path as string;
		write(wt, "edit.txt", "uncommitted\n");
		const r = await call({ runId: A });
		expect(r).toMatchObject({ ok: true, dryRun: true, files: 1, changed: ["edit.txt"], pinRef: discardedRef(A) });
		expect(existsSync(wt)).toBe(true);
		const explicit = await call({ runId: A, dryRun: true, expectedHead: "x" });
		expect(explicit).toMatchObject({ dryRun: true });
	});

	it("executes only with the head the preview returned, removes just that run's worktree, commits nothing and pins its commits", async () => {
		const a = createRunWorktree(shared, { root, runId: A, target: "main" }).path as string;
		const b = createRunWorktree(shared, { root, runId: B, target: "main" }).path as string;
		write(a, "kept.txt", "committed\n");
		git(a, "-c", "user.email=t@example.com", "-c", "user.name=T", "add", "-A");
		git(a, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "run commit");
		write(a, "edit.txt", "uncommitted\n");
		write(b, "other.txt", "other run\n");
		const preview = await call({ runId: A });
		await expect(call({ runId: A, dryRun: false })).rejects.toThrow(/expectedHead/);
		expect(await call({ runId: A, dryRun: false, expectedHead: "f".repeat(40) })).toMatchObject({ ok: false, reason: "stale_head" });
		expect(existsSync(a)).toBe(true);
		const done = await call({ runId: A, dryRun: false, expectedHead: preview.head });
		expect(done).toMatchObject({ ok: true, discardedFiles: 1, pinned: discardedRef(A) });
		expect(existsSync(a)).toBe(false);
		expect(git(shared, "rev-parse", discardedRef(A)).trim()).toBe(preview.head);
		expect(readFileSync(join(b, "other.txt"), "utf-8")).toBe("other run\n");
		expect(git(shared, "status", "--porcelain")).toBe("");
	});

	it("refuses a run whose engine is still alive, and one it does not manage", async () => {
		const a = createRunWorktree(shared, { root, runId: A, target: "main" }).path as string;
		live = [`csess_${A}`];
		expect(await call({ runId: A, dryRun: false, expectedHead: "f".repeat(40) })).toMatchObject({ ok: false, reason: "session_live" });
		expect(existsSync(a)).toBe(true);
		live = [];
		expect(await call({ runId: B })).toMatchObject({ ok: false, reason: "not_managed" });
		await expect(call({ runId: "../../etc" })).rejects.toThrow(/uuid/);
	});
});
