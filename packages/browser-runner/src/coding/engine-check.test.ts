import { describe, expect, it } from "vitest";
import { checkEngine, detectEngineLogin } from "./engine-check.js";

const HOME = "/home/me";
const onPath = (bins: string[]) => (p: string) => bins.some((b) => p === b);

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
		// Grok's other routes — an external auth provider, OIDC, an enterprise deployment key — stay unknown (#1156).
		for (const v of ["GROK_AUTH_PROVIDER_COMMAND", "GROK_OIDC_ISSUER", "GROK_DEPLOYMENT_KEY"]) {
			expect(detectEngineLogin("grok", { env: { [v]: "x" }, home: HOME, exists: onPath([]) }).login).toBe("unknown");
		}
	});

	it("grok: xAI's subscription login is auth.json under GROK_HOME (default ~/.grok) — without it the CLI refuses every turn (#1156)", () => {
		// Verified on xAI's Grok CLI 1.0.62 with no ~/.grok/auth.json: "Not signed in. To authenticate without a browser…".
		expect(detectEngineLogin("grok", { env: {}, home: HOME, exists: onPath([`${HOME}/.grok/auth.json`]) })).toEqual({ login: "found", where: `${HOME}/.grok/auth.json` });
		expect(detectEngineLogin("grok", { env: {}, home: HOME, exists: onPath([]) }).login).toBe("missing");
		expect(detectEngineLogin("grok", { env: { GROK_HOME: "/cfg/grok" }, home: HOME, exists: onPath(["/cfg/grok/auth.json"]) }).login).toBe("found");
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

describe("which grok, and which version (#1156)", () => {
	const official = `${HOME}/.grok/bin/grok`;
	const nvm = `${HOME}/.nvm/versions/node/v22/bin/grok`;
	const check = (files: string[], versionText: string | null, realpath: (p: string) => string = (p) => p) =>
		checkEngine({ clientType: "grok", command: "grok --permission-mode bypassPermissions -p" }, { env: { PATH: `${HOME}/.nvm/versions/node/v22/bin` }, platform: "darwin", home: HOME, exists: () => false, isExecutable: (p) => files.includes(p), versionText: () => versionText, realpath });

	it("xAI's CLI in ~/.grok/bin wins over an npm `grok` earlier on PATH, and names itself", () => {
		const r = check([official, nvm], "grok 1.0.62 (1474f9cbdd91)\n");
		expect(r).toMatchObject({ binaryFound: true, binaryPath: official, version: "1.0.62", vendor: "xai" });
	});

	it("only the community npm package: found, but reported as what it is — its bare version and its node_modules target", () => {
		const r = check([nvm], "1.0.1\n", () => `${HOME}/.nvm/versions/node/v22/lib/node_modules/@vibe-kit/grok-cli/dist/index.js`);
		expect(r).toMatchObject({ binaryPath: nvm, version: "1.0.1", vendor: "community" });
	});

	it("a version that does not answer is null, not a guess; other engines are asked only when the caller wants it", () => {
		expect(check([official], null)).toMatchObject({ version: null, vendor: "unknown" });
		const codex = checkEngine({ clientType: "codex", command: "codex exec" }, { env: { PATH: "/bin" }, platform: "darwin", home: HOME, exists: () => false, isExecutable: (p) => p === "/bin/codex", versionText: () => "codex-cli 0.162.1" });
		expect(codex.version).toBeUndefined();
		const asked = checkEngine({ clientType: "codex", command: "codex exec", withVersion: true }, { env: { PATH: "/bin" }, platform: "darwin", home: HOME, exists: () => false, isExecutable: (p) => p === "/bin/codex", versionText: () => "codex-cli 0.162.1" });
		expect(asked.version).toBe("0.162.1");
	});
});
