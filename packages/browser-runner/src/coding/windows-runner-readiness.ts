/**
 * Is this Windows machine usable CI capacity — separate from whether its runner SERVICE is installed (#1272, epic #1113)?
 *
 * The incident that prompted the machine-root work had a second cause: even a started service is not a usable runner if the AWS CLI is
 * absent or the workflow steps are written for Linux. "The service is running" and "jobs can be routed here" are different facts,
 * and conflating them put work on a machine that could only fail it. So readiness is its own check, run before the runner is offered
 * any routing label, and its answer is either "available" or "unavailable" WITH the reason and the fix — never a bare refusal.
 *
 * What it checks, all through injected probes (nothing here touches the OS):
 *   • the Windows build is one the Actions runner and our workflows support ({@link MIN_WINDOWS_BUILD});
 *   • every tool a PAGS job needs resolves on PATH — and resolves OUTSIDE a user profile. The service identity has no access to a
 *     profile (that is the whole point of the machine root), so a tool installed "for me only" under `C:\Users\<user>` is invisible to
 *     it, and reporting it as present would be a lie that only a failed job would correct.
 *
 * The result is advisory data for the cloud (`/coding/actions-runner/capabilities`), which withholds the routing labels from an
 * unavailable runner (workers/api/src/lib/runner-routing.ts `runnerAvailability`).
 */
import { win32 } from "node:path";
import { isWithin, profileRoots } from "./windows-runner-root.js";

/** Windows 10 1809 / Server 2019. Older builds are not supported by the current Actions runner or by our Windows workflow steps. */
export const MIN_WINDOWS_BUILD = 17763;

export interface RequiredTool {
	tool: string;
	/** Why a PAGS job needs it. */
	needed: string;
	/** How to get it, machine-wide. */
	remedy: string;
}

/** What a PAGS job on Windows needs. `bash` is Git for Windows' — workflow steps written as `shell: bash` (most of them) run there. */
export const WINDOWS_REQUIRED_TOOLS: readonly RequiredTool[] = [
	{ tool: "git", needed: "checkout steps", remedy: "Install Git for Windows for all users: https://git-scm.com/download/win" },
	{ tool: "bash", needed: "workflow steps that use `shell: bash`", remedy: "Install Git for Windows (it provides bash) for all users, and make sure its usr\\bin or bin is on the machine PATH" },
	{ tool: "node", needed: "build steps", remedy: "Install Node.js for all users (MSI): https://nodejs.org" },
	{ tool: "pnpm", needed: "pnpm install / build", remedy: "Install pnpm machine-wide (npm i -g pnpm from an elevated prompt, or corepack enable)" },
	{ tool: "aws", needed: "deploys that run `aws s3 sync`", remedy: "Install the AWS CLI v2 MSI for all users: https://aws.amazon.com/cli/" },
];

export type ReadinessCode = "os_too_old" | "os_unreadable" | "tool_missing" | "tool_in_profile";

export interface ReadinessReason {
	code: ReadinessCode;
	tool?: string;
	message: string;
	remedy: string;
}

export interface WindowsReadiness {
	/** False off Windows: the check does not apply and must not block anything. */
	applicable: boolean;
	ready: boolean;
	state: "available" | "unavailable";
	build: number | null;
	reasons: ReadinessReason[];
	/** One paragraph for a person. */
	summary: string;
}

export interface WindowsReadinessDeps {
	platform: NodeJS.Platform;
	/** Run a program briefly; its trimmed stdout, or null when absent/failed. */
	probe: (file: string, args: string[]) => string | null;
	/** The first path `where <bin>` resolves, or null. */
	whichPath: (bin: string) => string | null;
	userProfile: string;
}

/** `Microsoft Windows [Version 10.0.19045.4651]` → 19045. Null for anything else. */
export function parseWindowsBuild(ver: string | null): number | null {
	const m = /\[Version\s+\d+\.\d+\.(\d+)(?:\.\d+)?\]/i.exec(ver ?? "");
	return m ? Number.parseInt(m[1], 10) : null;
}

export function checkWindowsReadiness(deps: WindowsReadinessDeps, required: readonly RequiredTool[] = WINDOWS_REQUIRED_TOOLS): WindowsReadiness {
	if (deps.platform !== "win32") return { applicable: false, ready: true, state: "available", build: null, reasons: [], summary: "Not a Windows machine; the Windows readiness check does not apply." };
	const reasons: ReadinessReason[] = [];
	const build = parseWindowsBuild(deps.probe("cmd", ["/c", "ver"]));
	if (build === null) reasons.push({ code: "os_unreadable", message: "The Windows version could not be read, so compatibility with the Actions runner is unknown.", remedy: "Run `pags up` from a normal Windows command prompt or PowerShell session and try again." });
	else if (build < MIN_WINDOWS_BUILD) reasons.push({ code: "os_too_old", message: `Windows build ${build} is older than the minimum supported build ${MIN_WINDOWS_BUILD} (Windows 10 1809 / Server 2019).`, remedy: "Update Windows, or route this repo's jobs to a newer machine." });

	const profiles = profileRoots({ userProfile: deps.userProfile });
	for (const t of required) {
		const where = deps.whichPath(t.tool);
		if (!where) {
			reasons.push({ code: "tool_missing", tool: t.tool, message: `\`${t.tool}\` is not on PATH — needed for ${t.needed}.`, remedy: t.remedy });
		} else if (profiles.some((p) => isWithin(where, p))) {
			reasons.push({ code: "tool_in_profile", tool: t.tool, message: `\`${t.tool}\` is installed inside a user profile (${win32.dirname(where)}); the runner service has no access to a profile, so its jobs cannot use it.`, remedy: `${t.remedy} (a machine-wide install, not a per-user one).` });
		}
	}
	const ready = reasons.length === 0;
	return {
		applicable: true,
		ready,
		state: ready ? "available" : "unavailable",
		build,
		reasons,
		summary: ready
			? `This Windows machine (build ${build}) has ${required.map((t) => t.tool).join(", ")} machine-wide and can take jobs.`
			: `This Windows machine is not ready to take jobs and is held out of routing until fixed: ${reasons.map((r) => `${r.message} ${r.remedy}`).join(" ")}`,
	};
}
