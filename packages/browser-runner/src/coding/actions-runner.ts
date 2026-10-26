/**
 * The GitHub Actions self-hosted runner as a SERVICE on this machine, installed and removed on the
 * platform's instruction (#1209, epic #1113).
 *
 * Install: check the prerequisites a deploy job needs (reported, never assumed), download the
 * actions/runner release for this OS and CPU, `config.sh --unattended` it against the org or repo URL
 * with the labels `pags` and `pags-<node>`, then install and start it as a service (`svc.sh` on
 * macOS/Linux, `config.cmd --runasservice` on Windows). Remove: stop and uninstall the service, then
 * `config remove`. One runner per machine per scope; each lives in its own folder under
 * `~/.proagentstore/actions-runner/` — except on Windows (#1272), where it lives under
 * `%ProgramData%\ProAgentStore\actions-runner\` and is NEVER placed in a user profile; see windows-runner-root.ts.
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
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { checkWindowsReadiness, type WindowsReadinessDeps } from "./windows-runner-readiness.js";
import { macRunnerServiceRemoved } from "./actions-runner-mac-removal.js";
import { liveWindowsDeps } from "./windows-runner-live.js";
import { ensureWindowsRunnerRoot, machineRoot, NETWORK_SERVICE, type WindowsRootDeps } from "./windows-runner-root.js";

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
	/** Opt in to a pre-login PAGS system LaunchDaemon on macOS. Omitted keeps GitHub's user LaunchAgent behavior. */
	serviceMode?: "macos_system";
	/** Internal tokenless path: may reconcile a configured runner, never register one. */
	reconcileOnly?: boolean;
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
	/** Run a program briefly and return its trimmed stdout, or null when it is absent or fails (capability probes, #1260). */
	probe?: (file: string, args: string[]) => string | null;
	platform: NodeJS.Platform;
	arch: string;
	home: string;
	user: string;
	/** Root or not (Linux `svc.sh install` needs root). */
	isRoot: boolean;
	exists: (path: string) => boolean;
	readText?: (path: string) => string;
	/** macOS: local physical verification before accepting a user-writable removal receipt. */
	macServiceRemoved?: (dir: string) => boolean;
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
	/**
	 * Windows only (#1272): the machine-root effects. REQUIRED on win32 — without them there is nowhere safe to install, and the
	 * answer is a refusal, never a fallback into the user profile.
	 */
	windows?: WindowsRootDeps;
	/** Windows only: the probes behind the host-readiness check, reported with the capabilities (#1272). */
	readiness?: WindowsReadinessDeps;
}

const URL_SHAPE = /^https:\/\/github\.com\/([A-Za-z0-9-]+)(?:\/([A-Za-z0-9._-]+))?$/;

/** The folder a scope's runner lives in: `<home>/.proagentstore/actions-runner/<org>` or `<owner>--<repo>`. */
export function runnerDir(home: string, url: string): string {
	const m = URL_SHAPE.exec(url);
	if (!m) throw new Error(`Not a GitHub org or repo URL: ${url}`);
	return join(home, ".proagentstore", "actions-runner", m[2] ? `${m[1]}--${m[2]}` : m[1]);
}

/** A Windows runner lives under `%ProgramData%`, never in the profile (#1272): `…\\ProAgentStore\\actions-runner\\<scope>`. */
export function windowsRunnerDir(programData: string, url: string): string {
	return machineRoot(programData, runnerDir("", url).split(/[\\/]/).pop() as string);
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

// ── Capability labels (#1260) ─────────────────────────────────────────────────────────────────────
//
// A runner carries `pags` and `pags-<node>`, so ANY machine could take any job — and a 4 GB Intel MacBook Air with no Homebrew took 37
// in two hours, 12 of which failed for a missing `jq` or `brew`. The machine therefore reports what it HAS, as runner labels a workflow
// (or a router) can require: `has-<tool>` for each known CI tool on PATH, and `macos-NN+` for the OS tiers it meets — a job that needs
// macOS 14 asks for `macos-14+`, and a macOS 15 machine carries it too (every tier at or below its version, never only the highest, or
// a label-matching router would refuse a newer machine a job an older one can take).
//
// A FIXED list, deliberately: workflows are not scanned. Adding a tool is one line here.

/** The CI tools whose presence is reported, each with how to install it when a job needs it. */
export const CAPABILITY_TOOLS: ReadonlyArray<{ tool: string; hint: string }> = [
	{ tool: "brew", hint: "Homebrew — https://brew.sh" },
	{ tool: "jq", hint: "brew install jq (macOS) · apt install jq (Linux)" },
	{ tool: "flutter", hint: "https://docs.flutter.dev/get-started/install — Flutter 3.41 needs macOS 14 or newer" },
	{ tool: "dart", hint: "ships with Flutter; or brew install dart-sdk" },
	{ tool: "docker", hint: "Docker Desktop — https://docs.docker.com/get-started/get-docker/" },
	{ tool: "python3", hint: "brew install python (macOS) · apt install python3 (Linux)" },
	{ tool: "go", hint: "brew install go · https://go.dev/dl/" },
	{ tool: "node", hint: "brew install node · https://nodejs.org" },
	{ tool: "pnpm", hint: "corepack enable · npm i -g pnpm" },
	{ tool: "aws", hint: "brew install awscli · https://aws.amazon.com/cli/" },
	{ tool: "git", hint: "xcode-select --install (macOS) · apt install git (Linux)" },
];

/** The tools the org's fleet has had jobs fail for (#1260): a machine without one is told before it registers. */
export const PREFLIGHT_TOOLS: readonly string[] = ["brew", "jq", "flutter", "dart"];

/** macOS majors worth a tier label. Apple skipped 16-25; a version outside the list still gets its own tier. */
const MACOS_TIERS = [11, 12, 13, 14, 15, 26];

export interface CapabilityReport {
	/** `has-<tool>` for each tool present, then `macos-NN+` tiers on macOS. Valid runner labels. */
	labels: string[];
	/** The preflight tools this machine lacks, each with how to install it. */
	missing: Array<{ tool: string; hint: string }>;
	/** Things worth knowing that are not a missing tool, e.g. an OS too old for Flutter. */
	warnings: string[];
	os: { platform: string; version: string | null };
}

/** The macOS major version, from `sw_vers -productVersion`, or null off macOS / when it cannot be read. */
export function macosMajor(deps: Pick<ActionsRunnerDeps, "platform" | "probe">): { version: string | null; major: number | null } {
	if (deps.platform !== "darwin") return { version: null, major: null };
	const version = deps.probe?.("sw_vers", ["-productVersion"]) ?? null;
	const major = version && /^\d+(\.\d+)*$/.test(version) ? Number.parseInt(version.split(".")[0], 10) : null;
	return { version, major: major !== null && Number.isFinite(major) ? major : null };
}

/** The `macos-NN+` tiers a macOS of this major version meets: every known tier at or below it. */
export function macosTierLabels(major: number | null): string[] {
	if (major === null) return [];
	const tiers = new Set(MACOS_TIERS.filter((t) => t <= major));
	tiers.add(major);
	return [...tiers].sort((a, b) => a - b).map((t) => `macos-${t}+`);
}

/** What this machine can run, as runner labels, plus the preflight gaps. Reads only PATH and two OS probes; installs nothing. */
export function detectCapabilities(deps: Pick<ActionsRunnerDeps, "which" | "platform" | "probe">): CapabilityReport {
	const labels = CAPABILITY_TOOLS.filter((t) => deps.which(t.tool)).map((t) => `has-${t.tool}`);
	// Xcode is a developer directory, not a binary on PATH: `xcode-select -p` prints it when the tools are installed.
	if (deps.platform === "darwin" && deps.which("xcode-select") && (deps.probe?.("xcode-select", ["-p"]) ?? "").startsWith("/")) labels.push("has-xcode");
	const { version, major } = macosMajor(deps);
	labels.push(...macosTierLabels(major));
	const missing = CAPABILITY_TOOLS.filter((t) => PREFLIGHT_TOOLS.includes(t.tool) && !deps.which(t.tool));
	const warnings: string[] = [];
	if (major !== null && major < 14) warnings.push(`macOS ${version} is older than 14: Flutter 3.41's Dart VM will not start here, so Flutter jobs must not be routed to this machine — it will not carry the macos-14+ label, and installing the SDK does not fix it.`);
	return { labels, missing, warnings, os: { platform: deps.platform, version } };
}

/** The `has-*` / `macos-NN+` labels alone (what a workflow's `runs-on` can require). */
export function detectCapabilityLabels(deps: Pick<ActionsRunnerDeps, "which" | "platform" | "probe">): string[] {
	return detectCapabilities(deps).labels;
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
	// `+` is allowed for the OS tier labels (`macos-14+`, #1260).
	for (const l of req.labels ?? []) if (!/^[A-Za-z0-9._+-]{1,100}$/.test(l)) throw new Error(`label ${JSON.stringify(l)} is not a valid runner label`);
	if (req.runnerGroup !== undefined && !/^[A-Za-z0-9 ._-]{1,100}$/.test(req.runnerGroup)) throw new Error("runnerGroup is not a valid runner group name");
	if (req.serviceMode !== undefined && req.serviceMode !== "macos_system") throw new Error("serviceMode must be macos_system when set");
}

/**
 * Start (or join) an install or removal. Answers at once with the job; {@link runnerJob} reads it back.
 * One job per folder: asking again while one runs returns it rather than starting a second.
 */
export function startRunnerJob(action: RunnerAction, req: ActionsRunnerRequest, deps: ActionsRunnerDeps): ActionsRunnerJob {
	validate(req, action);
	if (deps.platform === "win32" && !deps.windows) throw new Error("This machine's Windows runner root is unavailable, so nothing was installed. A service-managed runner is never placed in a user profile.");
	const dir = deps.platform === "win32" && deps.windows ? windowsRunnerDir(deps.windows.programData, req.url) : runnerDir(deps.home, req.url);
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
		if (req.serviceMode === "macos_system" && deps.platform !== "darwin") throw new Error("macos_system service mode requires macOS");
		// Convergence (#1272): every install and re-run sets AND verifies the root's ACL first, so `pags up`, a restart and a
		// self-update all land on the same permissions. A failure here stops the install before anything is downloaded.
		if (win && deps.windows) {
			const root = await ensureWindowsRunnerRoot(deps.windows, { folder: job.dir.split(/[\\/]/).pop() as string });
			job.steps.push(...root.steps, `service account ${root.identity} limited to ${root.root} (${root.verified} check passed)`);
			job.runsAs = root.identity;
		}
		if (deps.exists(join(job.dir, ".runner"))) {
			const raw = (deps.readText ?? ((path: string) => readFileSync(path, "utf8")))(join(job.dir, ".runner"));
			let record: { agentName?: unknown; gitHubUrl?: unknown };
			try { record = JSON.parse(raw.replace(/^﻿/, "")) as typeof record; } catch { throw new Error("Configured .runner is unreadable; refusing service adoption."); }
			if (record.agentName !== req.name || typeof record.gitHubUrl !== "string" || record.gitHubUrl.replace(/\/$/, "").toLowerCase() !== req.url.toLowerCase()) throw new Error("Configured .runner name or GitHub scope does not match this setup request; refusing service adoption.");
			job.steps.push(`already configured in ${job.dir} — not reinstalled (remove it first to re-register)`);
			if (deps.platform === "darwin" && req.serviceMode === "macos_system") {
				job.service = "needs_admin";
				job.serviceNote = `Reconcile this configured runner as a pre-login PAGS system service on the machine: pags actions service install --dir ${job.dir}`;
			} else job.service = "installed";
			return finish(job, deps);
		}
		if (req.reconcileOnly) throw new Error("The runner was removed while reconciliation started; no registration was attempted.");
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
			...(win ? ["--runasservice", "--windowslogonaccount", NETWORK_SERVICE] : []),
		];
		await step(job, deps, win ? join(job.dir, "config.cmd") : join(job.dir, "config.sh"), config, req.token);
		if (win) {
			// `--runasservice` installs and starts the Windows service inside `config.cmd`. It needs an
			// elevated prompt; without one config itself fails, and that failure is the job's error.
			job.service = "installed";
			return finish(job, deps);
		}
		if (deps.platform === "darwin" && req.serviceMode === "macos_system") {
			job.service = "needs_admin";
			job.serviceNote = `The runner is configured. Install its pre-login PAGS system service on the machine: pags actions service install --dir ${job.dir}`;
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
		if (req.serviceMode === "macos_system" && deps.platform !== "darwin") throw new Error("macos_system service mode requires macOS");
		if (!deps.exists(join(job.dir, ".runner"))) {
			if (deps.platform === "darwin") {
				const label = `online.proagentstore.actions.${job.dir.split(/[\\/]/).pop()?.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`;
				if (deps.exists(`/Library/LaunchDaemons/${label}.plist`)) throw new Error("The runner record is missing but its PAGS system LaunchDaemon still exists. Inspect and remove that exact service locally before treating this runner as removed.");
			}
			job.steps.push(`no runner configured in ${job.dir} — nothing to remove`);
			job.service = "removed";
			return finish(job, deps);
		}
		if (!win) {
			if (deps.platform === "darwin") {
				const proof = join(job.dir, ".pags-supervisor", "removal-approved.json");
				const supervisorConfig = join(job.dir, ".pags-supervisor", "config.json");
				const label = `online.proagentstore.actions.${job.dir.split(/[\\/]/).pop()?.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`;
				const systemPresent = deps.exists(`/Library/LaunchDaemons/${label}.plist`);
				if (!systemPresent && !deps.exists(supervisorConfig) && req.serviceMode !== "macos_system" && !deps.exists(proof)) {
					await step(job, deps, join(job.dir, "svc.sh"), ["stop"], req.token).catch(() => job.steps.push("svc.sh stop: was not running"));
					await step(job, deps, join(job.dir, "svc.sh"), ["uninstall"], req.token);
					await step(job, deps, join(job.dir, "config.sh"), ["remove", "--token", req.token], req.token);
					job.service = "removed";
					return finish(job, deps);
				}
				let approved = false;
				if (deps.exists(proof)) {
					try {
						const r = JSON.parse((deps.readText ?? ((path: string) => readFileSync(path, "utf8")))(proof)) as { name?: unknown; url?: unknown; at?: unknown };
						approved = r.name === req.name && r.url === req.url && typeof r.at === "number" && Date.now() - r.at < 24 * 60 * 60_000;
					} catch { /* no approval */ }
				}
				if (!approved) {
					job.service = "needs_admin";
					job.serviceNote = `Remove this runner's exact service on the machine, then ask again to deregister: pags actions service remove --dir ${job.dir}`;
					return finish(job, deps);
				}
				if (deps.macServiceRemoved?.(job.dir) !== true) {
					job.service = "needs_admin";
					job.serviceNote = `The local approval receipt is present, but an Actions service or process for this runner may still be active. Inspect the exact service and retry: pags actions service remove --dir ${job.dir}`;
					return finish(job, deps);
				}
				job.steps.push("local administrator-approved service removal verified");
				await step(job, deps, join(job.dir, "config.sh"), ["remove", "--token", req.token], req.token);
				rmSync(proof, { force: true });
				job.service = "removed";
				return finish(job, deps);
			}
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
	/** A Windows runner still in the user profile (#1272): it is migrated to the machine root, never repaired in place. */
	legacy?: boolean;
	/** Local OS service domain, derived from the exact generated unit where available. */
	serviceMode?: "macos_system" | "macos_user" | "linux_system" | "windows_system" | "unknown";
	/** The persisted local policy, when a valid PAGS supervisor configuration exists. */
	acRecoveryEnabled?: boolean;
	/** Supervisor's persisted observation; freshness is checked by consumers. */
	supervisor?: Record<string, unknown> | null;
	supervisorNote?: string;
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
	const live = win ? liveWindowsDeps() : null;
	return {
		...(live ? { windows: live.root, readiness: live.readiness } : {}),
		platform: process.platform,
		arch: process.arch,
		home: homedir(),
		user: userInfo().username,
		isRoot: typeof process.getuid === "function" && process.getuid() === 0,
		exists: existsSync,
		readText: (path) => readFileSync(path, "utf8"),
		macServiceRemoved: (dir) => macRunnerServiceRemoved(dir, homedir()),
		mkdir: (path) => mkdirSync(path, { recursive: true }),
		which: (bin) => spawnSync(win ? "where" : "which", [bin], { stdio: "ignore" }).status === 0,
		probe: (file, args) => {
			const r = spawnSync(file, args, { encoding: "utf8", timeout: 5000 });
			return r.status === 0 ? String(r.stdout).trim() : null;
		},
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
export function installedRunners(home = homedir(), programData = process.platform === "win32" ? process.env.ProgramData : undefined): InstalledRunner[] {
	const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
	const scan = (base: string, legacy: boolean) => (existsSync(base) ? readdirSync(base).map((d) => readInstalledRunner(join(base, d), true, readText)).map((r) => (r && legacy ? { ...r, legacy: true } : r)) : []);
	// The machine root (#1272) and, on Windows, any profile-scoped install still waiting to be migrated (`legacy`).
	const machine = programData ? scan(join(programData, "ProAgentStore", "actions-runner"), false) : [];
	const profile = scan(join(home, ".proagentstore", "actions-runner"), process.platform === "win32");
	const runners = [...machine, ...profile, readInstalledRunner(join(home, "actions-runner"), false, readText)].filter((r): r is InstalledRunner => r !== null);
	// A legacy service can have any plist name. Parse the two launchd directories once
	// per status request, only when at least one runner needs legacy discovery.
	const needsLegacyScan = process.platform === "darwin" && runners.some((r) => r.managed && !existsSync(`/Library/LaunchDaemons/online.proagentstore.actions.${r.dir.split(/[\\/]/).pop()?.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}.plist`));
	const legacyServices: Array<{ mode: "macos_system" | "macos_user"; workingDirectory?: unknown; args?: unknown }> = [];
	if (needsLegacyScan) for (const [base, mode] of [["/Library/LaunchDaemons", "macos_system"], [join(home, "Library", "LaunchAgents"), "macos_user"]] as const) {
		if (!existsSync(base)) continue;
		for (const name of readdirSync(base)) {
			if (!name.endsWith(".plist")) continue;
			const plist = spawnSync("plutil", ["-convert", "json", "-o", "-", join(base, name)], { encoding: "utf8", timeout: 5000 });
			if (plist.status !== 0) continue;
			try {
				const value = JSON.parse(plist.stdout) as { WorkingDirectory?: unknown; ProgramArguments?: unknown };
				legacyServices.push({ mode, workingDirectory: value.WorkingDirectory, args: value.ProgramArguments });
			} catch { /* other software's plist */ }
		}
	}
	return runners.map((r) => {
		// A configured folder alone does not prove that systemd or the Windows service still exists.
		if (process.platform === "win32" || process.platform === "linux") return { ...r, serviceMode: "unknown" };
		if (process.platform !== "darwin" || !r.managed) return r;
		const label = `online.proagentstore.actions.${r.dir.split(/[\\/]/).pop()?.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`;
		const system = `/Library/LaunchDaemons/${label}.plist`;
		let mode: InstalledRunner["serviceMode"] = existsSync(system) ? "macos_system" : "unknown";
		if (mode === "unknown") for (const service of legacyServices) {
			if (service.workingDirectory === r.dir || (Array.isArray(service.args) && service.args.some((arg) => arg === r.dir || arg === join(r.dir, "runsvc.sh")))) mode = service.mode;
		}
		const status = readText(join(r.dir, ".pags-supervisor", "status.json"));
		let supervisor: Record<string, unknown> | null = null;
		try { if (status) supervisor = JSON.parse(status) as Record<string, unknown>; } catch { /* reported below */ }
		let acRecoveryEnabled: boolean | undefined;
		try {
			const config = JSON.parse(readText(join(r.dir, ".pags-supervisor", "config.json")) ?? "null") as { version?: unknown; acRecoveryEnabled?: unknown } | null;
			if (config?.version === 1 && typeof config.acRecoveryEnabled === "boolean") acRecoveryEnabled = config.acRecoveryEnabled;
		} catch { /* invalid or absent policy is unknown */ }
		return { ...r, serviceMode: mode, supervisor, ...(acRecoveryEnabled === undefined ? {} : { acRecoveryEnabled }), ...(!supervisor ? { supervisorNote: status ? "Supervisor status is unreadable" : "No supervisor status sample" } : {}) };
	});
}

/** Queue one explicit restart for this exact managed runner; the supervisor enforces active-job deferral. */
export function requestLocalActionsRecovery(url: string, deps: Pick<ActionsRunnerDeps, "home" | "exists">): { id: string; reason: "manual"; state: "queued" | "deferred_active_job"; requestedAt: number } {
	const dir = runnerDir(deps.home, url);
	if (!deps.exists(join(dir, ".runner")) || !deps.exists(join(dir, ".credentials")) || !deps.exists(join(dir, "runsvc.sh"))) throw new Error("This managed Actions runner is not fully configured.");
	const rawRunner = readFileSync(join(dir, ".runner"), "utf8").replace(/^﻿/, "");
	const record = JSON.parse(rawRunner) as { gitHubUrl?: unknown };
	if (typeof record.gitHubUrl !== "string" || record.gitHubUrl.replace(/\/$/, "").toLowerCase() !== url.toLowerCase()) throw new Error("The configured runner scope does not match the requested scope.");
	const local = join(dir, ".pags-supervisor");
	const cfg = JSON.parse(readFileSync(join(local, "config.json"), "utf8")) as { version?: unknown; acRecoveryEnabled?: unknown };
	if (cfg.version !== 1 || typeof cfg.acRecoveryEnabled !== "boolean") throw new Error("The PAGS supervisor configuration is invalid.");
	const status = JSON.parse(readFileSync(join(local, "status.json"), "utf8")) as { updatedAt?: unknown; supervisorPid?: unknown; activeJob?: unknown; lastManualRequestId?: unknown; lastRecovery?: { id?: unknown; state?: unknown; completedAt?: unknown } };
	if (typeof status.updatedAt !== "number" || Date.now() - status.updatedAt > 90_000 || typeof status.supervisorPid !== "number") throw new Error("The PAGS supervisor has no current health sample.");
	try { process.kill(status.supervisorPid, 0); } catch { throw new Error("The PAGS supervisor is not running."); }
	const target = join(local, "recover.json");
	const lock = join(local, "recover-write.lock");
	const nonce = randomUUID();
	const deadline = Date.now() + 3000;
	for (;;) {
		try {
			const fd = openSync(lock, "wx", 0o600);
			try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), nonce })); } finally { closeSync(fd); }
			break;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			let stale = false;
			let ino: number | null = null;
			try {
				const stat = statSync(lock);
				ino = stat.ino;
				const owner = JSON.parse(readFileSync(lock, "utf8")) as { pid?: unknown; at?: unknown };
				let alive = false;
				if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) try { process.kill(owner.pid, 0); alive = true; } catch (err) { alive = (err as NodeJS.ErrnoException).code === "EPERM"; }
				stale = !alive || (typeof owner.at === "number" && Date.now() - owner.at > 30_000);
			} catch { try { stale = Date.now() - statSync(lock).mtimeMs > 30_000; } catch { /* another caller removed it */ } }
			if (stale && ino !== null) try { if (statSync(lock).ino === ino) rmSync(lock); } catch { /* another caller won */ }
			if (Date.now() > deadline) throw new Error("Another recovery request is being written; retry shortly.");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
	try {
	if (deps.exists(target)) {
		const prior = JSON.parse(readFileSync(target, "utf8")) as { id?: unknown; requestedAt?: unknown; reason?: unknown };
		const terminal = status.lastRecovery?.id === prior.id && (status.lastRecovery?.state === "ready" || status.lastRecovery?.state === "error") && typeof status.lastRecovery?.completedAt === "number";
		const pending = status.lastRecovery?.id === prior.id && !terminal;
		if (typeof prior.id === "string" && typeof prior.requestedAt === "number" && prior.reason === "manual" && (status.lastManualRequestId !== prior.id || pending)) return { id: prior.id, requestedAt: prior.requestedAt, reason: "manual", state: status.activeJob ? "deferred_active_job" : "queued" };
		if (prior.reason !== "manual" || typeof prior.id !== "string") throw new Error("An unknown recovery request already exists; refusing to overwrite it.");
	}
	const request = { id: randomUUID(), reason: "manual" as const, requestedAt: Date.now() };
	const temp = join(local, `recover.${request.id}.tmp`);
	writeFileSync(temp, JSON.stringify(request) + "\n", { mode: 0o600, flag: "wx" });
	try { renameSync(temp, target); } finally { rmSync(temp, { force: true }); }
	return { ...request, state: status.activeJob ? "deferred_active_job" : "queued" };
	} finally {
		try {
			const owner = JSON.parse(readFileSync(lock, "utf8")) as { nonce?: unknown };
			if (owner.nonce === nonce) rmSync(lock);
		} catch { /* an external failure leaves a stale lock, recovered on the next request */ }
	}
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
		if (path === "/coding/actions-runner/reconcile") {
			const d = deps();
			const req = body as unknown as Omit<ActionsRunnerRequest, "token">;
			if (!URL_SHAPE.test(req.url ?? "") || !/^[A-Za-z0-9._-]{1,64}$/.test(req.name ?? "")) throw new Error("A valid GitHub runner URL and name are required.");
			const dir = d.platform === "win32" && d.windows ? windowsRunnerDir(d.windows.programData, req.url) : runnerDir(d.home, req.url);
			if (!d.exists(join(dir, ".runner"))) throw new Error("The runner is no longer configured on this machine; setup needs a registration token.");
			return { status: 202, body: startRunnerJob("install", { ...req, token: "reconcile-only", reconcileOnly: true }, d) };
		}
		if (path === "/coding/actions-runner/recover") {
			if (typeof body.url !== "string") throw new Error("A GitHub runner scope URL is required.");
			return { status: 200, body: requestLocalActionsRecovery(body.url, deps()) };
		}
		if (path === "/coding/actions-runner/capabilities") {
			const d = deps();
			// On Windows the report also says whether the HOST is fit to take jobs (#1272); the cloud withholds routing until it is.
			return { status: 200, body: { ...detectCapabilities(d), ...(d.readiness ? { windows: checkWindowsReadiness(d.readiness) } : {}) } };
		}
		if (path === "/coding/actions-runner/status") {
			return { status: 200, body: { job: typeof body.jobId === "string" ? runnerJob(body.jobId) : null, installed: installedRunners() } };
		}
		return { status: 404, body: { error: "Not found" } };
	} catch (e: unknown) {
		return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
	}
}
