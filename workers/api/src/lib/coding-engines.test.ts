import { describe, expect, it } from "vitest";
import {
	DEFAULT_ENGINES,
	ENGINE_WRITE_FLAGS,
	deriveClientType,
	engineAuthFor,
	engineAuthReport,
	engineAuthWarning,
	resolveEngineEnv,
	type CodingEngine,
} from "./coding-engines.js";
import type { Env } from "../types.js";

/** Env whose vault holds only the providers listed. */
function buildEnv(stored: Record<string, string> = {}) {
	return {
		DB: {
			prepare() {
				return { bind() { return { async first() { return null; }, async all() { return { results: [] }; } }; } };
			},
		},
		__stored: stored,
	} as unknown as Env;
}

/** resolveEngineEnv reads the vault via getUserProviderKey; stub the module boundary by
 *  passing an env whose DB returns nothing, so "no stored token" is the default path. */
const session = (over: Record<string, unknown> = {}) =>
	({ id: "s1", clientType: "claude", launchCommand: "claude --dangerously-skip-permissions", ...over }) as never;

const presets: CodingEngine[] = [
	{ id: "claude", label: "Claude Code", command: "claude --dangerously-skip-permissions" },
	{ id: "sub", label: "Claude (subscription)", command: "claude --sub", auth: "subscription" },
	{ id: "machine", label: "Claude (machine)", command: "claude --machine", auth: "machine" },
	{ id: "key", label: "Claude (api key)", command: "claude --key", auth: "api-key" },
];

describe("engineAuthFor", () => {
	it("defaults an unlabelled preset to auto", () => {
		expect(engineAuthFor(presets, "claude --dangerously-skip-permissions")).toBe("auto");
	});

	it("reads the preset's declared mode", () => {
		expect(engineAuthFor(presets, "claude --sub")).toBe("subscription");
		expect(engineAuthFor(presets, "claude --machine")).toBe("machine");
		expect(engineAuthFor(presets, "claude --key")).toBe("api-key");
	});

	it("falls back to auto for a command matching no preset", () => {
		// An edited preset applies on the next start; an orphan command must not crash.
		expect(engineAuthFor(presets, "claude --something-else")).toBe("auto");
	});
});

describe("resolveEngineEnv — a mode must decide how the engine BILLS", () => {
	it("auto with no stored token STRIPS the inherited API key", async () => {
		// The bug this exists to stop: a shell exporting ANTHROPIC_API_KEY silently turned every
		// mode into per-token billing, because the runner inherits process.env wholesale and
		// Claude Code prefers an API key over the subscription login.
		const out = await resolveEngineEnv(buildEnv(), "i1", "u1", session());
		expect(out).toEqual({ ANTHROPIC_API_KEY: "" }); // "" means REMOVE (runner mergeEnv)
	});

	it("machine mode strips it too — an env key is not a login", async () => {
		const out = await resolveEngineEnv(buildEnv(), "i1", "u1", session({ launchCommand: "claude --machine" }));
		expect(out).toEqual({ ANTHROPIC_API_KEY: "" });
	});

	it("a non-Claude engine also gets its own provider key stripped", async () => {
		// Codex would otherwise inherit OPENAI_API_KEY the same way.
		const out = await resolveEngineEnv(buildEnv(), "i1", "u1", session({ clientType: "codex", launchCommand: "codex" }));
		expect(out).toEqual({ OPENAI_API_KEY: "" });
	});
});

describe("deriveClientType", () => {
	it("maps the real binary past wrappers and env prefixes", () => {
		expect(deriveClientType("FOO=1 npx claude --flag")).toBe("claude");
		expect(deriveClientType("codex")).toBe("codex");
	});

	it("runs an unknown binary RAW rather than mis-driving it as Claude", () => {
		expect(deriveClientType("some-other-cli")).toBe("codex");
	});
});

describe("default engine presets", () => {
	const byId = (id: string) => DEFAULT_ENGINES.find((e) => e.id === id) as CodingEngine;
	/** The CLI engines whose posture PAGS is responsible for (excludes the bring-your-own local one). */
	const CLI_IDS = ["claude", "codex", "gemini", "grok"] as const;

	it("gives every non-Claude engine a NON-INTERACTIVE command", () => {
		// A bare `codex`/`gemini` launches a TUI and dies with "stdin is not a terminal",
		// because headless mode has no PTY — the thing tmux used to provide. Verified live:
		// `codex` exited 1 instantly; `codex exec` is the supported analogue of `claude -p`.
		expect(byId("codex").command.startsWith("codex exec")).toBe(true);
		// `-p`/`--prompt` are each CLI's own single-turn flag. grok's is `-p`/`--single`;
		// it has NO `--prompt` (only `--prompt-file`/`--prompt-json`), which the old preset used.
		expect(byId("gemini").command).toMatch(/(^|\s)(-p|--prompt)(\s|$)/);
		expect(byId("grok").command).toMatch(/(^|\s)(-p|--single)(\s|$)/);
		expect(byId("grok").command).not.toMatch(/--prompt(\s|$)/);
	});

	it("lets every CLI engine actually WRITE — a read-only engine is a silently useless agent", () => {
		// The bug this pins: `codex exec` with no `--sandbox` inherits `sandbox: read-only`, so the
		// engine explored the repo, explained itself well, and could not edit a file or `git pull`
		// ("cannot open '.git/FETCH_HEAD': Operation not permitted"). Nothing failed loudly.
		// Claude has always carried `--dangerously-skip-permissions`; if a sibling engine ships
		// without its equivalent, switching engines silently changes what the agent can do.
		for (const id of CLI_IDS) {
			const { command } = byId(id);
			const flags = ENGINE_WRITE_FLAGS[deriveClientType(command)];
			expect(flags.some((f) => command.includes(f)), `${id}: "${command}" has no write-permission flag`).toBe(true);
		}
	});

	it("pairs gemini's yolo with --skip-trust, or the yolo is inert", () => {
		// Live: `gemini --approval-mode yolo --prompt …` prints
		//   Approval mode overridden to "default" because the current folder is not trusted
		// and goes back to asking — headless, with nobody to ask. The write flag alone is a
		// preset that LOOKS correct and behaves read-only, the worst of both.
		expect(byId("gemini").command).toContain("--skip-trust");
	});

	it("ships a local-model preset — no cloud key required", () => {
		// "Give people options": a local model costs nothing per token, and the one-shot
		// contract (command is a prefix, turn text appended) makes it work by configuration.
		expect(byId("local").command).toContain("ollama run");
		expect(byId("local").auth).toBe("machine");
	});

	it("defaults gemini to api-key — its individual Google sign-in is deprecated", () => {
		expect(byId("gemini").auth).toBe("api-key");
	});
});

// ── #248: setting vs outcome ────────────────────────────────────────────────
// The preset says how the engine SHOULD sign in; the runner observes what it actually got. These
// cover the pairing — and specifically that a wrong outcome is loud instead of silent.

describe("engineAuthWarning — a mismatch between the setting and the outcome", () => {
	it("says nothing when the outcome matches the setting", () => {
		expect(engineAuthWarning("subscription", "subscription")).toBeNull();
		expect(engineAuthWarning("api-key", "api-key")).toBeNull();
		expect(engineAuthWarning("machine", "machine-login")).toBeNull();
		expect(engineAuthWarning("auto", "subscription")).toBeNull();
		expect(engineAuthWarning("auto", "machine-login")).toBeNull();
	});

	it("an UNKNOWN outcome is not a wrong one — no runner, no warning", () => {
		// Guessing from the setting is exactly what this feature exists to stop.
		for (const mode of ["auto", "machine", "subscription", "api-key"] as const) {
			expect(engineAuthWarning(mode, null)).toBeNull();
		}
	});

	it("THE documented silent-billing case: chose subscription, got an API key", () => {
		const w = engineAuthWarning("subscription", "api-key");
		expect(w).toMatch(/billing per token/i);
		expect(w).toMatch(/subscription/i);
	});

	it("warns whenever an API key appears under a mode that never asked for one", () => {
		expect(engineAuthWarning("auto", "api-key")).toMatch(/billing per token/i);
		expect(engineAuthWarning("machine", "api-key")).toMatch(/billing per token/i);
	});

	it("warns on the QUIET fallbacks — the ones that currently look like success", () => {
		// Chose subscription, but no setup-token is saved → the machine's own login.
		expect(engineAuthWarning("subscription", "machine-login")).toMatch(/setup-token/);
		// Chose an API key, but the vault has none → the machine's own login.
		expect(engineAuthWarning("api-key", "machine-login")).toMatch(/vault/i);
	});

	it("warns when an API key was asked for and a subscription token ran instead", () => {
		expect(engineAuthWarning("api-key", "subscription")).toMatch(/subscription token/i);
	});

	it("a machine that exports its OWN subscription token under 'machine' is not a mismatch", () => {
		// "machine" means whatever the machine has — a token it already holds IS that.
		expect(engineAuthWarning("machine", "subscription")).toBeNull();
	});
});

describe("engineAuthReport — the per-session transparency payload", () => {
	it("states the runtime, so 'is this tmux?' is answerable rather than implied (#247)", () => {
		expect(engineAuthReport("auto", "subscription").runtime).toBe("child-process");
	});

	it("carries mode + resolved + warning together", () => {
		expect(engineAuthReport("subscription", "api-key")).toMatchObject({
			mode: "subscription",
			resolved: "api-key",
			runtime: "child-process",
		});
		expect(engineAuthReport("subscription", "api-key").warning).toBeTruthy();
	});

	it("reports an unobserved session honestly instead of echoing the setting", () => {
		const r = engineAuthReport("subscription", null);
		expect(r.resolved).toBeNull();
		expect(r.warning).toBeNull();
	});

	it("never carries a credential value — it is an enum, not a channel", () => {
		const json = JSON.stringify(engineAuthReport("api-key", "api-key"));
		expect(json).not.toMatch(/sk-ant|sk-o|CLAUDE_CODE_OAUTH_TOKEN/);
	});
});
