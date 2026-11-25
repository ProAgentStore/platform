import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editedPathFromToolUse } from "./edited-paths.js";
import { HeadlessSession } from "./headless.js";
import { handleIsolatedRoute, reconcileAllWorktrees } from "./isolated-routes.js";
import { startIsolatedCheckout, worktreeRootFor } from "./isolated-start.js";
import { parkSnapshot } from "./park-snapshot.js";
import { CodingRuntime } from "./runtime.js";

/** #1714 / #1713 — shared-checkout admission, owned-path parking, reconcile at start, publish and clean up an isolated run. Real temporary repositories only. */

const S1 = "csess_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const R1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const S2 = "csess_bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const R2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const git = (cwd: string, ...argv: string[]) => execFileSync("git", argv, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

describe("checkout strategy routes (#1714, #1713)", () => {
	let base: string;
	let shared: string;
	let root: string;
	let origin: string;
	const deps = (live: string[] = []) => ({ resolveWorkDir: () => shared, root, liveRunIds: () => new Set(live) });
	const call = async (path: string, body: Record<string, unknown>, live: string[] = []) => (await handleIsolatedRoute("POST", path, deps(live), async () => body))?.body as Record<string, unknown>;
	const commit = (dir: string, file: string, text: string) => {
		writeFileSync(join(dir, file), text);
		git(dir, "add", "-A");
		git(dir, "commit", "-qm", `add ${file}`);
	};

	beforeEach(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "pags-iso-routes-")));
		origin = join(base, "origin.git");
		shared = join(base, "shared");
		root = worktreeRootFor(join(base, "config", "repos"));
		git(base, "init", "-q", "--bare", "-b", "main", origin);
		git(base, "clone", "-q", origin, shared);
		git(shared, "config", "user.email", "t@example.com");
		git(shared, "config", "user.name", "T");
		git(shared, "checkout", "-q", "-b", "main");
		commit(shared, "a.txt", "one\n");
		git(shared, "push", "-q", "origin", "main");
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("ignores paths and methods that are not its own", async () => {
		expect(await handleIsolatedRoute("GET", "/coding/worktrees", deps(), async () => ({}))).toBeNull();
		expect(await handleIsolatedRoute("POST", "/coding/branches", deps(), async () => ({}))).toBeNull();
	});

	it("admission names the blocking paths and touches none of them", async () => {
		expect(await call("/coding/admit-checkout", {})).toMatchObject({ ok: true, blocking: [] });
		writeFileSync(join(shared, "a.txt"), "edited\n");
		writeFileSync(join(shared, "new.txt"), "untracked\n");
		const before = git(shared, "status", "--porcelain");
		expect(await call("/coding/admit-checkout", {})).toMatchObject({ ok: false, blockingCount: 2, blocking: expect.arrayContaining(["a.txt", "new.txt"]) });
		expect(git(shared, "status", "--porcelain")).toBe(before);
		expect(git(shared, "stash", "list")).toBe("");
		expect(readFileSync(join(shared, "new.txt"), "utf-8")).toBe("untracked\n");
	});

	it("publishes an isolated-direct run to the target, reads it back, then removes the clean worktree", async () => {
		const wt = startIsolatedCheckout(shared, root, { sessionId: S1, strategy: "isolated-direct", branch: "main" });
		commit(wt?.path ?? "", "b.txt", "two\n");
		const out = await call("/coding/worktree-publish", { sessionId: S1, expect: "direct" });
		expect(out).toMatchObject({ isolated: true, ok: true, mode: "direct", target: "main" });
		expect(git(origin, "rev-parse", "main").trim()).toBe(git(wt?.path ?? "", "rev-parse", "HEAD").trim());
		expect(await call("/coding/worktree-finish", { sessionId: S1 })).toMatchObject({ isolated: true, removed: true });
		expect(existsSync(wt?.path ?? "")).toBe(false);
		expect(existsSync(join(shared, "a.txt"))).toBe(true);
	});

	it("an isolated-pr run pushes its run branch, never the target, and the branch is not forced", async () => {
		const wt = startIsolatedCheckout(shared, root, { sessionId: S1, strategy: "isolated-pr", branch: "main" });
		commit(wt?.path ?? "", "b.txt", "two\n");
		const before = git(origin, "rev-parse", "main").trim();
		const out = await call("/coding/worktree-publish", { sessionId: S1, expect: "pr" });
		expect(out).toMatchObject({ isolated: true, ok: true, mode: "pr", branch: `pags/run/${R1}`, target: "main" });
		expect(git(origin, "rev-parse", "main").trim()).toBe(before);
		expect(git(origin, "rev-parse", `pags/run/${R1}`).trim()).toBe(git(wt?.path ?? "", "rev-parse", "HEAD").trim());
		expect(await call("/coding/worktree-finish", { sessionId: S1 })).toMatchObject({ removed: true });
	});

	it("refuses to publish a worktree cut the other way from what the repository is set to", async () => {
		const wt = startIsolatedCheckout(shared, root, { sessionId: S1, strategy: "isolated-direct", branch: "main" });
		commit(wt?.path ?? "", "b.txt", "two\n");
		const before = git(origin, "rev-parse", "main").trim();
		expect(await call("/coding/worktree-publish", { sessionId: S1, expect: "pr" })).toMatchObject({ ok: false, reason: "mode_mismatch" });
		expect(git(origin, "rev-parse", "main").trim()).toBe(before);
		expect(existsSync(wt?.path ?? "")).toBe(true);
	});

	it("keeps a dirty worktree: nothing pushed, nothing removed, edits still there", async () => {
		const wt = startIsolatedCheckout(shared, root, { sessionId: S1, strategy: "isolated-direct", branch: "main" });
		writeFileSync(join(wt?.path ?? "", "wip.txt"), "unsaved\n");
		expect(await call("/coding/worktree-publish", { sessionId: S1 })).toMatchObject({ ok: false, reason: "dirty" });
		expect(await call("/coding/worktree-finish", { sessionId: S1 })).toMatchObject({ removed: false, refused: expect.stringContaining("uncommitted") });
		expect(readFileSync(join(wt?.path ?? "", "wip.txt"), "utf-8")).toBe("unsaved\n");
	});

	it("keeps an unpublished commit when the target moved, and never forces", async () => {
		const wt = startIsolatedCheckout(shared, root, { sessionId: S1, strategy: "isolated-direct", branch: "main" });
		commit(wt?.path ?? "", "b.txt", "mine\n");
		const other = join(base, "other");
		git(base, "clone", "-q", origin, other);
		git(other, "config", "user.email", "t@example.com");
		git(other, "config", "user.name", "T");
		commit(other, "c.txt", "theirs\n");
		git(other, "push", "-q", "origin", "main");
		const theirs = git(origin, "rev-parse", "main").trim();
		expect(await call("/coding/worktree-publish", { sessionId: S1 })).toMatchObject({ ok: false, reason: "target_moved" });
		expect(git(origin, "rev-parse", "main").trim()).toBe(theirs);
		expect(await call("/coding/worktree-finish", { sessionId: S1 })).toMatchObject({ removed: false });
		expect(existsSync(wt?.path ?? "")).toBe(true);
	});

	it("answers `isolated: false` for a session with no managed worktree, and touches nothing", async () => {
		expect(await call("/coding/worktree-publish", { sessionId: S1 })).toEqual({ isolated: false });
		expect(await call("/coding/worktree-finish", { sessionId: S1 })).toEqual({ isolated: false });
		expect(git(shared, "status", "--porcelain")).toBe("");
	});

	it("lists retained worktrees attributed to their run: edits, published, live", async () => {
		startIsolatedCheckout(shared, root, { sessionId: S1, strategy: "isolated-direct", branch: "main" });
		const dirty = startIsolatedCheckout(shared, root, { sessionId: S2, strategy: "isolated-direct", branch: "main" });
		writeFileSync(join(dirty?.path ?? "", "wip.txt"), "x\n");
		const out = (await call("/coding/worktrees", {}, [R2])) as { worktrees: Array<Record<string, unknown>> };
		const byRun = Object.fromEntries(out.worktrees.map((w) => [w.runId as string, w]));
		expect(byRun[R1]).toMatchObject({ clean: true, files: 0, live: false });
		expect(byRun[R2]).toMatchObject({ clean: false, files: 1, paths: ["wip.txt"], live: true });
	});

	it("reconcile at start removes clean published leftovers and keeps (and reports) a worktree holding an edit", () => {
		const clean = startIsolatedCheckout(shared, root, { sessionId: S1, strategy: "isolated-direct", branch: "main" });
		const dirty = startIsolatedCheckout(shared, root, { sessionId: S2, strategy: "isolated-direct", branch: "main" });
		writeFileSync(join(dirty?.path ?? "", "wip.txt"), "unsaved\n");
		const report = reconcileAllWorktrees(root, new Set());
		expect(report.removed).toEqual([R1]);
		expect(report.kept).toMatchObject([{ runId: R2, files: 1 }]);
		expect(existsSync(clean?.path ?? "")).toBe(false);
		expect(readFileSync(join(dirty?.path ?? "", "wip.txt"), "utf-8")).toBe("unsaved\n");
		expect(reconcileAllWorktrees(join(base, "no-such-root"), new Set())).toEqual({ removed: [], kept: [] });
	});

	it("reconcile never touches the worktree of a live run", () => {
		const live = startIsolatedCheckout(shared, root, { sessionId: S1, strategy: "isolated-direct", branch: "main" });
		expect(reconcileAllWorktrees(root, new Set([R1]))).toEqual({ removed: [], kept: [] });
		expect(existsSync(live?.path ?? "")).toBe(true);
	});

	describe("parking in a shared checkout rests on what the engine wrote", () => {
		it("sets aside only the paths the session's engine edited; a stranger's edit stays", () => {
			writeFileSync(join(shared, "engine.txt"), "engine\n");
			writeFileSync(join(shared, "stranger.txt"), "not mine\n");
			const r = parkSnapshot(shared, R1, { owned: ["engine.txt"] });
			expect(r).toMatchObject({ clean: false, unowned: ["stranger.txt"], files: 1 });
			expect(existsSync(join(shared, "engine.txt"))).toBe(false);
			expect(readFileSync(join(shared, "stranger.txt"), "utf-8")).toBe("not mine\n");
		});

		it("the runtime parks by session: a path the engine wrote is owned, everything else is left, an unknown session owns nothing", () => {
			const rt = new CodingRuntime(join(base, "config", "repos"));
			const seen = new Set(["engine.txt"]);
			(rt as unknown as { endedEdits: Map<string, Set<string>> }).endedEdits.set(S1, seen);
			writeFileSync(join(shared, "engine.txt"), "engine\n");
			writeFileSync(join(shared, "stranger.txt"), "not mine\n");
			const unknown = rt.parkSnapshot({ workDir: shared, runId: R2, sessionId: S2 });
			expect(unknown).toMatchObject({ clean: false, snapshot: null });
			expect(existsSync(join(shared, "engine.txt"))).toBe(true);
			const mine = rt.parkSnapshot({ workDir: shared, runId: R1, sessionId: S1 });
			expect(mine).toMatchObject({ clean: false, files: 1, unowned: ["stranger.txt"] });
			expect(existsSync(join(shared, "engine.txt"))).toBe(false);
			expect(readFileSync(join(shared, "stranger.txt"), "utf-8")).toBe("not mine\n");
		});

		it("without a session or an owned list, a dirty checkout is left exactly as it was (today's behaviour)", () => {
			const rt = new CodingRuntime(join(base, "config", "repos"));
			writeFileSync(join(shared, "stranger.txt"), "not mine\n");
			expect(rt.parkSnapshot({ workDir: shared, runId: R1 })).toMatchObject({ clean: false, snapshot: null, conflict: "ownership_unknown", unowned: ["stranger.txt"] });
			expect(git(shared, "stash", "list")).toBe("");
		});
	});
});

describe("a session records the files its engine wrote (#1714)", () => {
	it("keeps the repo-relative path of a write tool call and ignores a read", () => {
		const dir = mkdtempSync(join(tmpdir(), "pags-edits-"));
		const s = new HeadlessSession({ id: "csess_cccccccc-3333-4333-8333-cccccccccccc", workDir: dir, clientType: "claude", statePath: join(dir, "state.json") });
		const note = (name: string, input: unknown) => (s as unknown as { noteEdit(n: string, i: unknown): void }).noteEdit(name, input);
		note("Edit", { file_path: join(dir, "src", "a.ts") });
		note("Read", { file_path: join(dir, "b.ts") });
		expect([...s.editedPaths]).toEqual(["src/a.ts"]);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("editedPathFromToolUse (#1714)", () => {
	it("reads the file a write tool names, repo-relative, and nothing else", () => {
		expect(editedPathFromToolUse("Edit", { file_path: "/repo/src/a.ts" }, "/repo")).toBe("src/a.ts");
		expect(editedPathFromToolUse("Write", { file_path: "src/b.ts" }, "/repo")).toBe("src/b.ts");
		expect(editedPathFromToolUse("NotebookEdit", { notebook_path: "/repo/n.ipynb" }, "/repo")).toBe("n.ipynb");
	});

	it("is null for a read, a shell command, a path outside the checkout, or garbage", () => {
		expect(editedPathFromToolUse("Read", { file_path: "/repo/a.ts" }, "/repo")).toBeNull();
		expect(editedPathFromToolUse("Bash", { command: "sed -i s/a/b/ a.ts" }, "/repo")).toBeNull();
		expect(editedPathFromToolUse("Edit", { file_path: "/elsewhere/a.ts" }, "/repo")).toBeNull();
		expect(editedPathFromToolUse("Edit", { file_path: "../a.ts" }, "/repo")).toBeNull();
		expect(editedPathFromToolUse("Edit", { file_path: "/repo" }, "/repo")).toBeNull();
		expect(editedPathFromToolUse("Edit", null, "/repo")).toBeNull();
		expect(editedPathFromToolUse("Edit", { file_path: 5 }, "/repo")).toBeNull();
	});
});
