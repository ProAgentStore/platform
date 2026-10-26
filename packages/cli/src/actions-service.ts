/** Local, administrator-approved macOS service adoption for one configured Actions runner (#1209). */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ServiceContext } from "./service-install.js";

export const actionsServiceLabel = (dir: string) => `online.proagentstore.actions.${basename(dir).toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`;
export const actionsServicePlist = (dir: string) => `/Library/LaunchDaemons/${actionsServiceLabel(dir)}.plist`;
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function actionsServiceContent(dir: string, ctx: ServiceContext): string {
	if (ctx.platform !== "darwin" || !ctx.user || ctx.user === "root" || ctx.uid === 0) throw new Error("Run this command on macOS as the runner owner, without sudo; it asks for administrator approval itself.");
	if (!isAbsolute(dir)) throw new Error("--dir must be an absolute runner directory");
	const label = actionsServiceLabel(dir);
	// /usr/bin/env resolves the current Node from the owner's PATH on every start. The script is the stable npm bootstrap,
	// which loads the current payload after an update; no release-specific dist path is put in the plist.
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>UserName</key><string>${xml(ctx.user)}</string>
<key>ProgramArguments</key><array><string>/usr/bin/env</string><string>node</string><string>${xml(ctx.script)}</string><string>actions</string><string>supervise</string><string>--dir</string><string>${xml(dir)}</string></array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(ctx.home)}</string><key>USER</key><string>${xml(ctx.user)}</string><key>PATH</key><string>${xml(ctx.pathEnv)}</string><key>ACTIONS_RUNNER_SVC</key><string>1</string></dict>
<key>WorkingDirectory</key><string>${xml(dir)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
</dict></plist>\n`;
}

export interface MacActionsService {
	path: string;
	label: string;
	domain: "system" | `gui/${number}`;
	owned: boolean;
}

export function assertOwnedRemovalService(service: MacActionsService | undefined): void {
	if (service && !service.owned) throw new Error(`Refusing to remove ${service.domain}/${service.label}: it is not a PAGS-generated Actions service. Adopt it first, or remove that exact legacy service separately.`);
}

/** A plist is a candidate only when launchd directly names this exact runner directory. */
export function serviceForPlist(path: string, value: unknown, dir: string, uid: number): MacActionsService | null {
	if (!value || typeof value !== "object") return null;
	const p = value as { Label?: unknown; WorkingDirectory?: unknown; ProgramArguments?: unknown };
	if (typeof p.Label !== "string" || !Array.isArray(p.ProgramArguments) || !p.ProgramArguments.every((a) => typeof a === "string")) return null;
	const args = p.ProgramArguments as string[];
	const exact = p.WorkingDirectory === dir || args.includes(dir) || args.some((a) => a === join(dir, "runsvc.sh") || a === join(dir, "run.sh"));
	if (!exact) return null;
	const domain = path.startsWith("/Library/LaunchDaemons/") ? "system" : `gui/${uid}` as const;
	return { path, label: p.Label, domain, owned: path === actionsServicePlist(dir) && p.Label === actionsServiceLabel(dir) };
}

function parsedPlist(path: string): unknown {
	const result = spawnSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8", timeout: 5000 });
	if (result.status !== 0) return null;
	try { return JSON.parse(result.stdout); } catch { return null; }
}

export function inventoryActionsServices(dir: string, ctx: ServiceContext): MacActionsService[] {
	const uid = ctx.uid ?? 501;
	const roots = ["/Library/LaunchDaemons", join(ctx.home, "Library", "LaunchAgents")];
	const found: MacActionsService[] = [];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		for (const name of readdirSync(root)) {
			if (!name.endsWith(".plist")) continue;
			const path = join(root, name);
			const candidate = serviceForPlist(path, parsedPlist(path), dir, uid);
			if (candidate) found.push(candidate);
		}
	}
	return found;
}

/** Resolve a Worker PID to its cwd, so a job in another runner folder does not block this scope. */
type ProbeResult = { status: number | null; stdout: string };
type ProcessProbe = (file: string, args: string[]) => ProbeResult;
const liveProcessProbe: ProcessProbe = (file, args) => {
	const result = spawnSync(file, args, { encoding: "utf8", timeout: 5000 });
	return { status: result.status, stdout: String(result.stdout ?? "") };
};
const livePid = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

export function activeProcessIn(dir: string, name: "Runner.Worker" | "Runner.Listener", probe: ProcessProbe = liveProcessProbe, alive: (pid: number) => boolean = livePid): number[] {
	const ps = probe("pgrep", ["-f", name]);
	if (ps.status === 1) return [];
	if (ps.status !== 0) throw new Error(`Could not inspect ${name} processes; refusing a service change.`);
	const pids = ps.stdout.trim().split(/\s+/).filter((x) => /^\d+$/.test(x));
	if (!pids.length) throw new Error(`Process inventory for ${name} was incomplete; refusing a service change.`);
	const found: number[] = [];
	for (const pidText of pids) {
		const pid = Number(pidText);
		const cwd = probe("lsof", ["-a", "-p", pidText, "-d", "cwd", "-Fn"]);
		if (cwd.status !== 0) {
			if (alive(pid)) throw new Error(`Could not inspect ${name} process ${pid}; refusing a service change.`);
			continue; // exited between pgrep and lsof
		}
		const paths = cwd.stdout.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
		if (!paths.length && alive(pid)) throw new Error(`No cwd for ${name} process ${pid}; refusing a service change.`);
		if (paths.some((path) => path === dir || path.startsWith(`${dir}/`))) found.push(pid);
	}
	return found;
}

export const activeWorkerIn = (dir: string): boolean => activeProcessIn(dir, "Runner.Worker").length > 0;

export async function waitListenerGone(dir: string, timeoutMs = 20_000, scan: (dir: string, name: "Runner.Listener") => number[] = activeProcessIn, pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<void> {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (scan(dir, "Runner.Listener").length === 0) return;
		await pause(500);
	}
	throw new Error(`Runner.Listener remained active in ${dir} after its exact service stopped; refusing to start another listener.`);
}

function launchctl(args: string[], allowAbsent = false): void {
	const r = spawnSync("sudo", ["launchctl", ...args], { stdio: "inherit" });
	if (r.status !== 0 && !allowAbsent) throw new Error(`launchctl ${args[0]} failed (exit ${r.status ?? "signal"})`);
}

function loaded(service: MacActionsService): boolean {
	return spawnSync("launchctl", ["print", `${service.domain}/${service.label}`], { stdio: "ignore", timeout: 5000 }).status === 0;
}

function stop(service: MacActionsService): void {
	if (!loaded(service)) return;
	if (service.domain === "system") launchctl(["bootout", `system/${service.label}`]);
	else {
		const r = spawnSync("launchctl", ["bootout", `${service.domain}/${service.label}`], { stdio: "inherit" });
		if (r.status !== 0) throw new Error(`Could not stop ${service.domain}/${service.label}`);
	}
}

function start(service: MacActionsService): void {
	if (service.domain === "system") launchctl(["bootstrap", "system", service.path]);
	else {
		const r = spawnSync("launchctl", ["bootstrap", service.domain, service.path], { stdio: "inherit" });
		if (r.status !== 0) throw new Error(`Could not restore ${service.domain}/${service.label}`);
	}
}

function readySample(dir: string, since: number): boolean {
	try {
		const s = JSON.parse(readFileSync(join(dir, ".pags-supervisor", "status.json"), "utf8")) as { version?: unknown; runnerDir?: unknown; supervisorPid?: unknown; listenerPid?: unknown; health?: unknown; lastRestartAt?: unknown; lastReadyAt?: unknown; updatedAt?: unknown };
		if (!(s.version === 1 && s.runnerDir === dir && s.health === "ready" && typeof s.supervisorPid === "number" && typeof s.listenerPid === "number" && typeof s.lastReadyAt === "number" && typeof s.lastRestartAt === "number" && typeof s.updatedAt === "number" && s.lastRestartAt >= since && s.lastReadyAt >= s.lastRestartAt && Date.now() - s.updatedAt < 90_000)) return false;
		process.kill(s.supervisorPid, 0);
		process.kill(s.listenerPid, 0);
		return true;
	} catch { return false; }
}

function assertRunner(dir: string, ctx: ServiceContext): string {
	if (ctx.platform !== "darwin") throw new Error("Actions system services are currently supported on macOS only.");
	if (!isAbsolute(dir) || resolve(dir) !== dir || !dir.startsWith(join(ctx.home, ".proagentstore", "actions-runner") + "/")) throw new Error("--dir must name one managed runner under this user's ~/.proagentstore/actions-runner/");
	if (!existsSync(join(dir, ".runner")) || !existsSync(join(dir, ".credentials"))) throw new Error("This runner has no .runner and .credentials pair; configure it first with actions_runner_setup.");
	let record: { agentName?: unknown; gitHubUrl?: unknown };
	try { record = JSON.parse(readFileSync(join(dir, ".runner"), "utf8").replace(/^﻿/, "")) as typeof record; } catch { throw new Error("The configured .runner record is unreadable."); }
	const match = typeof record.gitHubUrl === "string" ? /^https:\/\/github\.com\/([A-Za-z0-9-]+)(?:\/([A-Za-z0-9._-]+))?\/?$/.exec(record.gitHubUrl) : null;
	const folder = match ? (match[2] ? `${match[1]}--${match[2]}` : match[1]) : null;
	if (!folder || folder !== basename(dir) || typeof record.agentName !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(record.agentName)) throw new Error("The .runner scope or name does not match this managed directory; refusing service adoption.");
	const owner = userInfo().username;
	if (owner !== ctx.user || owner === "root") throw new Error("Run as the runner owner, without sudo.");
	return dir;
}

/** Install/adopt only while idle. Any failed new bootstrap restores the exact previous service. */
async function awaitFreshReady(dir: string, startedAt: number, timeoutMs = 60_000): Promise<void> {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (readySample(dir, startedAt)) return;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error(`No new ready event from the PAGS supervisor for ${dir} within ${Math.round(timeoutMs / 1000)} seconds`);
}

export async function installMacActionsService(dir: string, ctx: ServiceContext): Promise<string[]> {
	assertRunner(dir, ctx);
	if (activeWorkerIn(dir)) return [`Deferred: ${dir} has an active Runner.Worker. Retry after the job completes.`];
	const services = inventoryActionsServices(dir, ctx);
	if (services.length > 1) throw new Error(`Ambiguous service ownership for ${dir}: ${services.map((s) => `${s.domain}/${s.label}`).join(", ")}. Resolve manually before adoption.`);
	const prior = services[0];
	const listeners = activeProcessIn(dir, "Runner.Listener");
	if (listeners.length > 1) throw new Error(`Two Runner.Listener processes are already active in ${dir}; refusing adoption.`);
	if (listeners.length && (!prior || !loaded(prior))) throw new Error(`An unmanaged Runner.Listener is active in ${dir}; stop its exact owner before adoption.`);
	const target = actionsServicePlist(dir);
	const label = actionsServiceLabel(dir);
	const owned = prior?.owned === true;
	const wasRunning = prior ? loaded(prior) : false;
	const oldPlist = existsSync(target) ? readFileSync(target) : null;
	const previousPlist = prior && prior.path !== target ? readFileSync(prior.path) : null;
	if (oldPlist && !owned) throw new Error(`${target} already exists but is not the PAGS service for this runner; refusing to overwrite it.`);
	const local = join(dir, ".pags-supervisor");
	mkdirSync(local, { recursive: true });
	const config = join(local, "config.json");
	if (!existsSync(config)) writeFileSync(config, JSON.stringify({ version: 1, acRecoveryEnabled: true }) + "\n", { mode: 0o600 });
	const staged = join(local, "service.plist");
	const content = actionsServiceContent(dir, ctx);
	writeFileSync(staged, content, { mode: 0o600 });
	if (owned && oldPlist?.toString() === content && wasRunning && readySample(dir, 0)) return [`Already installed and currently ready: system/${label}; configuration and runner credentials retained.`];
	const next: MacActionsService = { path: target, label, domain: "system", owned: true };
	let oldStopped = false;
	let newStarted = false;
	try {
		if (activeWorkerIn(dir)) throw new Error(`Runner.Worker started during service adoption in ${dir}; retry when it finishes.`);
		if (prior && wasRunning) { stop(prior); oldStopped = true; await waitListenerGone(dir); }
		if (activeWorkerIn(dir)) throw new Error(`Runner.Worker remained active after the old service stopped in ${dir}; refusing to start a second listener.`);
		const copy = spawnSync("sudo", ["install", "-o", "root", "-g", "wheel", "-m", "644", staged, target], { stdio: "inherit" });
		if (copy.status !== 0) throw new Error("Administrator approval or plist installation failed.");
		const startedAt = Date.now();
		start(next);
		newStarted = true;
		if (!loaded(next)) throw new Error(`system/${label} did not load after bootstrap`);
		await awaitFreshReady(dir, startedAt);
		if (prior && prior.path !== target) {
			if (prior.domain === "system") {
				const removed = spawnSync("sudo", ["rm", "-f", prior.path], { stdio: "inherit" });
				if (removed.status !== 0) throw new Error(`Could not retire prior service plist ${prior.path}`);
			} else rmSync(prior.path);
		}
		return [`Installed system/${label} as ${ctx.user}. Existing .runner, .credentials, labels and work directory were retained. Check actions_runner_status for a fresh ready event and GitHub online status.`];
	} catch (error) {
		const rollbackErrors: string[] = [];
		if (newStarted || loaded(next)) try { stop(next); await waitListenerGone(dir); } catch (e) { rollbackErrors.push(`new service did not stop cleanly: ${String(e)}`); }
		if (oldPlist) {
			const restore = join(local, "previous-service.plist");
			writeFileSync(restore, oldPlist, { mode: 0o600 });
			if (spawnSync("sudo", ["install", "-o", "root", "-g", "wheel", "-m", "644", restore, target], { stdio: "inherit" }).status !== 0) rollbackErrors.push(`could not restore ${target}`);
		} else if (spawnSync("sudo", ["rm", "-f", target], { stdio: "inherit" }).status !== 0) rollbackErrors.push(`could not remove ${target}`);
		if (prior && previousPlist && !existsSync(prior.path)) {
			const restore = join(local, "previous-service.plist");
			writeFileSync(restore, previousPlist, { mode: 0o600 });
			if (prior.domain === "system") {
				if (spawnSync("sudo", ["install", "-o", "root", "-g", "wheel", "-m", "644", restore, prior.path], { stdio: "inherit" }).status !== 0) rollbackErrors.push(`could not restore ${prior.path}`);
			}
			else writeFileSync(prior.path, previousPlist);
		}
		if (prior && oldStopped && !rollbackErrors.length) try {
			await waitListenerGone(dir);
			if (activeWorkerIn(dir)) throw new Error("an active Runner.Worker remains; retry adoption after it completes");
			start(prior);
		} catch (e) { rollbackErrors.push(`could not safely restart ${prior.domain}/${prior.label}: ${String(e)}`); }
		if (rollbackErrors.length) throw new Error(`Installation failed (${String(error)}); rollback incomplete: ${rollbackErrors.join("; ")}. Inspect both service units locally.`);
		throw error;
	}
}

/** Remove only the generated unit. Deregistration remains the existing token-gated setup flow. */
export async function removeMacActionsService(dir: string, ctx: ServiceContext): Promise<string[]> {
	assertRunner(dir, ctx);
	if (activeWorkerIn(dir)) return [`Deferred: ${dir} has an active Runner.Worker. Retry after the job completes.`];
	const services = inventoryActionsServices(dir, ctx);
	if (services.length > 1) throw new Error(`Ambiguous service ownership for ${dir}: ${services.map((s) => `${s.domain}/${s.label}`).join(", ")}`);
	const service = services[0];
	assertOwnedRemovalService(service);
	if (service) {
		if (activeWorkerIn(dir)) return [`Deferred: ${dir} has an active Runner.Worker. Retry after the job completes.`];
		const wasRunning = loaded(service);
		if (wasRunning) { stop(service); await waitListenerGone(dir); }
		if (service.domain === "system") {
			const result = spawnSync("sudo", ["rm", "-f", service.path], { stdio: "inherit" });
			if (result.status !== 0) {
				if (wasRunning) start(service);
				throw new Error(`Could not remove ${service.path}; the runner remains configured.`);
			}
		} else rmSync(service.path);
	}
	if (activeProcessIn(dir, "Runner.Listener").length) throw new Error(`Runner.Listener is still active in ${dir}; refusing to approve deregistration.`);
	mkdirSync(join(dir, ".pags-supervisor"), { recursive: true });
	rmSync(join(dir, ".pags-supervisor", "service.plist"), { force: true });
	rmSync(join(dir, ".pags-supervisor", "config.json"), { force: true });
	rmSync(join(dir, ".pags-supervisor", "status.json"), { force: true });
	rmSync(join(dir, ".pags-supervisor", "recover.json"), { force: true });
	const record = JSON.parse(readFileSync(join(dir, ".runner"), "utf8")) as { agentName: string; gitHubUrl: string };
	writeFileSync(join(dir, ".pags-supervisor", "removal-approved.json"), JSON.stringify({ name: record.agentName, url: record.gitHubUrl, at: Date.now() }) + "\n", { mode: 0o600 });
	return [`Stopped and removed ${service ? `${service.domain}/${service.label}` : "no existing service"}. Runner credentials remain; run actions_runner_setup remove to deregister it.`];
}
