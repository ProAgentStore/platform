import { describe, expect, it } from "vitest";
import { checkEngine } from "./engine-check.js";
import { quoteCmdArg, resolveBinary, resolveEngineSpawn, shimTarget } from "./engine-spawn.js";

/**
 * Engine binary resolution on Windows (#1044). Run on any host: the platform, PATH, the file system
 * and the shim text are all injected, so these are the win32 code paths, not the host's.
 */
const NPM = "C:\\Users\\me\\AppData\\Roaming\\npm";
const NODE = "C:\\Program Files\\nodejs\\node.exe";

// What npm's cmd-shim writes for a native-binary `bin` (Claude Code) and for a Node script (codex).
const NATIVE_SHIM = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`;
const NODE_SHIM = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;

const CLAUDE_EXE = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const CODEX_JS = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;

function machine(files: Record<string, string>, env: NodeJS.ProcessEnv = { Path: `C:\\Windows\\system32;${NPM}`, ComSpec: "C:\\Windows\\system32\\cmd.exe" }) {
	return {
		platform: "win32" as const,
		env,
		nodePath: NODE,
		isExecutable: (p: string) => p in files,
		readText: (p: string) => files[p] ?? null,
	};
}

describe("resolveEngineSpawn on win32 (#1044)", () => {
	it("an npm shim-only install: spawns the package's native claude.exe, not the .cmd", () => {
		const deps = machine({ [`${NPM}\\claude.cmd`]: NATIVE_SHIM, [`${NPM}\\claude.ps1`]: "", [CLAUDE_EXE]: "" });
		const r = resolveEngineSpawn("claude", ["-p", "--output-format", "stream-json"], deps);
		expect(r).toEqual({ command: CLAUDE_EXE, args: ["-p", "--output-format", "stream-json"], binaryPath: CLAUDE_EXE, via: "direct" });
	});

	it("a real .exe on PATH is spawned directly, ahead of an earlier .cmd shim", () => {
		const exe = "C:\\tools\\claude\\claude.exe";
		const deps = machine({ [`${NPM}\\claude.cmd`]: NATIVE_SHIM, [CLAUDE_EXE]: "", [exe]: "" }, { PATH: `${NPM};C:\\tools\\claude` });
		expect(resolveEngineSpawn("claude", ["x"], deps)).toMatchObject({ command: exe, args: ["x"], binaryPath: exe, via: "direct" });
	});

	it("a Node-script shim (codex, gemini) runs its script with this Node — no shell, so a multi-line prompt survives", () => {
		const deps = machine({ [`${NPM}\\codex.cmd`]: NODE_SHIM, [CODEX_JS]: "" });
		const prompt = 'fix the "login" bug\nthen run the tests & push';
		const r = resolveEngineSpawn("codex", ["exec", "--json", prompt], deps);
		expect(r).toEqual({ command: NODE, args: [CODEX_JS, "exec", "--json", prompt], binaryPath: CODEX_JS, via: "node" });
		expect(r.windowsVerbatimArguments).toBeUndefined();
	});

	it("any other .cmd runs through cmd.exe /d /s /c with every argument quoted and escaped", () => {
		const deps = machine({ [`${NPM}\\grok.cmd`]: "@echo off\r\ngrok-real.exe %*\r\n" });
		const r = resolveEngineSpawn("grok", ["--prompt", "a & b | c", 'say "hi"'], deps);
		expect(r.via).toBe("cmd");
		expect(r.command).toBe("C:\\Windows\\system32\\cmd.exe");
		expect(r.windowsVerbatimArguments).toBe(true);
		expect(r.binaryPath).toBe(`${NPM}\\grok.cmd`);
		expect(r.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
		const line = r.args[3];
		expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
		// No metacharacter reaches cmd.exe bare: every one is caret-escaped.
		expect(line).not.toMatch(/(?<!\^)[&|]/);
		expect(line).toContain(quoteCmdArg("a & b | c"));
		expect(line).toContain(quoteCmdArg('say "hi"'));
	});

	it("a shim whose target is missing falls back to cmd.exe rather than a path that is not there", () => {
		const deps = machine({ [`${NPM}\\claude.cmd`]: NATIVE_SHIM });
		expect(resolveEngineSpawn("claude", [], deps).via).toBe("cmd");
	});

	it("not installed: spawns the bare name (ENOENT is the honest failure) and reports it missing", () => {
		const r = resolveEngineSpawn("claude", ["-p"], machine({}));
		expect(r).toEqual({ command: "claude", args: ["-p"], binaryPath: null, via: "direct" });
	});

	it("reads Windows env names case-insensitively (Path, ComSpec)", () => {
		const deps = machine({ [`${NPM}\\grok.cmd`]: "" }, { Path: NPM, ComSpec: "D:\\cmd.exe" });
		expect(resolveEngineSpawn("grok", [], deps).command).toBe("D:\\cmd.exe");
	});
});

describe("resolveEngineSpawn off Windows", () => {
	it("spawns the configured name unchanged", () => {
		const r = resolveEngineSpawn("claude", ["-p"], { platform: "linux", env: { PATH: "/usr/bin" }, isExecutable: (p) => p === "/usr/bin/claude" });
		expect(r).toEqual({ command: "claude", args: ["-p"], binaryPath: "/usr/bin/claude", via: "direct" });
	});
});

describe("shimTarget / quoteCmdArg", () => {
	it("reads the node_modules target, never the shim's own node.exe", () => {
		expect(shimTarget(`${NPM}\\codex.cmd`, NODE_SHIM)).toBe(CODEX_JS);
		expect(shimTarget(`${NPM}\\claude.cmd`, NATIVE_SHIM)).toBe(CLAUDE_EXE);
		expect(shimTarget(`${NPM}\\x.cmd`, "@echo off\r\nx.exe %*")).toBeNull();
	});

	it("quotes for the CRT parser, then caret-escapes for both cmd parses", () => {
		expect(quoteCmdArg("plain")).toBe('^^^"plain^^^"');
		expect(quoteCmdArg("a b")).toBe('^^^"a^^^ b^^^"');
		expect(quoteCmdArg('say "hi"')).toBe('^^^"say^^^ \\^^^"hi\\^^^"^^^"');
		expect(quoteCmdArg("C:\\dir\\")).toBe('^^^"C:\\dir\\\\^^^"');
	});
});

describe("resolveBinary (#879)", () => {
	it("finds a bare name on PATH and misses one that is not there", () => {
		const env = { PATH: "/usr/bin:/opt/codex/bin" };
		expect(resolveBinary("codex", { env, platform: "linux", isExecutable: (p) => p === "/opt/codex/bin/codex" })).toBe("/opt/codex/bin/codex");
		expect(resolveBinary("codex", { env, platform: "linux", isExecutable: () => false })).toBeNull();
	});

	it("takes a path as-is rather than searching PATH for it", () => {
		expect(resolveBinary("/usr/local/bin/claude", { env: { PATH: "" }, platform: "linux", isExecutable: (p) => p === "/usr/local/bin/claude" })).toBe("/usr/local/bin/claude");
	});
});

describe("checkEngine reports what the spawn will run (#1044)", () => {
	const base = { home: "C:\\Users\\me", exists: () => false };

	it("an npm shim-only claude: found, at the native exe the spawn uses", () => {
		const deps = { ...base, ...machine({ [`${NPM}\\claude.cmd`]: NATIVE_SHIM, [CLAUDE_EXE]: "" }) };
		const r = checkEngine({ clientType: "claude", command: "claude --dangerously-skip-permissions" }, deps);
		expect(r).toMatchObject({ binaryFound: true, binaryPath: CLAUDE_EXE, binaryVia: "direct" });
		expect(r.binaryPath).toBe(resolveEngineSpawn("claude", [], deps).command);
	});

	it("a codex Node-script shim: found, run through Node", () => {
		const deps = { ...base, ...machine({ [`${NPM}\\codex.cmd`]: NODE_SHIM, [CODEX_JS]: "" }) };
		expect(checkEngine({ clientType: "codex" }, deps)).toMatchObject({ binaryFound: true, binaryPath: CODEX_JS, binaryVia: "node" });
	});

	it("not installed: not found", () => {
		expect(checkEngine({ clientType: "claude" }, { ...base, ...machine({}) })).toMatchObject({ binaryFound: false });
	});
});
