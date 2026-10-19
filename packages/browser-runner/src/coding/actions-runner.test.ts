/**
 * #1209 — installing and removing the GitHub Actions runner service, with every system effect faked
 * and recorded: which commands ran, in which folder, and that the token appears in none of what the
 * job reports back.
 */
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type ActionsRunnerDeps, type ActionsRunnerJob, clearRunnerJobs, readInstalledRunner, routeActionsRunner, runnerAsset, runnerDir, runnerJob, startRunnerJob } from "./actions-runner.js";

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
