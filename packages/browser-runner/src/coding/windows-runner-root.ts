/**
 * The machine-scoped root of a Windows Actions runner, its ACLs, and the proof they hold (#1272, epic #1113).
 *
 * ── The decision
 *
 * A service-managed Windows runner lives under `%ProgramData%\ProAgentStore\actions-runner\<scope>`, never under
 * `C:\Users\<user>`. The first design put it in the owner's profile, and the service (`NETWORK SERVICE`) then failed to start:
 * the runner checks that it can read EVERY directory above its own. The tempting repair — grant the service traverse rights
 * through the profile (#1271) — works and is wrong: it makes an account shared by many Windows services able to look into an
 * administrator's profile, for the benefit of a process that executes repository-controlled workflow code. So the profile is
 * never touched, and a path under one is refused outright ({@link assertMachineRoot}).
 *
 * ── The ACL (what {@link aclPlan} applies and {@link verifyAcl} demands)
 *
 *   • inheritance from `%ProgramData%` is REMOVED — nothing writable by `Users` or `Authenticated Users` leaks in;
 *   • SYSTEM and Administrators: full control, so recovery and uninstall never need an ownership dance;
 *   • the service identity: Modify on the runner root tree. The runner self-updates by creating sibling `bin.<version>` and
 *     `externals.<version>` folders IN the root, so a read-only root would break the first update; the root is dedicated to this
 *     one runner, so Modify across it is the boundary, not a leak;
 *   • nobody else. Any other principal on the root — Users, Everyone, the interactive owner — is a verification failure.
 *
 * Nothing here grants anything on a profile, a desktop, an SSH folder or a development checkout; the service is given no
 * reason to need them.
 *
 * ── Why verification is two checks
 *
 * {@link verifyAcl} reads the ACL back (`icacls`) and compares it to the policy: that catches a grant that did not take and one
 * that leaked. It cannot prove what the SERVICE can actually do, so {@link ensureWindowsRunnerRoot} also runs a probe AS the
 * service identity ({@link probeScript}, executed through a one-shot Scheduled Task by {@link scheduledTaskProbe}) that lists
 * the root, writes and deletes a file in `_work`, and confirms the owner's profile is NOT readable. Success is reported only if
 * both hold.
 *
 * Every system effect goes through the injected `exec`/`fs` so this is testable on any OS; it refuses to run off Windows.
 */
import { win32 } from "node:path";

/** The built-in account the runner's `--runasservice` uses. Shared by services, so it gets this one root and nothing else. */
export const NETWORK_SERVICE = "NT AUTHORITY\\NETWORK SERVICE";

/** Well-known SIDs, used in GRANTS so a localised Windows (where the names differ) still resolves them. */
const SID = { system: "*S-1-5-18", administrators: "*S-1-5-32-544" } as const;

/** The subfolders the runner writes to. Created up front so the ACL is set before the first job, not discovered during it. */
export const RUNNER_SUBDIRS = ["_work", "_diag", "_temp", "_cache", "_logs"] as const;

export interface RunnerRootLayout {
	root: string;
	work: string;
	subdirs: string[];
}

/** `%ProgramData%\ProAgentStore\actions-runner\<folder>` — `folder` is the scope slug from `runnerDir` (`org` or `owner--repo`). */
export function machineRoot(programData: string, folder: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(folder)) throw new Error(`Not a runner folder name: ${folder}`);
	return win32.join(programData, "ProAgentStore", "actions-runner", folder);
}

export function layoutFor(root: string): RunnerRootLayout {
	const subdirs = RUNNER_SUBDIRS.map((d) => win32.join(root, d));
	return { root, work: win32.join(root, "_work"), subdirs };
}

const norm = (p: string) => win32.normalize(p).replace(/[\\/]+$/, "").toLowerCase();

/** Is `path` the directory `dir` or inside it? Case-insensitive, separator-insensitive, `..`-resolved. */
export function isWithin(path: string, dir: string): boolean {
	const p = norm(path);
	const d = norm(dir);
	return p === d || p.startsWith(`${d}\\`);
}

/** User-profile roots on this machine: `%USERPROFILE%`, its parent (`C:\Users`), and any other profile folder named. */
export function profileRoots(input: { userProfile: string; usersDir?: string; extra?: string[] }): string[] {
	const usersDir = input.usersDir ?? win32.dirname(input.userProfile);
	return [...new Set([usersDir, input.userProfile, ...(input.extra ?? [])].filter(Boolean))];
}

/** The prohibition, as code: a service-managed runner is never inside a user profile (or the `C:\Users` tree). */
export function assertMachineRoot(root: string, profiles: readonly string[]): void {
	const hit = profiles.find((p) => isWithin(root, p));
	if (hit) {
		throw new Error(`Refusing to put a service-managed runner at ${root}: it is inside the user profile area ${hit}. Runners live under ProgramData; the service account must never need access to a user's profile.`);
	}
	if (!norm(root).includes("\\proagentstore\\actions-runner\\")) {
		throw new Error(`${root} is not a ProAgentStore machine runner root (…\\ProAgentStore\\actions-runner\\<scope>).`);
	}
}

// ── The service identity ─────────────────────────────────────────────────────────────────────────

const PRIVILEGED = /^(?:nt authority\\system|localsystem|system|builtin\\administrators|administrators?|.*\\administrators?|everyone|users|builtin\\users|authenticated users|nt authority\\authenticated users|creator owner)$/i;

/**
 * A service identity must be least-privilege: the built-in NETWORK SERVICE / LOCAL SERVICE, or a named local/domain account
 * that is not SYSTEM, an Administrator or a broad group. Whether a named account is in the Administrators GROUP cannot be read
 * from its name; the effective-access probe and the owner's account choice carry that, and the docs say so.
 */
export function validateServiceIdentity(identity: string): string {
	const id = identity.trim();
	if (!/^[A-Za-z0-9 ._$-]{1,64}(?:\\[A-Za-z0-9 ._$-]{1,64})?$/.test(id)) throw new Error(`Not a Windows account name: ${JSON.stringify(identity)}`);
	if (PRIVILEGED.test(id)) throw new Error(`${id} is not a least-privilege service identity. Use NT AUTHORITY\\NETWORK SERVICE or a dedicated non-administrator account.`);
	return id;
}

// ── ACL plan ─────────────────────────────────────────────────────────────────────────────────────

export interface IcaclsCall {
	file: "icacls";
	args: string[];
	purpose: string;
}

/** The exact `icacls` calls that give `identity` the root and nothing else. Pure; {@link ensureWindowsRunnerRoot} runs them. */
export function aclPlan(layout: RunnerRootLayout, identity: string): IcaclsCall[] {
	const id = validateServiceIdentity(identity);
	return [
		{
			file: "icacls",
			purpose: "remove inherited ACEs and grant exactly SYSTEM, Administrators and the service identity",
			// /inheritance:r drops everything inherited from %ProgramData%; /grant:r REPLACES any existing ACE for the principal.
			args: [layout.root, "/inheritance:r", "/grant:r", `${SID.system}:(OI)(CI)F`, `${SID.administrators}:(OI)(CI)F`, `${id}:(OI)(CI)M`],
		},
		{
			// Belt and braces for a root that already existed with a stray ACE: take away the broad groups by SID.
			file: "icacls",
			purpose: "remove broad groups that an older or hand-made folder may carry",
			args: [layout.root, "/remove:g", "*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545", "/T", "/C", "/Q"],
		},
	];
}

// ── Reading the ACL back ─────────────────────────────────────────────────────────────────────────

export interface Ace {
	principal: string;
	/** `OI`, `CI`, `IO`, `NP`, `I` (inherited), `DENY`. */
	flags: string[];
	/** `F`, `M`, `RX`, `R`, `W`, `D`, … */
	rights: string[];
}

const INHERIT_FLAGS = new Set(["OI", "CI", "IO", "NP", "I", "DENY"]);

/** Parse `icacls <dir>` output (English principal names) into ACEs. Anything that is not an ACE line is ignored. */
export function parseIcacls(output: string, path: string): Ace[] {
	const aces: Ace[] = [];
	for (const raw of output.split(/\r?\n/)) {
		let line = raw.trim();
		if (!line || /^Successfully processed|^Failed processing/i.test(line)) continue;
		if (line.toLowerCase().startsWith(path.toLowerCase())) line = line.slice(path.length).trim();
		// `<principal>:(flag)(flag)(right,right)` — the principal may contain spaces and a backslash.
		const m = /^(.+?):((?:\([^)]*\))+)\s*$/.exec(line);
		if (!m) continue;
		const groups = [...m[2].matchAll(/\(([^)]*)\)/g)].map((g) => g[1].toUpperCase());
		const flags = groups.filter((g) => INHERIT_FLAGS.has(g));
		const rights = groups.filter((g) => !INHERIT_FLAGS.has(g)).flatMap((g) => g.split(","));
		aces.push({ principal: m[1].trim(), flags, rights });
	}
	return aces;
}

const sameAccount = (a: string, b: string) => a.toLowerCase().replace(/^\.\\/, "") === b.toLowerCase().replace(/^\.\\/, "") || a.toLowerCase().split("\\").pop() === b.toLowerCase().split("\\").pop();
const isSystem = (p: string) => /^nt authority\\system$/i.test(p) || /^system$/i.test(p);
const isAdmins = (p: string) => /^builtin\\administrators$/i.test(p) || /^administrators$/i.test(p);
const FULL = new Set(["F"]);
const MODIFY_OR_FULL = new Set(["F", "M"]);

export interface AclViolation {
	code: "inherited" | "missing_system" | "missing_administrators" | "missing_identity" | "identity_too_weak" | "unexpected_principal" | "deny_ace" | "unreadable";
	message: string;
}

/** Compare a root's ACL to the policy. Empty array = it holds. */
export function verifyAcl(aces: readonly Ace[], identity: string): AclViolation[] {
	const out: AclViolation[] = [];
	if (aces.length === 0) return [{ code: "unreadable", message: "icacls returned no ACL entries for the runner root." }];
	if (aces.some((a) => a.flags.includes("I"))) out.push({ code: "inherited", message: "The runner root still inherits permissions from its parent; they must be removed (icacls /inheritance:r)." });
	for (const a of aces) if (a.flags.includes("DENY")) out.push({ code: "deny_ace", message: `${a.principal} has a DENY entry on the runner root; the policy is grants only.` });
	const has = (pred: (p: string) => boolean, rights: Set<string>) => aces.some((a) => !a.flags.includes("DENY") && pred(a.principal) && a.rights.some((r) => rights.has(r)));
	if (!has(isSystem, FULL)) out.push({ code: "missing_system", message: "SYSTEM does not have full control of the runner root." });
	if (!has(isAdmins, FULL)) out.push({ code: "missing_administrators", message: "Administrators do not have full control of the runner root." });
	const mine = aces.filter((a) => !a.flags.includes("DENY") && sameAccount(a.principal, identity));
	if (mine.length === 0) out.push({ code: "missing_identity", message: `${identity} has no access to the runner root, so the service cannot start.` });
	else if (!mine.some((a) => a.rights.some((r) => MODIFY_OR_FULL.has(r)))) out.push({ code: "identity_too_weak", message: `${identity} cannot modify the runner root (it needs Modify for work, logs and self-update).` });
	for (const a of aces) {
		if (isSystem(a.principal) || isAdmins(a.principal) || sameAccount(a.principal, identity)) continue;
		out.push({ code: "unexpected_principal", message: `${a.principal} has access to the runner root (${a.rights.join(",") || "?"}); only SYSTEM, Administrators and ${identity} may.` });
	}
	return out;
}

// ── Effective access, as the service identity ────────────────────────────────────────────────────

/**
 * The batch script a one-shot task runs AS the service identity (a file, because a Scheduled Task's command line is capped at 261
 * characters and a root path plus quoting would not fit). Exits 0 only if the identity can list the root, create and delete a file
 * in `_work`, and CANNOT list the owner's profile. Exit 2 = cannot use its own root; exit 3 = it can see the profile.
 */
export function probeScript(layout: RunnerRootLayout, profileDir: string): string {
	const marker = win32.join(layout.work, ".acl-probe");
	return [
		"@echo off",
		`dir "${layout.root}" >nul 2>&1 || exit /b 2`,
		`echo x>"${marker}" 2>nul || exit /b 2`,
		`del /q "${marker}" >nul 2>&1 || exit /b 2`,
		`dir "${profileDir}" >nul 2>&1 && exit /b 3`,
		"exit /b 0",
		"",
	].join("\r\n");
}

export const PROBE_SCRIPT_NAME = ".acl-probe.cmd";

export interface ProbeResult {
	ok: boolean;
	detail: string;
}

export const PROBE_TASK = "PAGS-AclProbe";

/** Interpret the exit code the probe task reported. */
export function interpretProbeExit(code: number | null): ProbeResult {
	if (code === 0) return { ok: true, detail: "The service identity can use the runner root and cannot read the user profile." };
	if (code === 2) return { ok: false, detail: "The service identity cannot list the runner root or write to its _work folder." };
	if (code === 3) return { ok: false, detail: "The service identity CAN read the user profile, which the runner must never be able to do." };
	return { ok: false, detail: `The access probe did not complete (result ${code ?? "unknown"}).` };
}

/** Pull the task's "Last Result" out of `schtasks /query /v /fo csv`. */
export function parseLastResult(csv: string): number | null {
	const lines = csv.split(/\r?\n/).filter(Boolean);
	if (lines.length < 2) return null;
	const cells = (l: string) => [...l.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
	const head = cells(lines[0]);
	const idx = head.findIndex((h) => /^last result$/i.test(h));
	if (idx < 0) return null;
	const n = Number.parseInt(cells(lines[1])[idx] ?? "", 10);
	return Number.isFinite(n) ? n : null;
}

export interface WindowsRootDeps {
	platform: NodeJS.Platform;
	/** `%ProgramData%`. */
	programData: string;
	/** `%USERPROFILE%` of the interactive owner — what the service must NOT be able to read. */
	userProfile: string;
	exists: (path: string) => boolean;
	mkdir: (path: string) => void;
	/** Run a program (no shell); resolves with stdout, rejects with an Error whose message has no secrets. */
	exec: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
	writeText: (path: string, content: string) => void;
	removeFile: (path: string) => void;
	/** Run the script at `scriptPath` as `identity` and resolve with its exit code. Optional: without it only the static check runs. */
	probeAs?: (identity: string, scriptPath: string) => Promise<number | null>;
	sleep?: (ms: number) => Promise<void>;
}

/** A {@link WindowsRootDeps.probeAs} that uses a one-shot Scheduled Task as the (built-in) service account. Needs elevation. */
export function scheduledTaskProbe(exec: WindowsRootDeps["exec"], sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): NonNullable<WindowsRootDeps["probeAs"]> {
	return async (identity, scriptPath) => {
		const builtin = /^nt authority\\(network service|local service)$/i.test(identity);
		if (!builtin) throw new Error("The effective-access probe runs only as NETWORK SERVICE or LOCAL SERVICE; a named account needs its password, which this never asks for.");
		await exec("schtasks", ["/Create", "/F", "/TN", PROBE_TASK, "/SC", "ONCE", "/ST", "00:00", "/RU", identity, "/RL", "LIMITED", "/TR", `"${scriptPath}"`]);
		try {
			await exec("schtasks", ["/Run", "/TN", PROBE_TASK]);
			for (let i = 0; i < 30; i++) {
				await sleep(1000);
				const q = await exec("schtasks", ["/Query", "/TN", PROBE_TASK, "/V", "/FO", "CSV"]);
				if (!/Running/i.test(q.stdout)) return parseLastResult(q.stdout);
			}
			return null;
		} finally {
			await exec("schtasks", ["/Delete", "/F", "/TN", PROBE_TASK]).catch(() => undefined);
		}
	};
}

export interface EnsureResult {
	root: string;
	layout: RunnerRootLayout;
	/** False when the root already satisfied the policy and nothing was changed. */
	changed: boolean;
	identity: string;
	/** `effective` = proven as the service identity; `static` = the ACL was verified but no probe was available. */
	verified: "effective" | "static";
	steps: string[];
}

async function readAcl(deps: WindowsRootDeps, root: string): Promise<Ace[]> {
	const r = await deps.exec("icacls", [root]);
	return parseIcacls(r.stdout, root);
}

/**
 * Create the machine root, set its ACL, and prove it. Idempotent: a root that already satisfies the policy is verified and left
 * alone (`changed: false`), so `pags up`, a service restart and a self-update all converge on the same state. Throws, naming every
 * violation, if the ACL cannot be made to hold — the caller must not report the runner installed.
 */
export async function ensureWindowsRunnerRoot(deps: WindowsRootDeps, input: { folder: string; identity?: string }): Promise<EnsureResult> {
	if (deps.platform !== "win32") throw new Error("The Windows runner root is only set up on Windows.");
	const identity = validateServiceIdentity(input.identity ?? NETWORK_SERVICE);
	const root = machineRoot(deps.programData, input.folder);
	assertMachineRoot(root, profileRoots({ userProfile: deps.userProfile }));
	const layout = layoutFor(root);
	const steps: string[] = [];

	for (const dir of [root, ...layout.subdirs]) {
		if (!deps.exists(dir)) {
			deps.mkdir(dir);
			steps.push(`created ${dir}`);
		}
	}

	let changed = false;
	let violations = verifyAcl(await readAcl(deps, root).catch(() => []), identity);
	if (violations.length > 0) {
		for (const call of aclPlan(layout, identity)) {
			steps.push(`icacls ${call.purpose}`);
			await deps.exec(call.file, call.args);
		}
		changed = true;
		violations = verifyAcl(await readAcl(deps, root), identity);
	} else {
		steps.push("ACL already satisfies the policy");
	}
	if (violations.length > 0) {
		throw new Error(`The runner root ${root} does not have the required permissions after setting them: ${violations.map((v) => v.message).join(" ")}`);
	}

	let verified: EnsureResult["verified"] = "static";
	if (deps.probeAs) {
		const script = win32.join(root, PROBE_SCRIPT_NAME);
		deps.writeText(script, probeScript(layout, deps.userProfile));
		let exit: number | null;
		try {
			exit = await deps.probeAs(identity, script);
		} finally {
			deps.removeFile(script);
		}
		const result = interpretProbeExit(exit);
		if (!result.ok) throw new Error(`Effective-access check as ${identity} failed for ${root}: ${result.detail}`);
		verified = "effective";
		steps.push(result.detail);
	}
	return { root, layout, changed, identity, verified, steps };
}
