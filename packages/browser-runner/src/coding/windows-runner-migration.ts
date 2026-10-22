/**
 * Moving a profile-scoped Windows runner to the machine root, without ever leaving the machine with no runner (#1272).
 *
 * The legacy layout is `%USERPROFILE%\.proagentstore\actions-runner\<scope>`. It cannot be repaired in place without granting a
 * shared service account access to a user profile, which is the thing this work exists to avoid — so it is MIGRATED:
 *
 *   drain → stop → prepare (machine root + ACL) → copy → re-register → [verify online + smoke job, by the platform] → removable
 *
 * The local half ({@link startMigration}) runs on the machine and ends in `awaiting_verification`. The verification half is the
 * platform's: only GitHub can say the runner is online, and only a platform-owned job can prove it completes work, and this machine
 * holds no GitHub credential. The platform reports the verdict to {@link completeMigration}. Until a passing verdict arrives the old
 * install is stopped but intact and {@link rollbackMigration} can put it back.
 *
 * ── Invariants (each one has a test)
 *
 *   • The legacy folder is NEVER modified or removed here. It is stopped, read (copied from), and — on rollback — started again.
 *     Even on success it is only recorded as `removable`; deleting it is a separate, explicit act by the owner.
 *   • The new runner registers under a STAGED name (`<name>-m`). `config --replace` under the old name would invalidate the old
 *     runner's credentials at GitHub, and rollback would then have nothing to roll back to.
 *   • The registration token is used once, as an argument, masked in every recorded step and absent from every error; the copy
 *     excludes the old runner's credential files, so no stale credential is carried across.
 *   • A rollback only removes what THIS migration created (`createdDest`), never a pre-existing folder.
 *   • Re-running converges: a record already at `awaiting_verification` or later is returned as is, with nothing re-run.
 *   • The only service account supported is a built-in one (NETWORK SERVICE / LOCAL SERVICE); a named account needs a password,
 *     which this never handles.
 */
import { win32 } from "node:path";
import { ensureWindowsRunnerRoot, isWithin, NETWORK_SERVICE, validateServiceIdentity, type WindowsRootDeps } from "./windows-runner-root.js";

export type MigrationStage = "drain" | "stop" | "prepare" | "copy" | "register" | "awaiting_verification" | "ready_for_removal" | "rolled_back";

export interface LegacyInstall {
	dir: string;
	/** The folder name under actions-runner (the scope slug). */
	folder: string;
	name: string | null;
	url: string | null;
	/** From the runner's own `.service` file; null if it cannot be read. */
	serviceName: string | null;
}

export interface MigrationRecord {
	legacyDir: string;
	destDir: string;
	stagedName: string;
	stage: MigrationStage;
	/** What was done, in order — commands with the token masked. */
	steps: string[];
	legacyService: string | null;
	/** The service the staged runner installed, once registered. */
	newService: string | null;
	legacyStopped: boolean;
	createdDest: boolean;
	registered: boolean;
	/** After a rollback: true if the old runner's service was started again and reported running. */
	legacyRestored?: boolean;
	/** After a rollback that had registered: the staged runner GitHub still lists and the platform should deregister. */
	orphanRegistration?: string;
	removable?: boolean;
	error?: string;
}

export interface MigrationDeps extends WindowsRootDeps {
	home: string;
	readText: (path: string) => string | null;
	listDirs: (path: string) => string[];
	copyTree: (src: string, dest: string, exclude: readonly string[]) => Promise<void>;
	removeTree: (path: string) => Promise<void>;
	/** Is a job running from this runner folder (a `Runner.Worker` process)? */
	busy: (dir: string) => Promise<boolean>;
	exec: (file: string, args: string[], cwd?: string) => Promise<{ stdout: string; stderr: string }>;
	now: () => number;
	drainTimeoutMs?: number;
}

export interface MigrationRequest {
	legacy: LegacyInstall;
	url: string;
	/** A FRESH registration token the platform minted for this migration. Never stored. */
	token: string;
	labels: string[];
	identity?: string;
}

/** Files that identify the OLD registration, and working data; none is copied to the new root. */
export const COPY_EXCLUDE = [".runner", ".credentials", ".credentials_rsaparams", ".service", "_work", "_diag", "_temp", "_cache", "_logs", ".pags-migration.json"] as const;
export const STAGED_SUFFIX = "-m";
export const MANIFEST = ".pags-migration.json";
export const RECEIPT_DIR = "actions-runner-migrations";

const mask = (args: string[], token: string) => args.map((a) => (a === token ? "***" : a));
const legacyBase = (home: string) => win32.join(home, ".proagentstore", "actions-runner");

/** Every profile-scoped runner on this machine (configured: it has a `.runner`). Pure reads. */
export function findLegacyInstalls(deps: Pick<MigrationDeps, "platform" | "home" | "exists" | "readText" | "listDirs">): LegacyInstall[] {
	if (deps.platform !== "win32") return [];
	const base = legacyBase(deps.home);
	if (!deps.exists(base)) return [];
	const out: LegacyInstall[] = [];
	for (const folder of deps.listDirs(base)) {
		const dir = win32.join(base, folder);
		const raw = deps.readText(win32.join(dir, ".runner"));
		if (raw === null) continue;
		let name: string | null = null;
		let url: string | null = null;
		try {
			const r = JSON.parse(raw.replace(/^﻿/, "")) as { agentName?: unknown; gitHubUrl?: unknown };
			name = typeof r.agentName === "string" ? r.agentName : null;
			url = typeof r.gitHubUrl === "string" ? r.gitHubUrl : null;
		} catch {
			/* configured, record unreadable: still a runner to migrate */
		}
		const service = deps.readText(win32.join(dir, ".service"))?.replace(/^﻿/, "").trim() || null;
		out.push({ dir, folder, name, url, serviceName: service && /^[A-Za-z0-9._() -]{1,256}$/.test(service) ? service : null });
	}
	return out;
}

const destFor = (deps: MigrationDeps, folder: string) => win32.join(deps.programData, "ProAgentStore", "actions-runner", folder);

export function readMigration(deps: Pick<MigrationDeps, "readText">, destDir: string): MigrationRecord | null {
	// The sibling receipt survives rollback removing a destination created by the migration. The
	// in-destination manifest remains for compatibility and for a person inspecting that runner.
	const receipt = win32.join(win32.dirname(win32.dirname(destDir)), RECEIPT_DIR, `${win32.basename(destDir)}.json`);
	const raw = deps.readText(receipt) ?? deps.readText(win32.join(destDir, MANIFEST));
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as MigrationRecord;
	} catch {
		return null;
	}
}

function save(deps: MigrationDeps, rec: MigrationRecord): void {
	const content = JSON.stringify(rec, null, 2);
	const receiptDir = win32.join(win32.dirname(win32.dirname(rec.destDir)), RECEIPT_DIR);
	deps.mkdir(receiptDir);
	deps.writeText(win32.join(receiptDir, `${win32.basename(rec.destDir)}.json`), content);
	if (deps.exists(rec.destDir)) deps.writeText(win32.join(rec.destDir, MANIFEST), content);
}

async function sc(deps: MigrationDeps, rec: MigrationRecord, verb: "stop" | "start" | "delete", service: string): Promise<void> {
	rec.steps.push(`sc ${verb} ${service}`);
	await deps.exec("sc.exe", [verb, service]);
}

/** `sc stop` on a service that is not running exits 1062; that is "already stopped", not a failure. */
const alreadyStopped = (e: unknown) => /1062|not been started|is not started/i.test(e instanceof Error ? e.message : String(e));

async function drain(deps: MigrationDeps, rec: MigrationRecord, dir: string): Promise<void> {
	const deadline = deps.now() + (deps.drainTimeoutMs ?? 10 * 60_000);
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	while (await deps.busy(dir)) {
		if (deps.now() >= deadline) throw new Error("A job is still running on the old runner, so it was not stopped and nothing was changed. Try again when it is idle.");
		rec.steps.push("waiting for the running job to finish");
		await sleep(15_000);
	}
	rec.steps.push("old runner is idle");
}

/**
 * The local half. Never throws: every outcome is on the returned record. On any failure it rolls back before returning, so a
 * `rolled_back` record means the old runner has been put back (see `legacyRestored`).
 */
export async function startMigration(req: MigrationRequest, deps: MigrationDeps): Promise<MigrationRecord> {
	const destDir = destFor(deps, req.legacy.folder);
	const existing = readMigration(deps, destDir);
	// Idempotent: a migration already past registration is reported, never repeated.
	if (existing && (existing.stage === "awaiting_verification" || existing.stage === "ready_for_removal")) return existing;

	const name = req.legacy.name ?? req.legacy.folder;
	const rec: MigrationRecord = {
		legacyDir: req.legacy.dir,
		destDir,
		stagedName: `${name}${STAGED_SUFFIX}`,
		stage: "drain",
		steps: [],
		legacyService: req.legacy.serviceName,
		newService: null,
		legacyStopped: false,
		createdDest: false,
		registered: false,
	};
	try {
		if (deps.platform !== "win32") throw new Error("Windows runner migration only runs on Windows.");
		if (isWithin(destDir, deps.home) || isWithin(destDir, req.legacy.dir)) throw new Error(`Refusing to migrate to ${destDir}: the destination must be outside the user profile.`);
		if (!deps.exists(win32.join(req.legacy.dir, ".runner"))) throw new Error(`${req.legacy.dir} has no configured runner to migrate.`);
		if (!/^[A-Za-z0-9._-]{1,64}$/.test(rec.stagedName)) throw new Error("The runner name cannot be used for the staged registration.");
		const identity = validateServiceIdentity(req.identity ?? NETWORK_SERVICE);
		if (!/^nt authority\\(network service|local service)$/i.test(identity)) throw new Error("Migration supports the built-in NETWORK SERVICE / LOCAL SERVICE accounts only; a named account needs a password this never handles.");

		save(deps, rec);
		await drain(deps, rec, req.legacy.dir);

		rec.stage = "stop";
		save(deps, rec);
		if (req.legacy.serviceName) {
			await sc(deps, rec, "stop", req.legacy.serviceName).catch((e) => {
				if (!alreadyStopped(e)) throw e;
				rec.steps.push("old service was not running");
			});
		}
		rec.legacyStopped = !!req.legacy.serviceName;
		save(deps, rec);

		rec.stage = "prepare";
		save(deps, rec);
		rec.createdDest = !deps.exists(destDir);
		const ensured = await ensureWindowsRunnerRoot(deps, { folder: req.legacy.folder, identity });
		rec.steps.push(...ensured.steps);
		save(deps, rec);

		rec.stage = "copy";
		rec.steps.push(`copy ${req.legacy.dir} → ${destDir} (without ${COPY_EXCLUDE.join(", ")})`);
		save(deps, rec);
		await deps.copyTree(req.legacy.dir, destDir, COPY_EXCLUDE);

		rec.stage = "register";
		const config = ["--unattended", "--url", req.url, "--token", req.token, "--name", rec.stagedName, "--labels", req.labels.join(","), "--work", "_work", "--replace", "--runasservice", "--windowslogonaccount", identity];
		rec.steps.push(`config.cmd ${mask(config, req.token).join(" ")}`);
		save(deps, rec);
		await deps.exec(win32.join(destDir, "config.cmd"), config, destDir);
		rec.registered = true;
		rec.newService = deps.readText(win32.join(destDir, ".service"))?.replace(/^﻿/, "").trim() || null;

		rec.stage = "awaiting_verification";
		save(deps, rec);
		return rec;
	} catch (e) {
		// The token must not survive in an error: a failing `config.cmd` can echo its command line.
		rec.error = scrub(e instanceof Error ? e.message : String(e), req.token);
		return rollbackMigration(rec, deps, req.token);
	}
}

const scrub = (text: string, token: string) => (token ? text.split(token).join("***") : text);

/**
 * The platform's verdict. Both online and smoke must pass; then the old install is marked `removable` — and only marked. Either
 * failing rolls back.
 */
export async function completeMigration(rec: MigrationRecord, verdict: { online: boolean; smoke: { ok: boolean; detail?: string } }, deps: MigrationDeps): Promise<MigrationRecord> {
	if (rec.stage === "ready_for_removal") return rec;
	if (rec.stage !== "awaiting_verification") {
		rec.error = `Cannot complete a migration at stage ${rec.stage}.`;
		return rec;
	}
	if (!verdict.online) {
		rec.error = "GitHub does not show the migrated runner online.";
		return rollbackMigration(rec, deps);
	}
	if (!verdict.smoke.ok) {
		rec.error = `The migrated runner did not complete the platform smoke job${verdict.smoke.detail ? `: ${verdict.smoke.detail}` : "."}`;
		return rollbackMigration(rec, deps);
	}
	rec.stage = "ready_for_removal";
	rec.removable = true;
	rec.steps.push(`verified online and smoke job passed; ${rec.legacyDir} is now removable (it is not removed)`);
	save(deps, rec);
	return rec;
}

/**
 * Put the machine back as it was: remove what this migration installed, start the old runner. Never touches the old folder's
 * contents, never removes a destination this run did not create.
 */
export async function rollbackMigration(rec: MigrationRecord, deps: MigrationDeps, token = ""): Promise<MigrationRecord> {
	const problems: string[] = [];
	const attempt = async (what: string, f: () => Promise<void>) => {
		try {
			await f();
		} catch (e) {
			problems.push(`${what}: ${scrub(e instanceof Error ? e.message : String(e), token)}`);
		}
	};
	if (rec.registered) {
		if (rec.newService) {
			await attempt("stop new service", () => sc(deps, rec, "stop", rec.newService as string).catch((e) => (alreadyStopped(e) ? undefined : Promise.reject(e))));
			await attempt("delete new service", () => sc(deps, rec, "delete", rec.newService as string));
		}
		// GitHub still lists the staged runner; the platform holds the credential to deregister it, this machine does not.
		rec.orphanRegistration = rec.stagedName;
	}
	if (rec.createdDest && deps.exists(rec.destDir) && isWithin(rec.destDir, win32.join(deps.programData, "ProAgentStore", "actions-runner")) && !isWithin(rec.destDir, rec.legacyDir)) {
		await attempt("remove the new folder", () => deps.removeTree(rec.destDir));
		rec.steps.push(`removed ${rec.destDir} (created by this migration)`);
	}
	if (rec.legacyStopped && rec.legacyService) {
		await attempt("start old service", () => sc(deps, rec, "start", rec.legacyService as string));
		rec.legacyRestored = !problems.some((p) => p.startsWith("start old service"));
	} else {
		rec.legacyRestored = !rec.legacyStopped;
	}
	rec.stage = "rolled_back";
	rec.removable = false;
	if (problems.length) rec.error = `${rec.error ?? "Migration failed"} — and rollback reported: ${problems.join("; ")}`;
	save(deps, rec);
	return rec;
}
