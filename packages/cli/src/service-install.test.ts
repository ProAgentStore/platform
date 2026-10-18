/**
 * #1141 — `pags up --install-service`: an OS supervisor that brings `pags up` back whatever happened to it.
 *
 * The unit files and commands are checked as generated for each OS; the supervisor every OS runs is
 * run for real against a fake `pags` that keeps dying, to see it start it again — with backoff, as
 * a service — rather than giving up.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installService, SERVICE_LABEL, type ServiceContext, servicePlan, serviceRemovalPlan, supervisorPath, uninstallService } from "./service-install.js";

const mac: ServiceContext = { platform: "darwin", home: "/Users/serge", nodePath: "/opt/homebrew/bin/node", script: "/opt/homebrew/lib/node_modules/@proagentstore/cli/dist/bootstrap.js", configDir: "/Users/serge/.config/proagentstore", pathEnv: "/opt/homebrew/bin:/usr/bin:/bin", uid: 501, user: "serge" };
const linux: ServiceContext = { platform: "linux", home: "/home/serge", nodePath: "/usr/bin/node", script: "/usr/lib/node_modules/@proagentstore/cli/dist/bootstrap.js", configDir: "/home/serge/.config/proagentstore", pathEnv: "/usr/local/bin:/usr/bin", user: "serge" };
const win: ServiceContext = { platform: "win32", home: "C:\\Users\\serge", nodePath: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\Users\\serge\\AppData\\Roaming\\npm\\node_modules\\@proagentstore\\cli\\dist\\bootstrap.js", configDir: "C:\\Users\\serge\\.config\\proagentstore", pathEnv: "C:\\Program Files\\nodejs", user: "serge", domain: "DELL-LAPTOP" };

describe("the service each OS gets (#1141)", () => {
	it("macOS: a KeepAlive LaunchAgent running the supervisor, loaded into the user's GUI domain and kicked", () => {
		const plan = servicePlan(mac);
		expect(plan.kind).toBe("launchd");
		const plist = plan.files.find((f) => f.path.endsWith(`${SERVICE_LABEL}.plist`));
		expect(plist?.path).toBe(`/Users/serge/Library/LaunchAgents/${SERVICE_LABEL}.plist`);
		expect(plist?.content).toContain("<key>KeepAlive</key><true/>");
		expect(plist?.content).toContain("<string>/opt/homebrew/bin/node</string>");
		expect(plist?.content).toContain("<string>/Users/serge/.config/proagentstore/pags-up-supervisor.mjs</string>");
		expect(plan.commands.map((c) => [c.file, ...c.args].join(" "))).toEqual([
			`launchctl bootout gui/501/${SERVICE_LABEL}`,
			`launchctl bootstrap gui/501 /Users/serge/Library/LaunchAgents/${SERVICE_LABEL}.plist`,
			`launchctl kickstart -k gui/501/${SERVICE_LABEL}`,
		]);
		expect(plan.commands[0].optional).toBe(true);
	});

	it("Linux: a Restart=always systemd user unit, enabled now, lingering so it runs with nobody logged in", () => {
		const plan = servicePlan(linux);
		const unit = plan.files.find((f) => f.path.endsWith("pags-up.service"));
		expect(unit?.path).toBe("/home/serge/.config/systemd/user/pags-up.service");
		expect(unit?.content).toContain('ExecStart="/usr/bin/node" "/home/serge/.config/proagentstore/pags-up-supervisor.mjs"');
		expect(unit?.content).toContain("Restart=always");
		expect(unit?.content).toContain("StartLimitIntervalSec=0");
		expect(unit?.content).toContain('Environment="PATH=/usr/local/bin:/usr/bin"');
		expect(plan.commands.map((c) => [c.file, ...c.args].join(" "))).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now pags-up.service", "loginctl enable-linger serge"]);
	});

	it("Windows: a Scheduled Task at startup as this user (S4U), restarted on failure, registered by a script it writes", () => {
		const plan = servicePlan(win);
		const task = plan.files.find((f) => f.path.endsWith("pags-up-task.ps1"));
		expect(task?.content).toContain("New-ScheduledTaskTrigger -AtStartup");
		expect(task?.content).toContain("-UserId 'DELL-LAPTOP\\serge' -LogonType S4U");
		expect(task?.content).toContain("-RestartCount 999");
		expect(task?.content).toContain(`-Execute 'C:\\Program Files\\nodejs\\node.exe' -Argument '"C:\\Users\\serge\\.config\\proagentstore\\pags-up-supervisor.mjs"'`);
		expect(plan.commands).toEqual([expect.objectContaining({ file: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", task?.path] })]);
	});

	it("every OS runs the same supervisor: the installed `pags` script, `up --headless`, as a service", () => {
		for (const ctx of [mac, linux, win]) {
			const supervisor = servicePlan(ctx).files.find((f) => f.path === supervisorPath(ctx));
			expect(supervisor?.content).toContain(JSON.stringify(ctx.script));
			expect(supervisor?.content).toContain('[config.script, "up", "--headless"]');
			expect(supervisor?.content).toContain('PAGS_SERVICE: "1"');
		}
	});
});

describe("installing and removing it (#1141)", () => {
	it("writes every file, runs every command, and an optional one that fails does not fail the install", () => {
		const written: string[] = [];
		const ran: string[] = [];
		const r = installService(linux, {
			write: (p) => written.push(p),
			run: (file, args) => {
				ran.push([file, ...args].join(" "));
				if (file === "loginctl") throw Object.assign(new Error("x"), { stderr: "Could not enable linger: Access denied" });
			},
		});
		expect(r.ok).toBe(true);
		expect(written).toEqual(["/home/serge/.config/proagentstore/pags-up-supervisor.mjs", "/home/serge/.config/systemd/user/pags-up.service"]);
		expect(ran).toHaveLength(3);
		expect(r.lines).toContain("keep it running with nobody logged in: skipped — Could not enable linger: Access denied");
	});

	it("a required command that fails is reported FAILED and the install is not ok (an unelevated Windows shell)", () => {
		const r = installService(win, { write: () => undefined, run: () => { throw Object.assign(new Error("x"), { stderr: "Access is denied." }); } });
		expect(r.ok).toBe(false);
		expect(r.lines.join("\n")).toMatch(/register and start the Scheduled Task: FAILED — Access is denied\./);
	});

	it("--uninstall-service unloads it and removes the files it wrote", () => {
		const removed: string[] = [];
		const ran: string[] = [];
		uninstallService(mac, { remove: (p) => removed.push(p), run: (f, a) => ran.push([f, ...a].join(" ")) });
		expect(ran).toEqual([`launchctl bootout gui/501/${SERVICE_LABEL}`]);
		expect(removed).toEqual(serviceRemovalPlan(mac).files);
		expect(removed).toContain(`/Users/serge/Library/LaunchAgents/${SERVICE_LABEL}.plist`);
	});
});

describe("the supervisor, run for real (#1141)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-supervisor-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("starts `pags up` again every time it exits, backing off between quick failures", async () => {
		// A fake `pags` that records how it was started, then dies at once — a broken update.
		const fake = join(dir, "pags.mjs");
		const starts = join(dir, "starts.log");
		writeFileSync(fake, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(starts)}, JSON.stringify({ args: process.argv.slice(2), service: process.env.PAGS_SERVICE, at: Date.now() }) + "\\n");\nprocess.exit(1);\n`);
		const ctx: ServiceContext = { platform: process.platform, home: dir, nodePath: process.execPath, script: fake, configDir: dir, pathEnv: process.env.PATH ?? "" };
		const supervisor = servicePlan(ctx).files.find((f) => f.path === supervisorPath(ctx));
		writeFileSync(supervisorPath(ctx), supervisor?.content ?? "");

		const child = spawn(process.execPath, [supervisorPath(ctx)], { env: { ...process.env, PAGS_SUPERVISOR_MIN_MS: "100", PAGS_SUPERVISOR_MAX_MS: "400", PAGS_SUPERVISOR_RESET_MS: "600000" }, stdio: "ignore" });
		await new Promise((r) => setTimeout(r, 2_000));
		child.kill();
		await new Promise((r) => child.once("exit", r));

		const runs = readFileSync(starts, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; service: string; at: number });
		expect(runs[0]).toMatchObject({ args: ["up", "--headless"], service: "1" });
		// With no backoff, 100ms apart, there would be ~20 starts in 2s; doubling to a 400ms cap leaves far fewer.
		expect(runs.length).toBeGreaterThanOrEqual(3);
		expect(runs.length).toBeLessThanOrEqual(9);
		const gaps = runs.slice(1).map((r, i) => r.at - runs[i].at);
		expect(gaps.at(-1) ?? 0).toBeGreaterThan(gaps[0] ?? 0);
		expect(readFileSync(join(dir, "pags-up.log"), "utf8")).toMatch(/supervisor: pags up exited \(1\); starting it again/);
	}, 15_000);
});
