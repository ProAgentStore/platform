// `pags runner roots` — the folders THIS machine allows the runner's inspection routes to read (#1193).
//
// The runner refuses a `workDir` that is not a git repository (below the home folder) or a root registered here: the platform
// supplies the folder, and a compromised or mistaken registration must not be able to widen what the machine allows. So the
// list is written only here, at the machine, by the owner — nothing the cloud can ask for writes it.
//
//   pags runner roots                 list the registered roots
//   pags runner roots add <folder>    allow a folder (and everything inside it)
//   pags runner roots remove <folder> stop allowing it
//
// A folder inside a git working tree needs no entry. The runner re-checks every root when it uses it (never the home folder or
// above, never a credential directory, never a link into one), so this refuses only what can never work.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Command } from "commander";
import { writeError, writeLine } from "../../output.js";

export const ROOTS_FILE = "runner-roots.json";
export const rootsFile = (home = homedir()): string => join(home, ".config", "proagentstore", ROOTS_FILE);

export function readRootsFile(home = homedir()): string[] {
	try {
		const data = JSON.parse(readFileSync(rootsFile(home), "utf8")) as { v?: unknown; roots?: unknown };
		return data.v === 1 && Array.isArray(data.roots) ? data.roots.filter((r): r is string => typeof r === "string" && r.trim() !== "") : [];
	} catch {
		return [];
	}
}

function writeRootsFile(roots: string[], home: string): void {
	const dir = join(home, ".config", "proagentstore");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(rootsFile(home), `${JSON.stringify({ v: 1, roots }, null, 2)}\n`, { mode: 0o600 });
	try {
		chmodSync(rootsFile(home), 0o600);
	} catch {
		/* a filesystem without modes */
	}
}

const within = (child: string, parent: string) => {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Resolve what the owner typed to the folder that would be stored: absolute, through symlinks. Or the reason it cannot be a root. */
export function resolveRoot(input: string, home = homedir()): { ok: true; path: string } | { ok: false; reason: string } {
	const raw = input.trim().replace(/^~(?=$|[\\/])/, home);
	if (!raw) return { ok: false, reason: "Name a folder." };
	const abs = resolve(raw);
	let real: string;
	try {
		real = realpathSync(abs);
		if (!statSync(real).isDirectory()) return { ok: false, reason: `${abs} is not a folder.` };
	} catch {
		return { ok: false, reason: `${abs} does not exist.` };
	}
	const realHome = existsSync(home) ? realpathSync(home) : home;
	if (within(realHome, real)) return { ok: false, reason: `${real} is the home folder or a folder above it — register the project's own folder.` };
	return { ok: true, path: real };
}

export function addRoot(input: string, home = homedir()): { ok: true; path: string; added: boolean; roots: string[] } | { ok: false; reason: string } {
	const r = resolveRoot(input, home);
	if (!r.ok) return r;
	const roots = readRootsFile(home);
	if (roots.includes(r.path)) return { ok: true, path: r.path, added: false, roots };
	const next = [...roots, r.path];
	writeRootsFile(next, home);
	return { ok: true, path: r.path, added: true, roots: next };
}

export function removeRoot(input: string, home = homedir()): { removed: boolean; path: string; roots: string[] } {
	const roots = readRootsFile(home);
	const resolved = resolveRoot(input, home);
	// A folder that no longer exists can still be removed by the text it was stored under.
	const typed = resolve(input.trim().replace(/^~(?=$|[\\/])/, home));
	const gone = (() => {
		try {
			return join(realpathSync(dirname(typed)), basename(typed)); // the real parent plus the name it had
		} catch {
			return "";
		}
	})();
	const candidates = new Set([typed, gone, resolved.ok ? resolved.path : ""]);
	const next = roots.filter((r) => !candidates.has(r));
	if (next.length !== roots.length) writeRootsFile(next, home);
	return { removed: next.length !== roots.length, path: resolved.ok ? resolved.path : resolve(input), roots: next };
}

export function rootsCommand(): Command {
	const command = new Command("roots").description("The folders this machine allows the runner to read besides git repositories").action(() => {
		const roots = readRootsFile();
		if (!roots.length) {
			writeLine("No folders are registered. A folder inside a git repository needs no entry; allow another with: pags runner roots add <folder>");
			return;
		}
		for (const r of roots) writeLine(r);
	});
	command
		.command("add <folder>")
		.description("Allow a folder (and everything inside it) to be read through the runner")
		.action((folder: string) => {
			const r = addRoot(folder);
			if (!r.ok) {
				writeError(r.reason);
				process.exitCode = 1;
				return;
			}
			writeLine(r.added ? `Allowed ${r.path}.` : `${r.path} was already allowed.`);
		});
	command
		.command("remove <folder>")
		.description("Stop allowing a folder")
		.action((folder: string) => {
			const r = removeRoot(folder);
			writeLine(r.removed ? `No longer allowed: ${r.path}.` : `${r.path} was not registered.`);
		});
	return command;
}
