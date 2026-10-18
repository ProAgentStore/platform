import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { artifactEngineEnv } from "../local-artifact/engine.js";
import { engineEnv as browserEngineEnv } from "../local-browser/engine.js";
import { dropPlatformCredentials, engineSpawnEnv, mergeEnv, PLATFORM_CREDENTIAL_ENV } from "./engine-env.js";

/**
 * Moved here with `mergeEnv` itself when #679 gave the spawn-env concern its own file. The
 * behaviour is unchanged; what moved is where it lives.
 */
describe("mergeEnv — the platform's engine choice must beat the machine's", () => {
	it("REMOVES a key the platform sends as empty", () => {
		// The whole reason this exists: a developer with ANTHROPIC_API_KEY exported handed it to
		// every engine, and Claude Code prefers an API key over the subscription token — so
		// picking "subscription" billed per token anyway, silently.
		const out = mergeEnv({ ANTHROPIC_API_KEY: "sk-ant-real", PATH: "/usr/bin" }, { CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "" });
		expect("ANTHROPIC_API_KEY" in out).toBe(false);
		expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
	});

	it("removes OPENAI_API_KEY for Codex ChatGPT sign-in too", () => {
		const out = mergeEnv({ OPENAI_API_KEY: "sk-openai-shell", PATH: "/usr/bin" }, { OPENAI_API_KEY: "" });
		expect("OPENAI_API_KEY" in out).toBe(false);
		expect(out.PATH).toBe("/usr/bin");
	});

	it("keeps the rest of the machine env untouched", () => {
		const out = mergeEnv({ PATH: "/usr/bin", HOME: "/Users/x" }, { CLAUDE_CODE_OAUTH_TOKEN: "tok" });
		expect(out.PATH).toBe("/usr/bin");
		expect(out.HOME).toBe("/Users/x");
	});

	it("still lets api-key mode SET the key", () => {
		// Removal must not become a blanket ban — choosing api-key mode is legitimate.
		const out = mergeEnv({}, { ANTHROPIC_API_KEY: "sk-ant-chosen" });
		expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-chosen");
	});

	it("passes the machine env straight through when the platform sends nothing", () => {
		// "machine" auth: PAGS injects nothing and must not strip anything either.
		const out = mergeEnv({ ANTHROPIC_API_KEY: "sk-ant-machine" }, undefined);
		expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-machine");
	});
});

/**
 * #1163 — no engine inherits the platform's credentials. `PAGS_TOKEN` is the owner's 30-day account
 * session; an engine runs with permission prompts off on untrusted repos and issues, so a prompt
 * injection gets whatever its environment holds.
 */
describe("an engine's env never carries the platform's credentials (#1163)", () => {
	const CREDS = { PAGS_TOKEN: "acct-session-30d", PAGS_RUNNER_TOKEN: "pags_runner_bearer", PAGS_RUNNER_CONTROL_NONCE: "shutdown-nonce" };

	it("a spawned engine process sees none of them — whatever the machine's env held", () => {
		const saved = { ...process.env };
		Object.assign(process.env, CREDS);
		try {
			const env = engineSpawnEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sub" }, undefined);
			// A real child process, reading its own environment: the claim is about what the engine gets.
			const seen = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { env, encoding: "utf8" });
			for (const [name, value] of Object.entries(CREDS)) {
				expect(seen, name).not.toContain(value);
				expect(JSON.parse(seen)[name], name).toBeUndefined();
			}
			// The engine still gets what it is FOR.
			expect(JSON.parse(seen).CLAUDE_CODE_OAUTH_TOKEN).toBe("sub");
		} finally {
			for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
			Object.assign(process.env, saved);
		}
	});

	it("an overlay cannot put one back", () => {
		const out = mergeEnv({ PATH: "/usr/bin" }, { PAGS_TOKEN: "from-an-overlay" });
		expect(out.PAGS_TOKEN).toBeUndefined();
	});

	it("the local-browser and local-artifact engines are covered too — they build their env through the same merge", () => {
		const base = { PATH: "/usr/bin", ...CREDS };
		for (const env of [browserEngineEnv("machine", "claude", 60_000, base), artifactEngineEnv("machine", base)]) {
			for (const name of PLATFORM_CREDENTIAL_ENV) expect(env[name], name).toBeUndefined();
		}
	});

	it("the runtime drops them from its own env at start, so git, gh and a browser cannot inherit them either", () => {
		const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", ...CREDS };
		dropPlatformCredentials(env);
		expect(env).toEqual({ PATH: "/usr/bin" });
	});
});
