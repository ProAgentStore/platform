/** #1320 — the watchdog is its OWN OS service, separate from the runner's, on every platform; and a service-started runner installs it once. */
import { describe, expect, it, vi } from "vitest";
import { installWatchdogService, runnerServiceRestart, SERVICE_LABEL, type ServiceContext, SYSTEMD_UNIT, uninstallWatchdogService, WATCHDOG_LABEL, WATCHDOG_TASK, WATCHDOG_UNIT, watchdogRemovalPlan, watchdogServicePlan, servicePlan } from "../service-install.js";
import { ensureWatchdogInstalled } from "./ensure.js";

const ctx = (platform: NodeJS.Platform): ServiceContext => ({ platform, home: platform === "win32" ? "C:\\Users\\me" : "/home/me", nodePath: platform === "win32" ? "C:\\node\\node.exe" : "/usr/bin/node", script: platform === "win32" ? "C:\\npm\\pags.js" : "/usr/lib/pags.js", configDir: platform === "win32" ? "C:\\Users\\me\\.config\\proagentstore" : "/home/me/.config/proagentstore", pathEnv: "/usr/bin", uid: 501, user: "me" });

describe("the watchdog service, per OS", () => {
	it("macOS: a LaunchAgent of its own that runs `watchdog run`, is kept alive, and shares nothing with the runner's", () => {
		const p = watchdogServicePlan(ctx("darwin"));
		const plist = p.files[0];
		expect(plist.path).toBe(`/home/me/Library/LaunchAgents/${WATCHDOG_LABEL}.plist`);
		expect(plist.content).toContain(`<key>Label</key><string>${WATCHDOG_LABEL}</string>`);
		expect(plist.content).toMatch(/<string>\/usr\/lib\/pags\.js<\/string>\s*<string>watchdog<\/string>\s*<string>run<\/string>/);
		expect(plist.content).toContain("<key>KeepAlive</key><true/>");
		expect(plist.content).not.toContain(SERVICE_LABEL);
		expect(plist.content).not.toContain("<string>up</string>");
		expect(p.commands.map((c) => c.args[0])).toEqual(["bootout", "bootstrap", "kickstart"]);
		expect(p.commands[1].args).toEqual(["bootstrap", "gui/501", plist.path]);
	});
	it("Linux: a systemd user unit that restarts always, named apart from pags-up", () => {
		const p = watchdogServicePlan(ctx("linux"));
		expect(p.files[0].path).toBe(`/home/me/.config/systemd/user/${WATCHDOG_UNIT}`);
		expect(p.files[0].content).toContain('ExecStart="/usr/bin/node" "/usr/lib/pags.js" "watchdog" "run"');
		expect(p.files[0].content).toContain("Restart=always");
		expect(p.commands.some((c) => c.args.includes(WATCHDOG_UNIT) && c.args.includes("enable"))).toBe(true);
		expect(WATCHDOG_UNIT).not.toBe(SYSTEMD_UNIT);
	});
	it("Windows: a Scheduled Task of its own, re-triggered so a killed watchdog comes back, one instance at a time", () => {
		const p = watchdogServicePlan(ctx("win32"));
		expect(p.files[0].content).toContain(`Register-ScheduledTask -TaskName '${WATCHDOG_TASK}'`);
		expect(p.files[0].content).toContain('"watchdog" "run"');
		expect(p.files[0].content).toContain("-MultipleInstances IgnoreNew");
		expect(p.files[0].content).toContain("RepetitionInterval (New-TimeSpan -Minutes 5)");
		expect(WATCHDOG_TASK).not.toBe("pags up");
	});
	it("removal undoes exactly the watchdog's own files and unit, never the runner's", () => {
		for (const platform of ["darwin", "linux", "win32"] as const) {
			const r = watchdogRemovalPlan(ctx(platform));
			expect(r.files.every((f) => /watchdog/i.test(f))).toBe(true);
			expect(JSON.stringify(r.commands)).not.toContain(SERVICE_LABEL);
			expect(JSON.stringify(r.commands)).toMatch(/watchdog/i);
		}
	});
	it("install and uninstall carry the plan out, say what failed, and treat an unloadable earlier copy as optional", () => {
		const run = vi.fn((_file: string, args: string[]) => { if (args[0] === "bootstrap") throw Object.assign(new Error("denied"), { stderr: "Bootstrap failed: 5" }); });
		const write = vi.fn();
		const out = installWatchdogService(ctx("darwin"), { run, write });
		expect(out.ok).toBe(false);
		expect(out.lines.some((l) => /load the watchdog LaunchAgent: FAILED — Bootstrap failed: 5/.test(l))).toBe(true);
		expect(write).toHaveBeenCalledTimes(1);
		const removed: string[] = [];
		const u = uninstallWatchdogService(ctx("linux"), { run: () => undefined, remove: (p) => removed.push(p) });
		expect(removed).toEqual([`/home/me/.config/systemd/user/${WATCHDOG_UNIT}`]);
		expect(u.lines.some((l) => l.startsWith("removed "))).toBe(true);
	});
});

describe("restarting the RUNNER's service (what the watchdog does for a dead runner)", () => {
	it("is the runner's own unit on each OS — never the watchdog's", () => {
		expect(runnerServiceRestart(ctx("darwin")).args).toEqual(["kickstart", "-k", `gui/501/${SERVICE_LABEL}`]);
		expect(runnerServiceRestart(ctx("linux")).args).toEqual(["--user", "restart", SYSTEMD_UNIT]);
		expect(runnerServiceRestart(ctx("win32")).args.join(" ")).toContain("pags up");
		expect(servicePlan(ctx("darwin")).files.length).toBe(2); // the runner's plan is untouched
	});
});

describe("a service-started runner installs the watchdog, once (#1320)", () => {
	const x = ctx("darwin");
	it("installs when the unit is absent", () => {
		const install = vi.fn(() => ({ ok: true, lines: [] }));
		const daemonRun = vi.fn(() => ({ ok: true, lines: [] }));
		expect(ensureWatchdogInstalled(x, { PAGS_SERVICE: "1", PAGS_SERVICE_DOMAIN: "system" }, { exists: () => false, install: daemonRun })).toMatchObject({ action: "skipped", why: expect.stringMatching(/LaunchDaemon/) });
		expect(daemonRun).not.toHaveBeenCalled();
		expect(ensureWatchdogInstalled(x, { PAGS_SERVICE: "1" }, { exists: () => false, install })).toEqual({ action: "installed", why: "installed the watchdog service" });
		expect(install).toHaveBeenCalledTimes(1);
	});
	it("does nothing when it is already there, when the runner was started by hand, or when opted out", () => {
		const install = vi.fn(() => ({ ok: true, lines: [] }));
		expect(ensureWatchdogInstalled(x, { PAGS_SERVICE: "1" }, { exists: () => true, install }).action).toBe("present");
		expect(ensureWatchdogInstalled(x, {}, { exists: () => false, install }).action).toBe("skipped");
		expect(ensureWatchdogInstalled(x, { PAGS_SERVICE: "1", PAGS_NO_WATCHDOG: "1" }, { exists: () => false, install }).action).toBe("skipped");
		expect(install).not.toHaveBeenCalled();
	});
	it("a failed install is reported, never thrown, and never stops the runner starting", () => {
		const r = ensureWatchdogInstalled(x, { PAGS_SERVICE: "1" }, { exists: () => false, install: () => ({ ok: false, lines: ["load the watchdog LaunchAgent: FAILED — denied"] }) });
		expect(r).toEqual({ action: "failed", why: "load the watchdog LaunchAgent: FAILED — denied" });
	});
});
