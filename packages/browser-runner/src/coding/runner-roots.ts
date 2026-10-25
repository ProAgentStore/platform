/**
 * The folders the OWNER has allowed this machine's inspection routes to read (#1193).
 *
 * #1165 refused the home folder, the credential directories and symlinks into them — a deny-list. A registered or forged
 * `workDir` such as `~/Documents` was still readable, and any credential directory the list did not name (an app's own token
 * store) was not covered. This is the allow-list the runner can enforce itself: a short file on THIS machine,
 * `~/.config/proagentstore/runner-roots.json`, written only by the owner at the machine (`pags runner roots add <folder>`).
 *
 * It is deliberately not written by anything the cloud can ask for: the point is that a `workDir` the platform supplies — through a
 * compromise, a forged request or a bad registration — cannot widen what the machine allows. A folder inside a git working tree
 * needs no entry (see `workdir-guard.ts`); a root is for the folders that are not, or that sit outside the usual place.
 *
 * Format: `{ "v": 1, "roots": ["/Users/me/projects/notes", ...] }`. Absolute paths, resolved through symlinks when read.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ROOTS_FILE = "runner-roots.json";
const MAX_ROOTS = 200;

export const rootsPath = (home = homedir()): string => join(home, ".config", "proagentstore", ROOTS_FILE);

/** The roots on record; an absent, unreadable or malformed file is "none" — never a reason to allow more. */
export function readRoots(home = homedir()): string[] {
	const file = rootsPath(home);
	if (!existsSync(file)) return [];
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; roots?: unknown };
		if (data.v !== 1 || !Array.isArray(data.roots)) return [];
		const roots: string[] = [];
		for (const r of data.roots) {
			if (roots.length >= MAX_ROOTS) break; // a list this long is a mistake; the rest are not read
			if (typeof r === "string" && r.trim() !== "" && r.length <= 1024) roots.push(r);
		}
		return roots;
	} catch {
		return [];
	}
}
