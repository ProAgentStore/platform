import { afterEach, describe, expect, it, vi } from "vitest";
import { latestPublishedRelease, latestPublishedVersion, npmFailure, npmInvocation, quoteCmdArg } from "./payload.js";

/** The real `execFile` call `latestPublishedVersion` makes, captured — nothing is spawned. */
const calls = vi.hoisted(() => [] as Array<{ file: string; args: string[]; opts: Record<string, unknown> }>);
/** What the next execFile call fails with, when set (#1054) — the error object execFile itself would hand back. */
const fail = vi.hoisted(() => ({ next: null as (Error & Record<string, unknown>) | null }));
vi.mock("node:child_process", () => ({
	execFile: (file: string, args: string[], opts: Record<string, unknown>, cb: (e: Error | null, out: { stdout: string; stderr: string }) => void) => {
		calls.push({ file, args, opts });
		const e = fail.next;
		fail.next = null;
		if (e) cb(e, { stdout: "", stderr: String(e.stderr ?? "") });
		else cb(null, { stdout: "0.4.116\n", stderr: "" });
	},
}));

/**
 * #1020 (dell-laptop): on Windows `npm` is `npm.cmd`, which execFile cannot start without a shell, so
 * the release check and every install failed. The platform, PATH and file system are injected, so these
 * are the win32 paths on any host.
 */
const NODE_DIR = "C:\\Program Files\\nodejs";
const NODE = `${NODE_DIR}\\node.exe`;
const APPDATA_NPM = "C:\\Users\\John Doe\\AppData\\Roaming\\npm";
const cliIn = (dir: string) => `${dir}\\node_modules\\npm\\bin\\npm-cli.js`;
const win = (files: string[], env: NodeJS.ProcessEnv = { Path: `C:\\Windows\\system32;${APPDATA_NPM};${NODE_DIR}`, ComSpec: "C:\\Windows\\system32\\cmd.exe" }) => ({
	platform: "win32" as const,
	env,
	execPath: NODE,
	exists: (p: string) => files.includes(p),
});

describe("npmInvocation (#1020)", () => {
	it("off Windows: npm is an executable and runs as itself", () => {
		expect(npmInvocation(["view", "@proagentstore/cli", "version"], { platform: "linux" })).toEqual({ file: "npm", args: ["view", "@proagentstore/cli", "version"] });
		expect(npmInvocation(["i", "-g", "x"], { platform: "darwin" }).file).toBe("npm");
	});

	it("Windows: the npm.cmd PATH resolves wins — its own npm-cli.js, run by this Node, no shell", () => {
		const deps = win([`${APPDATA_NPM}\\npm.cmd`, cliIn(APPDATA_NPM), `${NODE_DIR}\\npm.cmd`, cliIn(NODE_DIR)]);
		expect(npmInvocation(["i", "-g", "@proagentstore/cli@0.4.116"], deps)).toEqual({ file: NODE, args: [cliIn(APPDATA_NPM), "i", "-g", "@proagentstore/cli@0.4.116"] });
	});

	it("Windows: falls back to the npm the Node installer put beside node.exe", () => {
		const deps = win([cliIn(NODE_DIR)], { PATH: "C:\\Windows\\system32" });
		expect(npmInvocation(["view", "@proagentstore/cli", "version"], deps)).toEqual({ file: NODE, args: [cliIn(NODE_DIR), "view", "@proagentstore/cli", "version"] });
	});

	it("Windows with no npm-cli.js to be found: npm.cmd through cmd.exe, every argument quoted (a spaced --prefix stays one argument)", () => {
		const prefix = "C:\\Users\\John Doe\\.config\\proagentstore\\cli\\.install-0.4.116-x";
		const r = npmInvocation(["install", "--prefix", prefix, "@proagentstore/cli@0.4.116"], win([]));
		expect(r.file).toBe("C:\\Windows\\system32\\cmd.exe");
		expect(r.windowsVerbatimArguments).toBe(true);
		expect(r.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
		expect(r.args[3]).toBe(`"npm ${["install", "--prefix", prefix, "@proagentstore/cli@0.4.116"].map(quoteCmdArg).join(" ")}"`);
		// No space reaches cmd.exe unescaped, so the path cannot split.
		expect(r.args[3].slice(1, -1)).not.toMatch(/(?<!\^) (?!\^)/);
	});

	it("quoteCmdArg: CRT quoting, then caret-escaped for cmd and again for npm.cmd's %*", () => {
		expect(quoteCmdArg("view")).toBe('^^^"view^^^"');
		expect(quoteCmdArg("a b")).toBe('^^^"a^^^ b^^^"');
		expect(quoteCmdArg("C:\\dir\\")).toBe('^^^"C:\\dir\\\\^^^"');
	});
});

describe("latestPublishedVersion on win32 — the production call (#1020)", () => {
	const real = process.platform;
	afterEach(() => {
		Object.defineProperty(process, "platform", { value: real });
		calls.length = 0;
	});

	it("never hands execFile a bare `npm` on Windows", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		expect(await latestPublishedVersion()).toBe("0.4.116");
		expect(calls).toHaveLength(1);
		expect(calls[0].file).not.toBe("npm");
		// This host has no npm-cli.js at Windows paths, so it is the quoted cmd.exe route, verbatim.
		expect(calls[0].opts.windowsVerbatimArguments).toBe(true);
		expect(calls[0].args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
	});

	it("says WHY npm could not be asked — the spawn failure a shell-less npm.cmd produced (#1054)", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		fail.next = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT", errno: -4058, syscall: "spawn npm" });
		expect(await latestPublishedRelease()).toEqual({ error: "npm could not be started (ENOENT: spawn npm ENOENT)" });
		expect(await latestPublishedVersion()).toBe("0.4.116"); // the null-or-version form is unchanged for the stub
	});

	it("carries npm's own error when it ran and failed", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		fail.next = Object.assign(new Error("Command failed"), { code: 1, stderr: "npm error code ECONNRESET\nnpm error network aborted\nnpm error A complete log of this run can be found in: C:\\Users\\admin\\AppData\\Local\\npm-cache\\_logs\\x.log\n" });
		expect(await latestPublishedRelease()).toEqual({ error: "npm error code ECONNRESET npm error network aborted" });
	});

	it("still runs plain `npm` elsewhere", async () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		await latestPublishedVersion();
		expect(calls[0]).toMatchObject({ file: "npm", args: ["view", "@proagentstore/cli", "version"] });
		expect(calls[0].opts.windowsVerbatimArguments).toBeUndefined();
	});
});

describe("npmFailure (#1054) — one bounded line, never a dropped reason", () => {
	it("names a timeout", () => {
		expect(npmFailure(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }))).toBe("npm did not answer in time (SIGTERM)");
	});
	it("falls back to stderr's last line, then the message", () => {
		expect(npmFailure({ stderr: "warn: proxy\nunexpected token\n" })).toBe("unexpected token");
		expect(npmFailure(new Error("boom"))).toBe("boom");
	});
	it("is single-line and bounded", () => {
		const out = npmFailure({ stderr: `npm error ${"x".repeat(1000)}\nnpm error two` });
		expect(out).not.toMatch(/\n/);
		expect(out.length).toBeLessThanOrEqual(300);
	});
	it("an empty answer is its own reason, not a version", async () => {
		expect(await latestPublishedRelease(1000, undefined, { runNpm: (async () => ({ stdout: "  \n", stderr: "" })) as never })).toEqual({ error: "npm printed no version" });
	});
});
