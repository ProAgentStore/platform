import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { InspectError } from "./inspect.js";

/**
 * Set a parked run's uncommitted work aside, and put it back (#1077).
 *
 * ── Why this exists beside `repo-write.ts`, whose rule it bends
 *
 * `repo-write.ts` closes the platform's unattended write vocabulary at two pointer moves and says why
 * nothing in the `stash`/`reset`/`clean` family is reachable: those are how work gets swallowed. A
 * run parked on a question (#1076) has to release its checkout so the next objective can run (#1077,
 * the design on #1072 §B), and a checkout with somebody's edits in it cannot be handed to another
 * run as it is. So the work is set aside — and every way that could lose a byte is closed here:
 *
 *   * The save is `git stash push --include-untracked` with a message naming the run: git's own
 *     atomic save-then-clean, which writes the whole tree (tracked, staged and untracked; ignored
 *     files are never touched) into a commit BEFORE it cleans anything.
 *   * The new entry is identified by that message — never by `stash@{0}` alone — and its exact
 *     commit id is pinned on a ref of its own, `refs/pags/parked/<run>`. Nothing here pops, drops or
 *     clears a stash, so the entry stays in `git stash list` as a second, visible copy, and the ref
 *     keeps the commit reachable even if somebody drops the entry by hand. A ref under `refs/pags/`
 *     is not a branch and is not pushed.
 *   * The restore applies by that exact id, only onto a clean tree, and only after checking it
 *     applies cleanly — tracked changes with `git apply --check`, untracked files by refusing any that
 *     already exist. A restore that would conflict changes NOTHING and says so; the work stays on the
 *     ref for a person (or #1078's reconciliation) to bring back.
 *
 * Fixed argv, no shell. The run id is the only caller token, and it must be a uuid.
 */

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const parkRef = (runId: string) => `refs/pags/parked/${runId}`;
const parkMessage = (runId: string) => `pags-park ${runId}`;

function git(workDir: string, argv: string[], input?: string): string {
	return execFileSync("git", argv, { cwd: workDir, encoding: "utf-8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024, input, stdio: ["pipe", "pipe", "pipe"] });
}

function checkout(workDir: string, runId: string): void {
	if (!RUN_ID.test(runId)) throw new InspectError(`unusable run id: ${runId}`);
	if (!existsSync(join(workDir, ".git"))) throw new InspectError(`not a git checkout: ${workDir}`);
}

/** Every path git would report changed, untracked included — the whole working-tree state. */
function changes(workDir: string): string[] {
	return git(workDir, ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean);
}

export interface ParkSnapshotResult {
	/** The exact commit id the work was saved as; null when the tree was already clean. */
	snapshot: string | null;
	/** Files that were set aside. */
	files: number;
	/** The checkout is clean now — the only state in which the cloud may hand it to another run. */
	clean: boolean;
	ref: string | null;
}

/** Save the parked run's uncommitted work and leave the checkout clean. Idempotent per run. */
export function parkSnapshot(workDir: string, runId: string): ParkSnapshotResult {
	checkout(workDir, runId);
	const ref = parkRef(runId);
	const existing = (() => {
		try {
			return git(workDir, ["rev-parse", "--verify", "--quiet", ref]).trim() || null;
		} catch {
			return null;
		}
	})();
	const before = changes(workDir);
	// A replay of a park that already saved: the work is on the ref; report it rather than save a second copy.
	if (existing) return { snapshot: existing, files: before.length, clean: before.length === 0, ref };
	if (before.length === 0) return { snapshot: null, files: 0, clean: true, ref: null };
	git(workDir, ["stash", "push", "--include-untracked", "-m", parkMessage(runId)]);
	// The entry git just wrote, found by its message: never assume `stash@{0}` is ours.
	const list = git(workDir, ["stash", "list", "--format=%H %s"]).split("\n").filter(Boolean);
	const mine = list.find((l) => l.endsWith(parkMessage(runId)));
	if (!mine) throw new InspectError("the stash entry for this park was not found after saving it; nothing was released");
	const snapshot = mine.split(" ")[0];
	git(workDir, ["update-ref", ref, snapshot]);
	return { snapshot, files: before.length, clean: changes(workDir).length === 0, ref };
}

export interface ParkRestoreResult {
	restored: boolean;
	/** Why nothing was changed, when `restored` is false. */
	refused?: string;
}

/** Put a parked run's work back by its exact id — only onto a clean tree, only if it applies cleanly. */
export function parkRestore(workDir: string, runId: string, snapshot: string): ParkRestoreResult {
	checkout(workDir, runId);
	if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(snapshot)) throw new InspectError(`unusable snapshot id: ${snapshot}`);
	const ref = parkRef(runId);
	let pinned = "";
	try {
		pinned = git(workDir, ["rev-parse", "--verify", "--quiet", ref]).trim();
	} catch {
		pinned = "";
	}
	if (pinned !== snapshot) return { restored: false, refused: `the saved work is not at ${ref} on this machine (expected ${snapshot})` };
	const dirty = changes(workDir);
	if (dirty.length) return { restored: false, refused: `the checkout is not clean (${dirty.length} changed file${dirty.length === 1 ? "" : "s"}), so the saved work was not put back on top of it` };
	// Tracked changes: the stash's own diff against its base, checked against the current tree.
	const patch = git(workDir, ["diff", "--binary", `${snapshot}^1`, snapshot]);
	if (patch.trim()) {
		try {
			git(workDir, ["apply", "--check"], patch);
		} catch {
			return { restored: false, refused: "the saved work no longer applies cleanly to this checkout (it changed underneath while the run was parked)" };
		}
	}
	// Untracked files: the stash's third parent. Any that already exists would be refused by git mid-apply.
	let untracked: string[] = [];
	try {
		untracked = git(workDir, ["ls-tree", "-r", "--name-only", `${snapshot}^3`]).split("\n").filter(Boolean);
	} catch {
		untracked = [];
	}
	const clash = untracked.filter((p) => existsSync(join(workDir, p)));
	if (clash.length) return { restored: false, refused: `${clash.length} file${clash.length === 1 ? "" : "s"} the saved work would create already exist${clash.length === 1 ? "s" : ""} (first: ${clash[0]})` };
	git(workDir, ["stash", "apply", snapshot]);
	git(workDir, ["update-ref", "-d", ref, snapshot]);
	return { restored: true };
}
