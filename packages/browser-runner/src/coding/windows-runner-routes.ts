/**
 * The runner's Windows-only `/coding/actions-runner/*` routes (#1272): readiness, legacy-install discovery, and the local half of a
 * migration. Kept apart from actions-runner.ts, which only delegates here. The migration routes take the platform's fresh
 * registration token in the body and never echo it; the verdict route is how the platform reports "online + smoke job passed".
 */
import { checkWindowsReadiness, type WindowsReadiness } from "./windows-runner-readiness.js";
import { completeMigration, findLegacyInstalls, type LegacyInstall, type MigrationDeps, type MigrationRecord, readMigration, rollbackMigration, startMigration } from "./windows-runner-migration.js";
import { liveWindowsDeps, type LiveWindows } from "./windows-runner-live.js";
import { win32 } from "node:path";

type Reply = { status: number; body: unknown };
const bad = (error: string): Reply => ({ status: 400, body: { error } });

/**
 * Migration does real service work and may spend ten minutes draining a running job. It must not
 * hold one relay command open while it does that (#1301). The durable migration record remains the
 * source of truth; this map only says that this runner process is still advancing that record.
 */
const activeMigrations = new Map<string, Promise<MigrationRecord>>();

function migrationKey(deps: MigrationDeps, folder: string): string {
	return win32.join(deps.programData, "ProAgentStore", "actions-runner", folder).toLowerCase();
}

function beginMigration(req: Parameters<typeof startMigration>[0], deps: MigrationDeps): boolean {
	const key = migrationKey(deps, req.legacy.folder);
	if (activeMigrations.has(key)) return false;
	const task = startMigration(req, deps).finally(() => activeMigrations.delete(key));
	activeMigrations.set(key, task);
	return true;
}

export function windowsReadiness(win: LiveWindows = liveWindowsDeps()): WindowsReadiness {
	return checkWindowsReadiness(win.readiness);
}

/** Legacy installs and where each stands. `needed` is what makes the cloud start a migration. */
export function migrationStatus(deps: MigrationDeps): { needed: boolean; legacy: Array<LegacyInstall & { migration: MigrationRecord | null; running: boolean }> } {
	const legacy = findLegacyInstalls(deps).map((l) => ({
		...l,
		migration: readMigration(deps, win32.join(deps.programData, "ProAgentStore", "actions-runner", l.folder)),
		running: activeMigrations.has(migrationKey(deps, l.folder)),
	}));
	return { needed: legacy.some((l) => (!l.migration && !l.running) || l.migration?.stage === "rolled_back"), legacy };
}

const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

export async function routeWindowsRunner(path: string, body: Record<string, unknown>, win: () => LiveWindows = liveWindowsDeps): Promise<Reply | null> {
	if (!path.startsWith("/coding/actions-runner/") || !(path.endsWith("/readiness") || path.includes("/migration"))) return null;
	if (process.platform !== "win32" && win === liveWindowsDeps) return { status: 200, body: path.endsWith("/readiness") ? checkWindowsReadiness({ platform: process.platform, probe: () => null, whichPath: () => null, userProfile: "" }) : { needed: false, legacy: [] } };
	const w = win();
	if (path.endsWith("/readiness")) return { status: 200, body: windowsReadiness(w) };
	if (path.endsWith("/migration/status")) return { status: 200, body: migrationStatus(w.migration) };
	const folder = typeof body.folder === "string" && FOLDER.test(body.folder) ? body.folder : null;
	if (!folder) return bad("folder must be the legacy runner's folder name");
	const legacy = findLegacyInstalls(w.migration).find((l) => l.folder === folder);
	const dest = win32.join(w.migration.programData, "ProAgentStore", "actions-runner", folder);
	if (path.endsWith("/migration/start")) {
		if (!legacy) return bad(`No profile-scoped runner named ${folder} to migrate.`);
		const url = typeof body.url === "string" ? body.url : legacy.url;
		if (!url || typeof body.token !== "string" || body.token.length < 10 || /\s/.test(body.token)) return bad("url and a fresh registration token are required");
		const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === "string" && /^[A-Za-z0-9._+-]{1,100}$/.test(l)) : [];
		const started = beginMigration({ legacy, url, token: body.token, labels }, w.migration);
		return { status: 202, body: { accepted: true, started, folder } };
	}
	const rec = readMigration(w.migration, dest);
	if (!rec) return bad(`No migration is recorded for ${folder}.`);
	if (path.endsWith("/migration/complete")) {
		const v = body.verdict as { online?: unknown; smoke?: { ok?: unknown; detail?: unknown } } | undefined;
		if (!v || typeof v.online !== "boolean" || typeof v.smoke?.ok !== "boolean") return bad("verdict must be { online: boolean, smoke: { ok: boolean } }");
		return { status: 200, body: await completeMigration(rec, { online: v.online, smoke: { ok: v.smoke.ok, detail: typeof v.smoke.detail === "string" ? v.smoke.detail : undefined } }, w.migration) };
	}
	if (path.endsWith("/migration/rollback")) return { status: 200, body: await rollbackMigration(rec, w.migration) };
	return null;
}
