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
 *   1. Preflight, mutating nothing. Paths arrive as separate argv entries; each must be a regular file or
 *      absent in the working tree, and a regular file or absent at the base. Refused up front: symlinks
 *      (the target and every parent directory), git administrative metadata (any `.git` component, the git
 *      dir and common dir), paths inside a nested repository or worktree, traversal and canonical escapes,
 *      and one entry that is several space-joined paths (the observed failure). Any earlier journal is
 *      UNKNOWN state and stops everything.
 *   2. Ownership evidence first: the journal exists, bound to this repository's canonical root, git dir and
 *      common dir, before any backup or write. Every journal write is atomic and carries a digest.
 *   3. Snapshot each file's bytes, hash and mode (absent is a state too), and verify each backup.
 *   4. Apply: for each file, journal the INTENDED state (base bytes + base mode, or absent) before writing
 *      it, then write it atomically. A failure anywhere in setup rolls back exactly what was written.
 *   5. Run the test argv with no shell, and keep its real exit status.
 *   6. Restore. Before changing any file: the journal must verify, belong to this repository, and every
 *      backup must match its recorded hash. Per file, content, type and mode are one state: already the
 *      original → nothing to do; exactly the journalled intent → restore; anything else → someone else
 *      changed it, so it is left alone, reported, and the journal is kept.
 *
 * Restoration is correlated to THIS run's journal, never to a global stack, so stash ordering, other
 * stashes and other journals cannot be consumed. A journal is removed only once every file is verified
 * back; any failure keeps it as recovery evidence. `restoreFromJournal` finishes an interrupted run.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	writeSync,
} from "node:fs";
import { constants } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Exit codes. A test's own status passes through untouched; these sit above any test runner's. */
export const EXIT = { refused: 64, conflict: 70, unknownState: 75 };

const JOURNAL_DIR = "pags-fail-before";
const FORMAT = 2;
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
/** The permission bits this helper restores exactly. setuid, setgid and sticky files are refused, not masked. */
const SUPPORTED_MODE = 0o777;
/** A write that makes no progress this many times in a row is an error, not a loop. */
const MAX_ZERO_WRITES = 3;

/**
 * The two syscalls a test needs to observe synthetically (#1021): short writes, and a stat that reports
 * mode bits no unprivileged fixture can set. Production never replaces them.
 */
export const _io = { writeSync, lstatSync };

function git(cwd, args, opts = {}) {
	const r = spawnSync("git", args, { cwd, encoding: opts.binary ? "buffer" : "utf8", maxBuffer: 256 * 1024 * 1024 });
	return { ok: r.status === 0, status: r.status, out: r.stdout, err: String(r.stderr ?? "") };
}

/** The repository's identity: canonical worktree root, git dir and common dir. Null outside a repository. */
function repoIdentity(cwd) {
	const r = git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]);
	if (!r.ok) return null;
	const [top, gitDir, common] = r.out.trim().split("\n");
	const canon = (p) => realpathSync(isAbsolute(p) ? p : resolve(cwd, p));
	return { root: canon(top), gitDir: canon(gitDir), commonDir: canon(common) };
}
const sameRepo = (a, b) => !!a && !!b && a.root === b.root && a.gitDir === b.gitDir && a.commonDir === b.commonDir;
const within = (p, dir) => p === dir || p.startsWith(dir + sep);
const journalRoot = (ident) => join(ident.gitDir, JOURNAL_DIR);

/**
 * What is at the journal root, never following a link: absent, the plain directory this helper made, or
 * something else (a symlink, a file) — which is unknown state, and never written through.
 */
function journalRootState(ident) {
	const dir = journalRoot(ident);
	let st;
	try {
		st = _io.lstatSync(dir);
	} catch (e) {
		return e.code === "ENOENT" ? "absent" : "bad";
	}
	return st.isDirectory() && !st.isSymbolicLink() && realpathSync(dir) === dir ? "dir" : "bad";
}

/** Journals left by runs that did not finish — every entry, readable or not. Any of them is unknown state. */
export function pendingJournals(root) {
	const ident = repoIdentity(root);
	if (!ident) return [];
	const dir = journalRoot(ident);
	const state = journalRootState(ident);
	if (state === "absent") return [];
	if (state === "bad") return [dir]; // not a plain directory: unknown evidence, reported and left as it is
	return readdirSync(dir).map((d) => join(dir, d));
}

/** Create (or confirm) the plain journal root and this run's own directory, never through a link. */
function makeRunDir(ident, id) {
	const root = journalRoot(ident);
	try {
		mkdirSync(root, { mode: 0o700 });
	} catch (e) {
		if (e.code !== "EEXIST") throw e;
	}
	if (journalRootState(ident) !== "dir") throw Object.assign(new Error(`${root} is not a plain directory`), { unknownState: true });
	const dir = join(root, id);
	mkdirSync(dir, { mode: 0o700 }); // fails if it exists: the id is this run's alone
	mkdirSync(join(dir, "files"), { mode: 0o700 });
	return dir;
}

/**
 * Quote argv for a POSIX-family shell (`sh`, `bash`, `zsh`) so each element arrives as ONE word. Single
 * quotes are literal in all three; an embedded `'` is closed, escaped and reopened.
 */
export function quoteForShell(args, shell = "sh") {
	if (!["sh", "bash", "zsh"].includes(shell)) throw new Error(`unsupported shell: ${shell}`);
	return args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(" ");
}

/** What is at `abs` now, never following a link: absent, a regular file (hash + mode), a symlink, or other. */
function observe(abs) {
	let st;
	try {
		st = _io.lstatSync(abs);
	} catch (e) {
		if (e.code === "ENOENT") return { type: "absent" };
		throw e;
	}
	if (st.isSymbolicLink()) return { type: "symlink" };
	if (!st.isFile()) return { type: "other" };
	// Every mode bit, so a setuid/setgid/sticky file can be refused rather than silently stripped.
	return { type: "file", hash: sha(readFileSync(abs)), mode: st.mode & 0o7777 };
}
/** Content, type and mode are ONE state: a mode-only change is a change. */
const same = (a, b) => !!a && !!b && a.type === b.type && (a.type !== "file" || (a.hash === b.hash && a.mode === b.mode));

/**
 * Why `rel` may not be touched, or null. Applied at preflight and again before a restore writes, so a
 * journal cannot be pointed at metadata or through a link that appeared later.
 */
function pathRefusal(ident, rel) {
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "is outside the repository";
	const parts = rel.split(sep);
	if (parts.some((c) => c.toLowerCase() === ".git")) return "is git administrative metadata";
	let cur = ident.root;
	for (const part of parts.slice(0, -1)) {
		cur = join(cur, part);
		let st;
		try {
			st = lstatSync(cur);
		} catch (e) {
			if (e.code === "ENOENT") break; // the rest is created by the apply, under a checked parent
			throw e;
		}
		if (st.isSymbolicLink()) return `goes through a symlink (${relative(ident.root, cur)})`;
		if (!st.isDirectory()) return `has a parent that is not a directory (${relative(ident.root, cur)})`;
		if (existsSync(join(cur, ".git"))) return `is inside a nested repository or worktree (${relative(ident.root, cur)})`;
	}
	const abs = join(ident.root, rel);
	let probe = dirname(abs);
	while (!existsSync(probe)) probe = dirname(probe);
	const real = realpathSync(probe);
	if (!within(real, ident.root)) return "resolves outside the repository";
	if (within(real, ident.gitDir) || within(real, ident.commonDir)) return "is git administrative metadata";
	return null;
}

/** The base revision's entry for `rel`: `null` when the base has none, else its bytes' mode, or a refusal. */
function baseEntry(root, baseSha, rel) {
	const r = git(root, ["ls-tree", "-z", baseSha, "--", rel.split(sep).join("/")]);
	if (!r.ok) return { refused: `could not read ${rel} at the base` };
	const line = r.out.split("\0").find(Boolean);
	if (!line) return null;
	const [meta] = line.split("\t");
	const [mode, type] = meta.split(" ");
	if (type !== "blob") return { refused: `${rel} is a ${type === "commit" ? "submodule" : "directory"} at the base` };
	if (mode === "120000") return { refused: `${rel} is a symlink at the base` };
	return { mode: mode === "100755" ? 0o755 : 0o644 };
}

/** Mutates nothing. Returns `{ ident, base, files }` or `{ refused, code }`. */
export function preflight({ cwd, base = "HEAD", paths, command }) {
	const ident = repoIdentity(cwd);
	if (!ident) return { refused: `not a git repository: ${cwd}`, code: EXIT.refused };
	if (journalRootState(ident) === "bad") {
		return { refused: `${journalRoot(ident)} is not a plain directory (a symlink or a file is there); it is left as it is and nothing was changed.`, code: EXIT.unknownState };
	}
	const pending = pendingJournals(ident.root);
	if (pending.length) {
		return {
			refused: `an earlier fail-before run did not finish (${pending.join(", ")}); the working tree's state is unknown. Finish it with --restore <journal> first. Nothing was changed.`,
			code: EXIT.unknownState,
		};
	}
	if (!Array.isArray(command) || !command.length) return { refused: "no test command was given (everything after `--`). Nothing was changed.", code: EXIT.refused };
	if (!Array.isArray(paths) || !paths.length) return { refused: "no paths were given. Nothing was changed.", code: EXIT.refused };
	const rev = git(ident.root, ["rev-parse", "--verify", `${base}^{commit}`]);
	if (!rev.ok) return { refused: `base revision ${base} does not resolve to a commit. Nothing was changed.`, code: EXIT.refused };
	const baseSha = rev.out.trim();
	const files = [];
	const seen = new Set();
	for (const p of paths) {
		if (typeof p !== "string" || !p || p.includes("\0")) return { refused: `invalid path ${JSON.stringify(p)}. Nothing was changed.`, code: EXIT.refused };
		const rel = relative(ident.root, isAbsolute(p) ? p : resolve(ident.root, p));
		const why = pathRefusal(ident, rel);
		if (why) return { refused: `${p} ${why}. Nothing was changed.`, code: EXIT.refused };
		if (seen.has(rel)) return { refused: `${rel} was given twice. Nothing was changed.`, code: EXIT.refused };
		seen.add(rel);
		const now = observe(join(ident.root, rel));
		if (now.type === "file" && now.mode & ~SUPPORTED_MODE) {
			return { refused: `${rel} has mode ${now.mode.toString(8)}; only plain permission bits (0777) are restored exactly, so setuid/setgid/sticky files are not supported. Nothing was changed.`, code: EXIT.refused };
		}
		if (now.type === "symlink") return { refused: `${rel} is a symlink; only regular files are supported. Nothing was changed.`, code: EXIT.refused };
		if (now.type === "other") return { refused: `${rel} is not a regular file. Nothing was changed.`, code: EXIT.refused };
		const atBase = baseEntry(ident.root, baseSha, rel);
		if (atBase?.refused) return { refused: `${atBase.refused}; only regular files are supported. Nothing was changed.`, code: EXIT.refused };
		if (now.type === "absent" && !atBase) {
			// The observed failure: several paths in one argument, because a shell did not split a variable.
			const parts = rel.split(/\s+/).filter(Boolean);
			const joined = parts.length > 1 && parts.every((q) => existsSync(resolve(ident.root, q)) || git(ident.root, ["cat-file", "-e", `${baseSha}:${q}`]).ok);
			return {
				refused: joined
					? `"${p}" is ${parts.length} paths in ONE argument — a shell passed a space-separated variable unsplit. Pass each path as its own argument. Nothing was changed.`
					: `${rel} exists neither in the working tree nor at ${base}. Nothing was changed.`,
				code: EXIT.refused,
			};
		}
		files.push({ path: rel, now, atBase });
	}
	return { ident, base: baseSha, files };
}

/** Write `bytes` to `abs` atomically, never through a link: a sibling temp file, fsynced, then renamed over. */
function writeAtomic(abs, bytes, mode, tag, faults) {
	const tmp = join(dirname(abs), `.${basename(abs)}.${tag}.pags-fb-tmp`);
	rmOwnTemp(tmp);
	const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
	try {
		writeFully(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	// Nothing is renamed into place until it is exactly the bytes intended.
	if (sha(readFileSync(tmp)) !== sha(bytes)) throw new Error(`the write of ${abs} did not complete`);
	chmodSync(tmp, mode);
	faults?.("rename", abs);
	renameSync(tmp, abs);
}
/** Write every byte: `writeSync` may write fewer than asked, and repeated zero progress is an error. */
function writeFully(fd, data) {
	const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
	let off = 0;
	let stalls = 0;
	while (off < buf.length) {
		const n = _io.writeSync(fd, buf, off, buf.length - off);
		if (n > 0) {
			off += n;
			stalls = 0;
		} else if (++stalls >= MAX_ZERO_WRITES) throw new Error(`a write made no progress ${MAX_ZERO_WRITES} times (${off} of ${buf.length} bytes)`);
	}
	const size = fstatSync(fd).size;
	if (size !== buf.length) throw new Error(`a write ended at ${size} of ${buf.length} bytes`);
}
/** A temp file THIS journal named (its id is in the name) is ours to remove; anything else at the name is not. */
function rmOwnTemp(tmp) {
	const t = observe(tmp);
	if (t.type === "file") rmSync(tmp);
	else if (t.type !== "absent") throw new Error(`${tmp} exists and is not a regular file`);
}

/** Every journal write: atomic, digested, and fault-injectable for the tests. */
function saveJournal(dir, journal, faults) {
	const { digest: _old, ...body } = journal;
	const text = `${JSON.stringify({ ...body, digest: sha(JSON.stringify(body)) }, null, 2)}\n`;
	const tmp = join(dir, "journal.json.tmp");
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeFully(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	if (readFileSync(tmp, "utf8") !== text) throw new Error("the journal write did not complete");
	faults?.("journal", journal.state);
	renameSync(tmp, join(dir, "journal.json"));
}
function loadJournal(dir) {
	const parsed = JSON.parse(readFileSync(join(dir, "journal.json"), "utf8"));
	const { digest, ...body } = parsed;
	if (parsed.format !== FORMAT || digest !== sha(JSON.stringify(body))) throw new Error("journal digest or format does not verify");
	return body;
}

/**
 * The whole comparison. `run(command, root)` returns the test's exit status (injectable for tests); the
 * default runs the argv with no shell and inherits stdio. `faults(step, detail)` lets a test fail any
 * write deterministically. Returns a receipt; never throws on a refusal.
 */
export function failBefore({ cwd, base = "HEAD", paths, command, run = defaultRun, faults }) {
	let pre;
	try {
		pre = preflight({ cwd, base, paths, command });
	} catch (e) {
		// Preflight writes nothing, so an I/O error here (EACCES, ENOTDIR…) changed nothing — and says which.
		return { ok: false, phase: "preflight", exit: EXIT.refused, detail: `could not inspect the paths (${e.code ?? "error"}: ${e.message}). Nothing was changed.`, mutated: false };
	}
	if ("refused" in pre) return { ok: false, phase: "preflight", exit: pre.code, detail: pre.refused, mutated: false };
	const { ident, files } = pre;
	const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
	let dir;
	try {
		dir = makeRunDir(ident, id);
	} catch (e) {
		return { ok: false, phase: "snapshot", exit: e.unknownState ? EXIT.unknownState : EXIT.refused, detail: `could not create this run's journal (${e.message}). Nothing was changed.`, mutated: false };
	}
	const journal = {
		format: FORMAT,
		id,
		repo: ident,
		base: pre.base,
		state: "snapshotting",
		files: files.map((f, i) => ({ path: f.path, original: null, backup: `files/${i}`, createdDirs: [] })),
	};
	// 2–3. The journal exists before any backup; the snapshot writes nothing in the working tree.
	try {
		saveJournal(dir, journal, faults);
		for (const [i, entry] of journal.files.entries()) {
			const abs = join(ident.root, entry.path);
			const now = observe(abs);
			if (!same(now, files[i].now)) throw new Error(`${entry.path} changed during preflight`);
			if (now.type === "file") {
				const bytes = readFileSync(abs);
				if (sha(bytes) !== now.hash) throw new Error(`${entry.path} changed while it was read`);
				writeAtomic(join(dir, entry.backup), bytes, 0o600, id, faults);
				if (sha(readFileSync(join(dir, entry.backup))) !== now.hash) throw new Error(`the backup of ${entry.path} does not verify`);
			}
			entry.original = now;
			const blob = files[i].atBase ? git(ident.root, ["cat-file", "blob", `${pre.base}:${entry.path.split(sep).join("/")}`], { binary: true }) : null;
			if (blob && !blob.ok) throw new Error(`could not read ${entry.path} at the base`);
			entry.intent = blob ? { type: "file", hash: sha(blob.out), mode: files[i].atBase.mode } : { type: "absent" };
		}
		journal.state = "snapshotted";
		saveJournal(dir, journal, faults);
	} catch (e) {
		rmSync(dir, { recursive: true, force: true }); // only this run's own journal; no working-tree file was written
		return { ok: false, phase: "snapshot", exit: EXIT.refused, detail: `could not snapshot: ${e.message}. Nothing was changed.`, mutated: false };
	}
	// 4. Apply. The intent is durable BEFORE each write, so a write whose journal update fails is still ours.
	try {
		journal.state = "applying";
		saveJournal(dir, journal, faults);
		for (const entry of journal.files) {
			const abs = join(ident.root, entry.path);
			if (!same(observe(abs), entry.original)) throw new Error(`${entry.path} changed before it was written`);
			const missing = [];
			for (let d = dirname(abs); !existsSync(d); d = dirname(d)) missing.push(relative(ident.root, d));
			entry.createdDirs = missing;
			entry.applying = true;
			saveJournal(dir, journal, faults);
			faults?.("apply", entry.path);
			if (entry.intent.type === "file") {
				mkdirSync(dirname(abs), { recursive: true });
				const blob = git(ident.root, ["cat-file", "blob", `${pre.base}:${entry.path.split(sep).join("/")}`], { binary: true });
				if (!blob.ok || sha(blob.out) !== entry.intent.hash) throw new Error(`the base bytes of ${entry.path} changed`);
				writeAtomic(abs, blob.out, entry.intent.mode, id, faults);
			} else if (entry.original.type === "file") rmSync(abs);
			entry.applied = true;
			saveJournal(dir, journal, faults);
		}
		journal.state = "applied";
		saveJournal(dir, journal, faults);
	} catch (e) {
		// Partial setup: put back exactly what was written, from the journal as it stands on disk.
		let back;
		try {
			back = restoreFromJournal(dir, { root: ident.root, faults });
		} catch (r) {
			back = { ok: false, exit: EXIT.unknownState, journal: dir, restored: [], conflicts: [], detail: `the rollback was interrupted too (${r.message}); the journal is kept at ${dir}. Finish it with --restore.` };
		}
		return {
			...back,
			ok: false,
			phase: "apply",
			testExit: null,
			exit: back.ok ? EXIT.refused : back.exit,
			mutated: !back.ok,
			detail: `setup failed (${e.message}); ${back.ok ? "every file written so far was restored. Nothing was changed." : back.detail}`,
		};
	}
	// 5. The test, with its real status.
	const testExit = run(command, ident.root);
	let restored;
	try {
		journal.state = "restoring";
		saveJournal(dir, journal, faults);
		restored = restoreFromJournal(dir, { root: ident.root, faults });
	} catch (e) {
		restored = { ok: false, exit: EXIT.unknownState, journal: dir, restored: [], conflicts: [], detail: `the restore was interrupted (${e.message}); the journal is kept at ${dir}. Finish it with --restore.` };
	}
	return { ...restored, phase: restored.ok ? "done" : "restore", testExit, exit: restored.ok ? testExit : restored.exit, mutated: !restored.ok };
}

/**
 * Put the journalled files back. `opts.root` is the repository the caller is in (a string is accepted for
 * it); the journal must belong to that repository. Nothing is written until the journal verifies, belongs
 * here, and every backup matches its recorded hash. The journal is removed only when every file is back.
 */
export function restoreFromJournal(dir, opts = {}) {
	const callerRoot = typeof opts === "string" ? opts : opts.root;
	const faults = typeof opts === "string" ? undefined : opts.faults;
	const stop = (detail, extra = {}) => ({ ok: false, exit: EXIT.unknownState, journal: dir, restored: [], conflicts: [], detail: `${detail} Nothing was changed; the journal is kept.`, ...extra });
	let journal;
	try {
		journal = loadJournal(dir);
	} catch (e) {
		return stop(`The journal at ${dir} cannot be trusted (${e.message}).`);
	}
	// Bound to its repository: the recorded identity must still be that repository, the journal must live in
	// its git dir, and a caller in a different repository is refused.
	const ident = repoIdentity(journal.repo?.root ?? "/nonexistent");
	if (!sameRepo(ident, journal.repo)) return stop(`The journal was written for ${journal.repo?.root}, which is no longer that repository.`);
	let realDir;
	try {
		realDir = realpathSync(dir);
	} catch {
		return stop(`The journal directory ${dir} cannot be resolved.`);
	}
	if (realDir !== join(journalRoot(ident), journal.id)) return stop(`The journal is not where ${journal.repo.root} keeps its own journals.`);
	if (callerRoot !== undefined && !sameRepo(repoIdentity(callerRoot), ident)) {
		return stop(`The journal belongs to ${journal.repo.root}, not to ${callerRoot}.`);
	}
	// Every path and every backup is verified before ANY file changes.
	const backups = new Map();
	try {
		for (const entry of journal.files) {
			const why = pathRefusal(ident, entry.path);
			if (why) return stop(`The journalled path ${entry.path} ${why}.`);
			if (entry.original?.type === "file") {
				const b = join(dir, entry.backup);
				const bs = observe(b);
				if (bs.type !== "file" || bs.hash !== entry.original.hash) return stop(`The backup of ${entry.path} does not match its recorded hash.`);
				backups.set(entry.path, readFileSync(b));
			}
		}
	} catch (e) {
		// Verification writes nothing, so an unreadable backup or path stops here with nothing changed.
		return stop(`Could not verify the journal's paths and backups (${e.code ?? "error"}: ${e.message}).`);
	}
	const conflicts = [];
	const restored = [];
	let current = null;
	try {
		for (const entry of journal.files) {
			current = entry.path;
			const abs = join(ident.root, entry.path);
		rmOwnTemp(join(dirname(abs), `.${basename(abs)}.${journal.id}.pags-fb-tmp`));
		rmOwnTemp(join(dirname(abs), `.${basename(abs)}.${journal.id}-r.pags-fb-tmp`));
		const now = observe(abs);
		if (!entry.original) continue; // never snapshotted, so never written
		if (same(now, entry.original)) continue;
		// Ours only if it is exactly what this run journalled it would write — content, type and mode.
		if (!entry.applying || !same(now, entry.intent)) {
			conflicts.push(entry.path);
			continue;
		}
		if (entry.original.type === "file") {
			mkdirSync(dirname(abs), { recursive: true });
			writeAtomic(abs, backups.get(entry.path), entry.original.mode, `${journal.id}-r`, faults);
		} else rmSync(abs);
		faults?.("restore", entry.path);
		if (!same(observe(abs), entry.original)) {
			conflicts.push(entry.path);
			continue;
		}
			restored.push(entry.path);
		}
	} catch (e) {
		// An ordinary I/O error part-way: say exactly what was put back and where it stopped. The journal and
		// every backup are kept, so a later --restore finishes it; this is never "nothing changed".
		return {
			ok: false,
			exit: EXIT.unknownState,
			journal: dir,
			restored,
			conflicts,
			stoppedAt: current,
			detail: `the restore stopped at ${current} (${e.code ?? "error"}: ${e.message})${restored.length ? ` after putting back ${restored.join(", ")}` : " before putting any file back"}; the journal and its backups are kept at ${dir}. Fix the cause and finish it with --restore.`,
		};
	}
	if (conflicts.length) {
		return {
			ok: false,
			exit: EXIT.conflict,
			journal: dir,
			restored,
			conflicts,
			detail: `${conflicts.join(", ")} changed while the comparison ran (content, type or mode) and was left as it is; the original is still in ${dir}. Nothing else was touched.`,
		};
	}
	for (const entry of journal.files) {
		for (const d of entry.createdDirs ?? []) {
			try {
				rmdirSync(join(ident.root, d)); // only if still empty
			} catch {
				// not empty, or already gone: someone else's now, so it stays
			}
		}
	}
	rmSync(dir, { recursive: true, force: true });
	return { ok: true, exit: 0, restored, conflicts: [], detail: "every file is back to its pre-run bytes and mode" };
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
