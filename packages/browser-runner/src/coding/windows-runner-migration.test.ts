/**
 * #1272 — migrating a profile-scoped Windows runner to the machine root: the happy path, the rollback at every stage, that the old
 * install is never modified or removed, that the token never leaks, and that re-running converges. A fake Windows only; no real
 * service is touched and no real token exists.
 */
import { win32 } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { COPY_EXCLUDE, completeMigration, findLegacyInstalls, MANIFEST, type MigrationRecord, readMigration, rollbackMigration, startMigration } from "./windows-runner-migration.js";
import { addLegacyInstall, type FakeMachine, fakeMachine, PROFILE, PROGRAM_DATA, TOKEN } from "./windows-runner.fixture.js";
import { routeWindowsRunner } from "./windows-runner-routes.js";

const DEST = `${PROGRAM_DATA}\\ProAgentStore\\actions-runner\\proappstore-online`;
let m: FakeMachine;
let legacy: { dir: string; service: string };

const request = () => ({ legacy: findLegacyInstalls(m)[0], url: "https://github.com/proappstore-online", token: TOKEN, labels: ["pags", "pags-pink-laptop"] });
const legacySnapshot = () => JSON.stringify([...m.files].filter(([f]) => f.startsWith(legacy.dir)).sort());
const everything = (rec: MigrationRecord) => JSON.stringify(rec) + m.calls.map((c) => c.args.join(" ")).join("\n").replace(TOKEN, "") + [...m.files.values()].join("\n");

beforeEach(() => {
	m = fakeMachine();
	legacy = addLegacyInstall(m);
});

describe("finding legacy installs", () => {
	it("lists each configured profile-scoped runner with its name, URL and service", () => {
		expect(findLegacyInstalls(m)).toEqual([{ dir: legacy.dir, folder: "proappstore-online", name: "pink-laptop", url: "https://github.com/proappstore-online", serviceName: legacy.service }]);
	});

	it("ignores unconfigured folders, and finds nothing off Windows or with no profile root", () => {
		m.dirs.add(win32.join(PROFILE, ".proagentstore", "actions-runner", "empty"));
		expect(findLegacyInstalls(m)).toHaveLength(1);
		expect(findLegacyInstalls({ ...m, platform: "darwin" })).toEqual([]);
		expect(findLegacyInstalls(fakeMachine())).toEqual([]);
	});

	it("an unreadable .runner is still a runner to migrate", () => {
		m.files.set(win32.join(legacy.dir, ".runner"), "{not json");
		expect(findLegacyInstalls(m)[0]).toMatchObject({ name: null, url: null });
	});
});

describe("the migration, locally", () => {
	it("drain → stop → machine root + ACL → copy → re-register under a staged name, ending awaiting verification", async () => {
		const rec = await startMigration(request(), m);
		expect(rec).toMatchObject({ stage: "awaiting_verification", stagedName: "pink-laptop-m", legacyStopped: true, createdDest: true, registered: true, legacyDir: legacy.dir, destDir: DEST });
		expect(m.services.get(legacy.service)).toBe("stopped");
		const config = m.calls.find((c) => c.file.endsWith("config.cmd"));
		expect(config?.cwd).toBe(DEST);
		expect(config?.args).toEqual(expect.arrayContaining(["--unattended", "--runasservice", "--windowslogonaccount", "NT AUTHORITY\\NETWORK SERVICE", "--name", "pink-laptop-m", "--replace"]));
		expect(rec.newService).toBe("actions.runner.proappstore-online.pink-laptop-m");
		expect(readMigration(m, DEST)?.stage).toBe("awaiting_verification");
	});

	it("registers under a STAGED name, never the old one — --replace under the old name would strand a rollback", async () => {
		await startMigration(request(), m);
		const name = m.calls.find((c) => c.file.endsWith("config.cmd"))?.args;
		expect(name?.[(name?.indexOf("--name") ?? 0) + 1]).not.toBe("pink-laptop");
	});

	it("copies the binaries but not the old registration, credentials or working data", async () => {
		await startMigration(request(), m);
		expect(m.copied[0].exclude).toEqual(COPY_EXCLUDE);
		expect(m.files.has(`${DEST}\\run.cmd`)).toBe(true);
		expect(m.files.get(`${DEST}\\.credentials`)).toBeUndefined();
		expect(JSON.stringify([...m.files].filter(([f]) => f.startsWith(DEST)))).not.toContain("OLD-CREDENTIAL");
	});

	it("never modifies the old install", async () => {
		const before = legacySnapshot();
		await startMigration(request(), m);
		expect(legacySnapshot()).toBe(before);
		expect(m.removed).toEqual([]);
	});

	it("sets the destination ACL BEFORE copying or registering into it, and gives nothing on the profile", async () => {
		await startMigration(request(), m);
		const order = m.calls.map((c) => (c.file === "icacls" && c.args.includes("/grant:r") ? "acl" : c.file.endsWith("config.cmd") ? "config" : c.file));
		expect(order.indexOf("acl")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("acl")).toBeLessThan(order.indexOf("config"));
		expect(m.calls.flatMap((c) => c.args).some((a) => a.toLowerCase().startsWith(PROFILE.toLowerCase()) && c.file === "icacls")).toBe(false);
	});

	it("the registration token is masked in every recorded step and appears in nothing persisted", async () => {
		const rec = await startMigration(request(), m);
		expect(rec.steps.some((s) => s.startsWith("config.cmd") && s.includes("--token ***"))).toBe(true);
		expect(everything(rec)).not.toContain(TOKEN);
	});

	it("waits for a running job to finish (drain) before stopping anything", async () => {
		m.busyDirs.add(legacy.dir);
		let polls = 0;
		const real = m.busy;
		m.busy = async (d) => {
			polls++;
			if (polls > 2) m.busyDirs.delete(legacy.dir);
			return real(d);
		};
		const rec = await startMigration(request(), m);
		expect(rec.stage).toBe("awaiting_verification");
		expect(rec.steps).toContain("waiting for the running job to finish");
		expect(m.calls.findIndex((c) => c.file === "sc.exe")).toBeGreaterThan(-1);
	});

	it("a job that never finishes aborts BEFORE touching anything", async () => {
		m.busyDirs.add(legacy.dir);
		const rec = await startMigration(request(), { ...m, drainTimeoutMs: 5_000, now: (() => { let t = 0; return () => (t += 3_000); })() } as typeof m);
		expect(rec).toMatchObject({ stage: "rolled_back", legacyRestored: true });
		expect(rec.error).toMatch(/still running/);
		expect(m.calls).toEqual([]);
		expect(m.dirs.has(DEST)).toBe(false);
	});

	it("is idempotent: asking again after registration changes and runs nothing", async () => {
		const first = await startMigration(request(), m);
		const calls = m.calls.length;
		const again = await startMigration(request(), m);
		expect(again.stage).toBe("awaiting_verification");
		expect(again.stagedName).toBe(first.stagedName);
		expect(m.calls.length).toBe(calls);
	});

	it("refuses off Windows, a missing runner, a privileged or named identity, and a destination in the profile", async () => {
		expect((await startMigration(request(), { ...m, platform: "darwin" } as typeof m)).error).toMatch(/only runs on Windows/);
		expect((await startMigration({ ...request(), identity: "Administrators" }, m)).error).toMatch(/least-privilege/);
		expect((await startMigration({ ...request(), identity: "PC\\svc" }, m)).error).toMatch(/built-in/);
		const inProfile = fakeMachine({ programData: `${PROFILE}\\ProgramData` });
		addLegacyInstall(inProfile);
		expect((await startMigration({ legacy: findLegacyInstalls(inProfile)[0], url: "https://github.com/proappstore-online", token: TOKEN, labels: [] }, inProfile)).error).toMatch(/outside the user profile/);
	});
});

describe("rollback at every stage leaves the old runner running and intact", () => {
	const failAt = {
		"stopping the old service": (f: string, a: string[]) => f === "sc.exe" && a[0] === "stop" && a[1].includes("actions.runner.proappstore-online.pink-laptop") && !a[1].endsWith("-m"),
		"setting the ACL": (f: string, a: string[]) => f === "icacls" && a.includes("/inheritance:r"),
		"registering": (f: string) => f.endsWith("config.cmd"),
	} as const;

	for (const [stage, match] of Object.entries(failAt)) {
		it(`a failure while ${stage} restores the old runner, removes only what it made, and never leaks the token`, async () => {
			const before = legacySnapshot();
			m.failOn(match, `boom ${TOKEN} during ${stage}`);
			const rec = await startMigration(request(), m);
			expect(rec.stage).toBe("rolled_back");
			expect(rec.error).toContain("boom");
			expect(rec.error).not.toContain(TOKEN);
			expect(m.services.get(legacy.service)).toBe("running");
			expect(rec.legacyRestored).toBe(true);
			expect(legacySnapshot()).toBe(before);
			expect(m.removed.every((p) => p === DEST)).toBe(true);
			expect(m.dirs.has(legacy.dir)).toBe(true);
			expect(everything(rec)).not.toContain(TOKEN);
		});
	}

	it("a failed copy removes the half-copied destination this run created", async () => {
		m.copyTree = async () => {
			m.dirs.add(DEST);
			throw new Error("disk full");
		};
		const rec = await startMigration(request(), m);
		expect(rec.stage).toBe("rolled_back");
		expect(m.removed).toEqual([DEST]);
		expect(m.services.get(legacy.service)).toBe("running");
		expect(readMigration(m, DEST)).toMatchObject({ stage: "rolled_back", legacyRestored: true, error: "disk full" });
	});

	it("a failed registration removes the staged service and names the orphan GitHub still lists, for the platform to deregister", async () => {
		m.failOn((f) => f.endsWith("config.cmd"), "config failed");
		const rec = await startMigration(request(), m);
		expect(rec.registered).toBe(false);
		expect(rec.orphanRegistration).toBeUndefined();
		// A failure AFTER registration (the verdict) does have an orphan.
		const m2 = fakeMachine();
		addLegacyInstall(m2);
		const ok = await startMigration({ legacy: findLegacyInstalls(m2)[0], url: "https://github.com/proappstore-online", token: TOKEN, labels: [] }, m2);
		const back = await completeMigration(ok, { online: false, smoke: { ok: false } }, m2);
		expect(back).toMatchObject({ stage: "rolled_back", orphanRegistration: "pink-laptop-m", legacyRestored: true });
		expect(m2.services.has(ok.newService as string)).toBe(false);
	});

	it("never removes a destination that already existed before the migration", async () => {
		m.dirs.add(DEST);
		m.failOn((f) => f.endsWith("config.cmd"), "config failed");
		const rec = await startMigration(request(), m);
		expect(rec.createdDest).toBe(false);
		expect(m.removed).toEqual([]);
	});

	it("reports it honestly when the old service will not restart", async () => {
		m.failOn((f, a) => f === "sc.exe" && a[0] === "start", "access denied");
		m.failOn((f) => f.endsWith("config.cmd"), "config failed");
		const rec = await startMigration(request(), m);
		expect(rec.stage).toBe("rolled_back");
		expect(rec.legacyRestored).toBe(false);
		expect(rec.error).toMatch(/rollback reported: start old service: access denied/);
	});
});

describe("the platform's verdict", () => {
	it("online + smoke job passed → the old install is marked removable, and still not removed", async () => {
		const rec = await startMigration(request(), m);
		const before = legacySnapshot();
		const done = await completeMigration(rec, { online: true, smoke: { ok: true } }, m);
		expect(done).toMatchObject({ stage: "ready_for_removal", removable: true });
		expect(m.removed).toEqual([]);
		expect(m.dirs.has(legacy.dir)).toBe(true);
		expect(legacySnapshot()).toBe(before);
		expect(m.services.get(legacy.service)).toBe("stopped");
		expect(readMigration(m, DEST)?.removable).toBe(true);
	});

	it("not online → rolled back; smoke job failed → rolled back with its detail", async () => {
		const a = await completeMigration(await startMigration(request(), m), { online: false, smoke: { ok: true } }, m);
		expect(a).toMatchObject({ stage: "rolled_back", removable: false, legacyRestored: true });
		expect(a.error).toMatch(/does not show/);
		const m2 = fakeMachine();
		const l2 = addLegacyInstall(m2);
		const b = await completeMigration(await startMigration({ legacy: findLegacyInstalls(m2)[0], url: "https://github.com/proappstore-online", token: TOKEN, labels: [] }, m2), { online: true, smoke: { ok: false, detail: "step 3 failed: aws not found" } }, m2);
		expect(b.error).toMatch(/smoke job.*aws not found/);
		expect(m2.services.get(l2.service)).toBe("running");
	});

	it("completing twice, or before registration, changes nothing", async () => {
		const rec = await startMigration(request(), m);
		const done = await completeMigration(rec, { online: true, smoke: { ok: true } }, m);
		const calls = m.calls.length;
		expect((await completeMigration(done, { online: false, smoke: { ok: false } }, m)).stage).toBe("ready_for_removal");
		expect(m.calls.length).toBe(calls);
		const early = await completeMigration({ ...rec, stage: "copy" }, { online: true, smoke: { ok: true } }, m);
		expect(early.error).toMatch(/Cannot complete/);
	});

	it("an explicit rollback of a verified-pending migration restores the old runner", async () => {
		const rec = await startMigration(request(), m);
		const back = await rollbackMigration(rec, m);
		expect(back).toMatchObject({ stage: "rolled_back", legacyRestored: true });
		expect(m.services.get(legacy.service)).toBe("running");
		expect(m.dirs.has(DEST)).toBe(false);
	});
});

describe("the runner's migration routes", () => {
	const win = () => ({ root: m, migration: m, readiness: { platform: "win32" as const, userProfile: PROFILE, probe: () => null, whichPath: () => null } });

	it("status reports a legacy install as needing migration, then not once it is awaiting verification", async () => {
		expect((await routeWindowsRunner("/coding/actions-runner/migration/status", {}, win))?.body).toMatchObject({ needed: true });
		await startMigration(request(), m);
		expect((await routeWindowsRunner("/coding/actions-runner/migration/status", {}, win))?.body).toMatchObject({ needed: false });
	});

	it("start validates its input, never echoes the token, and rejects an unknown folder", async () => {
		const bad = await routeWindowsRunner("/coding/actions-runner/migration/start", { folder: "../x", token: TOKEN }, win);
		expect(bad?.status).toBe(400);
		expect((await routeWindowsRunner("/coding/actions-runner/migration/start", { folder: "nope", token: TOKEN }, win))?.status).toBe(400);
		expect((await routeWindowsRunner("/coding/actions-runner/migration/start", { folder: "proappstore-online", token: "short" }, win))?.status).toBe(400);
		const ok = await routeWindowsRunner("/coding/actions-runner/migration/start", { folder: "proappstore-online", token: TOKEN, labels: ["pags", "bad label"] }, win);
		expect(ok?.status).toBe(202);
		expect(ok?.body).toMatchObject({ accepted: true, started: true, folder: "proappstore-online" });
		expect(JSON.stringify(ok?.body)).not.toContain(TOKEN);
	});

	it("starts a slow migration once and reports it through status instead of holding the relay request open (#1301)", async () => {
		let release: ((busy: boolean) => void) | undefined;
		m.busy = async () => new Promise<boolean>((resolve) => {
			release = resolve;
		});
		const first = await routeWindowsRunner("/coding/actions-runner/migration/start", { folder: "proappstore-online", url: "https://github.com/proappstore-online", token: TOKEN, labels: ["pags"] }, win);
		expect(first).toMatchObject({ status: 202, body: { accepted: true, started: true } });
		expect((await routeWindowsRunner("/coding/actions-runner/migration/status", {}, win))?.body).toMatchObject({ legacy: [{ folder: "proappstore-online", running: true }] });

		const duplicate = await routeWindowsRunner("/coding/actions-runner/migration/start", { folder: "proappstore-online", url: "https://github.com/proappstore-online", token: TOKEN, labels: ["pags"] }, win);
		expect(duplicate).toMatchObject({ status: 202, body: { accepted: true, started: false } });
		release?.(false);
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
			const status = (await routeWindowsRunner("/coding/actions-runner/migration/status", {}, win))?.body as { legacy: Array<{ running: boolean; migration: MigrationRecord | null }> };
			if (!status.legacy[0].running) {
				expect(status.legacy[0].migration?.stage).toBe("awaiting_verification");
				return;
			}
		}
		throw new Error("background migration did not settle");
	});

	it("complete and rollback need a recorded migration and a well-formed verdict", async () => {
		expect((await routeWindowsRunner("/coding/actions-runner/migration/complete", { folder: "proappstore-online", verdict: {} }, win))?.status).toBe(400);
		await startMigration(request(), m);
		expect((await routeWindowsRunner("/coding/actions-runner/migration/complete", { folder: "proappstore-online", verdict: { online: "yes" } }, win))?.status).toBe(400);
		const done = await routeWindowsRunner("/coding/actions-runner/migration/complete", { folder: "proappstore-online", verdict: { online: true, smoke: { ok: true } } }, win);
		expect(done?.body).toMatchObject({ stage: "ready_for_removal" });
		expect(readMigration(m, DEST)?.stage).toBe("ready_for_removal");
		expect((await routeWindowsRunner("/coding/actions-runner/readiness", {}, win))?.status).toBe(200);
		expect(await routeWindowsRunner("/coding/actions-runner/install", {}, win)).toBeNull();
		expect(MANIFEST).toBe(".pags-migration.json");
	});
});
