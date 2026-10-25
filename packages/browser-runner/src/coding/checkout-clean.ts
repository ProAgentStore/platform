import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { InspectError } from "./inspect.js";
import { fastForwardRepo, type FastForwardResult } from "./repo-write.js";

/**
 * Stash or discard a checkout's local changes, on purpose and with a backup (#1324).
 *
 * ── Why this sits beside `repo-write.ts` and `park-snapshot.ts`, whose rules it bends
 *
 * `repo-write.ts` keeps the unattended write vocabulary at two pointer moves and `park-snapshot.ts`
 * sets work aside for a PARKED run. Neither can answer an OWNER who has decided "stash it" or "throw
 * it away": a run stopped on a dirty tree (a fast-forward git refuses because an incoming commit
 * touches a changed file) waited for someone at the keyboard. These two verbs are that decision made
 * remotely, and every way they could lose a byte unrecorded is closed:
 *
 *   * `stash` is `git stash push --include-untracked` with a labelled message — git's own atomic
 *     save-then-clean. The entry is found by its message (never `stash@{0}`), pinned on a ref of its
 *     own (`refs/pags/stash/<id>`) and left in `git stash list`. Ignored files are never touched.
 *   * `discard` writes a BACKUP FIRST — a binary patch of every tracked change and the list of
 *     untracked paths — under the git dir, then `reset --hard HEAD` and `clean -fd`. Never `-x`:
 *     ignored files (build outputs, `.env`) are not ours to remove. If the backup cannot be written,
 *     nothing is discarded.
 *   * Each may then fast-forward (`pull --ff-only`, through `fastForwardRepo`'s own preconditions), and
 *     the reply is built from re-reads — HEAD, whether the tree is clean — not from exit codes.
 *
 * Fixed argv, no shell. The only caller-supplied token is the label, and it is restricted to a
 * conservative alphabet. Whether a live session is writing in the checkout is the CLOUD's check
 * (it owns the session ledger); this module refuses nothing on that ground.
 */

export type CheckoutCleanAction = "stash" | "discard";

const LABEL = /^[A-Za-z0-9 ._:#/@-]{1,80}$/;

export interface CheckoutCleanResult {
	ok: boolean;
	action: CheckoutCleanAction;
	/** Files that were changed (tracked, staged and untracked) when the action started. */
	files: number;
	/** Where the work went: a ref and exact commit for a stash; a patch file and an untracked list for a discard. Null when there was nothing to keep. */
	backup: { kind: "stash"; ref: string; commit: string } | { kind: "patch"; path: string; untrackedList: string; untracked: number } | null;
	/** HEAD after, read back. */
	head: string | null;
	/** The tree is clean after, read back — the only state the cloud calls clean. */
	clean: boolean;
	/** The fast-forward that followed, when asked for. */
	pulled: { changed: boolean; from: string | null; to: string | null; commits: number | null; refused?: string; error?: string } | null;
	/** Why the action did not finish, credential-free; absent on success. */
	error?: string;
}

function git(workDir: string, argv: string[]): string {
	return execFileSync("git", argv, { cwd: workDir, encoding: "utf-8", timeout: 60_000, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

const changes = (workDir: string): string[] => git(workDir, ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean);

function head(workDir: string): string | null {
	try {
		return git(workDir, ["rev-parse", "HEAD"]).trim() || null;
	} catch {
		return null;
	}
}

function gitDir(workDir: string): string {
	const d = git(workDir, ["rev-parse", "--git-dir"]).trim();
	return isAbsolute(d) ? d : resolve(workDir, d);
}

function gitMessage(e: unknown): string {
	const raw = String((e as { stderr?: unknown }).stderr || (e instanceof Error ? e.message : e) || "git failed");
	return (raw.split("\n").map((l) => l.trim()).find((l) => l && !/^hint:/i.test(l)) ?? "git failed").replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<remote>").slice(0, 200);
}

function pull(workDir: string, branch: string | undefined): CheckoutCleanResult["pulled"] {
	let r: FastForwardResult;
	try {
		r = fastForwardRepo(workDir, { branch });
	} catch (e) {
		return { changed: false, from: null, to: null, commits: null, error: e instanceof Error ? e.message : String(e) };
	}
	return { changed: r.changed, from: r.from, to: r.to, commits: r.commits, ...(r.refused ? { refused: r.refused } : {}), ...(r.error ? { error: r.error } : {}) };
}

/** Stash or discard this checkout's local changes with a backup, then optionally fast-forward it. */
export function cleanCheckout(workDir: string, input: { action: CheckoutCleanAction; label: string; pull?: boolean; branch?: string; now?: number }): CheckoutCleanResult {
	const { action, label } = input;
	if (action !== "stash" && action !== "discard") throw new InspectError(`unsupported checkout action: ${String(action)}`);
	if (!LABEL.test(label)) throw new InspectError("unusable label: use 1-80 letters, digits, spaces and . _ : # / @ -");
	if (!existsSync(join(workDir, ".git"))) throw new InspectError(`not a git checkout: ${workDir}`);
	const stamp = new Date(input.now ?? Date.now()).toISOString().replace(/[-:.]/g, "").slice(0, 15);
	const before = changes(workDir);
	const result: CheckoutCleanResult = { ok: false, action, files: before.length, backup: null, head: head(workDir), clean: before.length === 0, pulled: null };

	if (before.length > 0) {
		try {
			if (action === "stash") {
				const message = `pags-stash ${stamp} ${label}`;
				git(workDir, ["stash", "push", "--include-untracked", "-m", message]);
				const mine = git(workDir, ["stash", "list", "--format=%H %s"]).split("\n").filter(Boolean).find((l) => l.endsWith(message));
				if (!mine) return { ...result, error: "the stash entry was not found after saving it, so the result cannot be trusted" };
				const commit = mine.split(" ")[0];
				const ref = `refs/pags/stash/${stamp}`;
				git(workDir, ["update-ref", ref, commit]);
				result.backup = { kind: "stash", ref, commit };
			} else {
				// The backup comes FIRST and a failure to write it stops everything: nothing is discarded unrecorded.
				const dir = join(gitDir(workDir), "pags-backups");
				mkdirSync(dir, { recursive: true });
				const patch = join(dir, `${stamp}.patch`);
				const list = join(dir, `${stamp}.untracked.txt`);
				const tracked = git(workDir, ["diff", "--binary", "HEAD"]);
				const untracked = git(workDir, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
				writeFileSync(patch, tracked);
				writeFileSync(list, `${untracked.join("\n")}${untracked.length ? "\n" : ""}`);
				result.backup = { kind: "patch", path: patch, untrackedList: list, untracked: untracked.length };
				git(workDir, ["reset", "--hard", "HEAD"]);
				git(workDir, ["clean", "-fd"]); // never -x: ignored files are not ours to remove
			}
		} catch (e) {
			return { ...result, head: head(workDir), clean: changes(workDir).length === 0, error: `${action} failed: ${gitMessage(e)}` };
		}
	}

	const after = changes(workDir);
	result.clean = after.length === 0;
	if (!result.clean) return { ...result, head: head(workDir), error: `the checkout still has ${after.length} changed file${after.length === 1 ? "" : "s"} after the ${action} (ignored files are never removed, but these are not ignored)` };
	if (input.pull) result.pulled = pull(workDir, input.branch);
	result.head = head(workDir);
	result.clean = changes(workDir).length === 0;
	result.ok = result.clean && !(result.pulled && (result.pulled.error || result.pulled.refused));
	if (!result.ok && result.pulled?.error) result.error = `the changes were ${action === "stash" ? "stashed" : "discarded"} but the fast-forward failed: ${result.pulled.error}`;
	else if (!result.ok && result.pulled?.refused) result.error = `the changes were ${action === "stash" ? "stashed" : "discarded"} but the fast-forward was refused: ${result.pulled.refused}`;
	return result;
}
