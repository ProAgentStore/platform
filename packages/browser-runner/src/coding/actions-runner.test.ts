/**
 * #1209 — installing and removing the GitHub Actions runner service, with every system effect faked
 * and recorded: which commands ran, in which folder, and that the token appears in none of what the
 * job reports back.
 */
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type ActionsRunnerDeps, type ActionsRunnerJob, CAPABILITY_TOOLS, clearRunnerJobs, detectCapabilities, detectCapabilityLabels, macosTierLabels, readInstalledRunner, routeActionsRunner, runnerAsset, runnerDir, runnerJob, startRunnerJob } from "./actions-runner.js";

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
	it("macOS: downloads this CPU's release, configures with the pags labels, installs and starts the service — and never reports the token", async () => {
		const d = fake();
		const job = await settle(startRunnerJob("install", { ...ORG, runnerGroup: "pags-pink-laptop" }, d));
		const dir = join(HOME, ".proagentstore", "actions-runner", "proappstore-online");
		expect(job).toMatchObject({ state: "done", service: "installed", dir, runsAs: "serge" });
		expect(d.downloads).toEqual(["https://github.com/actions/runner/releases/download/v2.329.0/actions-runner-osx-arm64-2.329.0.tar.gz"]);
		expect(d.ran.map((r) => r.file.split("/").pop())).toEqual(["tar", "config.sh", "svc.sh", "svc.sh"]);
		const config = d.ran[1].args;
		expect(config).toEqual(expect.arrayContaining(["--unattended", "--url", ORG.url, "--name", "pink-laptop", "--labels", "pags,pags-pink-laptop", "--runnergroup", "pags-pink-laptop"]));
		expect(config[config.indexOf("--token") + 1]).toBe(TOKEN); // config needs it…
		expect(JSON.stringify(job)).not.toContain(TOKEN); // …and nothing reported back carries it
		expect(job.steps.find((s) => s.includes("config.sh"))).toContain("--token ***");
		expect(d.ran.slice(2).map((r) => r.args[0])).toEqual(["install", "start"]);
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

	it("Windows: the zip is expanded and config.cmd installs the service itself (--runasservice)", async () => {
		const d = fake({ platform: "win32", arch: "x64" });
		const job = await settle(startRunnerJob("install", ORG, d));
		expect(d.downloads[0]).toMatch(/actions-runner-win-x64-2\.329\.0\.zip$/);
		expect(d.ran.map((r) => r.file.split(/[\\/]/).pop())).toEqual(["powershell", "config.cmd"]);
		expect(d.ran[1].args).toContain("--runasservice");
		expect(job.service).toBe("installed");
	});

	it("is idempotent: a folder already configured is not reinstalled", async () => {
		const d = fake();
		d.files.add(join(runnerDir(HOME, ORG.url), ".runner"));
		const job = await settle(startRunnerJob("install", ORG, d));
		expect(job).toMatchObject({ state: "done", service: "installed" });
		expect(d.ran).toEqual([]);
		expect(d.downloads).toEqual([]);
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
	it("stops and uninstalls the service, then deregisters with the removal token", async () => {
		const d = fake();
		d.files.add(join(runnerDir(HOME, ORG.url), ".runner"));
		const job = await settle(startRunnerJob("remove", ORG, d));
		expect(job).toMatchObject({ state: "done", service: "removed" });
		expect(d.ran.map((r) => `${r.file.split("/").pop()} ${r.args[0]}`)).toEqual(["svc.sh stop", "svc.sh uninstall", "config.sh remove"]);
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
