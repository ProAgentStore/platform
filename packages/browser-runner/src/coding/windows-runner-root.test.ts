/**
 * #1272 — the machine-scoped Windows runner root: where it lives, the exact ACL, the proof it holds, and that setting it up again
 * changes nothing. Every effect goes through a fake Windows (windows-runner.fixture.ts); the real `icacls` is never run.
 */
import { describe, expect, it } from "vitest";
import {
	aclPlan,
	assertMachineRoot,
	ensureWindowsRunnerRoot,
	interpretProbeExit,
	isWithin,
	layoutFor,
	machineRoot,
	NETWORK_SERVICE,
	parseIcacls,
	parseLastResult,
	probeScript,
	profileRoots,
	scheduledTaskProbe,
	validateServiceIdentity,
	verifyAcl,
} from "./windows-runner-root.js";
import { fakeMachine, INHERITED_ACL, PROFILE, PROGRAM_DATA } from "./windows-runner.fixture.js";

const ROOT = "C:\\ProgramData\\ProAgentStore\\actions-runner\\proappstore-online";

describe("where a Windows runner lives", () => {
	it("is under ProgramData, one folder per scope", () => {
		expect(machineRoot(PROGRAM_DATA, "proappstore-online")).toBe(ROOT);
		expect(() => machineRoot(PROGRAM_DATA, "..\\..\\Users")).toThrow(/Not a runner folder/);
		expect(() => machineRoot(PROGRAM_DATA, "a b")).toThrow();
	});

	it("never inside a user profile — a path under C:\\Users, however spelled, is refused", () => {
		const profiles = profileRoots({ userProfile: PROFILE });
		expect(profiles).toEqual(["C:\\Users", PROFILE]);
		for (const bad of ["C:\\Users\\admin\\.proagentstore\\actions-runner\\org", "c:/users/ADMIN/.proagentstore/actions-runner/org", "C:\\Users\\other\\ProAgentStore\\actions-runner\\org", "C:\\Users\\..\\Users\\admin\\x\\ProAgentStore\\actions-runner\\o"]) {
			expect(() => assertMachineRoot(bad, profiles), bad).toThrow(/user profile/);
		}
		expect(() => assertMachineRoot(ROOT, profiles)).not.toThrow();
		expect(() => assertMachineRoot("C:\\actions-runner\\org", profiles)).toThrow(/not a ProAgentStore machine runner root/);
	});

	it("isWithin is case-, separator- and trailing-slash-insensitive", () => {
		expect(isWithin("c:/PROGRAMDATA/x/", "C:\\ProgramData")).toBe(true);
		expect(isWithin("C:\\ProgramDataX", "C:\\ProgramData")).toBe(false);
	});
});

describe("the service identity is least-privilege", () => {
	it("accepts the built-in service accounts and a dedicated named account", () => {
		for (const ok of [NETWORK_SERVICE, "NT AUTHORITY\\LOCAL SERVICE", "PINK-LAPTOP\\pags-runner", ".\\svc-runner", "svc-runner"]) expect(() => validateServiceIdentity(ok), ok).not.toThrow();
	});

	it("refuses SYSTEM, administrators and broad groups as the identity the workflow code would run as", () => {
		for (const bad of ["NT AUTHORITY\\SYSTEM", "LocalSystem", "Administrator", "Administrators", "PINK-LAPTOP\\Administrators", "BUILTIN\\Administrators", "Everyone", "Users", "BUILTIN\\Users", "NT AUTHORITY\\Authenticated Users"]) {
			expect(() => validateServiceIdentity(bad), bad).toThrow(/least-privilege/);
		}
		expect(() => validateServiceIdentity("a;b")).toThrow(/Not a Windows account/);
		expect(() => validateServiceIdentity("x".repeat(80))).toThrow();
	});
});

describe("the ACL plan", () => {
	const layout = layoutFor(ROOT);

	it("drops inheritance and grants exactly SYSTEM, Administrators (by SID) and the service identity Modify — on the runner root only", () => {
		const [grant, remove] = aclPlan(layout, NETWORK_SERVICE);
		expect(grant.args).toEqual([ROOT, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", `${NETWORK_SERVICE}:(OI)(CI)M`]);
		expect(remove.args.slice(0, 2)).toEqual([ROOT, "/remove:g"]);
		expect(remove.args).toEqual(expect.arrayContaining(["*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"]));
	});

	it("never names a profile, a desktop, an SSH folder or any path but the runner root", () => {
		for (const call of aclPlan(layout, "PC\\pags-runner")) {
			expect(call.file).toBe("icacls");
			const paths = call.args.filter((a) => /^[A-Za-z]:\\/.test(a));
			expect(paths).toEqual([ROOT]);
			expect(call.args.join(" ")).not.toMatch(/Users|\.ssh|Desktop|Documents/i);
		}
	});

	it("lays out the folders the runner writes to under the root", () => {
		expect(layout.work).toBe(`${ROOT}\\_work`);
		expect(layout.subdirs).toEqual(["_work", "_diag", "_temp", "_cache", "_logs"].map((d) => `${ROOT}\\${d}`));
	});

	it("refuses to plan for a privileged identity", () => {
		expect(() => aclPlan(layout, "NT AUTHORITY\\SYSTEM")).toThrow(/least-privilege/);
	});
});

describe("reading an ACL back", () => {
	const canonical = [`${ROOT} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)`, "                                                          BUILTIN\\Administrators:(OI)(CI)(F)", `                                                          ${NETWORK_SERVICE}:(OI)(CI)(M)`, "", "Successfully processed 1 files; Failed processing 0 files"].join("\r\n");

	it("parses principals with spaces and backslashes, inheritance flags and rights", () => {
		const aces = parseIcacls(canonical, ROOT);
		expect(aces).toEqual([
			{ principal: "NT AUTHORITY\\SYSTEM", flags: ["OI", "CI"], rights: ["F"] },
			{ principal: "BUILTIN\\Administrators", flags: ["OI", "CI"], rights: ["F"] },
			{ principal: NETWORK_SERVICE, flags: ["OI", "CI"], rights: ["M"] },
		]);
		expect(parseIcacls(`${ROOT} Everyone:(I)(OI)(CI)(RX,W)\n`, ROOT)[0]).toEqual({ principal: "Everyone", flags: ["I", "OI", "CI"], rights: ["RX", "W"] });
		expect(parseIcacls("garbage\n\nSuccessfully processed 1 files", ROOT)).toEqual([]);
	});

	it("verifies the canonical ACL", () => {
		expect(verifyAcl(parseIcacls(canonical, ROOT), NETWORK_SERVICE)).toEqual([]);
	});

	it.each([
		["inherited ACEs", `${ROOT} NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)\n BUILTIN\\Administrators:(OI)(CI)(F)\n ${NETWORK_SERVICE}:(OI)(CI)(M)`, "inherited"],
		["no access for the service identity", `${ROOT} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n BUILTIN\\Administrators:(OI)(CI)(F)`, "missing_identity"],
		["a read-only service identity", `${ROOT} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n BUILTIN\\Administrators:(OI)(CI)(F)\n ${NETWORK_SERVICE}:(OI)(CI)(RX)`, "identity_too_weak"],
		["Users on the root", `${ROOT} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n BUILTIN\\Administrators:(OI)(CI)(F)\n ${NETWORK_SERVICE}:(OI)(CI)(M)\n BUILTIN\\Users:(OI)(CI)(RX)`, "unexpected_principal"],
		["the interactive owner on the root", `${ROOT} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n BUILTIN\\Administrators:(OI)(CI)(F)\n ${NETWORK_SERVICE}:(OI)(CI)(M)\n PINK\\admin:(OI)(CI)(F)`, "unexpected_principal"],
		["a missing SYSTEM", `${ROOT} BUILTIN\\Administrators:(OI)(CI)(F)\n ${NETWORK_SERVICE}:(OI)(CI)(M)`, "missing_system"],
		["no Administrators (recovery impossible)", `${ROOT} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n ${NETWORK_SERVICE}:(OI)(CI)(M)`, "missing_administrators"],
		["a DENY entry", `${ROOT} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n BUILTIN\\Administrators:(OI)(CI)(F)\n ${NETWORK_SERVICE}:(OI)(CI)(M)\n Everyone:(DENY)(W)`, "deny_ace"],
	])("rejects %s", (_n, text, code) => {
		expect(verifyAcl(parseIcacls(text, ROOT), NETWORK_SERVICE).map((v) => v.code)).toContain(code);
	});

	it("an empty read is a failure, not a pass", () => {
		expect(verifyAcl([], NETWORK_SERVICE)[0].code).toBe("unreadable");
	});
});

describe("ensureWindowsRunnerRoot", () => {
	const ensure = (m = fakeMachine(), identity?: string) => ensureWindowsRunnerRoot(m, { folder: "proappstore-online", identity });
	const grants = (m: ReturnType<typeof fakeMachine>) => m.calls.filter((c) => c.file === "icacls" && c.args.includes("/grant:r")).length;

	it("a fresh install creates the root and its folders, sets the ACL, verifies it, and proves it as the service identity", async () => {
		const m = fakeMachine();
		const r = await ensure(m);
		expect(r).toMatchObject({ root: ROOT, changed: true, verified: "effective", identity: NETWORK_SERVICE });
		for (const d of [ROOT, `${ROOT}\\_work`, `${ROOT}\\_diag`]) expect(m.dirs.has(d)).toBe(true);
		expect(verifyAcl(parseIcacls(m.calls.length ? (m.acls.get(ROOT) ?? []).join("\n") : "", ROOT), NETWORK_SERVICE)).toEqual([]);
		// The probe script was written, run as the identity, and removed.
		expect(m.files.has(`${ROOT}\\.acl-probe.cmd`)).toBe(false);
	});

	it("gives no permission on the user profile: not one icacls call touches it", async () => {
		const m = fakeMachine();
		await ensure(m);
		const touched = m.calls.flatMap((c) => c.args).filter((a) => /^[A-Za-z]:\\/.test(a));
		expect(touched.every((a) => a.startsWith(ROOT))).toBe(true);
		expect(touched.some((a) => a.toLowerCase().startsWith(PROFILE.toLowerCase()))).toBe(false);
		expect(m.acls.has(PROFILE)).toBe(false);
	});

	it("is idempotent: running it again verifies and changes nothing", async () => {
		const m = fakeMachine();
		await ensure(m);
		const before = grants(m);
		const again = await ensure(m);
		expect(again.changed).toBe(false);
		expect(again.steps).toContain("ACL already satisfies the policy");
		expect(grants(m)).toBe(before);
		// Three more times (pags up, a restart, a self-update) converge on the same ACL.
		const acl = [...(m.acls.get(ROOT) ?? [])].sort();
		for (let i = 0; i < 3; i++) await ensure(m);
		expect([...(m.acls.get(ROOT) ?? [])].sort()).toEqual(acl);
	});

	it("repairs a root that already exists with inherited, over-broad permissions", async () => {
		const m = fakeMachine();
		m.dirs.add(ROOT);
		m.acls.set(ROOT, [...INHERITED_ACL]);
		const r = await ensure(m);
		expect(r.changed).toBe(true);
		expect((m.acls.get(ROOT) ?? []).some((a) => /Users|Authenticated/.test(a))).toBe(false);
	});

	it("fails — and names why — if the grant did not take, instead of reporting a working install", async () => {
		const m = fakeMachine();
		m.ignoreGrants.value = true;
		await expect(ensure(m)).rejects.toThrow(/does not have the required permissions[\s\S]*no ACL entries/);
	});

	it("fails if the service identity can read the user profile, or cannot use its own root", async () => {
		const profile = fakeMachine();
		profile.probeExit.value = 3;
		await expect(ensure(profile)).rejects.toThrow(/CAN read the user profile/);
		const own = fakeMachine();
		own.probeExit.value = 2;
		await expect(ensure(own)).rejects.toThrow(/cannot list the runner root/);
		const none = fakeMachine();
		none.probeExit.value = null;
		await expect(ensure(none)).rejects.toThrow(/did not complete/);
	});

	it("without a probe it still verifies the ACL, and says the check was static", async () => {
		const m = fakeMachine({ probeAs: undefined });
		expect((await ensure(m)).verified).toBe("static");
	});

	it("works for a dedicated non-administrator service account, granting it and not NETWORK SERVICE", async () => {
		const m = fakeMachine();
		const r = await ensure(m, "PINK-LAPTOP\\pags-runner");
		expect(r.identity).toBe("PINK-LAPTOP\\pags-runner");
		const acl = (m.acls.get(ROOT) ?? []).join("\n");
		expect(acl).toContain("PINK-LAPTOP\\pags-runner:(OI)(CI)(M)");
		expect(acl).not.toContain("NETWORK SERVICE");
		await expect(ensure(fakeMachine(), "Administrators")).rejects.toThrow(/least-privilege/);
	});

	it("refuses off Windows, and refuses a ProgramData that is itself under a profile", async () => {
		await expect(ensure(fakeMachine({ platform: "darwin" }))).rejects.toThrow(/only set up on Windows/);
		await expect(ensureWindowsRunnerRoot(fakeMachine({ programData: "C:\\Users\\admin\\AppData\\ProgramData" }), { folder: "o" })).rejects.toThrow(/user profile/);
	});

	it("an exec failure surfaces its own message and creates no half-configured success", async () => {
		const m = fakeMachine();
		m.failOn((f, a) => f === "icacls" && a.includes("/inheritance:r"), "icacls failed: Access is denied. Run as administrator");
		await expect(ensure(m)).rejects.toThrow(/Access is denied/);
	});
});

describe("the access probe", () => {
	const layout = layoutFor(ROOT);

	it("lists the root, writes and deletes in _work, and must NOT be able to list the profile", () => {
		const s = probeScript(layout, PROFILE);
		expect(s).toContain(`dir "${ROOT}"`);
		expect(s).toContain(`${ROOT}\\_work\\.acl-probe`);
		expect(s).toContain(`dir "${PROFILE}" >nul 2>&1 && exit /b 3`);
	});

	it("maps exit codes to a verdict", () => {
		expect(interpretProbeExit(0).ok).toBe(true);
		expect(interpretProbeExit(2).detail).toMatch(/cannot list/);
		expect(interpretProbeExit(3).detail).toMatch(/CAN read the user profile/);
		expect(interpretProbeExit(null).ok).toBe(false);
	});

	it("reads the task's Last Result from schtasks CSV", () => {
		expect(parseLastResult('"HostName","TaskName","Status","Last Result"\r\n"PC","\\PAGS-AclProbe","Ready","3"\r\n')).toBe(3);
		expect(parseLastResult("")).toBeNull();
		expect(parseLastResult('"A","B"\r\n"1","2"')).toBeNull();
	});

	it("scheduledTaskProbe runs the script as the built-in account, reads the result, and always deletes the task", async () => {
		const calls: string[][] = [];
		const exec = async (file: string, args: string[]) => {
			calls.push([file, ...args]);
			return { stdout: args[0] === "/Query" ? '"TaskName","Status","Last Result"\r\n"x","Ready","0"\r\n' : "", stderr: "" };
		};
		const probe = scheduledTaskProbe(exec, async () => undefined);
		expect(await probe(NETWORK_SERVICE, `${ROOT}\\.acl-probe.cmd`)).toBe(0);
		expect(calls.map((c) => c[1])).toEqual(["/Create", "/Run", "/Query", "/Delete"]);
		expect(calls[0]).toEqual(expect.arrayContaining(["/RU", NETWORK_SERVICE, "/TR", `"${ROOT}\\.acl-probe.cmd"`]));
		const failing = scheduledTaskProbe(async (_f, a) => {
			if (a[0] === "/Run") throw new Error("run failed");
			return { stdout: "", stderr: "" };
		}, async () => undefined);
		await expect(failing(NETWORK_SERVICE, "x")).rejects.toThrow(/run failed/);
	});

	it("a named account is not probed (it would need a password this never asks for)", async () => {
		await expect(scheduledTaskProbe(async () => ({ stdout: "", stderr: "" }))("PC\\svc", "x")).rejects.toThrow(/only as NETWORK SERVICE/);
	});
});
