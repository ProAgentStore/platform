/**
 * fail-before — run a test against the OLD source of named files, then put the current files back (#1021).
 *
 * The incident this exists for: a coder built `SRC="a.ts b.ts"`, ran `git stash push -- $SRC; …; git stash
 * pop` under zsh. zsh does not split an unquoted parameter, so the save saw ONE pathspec, failed and
 * created nothing, and the unconditional `pop` restored an UNRELATED, pre-existing stash, which conflicted.
 * `git stash` is repo-global: "pop" means "the top of everyone's stack", not "what I just saved"
 * (`packages/browser-runner/src/coding/repo-write.ts` refuses to stash for the same reason).
 *
 * So this never touches the stash, the index, refs or any file it was not given:
 *
 *   1. Preflight, mutating nothing: the paths arrive as separate argv entries and each must exist in the
 *      working tree or at the base revision. One entry that is several paths joined by spaces is the
 *      observed failure and is refused by name. An unfinished journal from an earlier run is UNKNOWN
 *      state and stops everything.
 *   2. Snapshot: each file's bytes, mode and hash go into a journal under the git dir, BEFORE any write.
 *   3. Apply: write each file's base-revision bytes into the working tree only (or remove a file the base
 *      does not have), recording what was written.
 *   4. Run the test argv with no shell, and keep its real exit status.
 *   5. Restore exactly the journalled files. A file that is no longer what step 3 wrote was changed by
 *      someone else: it is left alone, the journal is kept, and the receipt says so.
 *
 * Restoration is correlated to THIS run's journal, never to a global stack, so stash ordering, other
 * stashes and other journals cannot be consumed. `restoreFromJournal` finishes an interrupted run with the
 * same per-file checks.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Exit codes. A test's own status passes through untouched; these sit above any test runner's. */
export const EXIT = { refused: 64, conflict: 70, unknownState: 75 };

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function git(cwd, args, opts = {}) {
	const r = spawnSync("git", args, { cwd, encoding: opts.binary ? "buffer" : "utf8", maxBuffer: 256 * 1024 * 1024 });
	return { ok: r.status === 0, status: r.status, out: r.stdout, err: String(r.stderr ?? "") };
}

function journalRoot(root) {
	const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
	return join(gitDir.out.trim(), "pags-fail-before");
}

/** Journals left by runs that did not finish. Any of them means the working tree's state is not known. */
export function pendingJournals(root) {
	const dir = journalRoot(root);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((d) => existsSync(join(dir, d, "journal.json"))).map((d) => join(dir, d));
}

/**
 * Quote argv for a POSIX-family shell (`sh`, `bash`, `zsh`) so each element arrives as ONE word. Single
 * quotes are literal in all three; an embedded `'` is closed, escaped and reopened.
 */
export function quoteForShell(args, shell = "sh") {
	if (!["sh", "bash", "zsh"].includes(shell)) throw new Error(`unsupported shell: ${shell}`);
	return args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(" ");
}

/** Mutates nothing. Returns `{ root, base, files }` or `{ refused, code }`. */
export function preflight({ cwd, base = "HEAD", paths, command }) {
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok) return { refused: `not a git repository: ${cwd}`, code: EXIT.refused };
	const root = top.out.trim();
	const pending = pendingJournals(root);
	if (pending.length) {
		return {
			refused: `an earlier fail-before run did not finish (${pending.map((p) => relative(root, p)).join(", ")}); the working tree's state is unknown. Finish it with --restore <journal> first. Nothing was changed.`,
			code: EXIT.unknownState,
		};
	}
	if (!Array.isArray(command) || !command.length) return { refused: "no test command was given (everything after `--`). Nothing was changed.", code: EXIT.refused };
	if (!Array.isArray(paths) || !paths.length) return { refused: "no paths were given. Nothing was changed.", code: EXIT.refused };
	const rev = git(root, ["rev-parse", "--verify", `${base}^{commit}`]);
	if (!rev.ok) return { refused: `base revision ${base} does not resolve to a commit. Nothing was changed.`, code: EXIT.refused };
	const baseSha = rev.out.trim();
	const files = [];
	for (const p of paths) {
		if (typeof p !== "string" || !p || p.includes("\0")) return { refused: `invalid path ${JSON.stringify(p)}. Nothing was changed.`, code: EXIT.refused };
		const abs = isAbsolute(p) ? p : resolve(root, p);
		const rel = relative(root, abs);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { refused: `${p} is outside the repository. Nothing was changed.`, code: EXIT.refused };
		const inTree = existsSync(abs);
		const atBase = git(root, ["cat-file", "-e", `${baseSha}:${rel}`]).ok;
		if (inTree && !statSync(abs).isFile()) return { refused: `${rel} is not a regular file. Nothing was changed.`, code: EXIT.refused };
		if (!inTree && !atBase) {
			// The observed failure: several paths in one argument, because a shell did not split a variable.
			const parts = rel.split(/\s+/).filter(Boolean);
			const joined = parts.length > 1 && parts.every((q) => existsSync(resolve(root, q)) || git(root, ["cat-file", "-e", `${baseSha}:${q}`]).ok);
			return {
				refused: joined
					? `"${p}" is ${parts.length} paths in ONE argument — a shell passed a space-separated variable unsplit. Pass each path as its own argument. Nothing was changed.`
					: `${rel} exists neither in the working tree nor at ${base}. Nothing was changed.`,
				code: EXIT.refused,
			};
		}
		files.push({ path: rel, inTree, atBase });
	}
	return { root, base: baseSha, files };
}

function writeJournal(dir, journal) {
	writeFileSync(join(dir, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
}

/**
 * The whole comparison. `run(command, root)` returns the test's exit status (injectable for tests); the
 * default runs the argv with no shell and inherits stdio. Returns a receipt; never throws on a refusal.
 */
export function failBefore({ cwd, base = "HEAD", paths, command, run = defaultRun }) {
	const pre = preflight({ cwd, base, paths, command });
	if ("refused" in pre) return { ok: false, phase: "preflight", exit: pre.code, detail: pre.refused, mutated: false };
	const { root, files } = pre;
	const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
	const dir = join(journalRoot(root), id);
	// 2. Snapshot, before any write. A failure here has changed no working-tree file.
	const journal = { id, base: pre.base, state: "snapshotting", files: [] };
	try {
		mkdirSync(join(dir, "files"), { recursive: true });
		for (const [i, f] of files.entries()) {
			const abs = join(root, f.path);
			const entry = { path: f.path, existed: f.inTree, backup: `files/${i}` };
			if (f.inTree) {
				const bytes = readFileSync(abs);
				writeFileSync(join(dir, entry.backup), bytes);
				Object.assign(entry, { mode: statSync(abs).mode & 0o777, hash: sha(bytes) });
			}
			journal.files.push(entry);
		}
		journal.state = "snapshotted";
		writeJournal(dir, journal);
	} catch (e) {
		rmSync(dir, { recursive: true, force: true }); // only this run's own, just-created journal
		return { ok: false, phase: "snapshot", exit: EXIT.refused, detail: `could not snapshot: ${e.message}. Nothing was changed.`, mutated: false };
	}
	// 3. Apply the base versions. Each file's written hash is journalled as it is written.
	journal.state = "applying";
	writeJournal(dir, journal);
	for (const entry of journal.files) {
		const abs = join(root, entry.path);
		const blob = git(root, ["cat-file", "blob", `${pre.base}:${entry.path}`], { binary: true });
		if (blob.ok) {
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, blob.out);
			entry.applied = sha(blob.out);
		} else {
			rmSync(abs, { force: true });
			entry.applied = null; // the base has no such file
		}
		writeJournal(dir, journal);
	}
	journal.state = "applied";
	writeJournal(dir, journal);
	// 4. The test, with its real status.
	const testExit = run(command, root);
	journal.state = "restoring";
	writeJournal(dir, journal);
	// 5. Restore exactly what was journalled.
	const restored = restoreFromJournal(dir, root);
	return {
		...restored,
		phase: restored.ok ? "done" : "restore",
		testExit,
		exit: restored.ok ? testExit : EXIT.conflict,
		mutated: !restored.ok,
	};
}

/**
 * Put the journalled files back. Per file: already the original → nothing to do; still what the apply
 * wrote → restore; anything else → someone else changed it, so it is left alone and reported. The journal
 * is removed only when every file is back.
 */
export function restoreFromJournal(dir, root) {
	const journal = JSON.parse(readFileSync(join(dir, "journal.json"), "utf8"));
	const conflicts = [];
	const restored = [];
	for (const entry of journal.files) {
		const abs = join(root, entry.path);
		const now = existsSync(abs) ? sha(readFileSync(abs)) : null;
		const original = entry.existed ? entry.hash : null;
		if (now === original) continue;
		// `applied` absent: the run was interrupted before this file was written, so it must still be original.
		if (!("applied" in entry) || now !== entry.applied) {
			conflicts.push(entry.path);
			continue;
		}
		if (entry.existed) {
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, readFileSync(join(dir, entry.backup)));
			chmodSync(abs, entry.mode);
		} else rmSync(abs, { force: true });
		restored.push(entry.path);
	}
	if (conflicts.length) {
		return {
			ok: false,
			journal: dir,
			restored,
			conflicts,
			detail: `${conflicts.join(", ")} changed while the comparison ran and was left as it is; the original is still in ${relative(root, dir)}. Nothing else was touched.`,
		};
	}
	rmSync(dir, { recursive: true, force: true });
	return { ok: true, restored, conflicts: [], detail: "every file is back to its pre-run bytes" };
}

function defaultRun(command, root) {
	// The test owns the terminal; an interrupt reaches it and its exit is still followed by the restore.
	const onSigint = () => undefined;
	process.on("SIGINT", onSigint);
	try {
		const r = spawnSync(command[0], command.slice(1), { cwd: root, stdio: "inherit" });
		if (r.error) return 127;
		// A signal-killed test reports the conventional 128+n, never a success.
		return r.signal ? 128 + (constants.signals[r.signal] ?? 1) : (r.status ?? 1);
	} finally {
		process.off("SIGINT", onSigint);
	}
}
