/**
 * #1272 — host readiness is its own question, separate from "is the service installed". A machine whose service started can still be
 * unusable CI capacity; this proves the check says so, with the reason and the fix, and that it only ever applies to Windows.
 */
import { describe, expect, it } from "vitest";
import { checkWindowsReadiness, MIN_WINDOWS_BUILD, parseWindowsBuild, WINDOWS_REQUIRED_TOOLS, type WindowsReadinessDeps } from "./windows-runner-readiness.js";

const VER = (build: number) => `Microsoft Windows [Version 10.0.${build}.4651]`;

function machine(over: { build?: number | null; tools?: Record<string, string | null>; platform?: NodeJS.Platform } = {}): WindowsReadinessDeps {
	const all: Record<string, string | null> = {
		git: "C:\\Program Files\\Git\\cmd\\git.exe",
		bash: "C:\\Program Files\\Git\\bin\\bash.exe",
		node: "C:\\Program Files\\nodejs\\node.exe",
		pnpm: "C:\\Program Files\\nodejs\\pnpm.cmd",
		aws: "C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe",
		...over.tools,
	};
	return {
		platform: over.platform ?? "win32",
		userProfile: "C:\\Users\\admin",
		probe: (file, args) => (file === "cmd" && args.join(" ") === "/c ver" ? (over.build === null ? null : VER(over.build ?? 19045)) : null),
		whichPath: (bin) => all[bin] ?? null,
	};
}

describe("parseWindowsBuild", () => {
	it("reads the build number out of `ver`", () => {
		expect(parseWindowsBuild("Microsoft Windows [Version 10.0.19045.4651]")).toBe(19045);
		expect(parseWindowsBuild("Microsoft Windows [Version 10.0.26100]")).toBe(26100);
		expect(parseWindowsBuild("Darwin")).toBeNull();
		expect(parseWindowsBuild(null)).toBeNull();
	});
});

describe("Windows host readiness (#1272)", () => {
	it("a current machine with every tool installed machine-wide is available", () => {
		const r = checkWindowsReadiness(machine());
		expect(r).toMatchObject({ applicable: true, ready: true, state: "available", build: 19045, reasons: [] });
		expect(r.summary).toMatch(/can take jobs/);
	});

	it("the incident: no AWS CLI → unavailable, naming the tool, why it matters and how to get it", () => {
		const r = checkWindowsReadiness(machine({ tools: { aws: null } }));
		expect(r.ready).toBe(false);
		expect(r.state).toBe("unavailable");
		expect(r.reasons).toHaveLength(1);
		expect(r.reasons[0]).toMatchObject({ code: "tool_missing", tool: "aws" });
		expect(r.reasons[0].message).toMatch(/aws s3 sync/);
		expect(r.reasons[0].remedy).toMatch(/MSI for all users/);
		expect(r.summary).toMatch(/held out of routing/);
	});

	it("bash missing is its own reason — Linux-style `shell: bash` steps cannot run without it", () => {
		const r = checkWindowsReadiness(machine({ tools: { bash: null } }));
		expect(r.reasons[0]).toMatchObject({ code: "tool_missing", tool: "bash" });
		expect(r.reasons[0].message).toMatch(/shell: bash/);
	});

	it("a tool installed inside a user profile is NOT available — the service account cannot see a profile", () => {
		const r = checkWindowsReadiness(machine({ tools: { aws: "C:\\Users\\admin\\AppData\\Local\\Programs\\AWS\\aws.exe", node: "c:/users/other/nodejs/node.exe" } }));
		expect(r.reasons.map((x) => [x.code, x.tool])).toEqual([["tool_in_profile", "node"], ["tool_in_profile", "aws"]]);
		expect(r.reasons[0].message).toMatch(/no access to a profile/);
		expect(r.reasons[0].remedy).toMatch(/machine-wide install, not a per-user one/);
	});

	it("a Windows build older than the minimum is unavailable with the minimum named", () => {
		const r = checkWindowsReadiness(machine({ build: MIN_WINDOWS_BUILD - 1 }));
		expect(r.reasons[0]).toMatchObject({ code: "os_too_old" });
		expect(r.reasons[0].message).toContain(String(MIN_WINDOWS_BUILD));
		expect(checkWindowsReadiness(machine({ build: MIN_WINDOWS_BUILD })).ready).toBe(true);
	});

	it("an unreadable Windows version is unavailable, not assumed fine", () => {
		const r = checkWindowsReadiness(machine({ build: null }));
		expect(r.reasons[0].code).toBe("os_unreadable");
		expect(r.build).toBeNull();
	});

	it("reports every problem at once, so one visit fixes them all", () => {
		const r = checkWindowsReadiness(machine({ build: 14393, tools: { aws: null, git: null } }));
		expect(r.reasons.map((x) => x.code).sort()).toEqual(["os_too_old", "tool_missing", "tool_missing"]);
	});

	it("does not apply off Windows and never blocks there", () => {
		for (const platform of ["darwin", "linux"] as const) {
			expect(checkWindowsReadiness(machine({ platform, tools: { aws: null } }))).toMatchObject({ applicable: false, ready: true, state: "available" });
		}
	});

	it("the required tools are explicit, each with a remedy", () => {
		expect(WINDOWS_REQUIRED_TOOLS.map((t) => t.tool)).toEqual(["git", "bash", "node", "pnpm", "aws"]);
		for (const t of WINDOWS_REQUIRED_TOOLS) expect(t.remedy.length).toBeGreaterThan(10);
		expect(checkWindowsReadiness(machine({ tools: { aws: null } }), [{ tool: "git", needed: "x", remedy: "y" }]).ready).toBe(true);
	});
});
