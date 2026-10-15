/**
 * The STAGED content of tracked files (#1103) — what a commit will contain, which is what the
 * pre-commit hook must judge rather than the working tree. One `git cat-file --batch` for every
 * file, not a process per file. A path with no staged blob (intent-to-add) is left out.
 */
import { execFileSync } from "node:child_process";

/** @param {string[]} files @param {{ cwd?: string }} [opts] @returns {Map<string, string>} */
export function stagedContents(files, opts = {}) {
	const out = execFileSync("git", ["cat-file", "--batch"], { cwd: opts.cwd, input: files.map((f) => `:${f}\n`).join(""), maxBuffer: 1 << 30 });
	const contents = new Map();
	let at = 0;
	for (const file of files) {
		const nl = out.indexOf(10, at);
		const header = out.toString("utf-8", at, nl);
		at = nl + 1;
		if (header.endsWith(" missing")) continue;
		const size = Number(header.split(" ")[2]);
		contents.set(file, out.toString("utf-8", at, at + size));
		at += size + 1;
	}
	return contents;
}
