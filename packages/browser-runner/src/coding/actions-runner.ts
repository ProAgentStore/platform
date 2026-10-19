/**
 * The GitHub Actions self-hosted runner as a SERVICE on this machine, installed and removed on the
 * platform's instruction (#1209, epic #1113).
 *
 * Install: check the prerequisites a deploy job needs (reported, never assumed), download the
 * actions/runner release for this OS and CPU, `config.sh --unattended` it against the org or repo URL
 * with the labels `pags` and `pags-<node>`, then install and start it as a service (`svc.sh` on
 * macOS/Linux, `config.cmd --runasservice` on Windows). Remove: stop and uninstall the service, then
 * `config remove`. One runner per machine per scope; each lives in its own folder under
 * `~/.proagentstore/actions-runner/`.
 *
 * Jobs, not one relay call: a download and configure outlasts the relay's two-minute ceiling, so the
 * cloud starts a job, gets its id at once, and reads `status` until it settles (the #858 clone shape).
 *
 * The registration/removal token arrives in the request, is passed to `config` as an argument, and is
 * never written anywhere by this module — not to a file, not to the job record (its steps show the
 * command with the token masked), not to a log. What `config` itself stores (`.credentials`,
 * `.runner`) is the RUNNER's long-lived credential, which is how the actions/runner service works.
 *
 * A separate OS user ("ideally", #1113) is not created here: that needs an administrator password on
 * the machine. `runsAs` reports which account the service runs as, so the owner can see it.
 */
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

export type RunnerAction = "install" | "remove";

export interface ActionsRunnerRequest {
	/** `https://github.com/<org>` or `https://github.com/<owner>/<repo>`. */
	url: string;
	/** A registration token (install) or a removal token (remove). Never stored. */
	token: string;
	/** The runner's name in GitHub — the machine's canonical node name. */
	name: string;
	/** Install only: `pags` and `pags-<node>`. */
	labels?: string[];
	/** Install only, org scope only: the runner group to join. */
	runnerGroup?: string;
}

export interface Prerequisite {
	name: string;
	found: boolean;
	/** Why it matters, for a missing one. */
	note?: string;
}

export interface ActionsRunnerJob {
	id: string;
	action: RunnerAction;
	url: string;
	name: string;
	dir: string;
	state: "running" | "done" | "failed";
	/** What was done, in order — commands with the token masked. */
	steps: string[];
	prerequisites: Prerequisite[];
	/** The account the service runs as. */
	runsAs: string;
	/** Whether the service is installed and started (install), or removed (remove). */
	service: "installed" | "removed" | "not_installed" | "needs_admin";
	/** Set when the service step needs a human with admin rights, with the exact command. */
	serviceNote?: string;
	error?: string;
	startedAt: number;
	finishedAt?: number;
}

export interface ActionsRunnerDeps {
	platform: NodeJS.Platform;
	arch: string;
	home: string;
	user: string;
	/** Root or not (Linux `svc.sh install` needs root). */
	isRoot: boolean;
	exists: (path: string) => boolean;
	mkdir: (path: string) => void;
	which: (bin: string) => boolean;
	/** The newest actions/runner version, e.g. "2.329.0". */
	latestVersion: () => Promise<string>;
	/** Download `url` to `dest`. */
	download: (url: string, dest: string) => Promise<void>;
	/** Run a program (no shell) in `cwd`; rejects with its stderr. */
	exec: (file: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
	now: () => number;
	newId: () => string;
}

const URL_SHAPE = /^https:\/\/github\.com\/([A-Za-z0-9-]+)(?:\/([A-Za-z0-9._-]+))?$/;

/** The folder a scope's runner lives in: `<home>/.proagentstore/actions-runner/<org>` or `<owner>--<repo>`. */
export function runnerDir(home: string, url: string): string {
	const m = URL_SHAPE.exec(url);
	if (!m) throw new Error(`Not a GitHub org or repo URL: ${url}`);
	return join(home, ".proagentstore", "actions-runner", m[2] ? `${m[1]}--${m[2]}` : m[1]);
}

/** The release asset for this OS/CPU, or an error naming what is unsupported. */
export function runnerAsset(platform: NodeJS.Platform, arch: string, version: string): { file: string; url: string; zip: boolean } {
	const os = platform === "darwin" ? "osx" : platform === "linux" ? "linux" : platform === "win32" ? "win" : null;
	const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : arch === "arm" ? "arm" : null;
	if (!os || !cpu) throw new Error(`The actions/runner has no release for ${platform}/${arch}.`);
	const zip = os === "win";
	const file = `actions-runner-${os}-${cpu}-${version}.${zip ? "zip" : "tar.gz"}`;
	return { file, url: `https://github.com/actions/runner/releases/download/v${version}/${file}`, zip };
}

/** What a deploy job on this machine needs — reported, so a missing one is a named gap, not a failed job. */
export function checkPrerequisites(deps: Pick<ActionsRunnerDeps, "which">): Prerequisite[] {
	const want: Array<[string, string]> = [
		["git", "checkout steps"],
		["node", "build steps (actions/setup-node also installs it per job)"],
		["pnpm", "pnpm install / build"],
		["aws", "deploys that run `aws s3 sync` (the PAS app deploy)"],
	];
	return want.map(([name, note]) => (deps.which(name) ? { name, found: true } : { name, found: false, note: `not on PATH — needed for ${note}` }));
}

const mask = (args: string[], token: string) => args.map((a) => (a === token ? "***" : a));

const jobs = new Map<string, ActionsRunnerJob>();

/** For tests. */
export function clearRunnerJobs(): void {
	jobs.clear();
}

function validate(req: ActionsRunnerRequest, action: RunnerAction): void {
	if (!URL_SHAPE.test(req.url ?? "")) throw new Error("url must be https://github.com/<org> or https://github.com/<owner>/<repo>");
	if (typeof req.token !== "string" || req.token.length < 10 || /\s/.test(req.token)) throw new Error(`token must be a GitHub runner ${action === "install" ? "registration" : "removal"} token`);
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(req.name ?? "")) throw new Error("name must be the machine's runner name (letters, digits, . _ -; at most 64)");
	for (const l of req.labels ?? []) if (!/^[A-Za-z0-9._-]{1,100}$/.test(l)) throw new Error(`label ${JSON.stringify(l)} is not a valid runner label`);
	if (req.runnerGroup !== undefined && !/^[A-Za-z0-9 ._-]{1,100}$/.test(req.runnerGroup)) throw new Error("runnerGroup is not a valid runner group name");
}

/**
 * Start (or join) an install or removal. Answers at once with the job; {@link runnerJob} reads it back.
 * One job per folder: asking again while one runs returns it rather than starting a second.
 */
export function startRunnerJob(action: RunnerAction, req: ActionsRunnerRequest, deps: ActionsRunnerDeps): ActionsRunnerJob {
	validate(req, action);
	const dir = runnerDir(deps.home, req.url);
	const running = [...jobs.values()].find((j) => j.dir === dir && j.state === "running");
	if (running) return running;
	const job: ActionsRunnerJob = {
		id: deps.newId(),
		action,
		url: req.url,
		name: req.name,
		dir,
		state: "running",
		steps: [],
		prerequisites: checkPrerequisites(deps),
		runsAs: deps.user,
		service: "not_installed",
		startedAt: deps.now(),
	};
	jobs.set(job.id, job);
	void (action === "install" ? runInstall(job, req, deps) : runRemove(job, req, deps));
	return job;
}

export function runnerJob(id: string): ActionsRunnerJob | null {
	return jobs.get(id) ?? null;
}

function finish(job: ActionsRunnerJob, deps: ActionsRunnerDeps, error?: unknown): ActionsRunnerJob {
	job.finishedAt = deps.now();
	if (error === undefined) job.state = "done";
	else {
		job.state = "failed";
		job.error = error instanceof Error ? error.message : String(error);
	}
	return job;
}

async function step(job: ActionsRunnerJob, deps: ActionsRunnerDeps, file: string, args: string[], token: string): Promise<void> {
	job.steps.push(`${file} ${mask(args, token).join(" ")}`);
	await deps.exec(file, args, job.dir);
}

/** Install, configure and start. Never rejects: every outcome is written onto `job`. */
export async function runInstall(job: ActionsRunnerJob, req: ActionsRunnerRequest, deps: ActionsRunnerDeps): Promise<ActionsRunnerJob> {
	const win = deps.platform === "win32";
	try {
		if (deps.exists(join(job.dir, ".runner"))) {
			job.steps.push(`already configured in ${job.dir} — not reinstalled (remove it first to re-register)`);
			job.service = "installed";
			return finish(job, deps);
		}
		deps.mkdir(job.dir);
		const version = await deps.latestVersion();
		const asset = runnerAsset(deps.platform, deps.arch, version);
		const archive = join(job.dir, asset.file);
		job.steps.push(`download ${asset.url}`);
		await deps.download(asset.url, archive);
		if (asset.zip) await step(job, deps, "powershell", ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${archive}' -DestinationPath '${job.dir}'`], req.token);
		else await step(job, deps, "tar", ["xzf", archive, "-C", job.dir], req.token);
		const config = [
			"--unattended",
			"--url",
			req.url,
			"--token",
			req.token,
			"--name",
			req.name,
			"--labels",
			(req.labels ?? []).join(","),
			"--work",
			"_work",
			"--replace",
			...(req.runnerGroup ? ["--runnergroup", req.runnerGroup] : []),
			...(win ? ["--runasservice"] : []),
		];
		await step(job, deps, win ? join(job.dir, "config.cmd") : join(job.dir, "config.sh"), config, req.token);
		if (win) {
			// `--runasservice` installs and starts the Windows service inside `config.cmd`. It needs an
			// elevated prompt; without one config itself fails, and that failure is the job's error.
			job.service = "installed";
			return finish(job, deps);
		}
		if (deps.platform === "linux" && !deps.isRoot) {
			job.service = "needs_admin";
			job.serviceNote = `The runner is configured but its service needs root on Linux. On this machine run: cd ${job.dir} && sudo ./svc.sh install ${deps.user} && sudo ./svc.sh start`;
			return finish(job, deps);
		}
		await step(job, deps, join(job.dir, "svc.sh"), ["install"], req.token);
		await step(job, deps, join(job.dir, "svc.sh"), ["start"], req.token);
		job.service = "installed";
		return finish(job, deps);
	} catch (e) {
		return finish(job, deps, e);
	}
}

/** Stop and uninstall the service, then deregister. Never rejects. */
export async function runRemove(job: ActionsRunnerJob, req: ActionsRunnerRequest, deps: ActionsRunnerDeps): Promise<ActionsRunnerJob> {
	const win = deps.platform === "win32";
	try {
		if (!deps.exists(join(job.dir, ".runner"))) {
			job.steps.push(`no runner configured in ${job.dir} — nothing to remove`);
			job.service = "removed";
			return finish(job, deps);
		}
		if (!win) {
			if (deps.platform === "linux" && !deps.isRoot) {
				job.service = "needs_admin";
				job.serviceNote = `Stopping the service needs root on Linux. On this machine run: cd ${job.dir} && sudo ./svc.sh stop && sudo ./svc.sh uninstall — then ask again to deregister.`;
				return finish(job, deps);
			}
			await step(job, deps, join(job.dir, "svc.sh"), ["stop"], req.token).catch(() => job.steps.push("svc.sh stop: was not running"));
			await step(job, deps, join(job.dir, "svc.sh"), ["uninstall"], req.token);
		}
		// On Windows `config.cmd remove` also removes the service it installed.
		await step(job, deps, win ? join(job.dir, "config.cmd") : join(job.dir, "config.sh"), ["remove", "--token", req.token], req.token);
		job.service = "removed";
		return finish(job, deps);
	} catch (e) {
		return finish(job, deps, e);
	}
}

/** The runners this machine has configured, managed or not — read from each folder's `.runner`. */
export interface InstalledRunner {
	dir: string;
	/** Installed by the platform under ~/.proagentstore/actions-runner, or found elsewhere (a hand install). */
	managed: boolean;
	name: string | null;
	url: string | null;
}

export function readInstalledRunner(dir: string, managed: boolean, readText: (path: string) => string | null): InstalledRunner | null {
	const raw = readText(join(dir, ".runner"));
	if (raw === null) return null;
	try {
		// `.runner` is written by config with a UTF-8 BOM on some platforms.
		const r = JSON.parse(raw.replace(/^﻿/, "")) as { agentName?: unknown; gitHubUrl?: unknown };
		return { dir, managed, name: typeof r.agentName === "string" ? r.agentName : null, url: typeof r.gitHubUrl === "string" ? r.gitHubUrl : null };
	} catch {
		return { dir, managed, name: null, url: null }; // configured, but its record is unreadable: still a runner here
	}
}

/** The real machine. */
export function liveRunnerDeps(): ActionsRunnerDeps {
	const win = process.platform === "win32";
	return {
		platform: process.platform,
		arch: process.arch,
		home: homedir(),
		user: userInfo().username,
		isRoot: typeof process.getuid === "function" && process.getuid() === 0,
		exists: existsSync,
		mkdir: (path) => mkdirSync(path, { recursive: true }),
		which: (bin) => spawnSync(win ? "where" : "which", [bin], { stdio: "ignore" }).status === 0,
		latestVersion: async () => {
			const res = await fetch("https://api.github.com/repos/actions/runner/releases/latest", { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
			const tag = res.ok ? ((await res.json()) as { tag_name?: unknown }).tag_name : null;
			if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Could not read the latest actions/runner release (GitHub answered ${res.status}).`);
			return tag.slice(1);
		},
		download: async (url, dest) => {
			const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
			if (!res.ok || !res.body) throw new Error(`Download of ${url} failed: ${res.status}`);
			await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(dest));
		},
		exec: async (file, args, cwd) => {
			try {
				return await run(file, args, { cwd, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, shell: win && file.endsWith(".cmd") });
			} catch (e) {
				const err = e as { stderr?: string; stdout?: string; message?: string };
				// The command line is NOT in this message: it would carry the token. File name and output only.
				throw new Error(`${file.split(/[\\/]/).pop()} failed: ${(err.stderr || err.stdout || err.message || "").trim().split("\n").slice(-5).join(" | ")}`);
			}
		},
		now: Date.now,
		newId: randomUUID,
	};
}

/** Every runner configured on this machine: the platform's own, and a hand install at ~/actions-runner. */
export function installedRunners(home = homedir()): InstalledRunner[] {
	const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
	const base = join(home, ".proagentstore", "actions-runner");
	const managed = existsSync(base) ? readdirSync(base).map((d) => readInstalledRunner(join(base, d), true, readText)) : [];
	return [...managed, readInstalledRunner(join(home, "actions-runner"), false, readText)].filter((r): r is InstalledRunner => r !== null);
}

/**
 * The runner's `/coding/actions-runner/*` routes: start an install or removal job (202), or read one
 * back together with what is installed (200). A bad request is a 400 with the reason.
 */
export function routeActionsRunner(path: string, body: Record<string, unknown>, deps: () => ActionsRunnerDeps = liveRunnerDeps): { status: number; body: unknown } {
	try {
		if (path === "/coding/actions-runner/install" || path === "/coding/actions-runner/remove") {
			return { status: 202, body: startRunnerJob(path.endsWith("install") ? "install" : "remove", body as unknown as ActionsRunnerRequest, deps()) };
		}
		if (path === "/coding/actions-runner/status") {
			return { status: 200, body: { job: typeof body.jobId === "string" ? runnerJob(body.jobId) : null, installed: installedRunners() } };
		}
		return { status: 404, body: { error: "Not found" } };
	} catch (e: unknown) {
		return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
	}
}
