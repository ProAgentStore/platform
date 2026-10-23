/**
 * The platform's half of migrating a profile-scoped Windows runner to the machine root (#1272).
 *
 * The machine does the local work (drain, stop, root + ACL, copy, re-register — packages/browser-runner windows-runner-migration.ts)
 * and stops at `awaiting_verification`; it holds no GitHub credential and cannot say whether it is online. This module is what can:
 *
 *   1. mint a FRESH short-lived registration token (never stored, never in a result) and hand it to `/migration/start`;
 *   2. the migrated runner registers under a staged name WITHOUT the routing labels — it carries `pags-unavailable`, so nothing is
 *      routed to it while it is unproven;
 *   3. confirm GitHub shows it ONLINE, then run the platform-owned smoke job on exactly that runner;
 *   4. only if both pass: report the verdict (`/migration/complete`, which marks the old install removable — it does not remove it)
 *      and swap the labels to the routing labels. Either failing: report the verdict, which rolls the machine back to the old runner.
 *
 * There is no smoke job in this deploy until `ProvisionDeps.smoke` is configured; without it the migration stays at
 * `awaiting_verification`, the new runner stays unrouted, the old install stays stopped-but-intact, and the answer says exactly that.
 * A runner is never routed work on the strength of "it started".
 */
import { HttpError } from "./auth.js";
import { logEvent } from "./events.js";
import type { RunnerConn } from "./runner-client.js";
import { RUNNER_UNAVAILABLE_LABEL, type RunnerAvailability, routingLabels } from "./runner-routing.js";
import type { Env } from "../types.js";

export type MigrationOutcome = "running" | "ready_for_removal" | "awaiting_verification" | "rolled_back" | "failed";

export interface MigrationView {
	outcome: MigrationOutcome;
	stagedName: string | null;
	/** What was done and what is left — plain sentences for the owner. */
	steps: string[];
	/** Set when the platform could not finish verifying (no smoke job configured, GitHub not yet showing it online). */
	needsHuman?: string;
	legacyRestored?: boolean;
	orphanRegistration?: string;
}

interface Machine {
	stage?: string;
	stagedName?: string;
	error?: string;
	steps?: string[];
	legacyRestored?: boolean;
	orphanRegistration?: string;
}

interface MachineMigrationStatus {
	legacy?: Array<{ folder?: string; running?: boolean; interrupted?: boolean; migration?: Machine | null }>;
}

/**
 * The GitHub-facing operations, handed in by actions-runner-provision.ts (which owns them) so this module imports nothing from it at
 * runtime — the two would otherwise be an import cycle.
 */
/** The shapes this module needs, declared here (structurally identical to provision's) so it imports nothing from it — not even a type. */
export interface MigrateJobView {
	id: string;
	action: "install" | "remove";
	url: string;
	name: string;
	state: "running" | "done" | "failed";
	steps: string[];
	prerequisites: Array<{ name: string; found: boolean; note?: string }>;
	runsAs: string;
	service: "installed" | "removed" | "not_installed" | "needs_admin";
	serviceNote?: string;
	error?: string;
}

export interface MigrateDeps {
	call: <T>(conn: RunnerConn, path: string, body: unknown) => Promise<T>;
	smoke?: (runnerName: string) => Promise<{ ok: boolean; detail?: string }>;
	sleep?: (ms: number) => Promise<void>;
}

export interface MigrateOps {
	mintToken: () => Promise<string>;
	scopeUrl: string;
	findRunner: (name: string) => Promise<{ status: string } | null>;
	relabel: (name: string, labels: readonly string[], alsoManaged: readonly string[]) => Promise<unknown>;
}

const wait = (deps: MigrateDeps, ms: number) => (deps.sleep ? deps.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)));

async function online(ops: MigrateOps, name: string, deps: MigrateDeps): Promise<boolean> {
	for (let i = 0; i < 6; i++) {
		const r = await ops.findRunner(name).catch(() => null);
		if (r?.status === "online") return true;
		await wait(deps, 5_000);
	}
	return false;
}

export async function migrateLegacyRunner<C extends { labels: string[] }, P>(
	env: Env,
	a: { userId: string; instanceId: string; node: string; label: string; url: string; folder: string; availability?: RunnerAvailability; caps: C | null; preflight?: P },
	conn: RunnerConn,
	deps: MigrateDeps,
	ops: MigrateOps,
): Promise<{ job: MigrateJobView; node: string; labels: string[]; capabilities: C | null; preflight?: P; migration: MigrationView }> {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(a.folder)) throw new HttpError(409, "The legacy runner's folder could not be identified, so it was not migrated.");
	const steps: string[] = [];
	const finalLabels = routingLabels(a.node, a.caps?.labels ?? [], a.availability ?? { available: true, reasons: [], summary: "" });
	// Unrouted until proven: the migrated runner carries the unavailable marker, not the routing labels.
	const stagedLabels = [RUNNER_UNAVAILABLE_LABEL, ...(a.caps?.labels ?? [])];
	const read = async () => {
		const status = await deps.call<MachineMigrationStatus>(conn, "/coding/actions-runner/migration/status", { folder: a.folder });
		return status.legacy?.find((item) => item.folder === a.folder) ?? null;
	};
	let observed = await read().catch(() => null);
	// A receipt stuck at an in-progress stage with nothing advancing it is a runner restart mid-stage (#1301). The machine says so
	// (`interrupted`); an older runner does not, so the same fact is read from the stage. Setup RESUMES it with a fresh token.
	const interrupted = (o: typeof observed) => !!o && !o.running && (o.interrupted ?? ["drain", "stop", "prepare", "copy", "register"].includes(o.migration?.stage ?? ""));
	if (!observed?.running && (!observed?.migration || observed.migration.stage === "rolled_back" || interrupted(observed))) {
		const token = await ops.mintToken();
		try {
			await deps.call(conn, "/coding/actions-runner/migration/start", { folder: a.folder, url: ops.scopeUrl, token, labels: stagedLabels });
		} catch (e) {
			// A lost response does not prove that a mutating command did nothing. Read status before
			// describing the old runner as unchanged (#1301).
			observed = await read().catch(() => null);
			if (!observed?.running && !observed?.migration) {
				throw new HttpError(409, `Migrating ${a.node}'s Windows runner could not be started; status confirms that no migration was recorded: ${e instanceof Error ? e.message.split(token).join("***") : "unknown error"}`);
			}
		}
	}

	let machine: Machine | null = observed?.migration ?? null;
	// The local operation may legitimately spend ten minutes draining an active job. Poll short,
	// read-only relay calls instead of holding a single mutating call open (#1301).
	for (let i = 0; i < 5; i++) {
		observed = await read();
		machine = observed?.migration ?? null;
		if (machine && ["awaiting_verification", "ready_for_removal", "rolled_back"].includes(machine.stage ?? "")) break;
		if (!observed?.running && machine) {
			throw new HttpError(409, `Migration of ${a.node} stopped at ${machine.stage ?? "an unknown stage"}. Its receipt is preserved; run setup again to resume it, or roll it back on the machine.`);
		}
		await wait(deps, 1_000);
	}
	machine ??= { stage: "drain", steps: [] };
	steps.push(...(machine.steps ?? []));
	const view = (outcome: MigrationOutcome, extra: Partial<MigrationView> = {}): MigrationView => ({ outcome, stagedName: machine.stagedName ?? null, steps, legacyRestored: machine.legacyRestored, orphanRegistration: machine.orphanRegistration, ...extra });
	const job = (state: MigrateJobView["state"], error?: string): MigrateJobView => ({ id: `migrate-${a.node}`, action: "install", url: a.url, name: machine.stagedName ?? a.label, state, steps, prerequisites: [], runsAs: "NT AUTHORITY\\NETWORK SERVICE", service: state === "failed" ? "not_installed" : "installed", ...(error ? { error } : {}) });
	const out = (migration: MigrationView, state: MigrateJobView["state"], error?: string) => ({ job: job(state, error), node: a.node, labels: migration.outcome === "ready_for_removal" ? finalLabels : stagedLabels, capabilities: a.caps, preflight: a.preflight, migration });
	const log = (event: string, context: Record<string, unknown>) => logEvent(env, { source: "runner", event: `actions_runner.${event}`, userId: a.userId, instanceId: a.instanceId, message: `Windows runner migration for ${a.node}: ${event}`, context: { node: a.node, url: a.url, ...context } }).catch(() => undefined);
	if (!["awaiting_verification", "ready_for_removal", "rolled_back"].includes(machine.stage ?? "")) {
		steps.push("migration is still running on the machine; run setup again to read the same operation's progress");
		return out(view("running", { steps }), "running");
	}

	if (machine.stage === "rolled_back") {
		await log("migration_rolled_back", { error: machine.error ?? null, legacyRestored: machine.legacyRestored ?? null });
		return out(view("rolled_back"), "failed", machine.error ?? "The migration was rolled back.");
	}
	if (machine.stage === "ready_for_removal") return out(view("ready_for_removal"), "done");

	const stagedName = machine.stagedName ?? `${a.label}-m`;
	if (!(await online(ops, stagedName, deps))) {
		const done = await deps.call<Machine>(conn, "/coding/actions-runner/migration/complete", { folder: a.folder, verdict: { online: false, smoke: { ok: false, detail: "not online" } } });
		steps.push("GitHub did not show the migrated runner online; rolled back to the old runner");
		await log("migration_rolled_back", { stage: "online", legacyRestored: done.legacyRestored ?? null });
		return out(view("rolled_back", { legacyRestored: done.legacyRestored, orphanRegistration: done.orphanRegistration, steps }), "failed", "GitHub does not show the migrated runner online.");
	}
	steps.push("GitHub shows the migrated runner online");
	if (!deps.smoke) {
		steps.push("no platform smoke job is configured, so the runner stays unrouted");
		await log("migration_awaiting_smoke", {});
		return out(view("awaiting_verification", { needsHuman: "The migrated runner is online but has not completed a platform-owned smoke job (none is configured in this deployment), so it is held out of routing and the old install is stopped but intact. Run the smoke job, then complete or roll back the migration." }), "running");
	}
	const smoke = await deps.smoke(stagedName).catch((e) => ({ ok: false, detail: e instanceof Error ? e.message : "smoke job failed to run" }));
	const verdict = await deps.call<Machine>(conn, "/coding/actions-runner/migration/complete", { folder: a.folder, verdict: { online: true, smoke } });
	steps.push(...(verdict.steps ?? []).filter((s) => !steps.includes(s)));
	if (verdict.stage !== "ready_for_removal") {
		await log("migration_rolled_back", { stage: "smoke", detail: smoke.detail ?? null, legacyRestored: verdict.legacyRestored ?? null });
		return out(view("rolled_back", { legacyRestored: verdict.legacyRestored, orphanRegistration: verdict.orphanRegistration, steps }), "failed", `The migrated runner did not pass the smoke job${smoke.detail ? `: ${smoke.detail}` : "."}`);
	}
	// Proven: now (and only now) it takes the routing labels. The old install is removable — and still not removed.
	await ops.relabel(stagedName, finalLabels, [RUNNER_UNAVAILABLE_LABEL]).catch((e) => steps.push(`could not swap to the routing labels: ${e instanceof Error ? e.message : "unknown"} — run setup again`));
	steps.push(`the old install at the profile path is now removable; it has NOT been removed`);
	await log("migration_complete", { stagedName });
	return out(view("ready_for_removal", { steps }), "done");
}
