/**
 * #1209 — installing and removing the GitHub Actions runner service, with every system effect faked
 * and recorded: which commands ran, in which folder, and that the token appears in none of what the
 * job reports back.
 */
import { join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeMachine } from "./windows-runner.fixture.js";
import { type ActionsRunnerDeps, type ActionsRunnerJob, CAPABILITY_TOOLS, clearRunnerJobs, detectCapabilities, detectCapabilityLabels, macosTierLabels, readInstalledRunner, requestLocalActionsRecovery, routeActionsRunner, runnerAsset, runnerDir, runnerJob, startRunnerJob } from "./actions-runner.js";

const TOKEN = "AABBCCDDEEFF00112233445566778899";
const HOME = "/Users/pags";

interface Fake extends ActionsRunnerDeps {
	ran: Array<{ file: string; args: string[]; cwd: string }>;
	downloads: string[];
	files: Set<string>;
}

function fake(over: Partial<ActionsRunnerDeps> = {}): Fake {
	let n = 0;
	const f: Fake = {
		ran: [],
		downloads: [],
		files: new Set(),
		readText: () => JSON.stringify({ agentName: ORG.name, gitHubUrl: ORG.url }),
		platform: "darwin",
		arch: "arm64",
		home: HOME,
		user: "serge",
		isRoot: false,
		exists: (p) => f.files.has(p),
		mkdir: () => undefined,
		which: (bin) => bin !== "aws",
		latestVersion: async () => "2.329.0",
		download: async (url) => {
			f.downloads.push(url);
		},
		exec: async (file, args, cwd) => {
			f.ran.push({ file, args, cwd });
			return { stdout: "", stderr: "" };
		},
		now: () => 1_000,
		newId: () => `job-${++n}`,
		...over,
	};
	return f;
}

const settle = async (job: ActionsRunnerJob) => {
	for (let i = 0; i < 50 && runnerJob(job.id)?.state === "running"; i++) await new Promise((r) => setTimeout(r, 1));
	return runnerJob(job.id) as ActionsRunnerJob;
};

const ORG = { url: "https://github.com/proappstore-online", token: TOKEN, name: "pink-laptop", labels: ["pags", "pags-pink-laptop"] };

beforeEach(() => clearRunnerJobs());

describe("install (#1209)", () => {
	it("macOS: configures this CPU's runner, then gives the exact local system-service step without a login-only service", async () => {
		const d = fake();
		const job = await settle(startRunnerJob("install", { ...ORG, runnerGroup: "pags-pink-laptop" }, d));
		const dir = join(HOME, ".proagentstore", "actions-runner", "proappstore-online");
		expect(job).toMatchObject({ state: "done", service: "needs_admin", dir, runsAs: "serge", serviceNote: expect.stringContaining(`pags actions service install --dir ${dir}`) });
		expect(d.downloads).toEqual(["https://github.com/actions/runner/releases/download/v2.329.0/actions-runner-osx-arm64-2.329.0.tar.gz"]);
		expect(d.ran.map((r) => r.file.split("/").pop())).toEqual(["tar", "config.sh"]);
		const config = d.ran[1].args;
		expect(config).toEqual(expect.arrayContaining(["--unattended", "--url", ORG.url, "--name", "pink-laptop", "--labels", "pags,pags-pink-laptop", "--runnergroup", "pags-pink-laptop"]));
		expect(config[config.indexOf("--token") + 1]).toBe(TOKEN); // config needs it…
		expect(JSON.stringify(job)).not.toContain(TOKEN); // …and nothing reported back carries it
		expect(job.steps.find((s) => s.includes("config.sh"))).toContain("--token ***");
		expect(d.ran.slice(2)).toEqual([]);
	});

	it("reports a missing prerequisite instead of assuming it", async () => {
		const job = await settle(startRunnerJob("install", ORG, fake()));
		expect(job.prerequisites.find((p) => p.name === "aws")).toMatchObject({ found: false, note: expect.stringContaining("aws s3 sync") });
		expect(job.prerequisites.filter((p) => p.found).map((p) => p.name)).toEqual(["git", "node", "pnpm"]);
	});

	it("Linux without root: configured, and the service step is handed to the owner with the exact command", async () => {
		const d = fake({ platform: "linux", arch: "x64" });
		const job = await settle(startRunnerJob("install", ORG, d));
		expect(job).toMatchObject({ state: "done", service: "needs_admin", serviceNote: expect.stringContaining("sudo ./svc.sh install serge") });
		expect(d.ran.map((r) => r.file.split("/").pop())).toEqual(["tar", "config.sh"]);
	});

	it("Windows: installs under ProgramData with the root's ACL set first, then expands the zip and has config.cmd install the service (#1272)", async () => {
		const win = fakeMachine();
		const d = fake({ platform: "win32", arch: "x64", windows: win });
		const job = await settle(startRunnerJob("install", ORG, d));
		expect(job.state).toBe("done");
		expect(job.dir).toBe("C:\\ProgramData\\ProAgentStore\\actions-runner\\proappstore-online");
		expect(job.dir.toLowerCase()).not.toContain("users");
		expect(d.downloads[0]).toMatch(/actions-runner-win-x64-2\.329\.0\.zip$/);
		expect(d.ran.map((r) => r.file.split(/[\\/]/).pop())).toEqual(["powershell", "config.cmd"]);
		expect(d.ran[1].args).toEqual(expect.arrayContaining(["--runasservice", "--windowslogonaccount", "NT AUTHORITY\\NETWORK SERVICE"]));
		// The ACL was set (and proven) before anything was downloaded into the root.
		expect(win.calls.some((c) => c.file === "icacls" && c.args.includes("/grant:r"))).toBe(true);
		expect(job.steps.findIndex((x) => x.includes("icacls"))).toBeLessThan(job.steps.findIndex((x) => x.startsWith("download")));
		expect(job.runsAs).toBe("NT AUTHORITY\\NETWORK SERVICE");
		expect(job.service).toBe("installed");
		expect(JSON.stringify(job)).not.toContain(TOKEN);
	});

	it("Windows: never installs into a profile — without the machine-root deps it refuses rather than falling back (#1272)", () => {
		const d = fake({ platform: "win32", arch: "x64" });
		expect(() => startRunnerJob("install", ORG, d)).toThrow(/never placed in a user profile/);
		expect(d.downloads).toEqual([]);
	});

	it("Windows: a failed ACL check stops the install before anything is downloaded or configured (#1272)", async () => {
		const win = fakeMachine();
		win.ignoreGrants.value = true;
		const d = fake({ platform: "win32", arch: "x64", windows: win });
		const job = await settle(startRunnerJob("install", ORG, d));
		expect(job.state).toBe("failed");
		expect(job.error).toMatch(/does not have the required permissions/);
		expect(d.downloads).toEqual([]);
		expect(d.ran).toEqual([]);
	});

	it("Windows: re-running on a configured runner re-verifies the root and reinstalls nothing (#1272)", async () => {
		const win = fakeMachine();
		const d = fake({ platform: "win32", arch: "x64", windows: win });
		const first = await settle(startRunnerJob("install", ORG, d));
		d.files.add(join(first.dir, ".runner"));
		const grantsBefore = win.calls.filter((c) => c.args.includes("/grant:r")).length;
		const again = await settle(startRunnerJob("install", ORG, d));
		expect(again.steps.join("\n")).toMatch(/already configured/);
		expect(again.steps).toContain("ACL already satisfies the policy");
		expect(win.calls.filter((c) => c.args.includes("/grant:r")).length).toBe(grantsBefore);
		expect(d.downloads).toHaveLength(1);
	});

	it("is idempotent: a folder already configured is not reinstalled", async () => {
		const d = fake();
		d.files.add(join(runnerDir(HOME, ORG.url), ".runner"));
		const job = await settle(startRunnerJob("install", ORG, d));
		expect(job).toMatchObject({ state: "done", service: "needs_admin" });
		expect(d.ran).toEqual([]);
		expect(d.downloads).toEqual([]);
	});

	it("refuses adoption when .runner belongs to a different name or GitHub scope", async () => {
		const d = fake({ readText: () => JSON.stringify({ agentName: "other", gitHubUrl: ORG.url }) });
		d.files.add(join(runnerDir(HOME, ORG.url), ".runner"));
		const job = await settle(startRunnerJob("install", ORG, d));
		expect(job).toMatchObject({ state: "failed", error: expect.stringContaining("does not match") });
		expect(d.ran).toEqual([]);
	});

	it("asking again while a job runs joins it rather than starting a second", () => {
		const d = fake({ download: () => new Promise(() => undefined) });
		const a = startRunnerJob("install", ORG, d);
		expect(startRunnerJob("install", ORG, d).id).toBe(a.id);
	});

	it("a failed step fails the job with the program's own reason — and the token is in neither the error nor the steps", async () => {
		const d = fake({
			exec: async (file) => {
				if (file.endsWith("config.sh")) throw new Error("config.sh failed: Http response code: NotFound from 'POST https://api.github.com/actions/runner-registration'");
				return { stdout: "", stderr: "" };
			},
		});
		const job = await settle(startRunnerJob("install", ORG, d));
		expect(job).toMatchObject({ state: "failed", error: expect.stringContaining("NotFound") });
		expect(JSON.stringify(job)).not.toContain(TOKEN);
	});

	it("refuses a request that is not a GitHub org/repo URL, a token, and a valid name", () => {
		const d = fake();
		expect(() => startRunnerJob("install", { ...ORG, url: "https://evil.example/x" }, d)).toThrow(/github\.com/);
		expect(() => startRunnerJob("install", { ...ORG, token: "x" }, d)).toThrow(/registration token/);
		expect(() => startRunnerJob("install", { ...ORG, name: "a b" }, d)).toThrow(/runner name/);
		expect(() => startRunnerJob("install", { ...ORG, labels: ["ok", "no spaces"] }, d)).toThrow(/label/);
	});
});

describe("remove (#1209)", () => {
	it("macOS requires exact local PAGS service removal before deregistration", async () => {
		const d = fake();
		d.files.add(join(runnerDir(HOME, ORG.url), ".runner"));
		const job = await settle(startRunnerJob("remove", ORG, d));
		expect(job).toMatchObject({ state: "done", service: "needs_admin", serviceNote: expect.stringContaining("pags actions service remove --dir") });
		expect(d.ran).toEqual([]);
		expect(JSON.stringify(job)).not.toContain(TOKEN);
	});

	it("nothing configured: nothing to remove, and nothing is run", async () => {
		const d = fake();
		expect(await settle(startRunnerJob("remove", ORG, d))).toMatchObject({ state: "done", service: "removed" });
		expect(d.ran).toEqual([]);
	});
});

describe("shapes", () => {
	it("one folder per scope: an org, or owner--repo", () => {
		expect(runnerDir(HOME, "https://github.com/ProAgentStore")).toBe(join(HOME, ".proagentstore", "actions-runner", "ProAgentStore"));
		expect(runnerDir(HOME, "https://github.com/proappstore-online/interns")).toBe(join(HOME, ".proagentstore", "actions-runner", "proappstore-online--interns"));
	});

	it("names the release asset per OS/CPU, and refuses one actions/runner does not ship", () => {
		expect(runnerAsset("linux", "arm64", "2.329.0").file).toBe("actions-runner-linux-arm64-2.329.0.tar.gz");
		expect(() => runnerAsset("freebsd", "x64", "2.329.0")).toThrow(/no release/);
	});

	it("reads a configured runner's .runner, BOM and all", () => {
		const r = readInstalledRunner("/x", false, () => '﻿{"agentName":"pink-laptop","gitHubUrl":"https://github.com/proappstore-online/interns"}');
		expect(r).toEqual({ dir: "/x", managed: false, name: "pink-laptop", url: "https://github.com/proappstore-online/interns" });
		expect(readInstalledRunner("/y", true, () => null)).toBeNull();
	});
});

describe("routes (#1209)", () => {
	it("install answers 202 with the job; a bad request is a 400 with the reason; status reads the job back", () => {
		const d = fake({ download: () => new Promise(() => undefined) });
		const started = routeActionsRunner("/coding/actions-runner/install", { ...ORG }, () => d);
		expect(started.status).toBe(202);
		const id = (started.body as ActionsRunnerJob).id;
		expect(routeActionsRunner("/coding/actions-runner/install", { ...ORG, url: "nope" }, () => d)).toMatchObject({ status: 400, body: { error: expect.stringContaining("github.com") } });
		expect((routeActionsRunner("/coding/actions-runner/status", { jobId: id }, () => d).body as { job: ActionsRunnerJob }).job.id).toBe(id);
		expect(routeActionsRunner("/coding/actions-runner/other", {}, () => d).status).toBe(404);
	});
});

describe("explicit recovery request (#1367)", () => {
	it("queues one tokenless request for the exact managed scope and preserves it on a repeat call", () => {
		const home = mkdtempSync(join(tmpdir(), "pags-actions-recover-"));
		try {
			const dir = runnerDir(home, ORG.url);
			const local = join(dir, ".pags-supervisor");
			mkdirSync(local, { recursive: true });
			writeFileSync(join(dir, ".runner"), JSON.stringify({ gitHubUrl: ORG.url, agentName: ORG.name }));
			writeFileSync(join(dir, ".credentials"), "private");
			writeFileSync(join(dir, "runsvc.sh"), "#!/bin/sh\n");
			writeFileSync(join(local, "config.json"), JSON.stringify({ version: 1, acRecoveryEnabled: true }));
			writeFileSync(join(local, "status.json"), JSON.stringify({ updatedAt: Date.now(), supervisorPid: process.pid, activeJob: false }));
			const deps = { home, exists: (path: string) => { try { readFileSync(path); return true; } catch { return false; } } };
			const first = requestLocalActionsRecovery(ORG.url, deps);
			const again = requestLocalActionsRecovery(ORG.url, deps);
			expect(first).toMatchObject({ reason: "manual", state: "queued" });
			expect(again.id).toBe(first.id);
			expect(JSON.parse(readFileSync(join(local, "recover.json"), "utf8"))).toEqual({ id: first.id, reason: "manual", requestedAt: first.requestedAt });
			writeFileSync(join(local, "status.json"), JSON.stringify({ updatedAt: Date.now(), supervisorPid: process.pid, activeJob: false, lastManualRequestId: first.id, lastRecovery: { id: first.id, state: "restarting" } }));
			expect(requestLocalActionsRecovery(ORG.url, deps).id).toBe(first.id);
			writeFileSync(join(local, "status.json"), JSON.stringify({ updatedAt: Date.now(), supervisorPid: process.pid, activeJob: false, lastManualRequestId: first.id, lastRecovery: { id: first.id, state: "ready", completedAt: Date.now() } }));
			writeFileSync(join(local, "recover-write.lock"), JSON.stringify({ pid: 99999999, at: Date.now() - 60_000, nonce: "abandoned" }));
			const second = requestLocalActionsRecovery(ORG.url, deps);
			expect(second.id).not.toBe(first.id);
			expect(JSON.parse(readFileSync(join(local, "recover.json"), "utf8")).id).toBe(second.id);
			expect(deps.exists(join(local, "recover-write.lock"))).toBe(false);
			expect(() => requestLocalActionsRecovery("https://github.com/other", deps)).toThrow(/fully configured/);
		} finally { rmSync(home, { recursive: true, force: true }); }
	});
});

// ── #1260: capability labels ─────────────────────────────────────────────────────────────────────────

/** A machine with exactly these tools on PATH and these OS probe answers. */
const machine = (tools: string[], platform: NodeJS.Platform = "darwin", probes: Record<string, string | null> = {}) => ({
	platform,
	which: (bin: string) => tools.includes(bin),
	probe: (file: string, args: string[]) => probes[`${file} ${args.join(" ")}`] ?? null,
});

describe("detectCapabilityLabels (#1260)", () => {
	it("a has-<tool> label for each known CI tool on PATH, and none for the rest", () => {
		const labels = detectCapabilityLabels(machine(["git", "node", "pnpm", "jq", "brew"], "linux"));
		expect(labels).toEqual(["has-brew", "has-jq", "has-node", "has-pnpm", "has-git"]);
		expect(labels).not.toContain("has-flutter");
	});

	it("the tiny-laptop of the incident (Monterey, no Homebrew, no jq): git and node only, tiers up to macos-12+, and a warning about Flutter", () => {
		const r = detectCapabilities(machine(["git", "node", "xcode-select"], "darwin", { "sw_vers -productVersion": "12.7.6", "xcode-select -p": "/Library/Developer/CommandLineTools" }));
		expect(r.labels).toEqual(["has-node", "has-git", "has-xcode", "macos-11+", "macos-12+"]);
		expect(r.labels).not.toContain("has-jq");
		expect(r.labels).not.toContain("has-brew");
		expect(r.labels).not.toContain("macos-14+");
		expect(r.missing.map((m) => m.tool)).toEqual(["brew", "jq", "flutter", "dart"]);
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toMatch(/macOS 12\.7\.6 is older than 14.*Flutter/);
		expect(r.os).toEqual({ platform: "darwin", version: "12.7.6" });
	});

	it("a current Mac with everything carries every tier it meets, so a job needing macos-13+ can still use it", () => {
		const r = detectCapabilities(machine(["brew", "jq", "flutter", "dart", "git", "xcode-select", "docker"], "darwin", { "sw_vers -productVersion": "15.1", "xcode-select -p": "/Applications/Xcode.app/Contents/Developer" }));
		expect(r.labels).toEqual(expect.arrayContaining(["has-brew", "has-jq", "has-flutter", "has-dart", "has-docker", "has-xcode", "macos-11+", "macos-13+", "macos-14+", "macos-15+"]));
		expect(r.labels).not.toContain("macos-26+");
		expect(r.missing).toEqual([]);
		expect(r.warnings).toEqual([]);
	});

	it("macOS 26 (Apple skipped 16-25) meets every earlier tier and its own", () => {
		expect(macosTierLabels(26)).toEqual(["macos-11+", "macos-12+", "macos-13+", "macos-14+", "macos-15+", "macos-26+"]);
		expect(macosTierLabels(27)).toEqual(["macos-11+", "macos-12+", "macos-13+", "macos-14+", "macos-15+", "macos-26+", "macos-27+"]);
		expect(macosTierLabels(null)).toEqual([]);
	});

	it("has-xcode needs the developer directory, not just the binary: xcode-select present but -p empty or failing is not Xcode", () => {
		for (const probes of [{}, { "xcode-select -p": "" }, { "xcode-select -p": "error: unable to get active developer directory" }]) {
			expect(detectCapabilityLabels(machine(["xcode-select"], "darwin", probes))).not.toContain("has-xcode");
		}
		expect(detectCapabilityLabels(machine(["xcode-select"], "linux", { "xcode-select -p": "/x" }))).not.toContain("has-xcode");
	});

	it("only macOS gets a tier label; an unreadable version gets none", () => {
		expect(detectCapabilityLabels(machine([], "linux", { "sw_vers -productVersion": "14.0" })).some((l) => l.startsWith("macos-"))).toBe(false);
		expect(detectCapabilityLabels(machine([], "win32")).some((l) => l.startsWith("macos-"))).toBe(false);
		expect(detectCapabilityLabels(machine([], "darwin", { "sw_vers -productVersion": "garbage" })).some((l) => l.startsWith("macos-"))).toBe(false);
		expect(detectCapabilityLabels({ platform: "darwin", which: () => false })).toEqual([]); // no probe available at all
	});

	it("every label it can emit is a valid runner label that the install request accepts", () => {
		const everything = detectCapabilities(machine(CAPABILITY_TOOLS.map((t) => t.tool).concat("xcode-select"), "darwin", { "sw_vers -productVersion": "26.0", "xcode-select -p": "/x" }));
		expect(everything.labels.length).toBeGreaterThan(10);
		for (const l of everything.labels) expect(l, l).toMatch(/^[A-Za-z0-9._+-]{1,100}$/);
		const d = fake();
		expect(() => startRunnerJob("install", { ...ORG, labels: ["pags", "pags-pink-laptop", ...everything.labels] }, d)).not.toThrow();
	});
});

describe("the capabilities route and the install labels (#1260)", () => {
	it("POST /coding/actions-runner/capabilities answers 200 with the machine's report", () => {
		const d = fake({ probe: (file, args) => (`${file} ${args.join(" ")}` === "sw_vers -productVersion" ? "14.2" : null) });
		const r = routeActionsRunner("/coding/actions-runner/capabilities", {}, () => d);
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ labels: expect.arrayContaining(["has-git", "has-node", "macos-14+"]), os: { platform: "darwin", version: "14.2" } });
	});

	it("an install carries the capability labels to config.sh (and a `+` in a label is accepted)", async () => {
		const d = fake();
		const job = await settle(startRunnerJob("install", { ...ORG, labels: ["pags", "pags-pink-laptop", "has-jq", "macos-14+"] }, d));
		expect(job.state).toBe("done");
		const config = d.ran.find((r) => r.file.endsWith("config.sh"));
		expect(config?.args[config.args.indexOf("--labels") + 1]).toBe("pags,pags-pink-laptop,has-jq,macos-14+");
	});

	it("still refuses a label with a space or shell characters", () => {
		for (const bad of ["has jq", "a;b", "x$y", "has-jq,rm"]) expect(() => startRunnerJob("install", { ...ORG, labels: [bad] }, fake())).toThrow(/not a valid runner label/);
	});
});

describe("Windows readiness rides the capabilities report (#1272)", () => {
	it("a Windows machine's capabilities carry its readiness; other machines' do not", () => {
		const readiness = { platform: "win32" as const, userProfile: "C:\\Users\\admin", probe: () => "Microsoft Windows [Version 10.0.19045.1]", whichPath: (b: string) => (b === "aws" ? null : `C:\\Program Files\\${b}.exe`) };
		const win = routeActionsRunner("/coding/actions-runner/capabilities", {}, () => fake({ platform: "win32", readiness }));
		expect((win.body as { windows: { ready: boolean; reasons: Array<{ tool?: string }> } }).windows).toMatchObject({ ready: false, reasons: [{ tool: "aws" }] });
		const mac = routeActionsRunner("/coding/actions-runner/capabilities", {}, () => fake());
		expect((mac.body as { windows?: unknown }).windows).toBeUndefined();
	});
});
