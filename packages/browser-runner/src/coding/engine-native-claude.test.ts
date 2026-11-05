import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkEngine } from "./engine-check.js";
import { resolveEngineSpawn } from "./engine-spawn.js";

let home: string;
let native: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pags-native-claude-"));
	if (process.platform === "win32") return;
	const version = join(home, ".local", "share", "claude", "versions", "2.1.296");
	native = join(home, ".local", "bin", "claude");
	mkdirSync(join(home, ".local", "bin"), { recursive: true });
	mkdirSync(join(home, ".local", "share", "claude", "versions"), { recursive: true });
	writeFileSync(version, '#!/bin/sh\nprintf "%s\\n" "2.1.296 (Claude Code)" "$@"\n');
	chmodSync(version, 0o700);
	symlinkSync(version, native);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const machine = () => ({ home, platform: "darwin" as const, env: { PATH: join(home, "empty-service-path") } });

describe.skipIf(process.platform === "win32")("native Claude outside service PATH", () => {
	it("preflights and actually spawns the same executable symlink without changing model arguments", () => {
		const check = checkEngine({ clientType: "claude", command: "claude --model sonnet --dangerously-skip-permissions", credentialInjected: true, withVersion: true }, machine());
		expect(check).toMatchObject({ binaryFound: true, binaryPath: native, version: "2.1.296", login: "found" });
		const args = ["--model", "sonnet", "--dangerously-skip-permissions"];
		const launch = resolveEngineSpawn("claude", args, machine());
		expect(launch).toEqual({ command: native, args, binaryPath: native, via: "direct" });
		const child = spawnSync(launch.command, launch.args, { encoding: "utf8", env: machine().env, timeout: 5000 });
		expect(child.status).toBe(0);
		expect(child.stdout).toContain("--model\nsonnet\n--dangerously-skip-permissions");
	}, 15_000);

	it("preserves executable PATH overrides and explicit paths", () => {
		const customDir = join(home, "custom");
		mkdirSync(customDir);
		const custom = join(customDir, "claude");
		writeFileSync(custom, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		expect(resolveEngineSpawn("claude", [], { ...machine(), env: { PATH: customDir } })).toEqual({ command: "claude", args: [], binaryPath: custom, via: "direct" });
		expect(resolveEngineSpawn(custom, [], machine()).command).toBe(custom);
		const missing = join(home, "owner-selected", "claude");
		expect(resolveEngineSpawn(missing, [], machine())).toMatchObject({ command: missing, binaryPath: null });
	});

	it("refuses a non-executable native target and leaves login evidence separate", () => {
		chmodSync(native, 0o600);
		const check = checkEngine({ clientType: "claude", command: "claude", credentialInjected: true }, machine());
		expect(check).toMatchObject({ binaryFound: false, login: "found" });
	});
});

it("uses the Windows native filename only when no executable exists on PATH", () => {
	const native = "C:\\Users\\owner\\.local\\bin\\claude.exe";
	const deps = { platform: "win32" as const, home: "C:\\Users\\owner", env: { PATH: "C:\\tools" }, isExecutable: (p: string) => p.toLowerCase() === native.toLowerCase() };
	expect(resolveEngineSpawn("claude", [], deps)).toMatchObject({ command: native, binaryPath: native });
	const custom = "C:\\tools\\claude.exe";
	expect(resolveEngineSpawn("claude", [], { ...deps, isExecutable: (p) => p.toLowerCase() === native.toLowerCase() || p.toLowerCase() === custom.toLowerCase() })).toMatchObject({ command: custom, binaryPath: custom });
});
