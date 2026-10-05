import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { RunnerInputError } from "../errors.js";

/**
 * The runner's half of the machine-to-machine secret handoff (#918): read a secret file so the
 * cloud can encrypt it, and write one back from the cloud's decrypted copy.
 *
 * The value crosses the relay between the API worker and this process and goes nowhere else. Both
 * functions are built so it cannot leak by accident:
 *
 *   • no shell, no tmux, no subprocess — a pane or a process table is exactly where a secret is
 *     visible to everything that later reads the machine (`tmux_capture_pane`, `ps`);
 *   • every error names the PATH and never the bytes, because a runner error becomes the cloud's
 *     error string, and that string reaches the model;
 *   • `readSecretFile` returns the value to its caller (the relay) and `writeSecretFile` returns
 *     only a byte count.
 */

/** Big enough for any `.env`, key file or credentials JSON; small enough that this is not a file-transfer tool. */
export const SECRET_MAX_BYTES = 64 * 1024;

/** `~` expanded; a relative path resolves against the home directory, which is where `pags up` users name things from. */
function resolvePath(raw: unknown): string {
	const p = String(raw ?? "").trim();
	if (!p) throw new RunnerInputError("A `path` is required.");
	const expanded = p.replace(/^~(?=$|\/)/, homedir());
	return isAbsolute(expanded) ? resolve(expanded) : resolve(homedir(), expanded);
}

export function readSecretFile(input: { path?: unknown }): { path: string; value: string; bytes: number } {
	const path = resolvePath(input.path);
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(path);
	} catch {
		throw new RunnerInputError(`No file at ${path}.`);
	}
	if (!st.isFile()) throw new RunnerInputError(`${path} is not a regular file.`);
	if (st.size === 0) throw new RunnerInputError(`${path} is empty — there is nothing to hand off.`);
	if (st.size > SECRET_MAX_BYTES) throw new RunnerInputError(`${path} is ${st.size} bytes; the secret handoff carries at most ${SECRET_MAX_BYTES}.`);
	const buf = readFileSync(path);
	const value = buf.toString("utf8");
	// The store holds text. A file that does not survive a UTF-8 round trip would arrive changed,
	// which for a key file is worse than refusing.
	if (!Buffer.from(value, "utf8").equals(buf)) throw new RunnerInputError(`${path} is not UTF-8 text; the secret handoff carries text files only.`);
	return { path, value, bytes: buf.length };
}

/** `"600"` / `"0600"` / `"640"` → a file mode, owner-readable at least, never group/world-writable or executable. */
function parseMode(raw: unknown): number {
	if (raw == null || raw === "") return 0o600;
	const s = String(raw).trim();
	if (!/^0?[0-7]{3}$/.test(s)) throw new RunnerInputError(`mode must be octal like "600", got "${s}".`);
	const mode = Number.parseInt(s, 8);
	if ((mode & 0o400) === 0) throw new RunnerInputError(`mode ${s} would make the file unreadable by its owner.`);
	if ((mode & 0o022) !== 0 || (mode & 0o111) !== 0) throw new RunnerInputError(`mode ${s} is group/world-writable or executable; a secret file must not be.`);
	return mode;
}

export function writeSecretFile(input: { path?: unknown; value?: unknown; mode?: unknown; overwrite?: unknown }): { path: string; bytes: number; replaced: boolean } {
	const path = resolvePath(input.path);
	if (typeof input.value !== "string" || !input.value) throw new RunnerInputError("Nothing to write.");
	const mode = parseMode(input.mode);
	let replaced = false;
	try {
		const st = lstatSync(path);
		if (!st.isFile()) throw new RunnerInputError(`${path} exists and is not a regular file.`);
		if (input.overwrite !== true) throw new RunnerInputError(`${path} already exists. Pass overwrite: true to replace it.`);
		replaced = true;
	} catch (e) {
		if (e instanceof RunnerInputError) throw e;
		// Not there yet: the normal case.
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// Written beside the target and renamed over it, so a reader never sees half a secret, and
	// created with the final mode so it is never briefly world-readable.
	const tmp = join(dirname(path), `.${basename(path)}.pags-${process.pid}-${Date.now()}.tmp`);
	const data = Buffer.from(input.value, "utf8");
	const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
	try {
		writeSync(fd, data);
		fsyncSync(fd);
	} catch (e) {
		closeSync(fd);
		rmSync(tmp, { force: true });
		throw new Error(`Could not write ${path}: ${(e as NodeJS.ErrnoException).code ?? "write failed"}.`);
	}
	closeSync(fd);
	renameSync(tmp, path);
	return { path, bytes: data.length, replaced };
}
