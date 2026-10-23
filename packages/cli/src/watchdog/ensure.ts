/**
 * A machine that already runs `pags up` as a service gets the watchdog service too, by itself (#1320): the first start of a release that has
 * the watchdog installs it, so the fleet does not wait for someone to run a command on every machine. Best-effort and once: a machine that
 * already has it, runs `pags up` by hand, or opted out (`PAGS_NO_WATCHDOG=1`) is left alone.
 */
import { existsSync } from "node:fs";
import { installWatchdogService, type ServiceContext, watchdogServicePlan } from "../service-install.js";

export type EnsureResult = { action: "present" | "skipped" | "installed" | "failed"; why: string };

export interface EnsureDeps {
	exists?: (path: string) => boolean;
	install?: typeof installWatchdogService;
}

export function ensureWatchdogInstalled(ctx: ServiceContext, env: NodeJS.ProcessEnv = process.env, deps: EnsureDeps = {}): EnsureResult {
	if (env.PAGS_NO_WATCHDOG === "1") return { action: "skipped", why: "PAGS_NO_WATCHDOG=1" };
	// Only a runner the OS service started: a `pags up` in a terminal is somebody at the keyboard, and installing a service is their call.
	if (env.PAGS_SERVICE !== "1") return { action: "skipped", why: "this runner was not started by the service" };
	const unit = watchdogServicePlan(ctx).files.at(-1)?.path;
	if (unit && (deps.exists ?? existsSync)(unit)) return { action: "present", why: "the watchdog service is already installed" };
	const result = (deps.install ?? installWatchdogService)(ctx);
	return result.ok ? { action: "installed", why: "installed the watchdog service" } : { action: "failed", why: result.lines.filter((l) => /FAILED/.test(l)).join("; ").slice(0, 300) || "the install failed" };
}
