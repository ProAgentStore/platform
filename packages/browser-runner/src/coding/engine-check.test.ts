import { describe, expect, it } from "vitest";
import { checkEngine, detectEngineLogin, resolveBinary } from "./engine-check.js";

const HOME = "/home/me";
const onPath = (bins: string[]) => (p: string) => bins.some((b) => p === b);

describe("resolveBinary — the lookup spawn does (#879)", () => {
	it("finds a bare name on PATH and misses one that is not there", () => {
		const env = { PATH: "/usr/bin:/opt/codex/bin" };
		expect(resolveBinary("codex", { env, platform: "linux", isExecutable: onPath(["/opt/codex/bin/codex"]) })).toBe("/opt/codex/bin/codex");
		expect(resolveBinary("codex", { env, platform: "linux", isExecutable: onPath([]) })).toBeNull();
	});

	it("takes a path as-is rather than searching PATH for it", () => {
		expect(resolveBinary("/usr/local/bin/claude", { env: { PATH: "" }, isExecutable: onPath(["/usr/local/bin/claude"]) })).toBe("/usr/local/bin/claude");
	});
});

describe("detectEngineLogin — subscription login presence only (#879)", () => {
	it("codex: auth.json under CODEX_HOME (default ~/.codex) is the login", () => {
		expect(detectEngineLogin("codex", { env: {}, home: HOME, exists: onPath([`${HOME}/.codex/auth.json`]) }).login).toBe("found");
		expect(detectEngineLogin("codex", { env: {}, home: HOME, exists: onPath([]) }).login).toBe("missing");
		expect(detectEngineLogin("codex", { env: { CODEX_HOME: "/cfg/codex" }, home: HOME, exists: onPath(["/cfg/codex/auth.json"]) }).login).toBe("found");
	});

	it("never counts an API key as a login", () => {
		const r = detectEngineLogin("codex", { env: { OPENAI_API_KEY: "sk-x" }, home: HOME, exists: onPath([]) });
		expect(r.login).toBe("missing");
		const c = detectEngineLogin("claude", { env: { ANTHROPIC_API_KEY: "sk-x" }, home: HOME, platform: "linux", exists: onPath([]) });
		expect(c.login).toBe("missing");
	});

	it("claude on macOS reads the keychain item's EXISTENCE, and an unreadable keychain is unknown, not missing", () => {
		const base = { env: {}, home: HOME, platform: "darwin" as const, exists: onPath([]) };
		expect(detectEngineLogin("claude", { ...base, keychainItemStatus: () => 0 }).login).toBe("found");
		expect(detectEngineLogin("claude", { ...base, keychainItemStatus: () => 44 }).login).toBe("missing");
		expect(detectEngineLogin("claude", { ...base, keychainItemStatus: () => 51 }).login).toBe("unknown");
		expect(detectEngineLogin("claude", { ...base, keychainItemStatus: () => null }).login).toBe("unknown");
	});

	it("claude: the credentials file or an exported subscription token is a login", () => {
		expect(detectEngineLogin("claude", { env: {}, home: HOME, platform: "linux", exists: onPath([`${HOME}/.claude/.credentials.json`]) }).login).toBe("found");
		expect(detectEngineLogin("claude", { env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, home: HOME, platform: "linux", exists: onPath([]) }).login).toBe("found");
	});

	it("engines with other sign-in routes are never reported missing", () => {
		expect(detectEngineLogin("gemini", { env: {}, home: HOME, exists: onPath([]) }).login).toBe("unknown");
		expect(detectEngineLogin("grok", { env: {}, home: HOME, exists: onPath([]) }).login).toBe("unknown");
	});
});

describe("checkEngine (#879)", () => {
	it("names the binary the command would spawn and reports both facts", () => {
		const r = checkEngine(
			{ clientType: "codex", command: "codex exec --json --sandbox danger-full-access" },
			{ env: { PATH: "/usr/bin" }, home: HOME, platform: "linux", isExecutable: onPath([]), exists: onPath([]) },
		);
		expect(r).toMatchObject({ checked: true, engine: "codex", bin: "codex", binaryFound: false, login: "missing" });
	});

	it("skips the machine-login check when the platform injects the credential", () => {
		const r = checkEngine(
			{ clientType: "claude", command: "claude --dangerously-skip-permissions", credentialInjected: true },
			{ env: { PATH: "/bin" }, home: HOME, platform: "linux", isExecutable: onPath(["/bin/claude"]), exists: onPath([]) },
		);
		expect(r).toMatchObject({ binaryFound: true, binaryPath: "/bin/claude", login: "found" });
	});

	it("falls back to the engine's default command when none is given", () => {
		const r = checkEngine({ clientType: "codex" }, { env: { PATH: "/b" }, home: HOME, platform: "linux", isExecutable: onPath(["/b/codex"]), exists: onPath([`${HOME}/.codex/auth.json`]) });
		expect(r).toMatchObject({ bin: "codex", binaryFound: true, login: "found" });
	});
});
