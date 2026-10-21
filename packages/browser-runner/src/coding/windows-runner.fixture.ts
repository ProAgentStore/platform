/**
 * A fake Windows machine for the #1272 tests: a stateful ACL store that answers and obeys `icacls` the way the real tool does for
 * the calls the runner root makes, an in-memory file tree, and a recording `exec`. Nothing touches the real OS.
 */
import { win32 } from "node:path";
import type { MigrationDeps } from "./windows-runner-migration.js";

export const PROGRAM_DATA = "C:\\ProgramData";
export const PROFILE = "C:\\Users\\admin";
export const TOKEN = "AABBCCDDEEFF00112233445566778899";

const SID_NAMES: Record<string, string> = { "*S-1-5-18": "NT AUTHORITY\\SYSTEM", "*S-1-5-32-544": "BUILTIN\\Administrators", "*S-1-1-0": "Everyone", "*S-1-5-11": "NT AUTHORITY\\Authenticated Users", "*S-1-5-32-545": "BUILTIN\\Users" };

/** What a fresh folder under %ProgramData% inherits: Users can read, Authenticated Users can modify. */
export const INHERITED_ACL = ["BUILTIN\\Administrators:(I)(OI)(CI)(F)", "NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)", "BUILTIN\\Users:(I)(OI)(CI)(RX)", "NT AUTHORITY\\Authenticated Users:(I)(OI)(CI)(M)"];

export interface FakeMachine extends MigrationDeps {
	acls: Map<string, string[]>;
	files: Map<string, string>;
	dirs: Set<string>;
	calls: Array<{ file: string; args: string[]; cwd?: string }>;
	/** Make a command fail: first matching call rejects with this message. */
	failOn: (match: (file: string, args: string[]) => boolean, message: string) => void;
	services: Map<string, "running" | "stopped">;
	busyDirs: Set<string>;
	probeExit: { value: number | null };
	/** When true, icacls /grant is ignored (a grant that "did not take"). */
	ignoreGrants: { value: boolean };
	removed: string[];
	copied: Array<{ src: string; dest: string; exclude: readonly string[] }>;
}

export function fakeMachine(over: Partial<MigrationDeps> = {}): FakeMachine {
	const failures: Array<{ match: (file: string, args: string[]) => boolean; message: string }> = [];
	let clock = 1_000;
	const m: FakeMachine = {
		acls: new Map(),
		files: new Map(),
		dirs: new Set([PROGRAM_DATA, PROFILE]),
		calls: [],
		failOn: (match, message) => failures.push({ match, message }),
		services: new Map(),
		busyDirs: new Set(),
		probeExit: { value: 0 },
		ignoreGrants: { value: false },
		removed: [],
		copied: [],
		platform: "win32",
		programData: PROGRAM_DATA,
		userProfile: PROFILE,
		home: PROFILE,
		exists: (p) => m.dirs.has(p) || m.files.has(p),
		mkdir: (p) => {
			m.dirs.add(p);
			// A new folder inherits from its parent until icacls says otherwise.
			if (!m.acls.has(p)) m.acls.set(p, [...INHERITED_ACL]);
		},
		writeText: (p, c) => void m.files.set(p, c),
		removeFile: (p) => void m.files.delete(p),
		readText: (p) => m.files.get(p) ?? null,
		listDirs: (p) => [...m.dirs].filter((d) => win32.dirname(d) === p).map((d) => win32.basename(d)),
		copyTree: async (src, dest, exclude) => {
			m.copied.push({ src, dest, exclude });
			m.dirs.add(dest);
			for (const [f, c] of [...m.files]) {
				if (f.startsWith(`${src}\\`) && !exclude.includes(win32.basename(f))) m.files.set(win32.join(dest, f.slice(src.length + 1)), c);
			}
		},
		removeTree: async (p) => {
			m.removed.push(p);
			for (const d of [...m.dirs]) if (d === p || d.startsWith(`${p}\\`)) m.dirs.delete(d);
			for (const f of [...m.files.keys()]) if (f.startsWith(`${p}\\`)) m.files.delete(f);
		},
		busy: async (dir) => m.busyDirs.has(dir),
		now: () => (clock += 1_000),
		sleep: async () => undefined,
		exec: async (file, args, cwd) => {
			m.calls.push({ file, args, cwd });
			const fail = failures.find((f) => f.match(file, args));
			if (fail) {
				failures.splice(failures.indexOf(fail), 1);
				throw new Error(fail.message);
			}
			if (file === "icacls") return icacls(m, args);
			if (file === "sc.exe") {
				const [verb, name] = args;
				if (verb === "stop") m.services.set(name, "stopped");
				if (verb === "start") m.services.set(name, "running");
				if (verb === "delete") m.services.delete(name);
				return { stdout: "", stderr: "" };
			}
			if (file.endsWith("config.cmd") && args[0] !== "remove") {
				const dest = win32.dirname(file);
				m.files.set(win32.join(dest, ".runner"), JSON.stringify({ agentName: args[args.indexOf("--name") + 1], gitHubUrl: args[args.indexOf("--url") + 1] }));
				const service = `actions.runner.proappstore-online.${args[args.indexOf("--name") + 1]}`;
				m.files.set(win32.join(dest, ".service"), service);
				m.services.set(service, "running");
			}
			return { stdout: "", stderr: "" };
		},
		probeAs: async () => m.probeExit.value,
		...over,
	};
	return m;
}

function icacls(m: FakeMachine, args: string[]): { stdout: string; stderr: string } {
	const path = args[0];
	if (args.length === 1) {
		const aces = m.acls.get(path) ?? [];
		return { stdout: `${aces.map((a, i) => (i === 0 ? `${path} ${a}` : `${" ".repeat(path.length + 1)}${a}`)).join("\n")}\n\nSuccessfully processed 1 files; Failed processing 0 files\n`, stderr: "" };
	}
	let aces = [...(m.acls.get(path) ?? [])];
	if (args.includes("/inheritance:r")) aces = aces.filter((a) => !a.includes("(I)"));
	const grantAt = args.indexOf("/grant:r");
	if (grantAt >= 0 && !m.ignoreGrants.value) {
		for (const g of args.slice(grantAt + 1).filter((a) => !a.startsWith("/"))) {
			const idx = g.lastIndexOf(":");
			const who = g.slice(0, idx);
			const rest = g.slice(idx + 1);
			const principal = SID_NAMES[who] ?? who;
			// `(OI)(CI)F` / `(OI)(CI)M`: inheritance flags in parentheses, then the simple right bare (or parenthesised, e.g. `(RX)`).
			const flags = [...rest.matchAll(/\(([A-Z,]+)\)/g)].map((x) => x[1]);
			const bare = /\)([A-Z]+)$/.exec(rest)?.[1];
			const right = bare ? [bare] : flags.filter((f) => !["OI", "CI", "IO", "NP"].includes(f));
			const inherit = flags.filter((f) => ["OI", "CI"].includes(f));
			aces = aces.filter((a) => !a.startsWith(`${principal}:`));
			aces.push(`${principal}:${inherit.map((f) => `(${f})`).join("")}(${right.join(",")})`);
		}
	}
	const removeAt = args.indexOf("/remove:g");
	if (removeAt >= 0) {
		for (const sid of args.slice(removeAt + 1).filter((a) => a.startsWith("*"))) aces = aces.filter((a) => !a.startsWith(`${SID_NAMES[sid]}:`));
	}
	m.acls.set(path, aces);
	return { stdout: "Successfully processed 1 files; Failed processing 0 files\n", stderr: "" };
}

/** A legacy profile-scoped install on the fake machine, with its service registered and running. */
export function addLegacyInstall(m: FakeMachine, folder = "proappstore-online", name = "pink-laptop"): { dir: string; service: string } {
	const dir = win32.join(PROFILE, ".proagentstore", "actions-runner", folder);
	const service = `actions.runner.${folder}.${name}`;
	m.dirs.add(win32.dirname(win32.dirname(dir)));
	m.dirs.add(win32.dirname(dir));
	m.dirs.add(dir);
	m.files.set(win32.join(dir, ".runner"), JSON.stringify({ agentName: name, gitHubUrl: `https://github.com/${folder}` }));
	m.files.set(win32.join(dir, ".service"), service);
	m.files.set(win32.join(dir, ".credentials"), "OLD-CREDENTIAL");
	m.files.set(win32.join(dir, "config.cmd"), "@echo config");
	m.files.set(win32.join(dir, "run.cmd"), "@echo run");
	m.services.set(service, "running");
	return { dir, service };
}
