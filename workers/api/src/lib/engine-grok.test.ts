/**
 * #1156: xAI's Grok CLI on the API side — the sign-in it is refused or offered, how the re-auth relay drives its
 * device-code login, the sign-in line it prints, and what coding_engine_get reports a machine has.
 */
import { describe, expect, it, vi } from "vitest";

const runner = vi.hoisted(() => ({ answers: new Map<string, unknown>() }));
vi.mock("./runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("./runner-client.js")>("./runner-client.js");
	return {
		...actual,
		callRunner: async (_conn: unknown, path: string, body: { clientType: string }) => {
			const a = runner.answers.get(body.clientType);
			if (a instanceof Error) throw a;
			if (path !== "/coding/engine-check") throw new Error(`unexpected ${path}`);
			return a;
		},
	};
});
const { grokCommunityMessage, machineEngineChecks, enginePreflightMessage } = await import("./engine-preflight.js");
const { planReauth, readReauthPane, reauthNextStep } = await import("./engine-reauth.js");
const { detectAuthPrompt } = await import("./engine-auth-prompt.js");

// What `grok login --device-auth` (xAI Grok CLI 1.0.62) printed on the Mac mini, with the code replaced.
const GROK_DEVICE_PANE = `
To sign in, open this URL in your browser:

  https://accounts.x.ai/oauth2/device?user_code=BCDF-GHJK

Confirm this code in your browser:

  BCDF-GHJK

Only continue with a code you requested. Don't share it with anyone.

Waiting for authorization...`;

describe("the re-auth relay signs Grok in with its device code (#1156)", () => {
	it("runs xAI's CLI — ~/.grok/bin first — with XAI_API_KEY removed, and says where the login lands", () => {
		const plan = planReauth({ clientType: "grok", auth: "auto", hasStoredClaudeToken: false });
		expect(plan).toMatchObject({ ok: true, method: "grok-device-auth", warning: null });
		if (!plan.ok) return;
		expect(plan.command).toMatch(/^env -u XAI_API_KEY "\$\( \[ -x "\$HOME\/\.grok\/bin\/grok" \].*\)" login --device-auth$/);
		expect(plan.lands).toContain("~/.grok/auth.json");
	});

	it("an API-key engine is refused, as for every engine — the relay is subscription login only", () => {
		expect(planReauth({ clientType: "grok", auth: "api-key", hasStoredClaudeToken: false }).ok).toBe(false);
	});

	it("reads the accounts.x.ai link and the code, says what to do, then sees the CLI's own success line", () => {
		const reading = readReauthPane(GROK_DEVICE_PANE, "grok-device-auth");
		expect(reading).toEqual({ state: "device_code", url: "https://accounts.x.ai/oauth2/device?user_code=BCDF-GHJK", deviceCode: "BCDF-GHJK" });
		expect(reauthNextStep(reading, "grok-device-auth")).toMatch(/Grok \(grok\.com\) account and enter the code BCDF-GHJK/);
		// "Signed in as <account>" — the string xAI's binary prints on success (read from the binary, not observed live).
		expect(readReauthPane(`${GROK_DEVICE_PANE}\n Signed in as serge@example.com`, "grok-device-auth").state).toBe("succeeded");
		// Codex's wording is unchanged.
		expect(reauthNextStep({ state: "device_code", url: "https://auth.openai.com/device", deviceCode: "AB12-CD34" }, "codex-device-auth")).toMatch(/ChatGPT account/);
	});
});

describe("Grok blocked on sign-in is recognised (#1156)", () => {
	it("its headless refusal is a sign-in block — its own words, verified on 1.0.62 with no login", () => {
		const pane = "Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.";
		expect(detectAuthPrompt(pane)).not.toBeNull();
		expect(detectAuthPrompt("  ↳ if (!user) throw new Error('not signed in')")).toBeNull();
	});
});

describe("what a machine has, for coding_engine_get (#1156)", () => {
	const env = {} as never;
	const conn = { runnerNode: "Sergeys-Mac-mini.local" } as never;
	const engines = [
		{ id: "grok", command: "grok --permission-mode bypassPermissions -p", clientType: "grok" as const },
		{ id: "codex", command: "codex exec --json --sandbox danger-full-access", clientType: "codex" as const },
		{ id: "gemini", command: "gemini --approval-mode yolo --skip-trust --prompt", clientType: "gemini" as const },
	];

	it("installed, which file, which version, signed in — and the fix when a session would not start", async () => {
		runner.answers.set("grok", { checked: true, bin: "grok", binaryFound: true, binaryPath: "/Users/serge/.grok/bin/grok", version: "1.0.62", vendor: "xai", login: "missing" });
		runner.answers.set("codex", { checked: true, bin: "codex", binaryFound: true, binaryPath: "/usr/local/bin/codex", version: "0.162.1", login: "found" });
		runner.answers.set("gemini", { checked: true, bin: "gemini", binaryFound: false, login: "unknown" });
		const out = await machineEngineChecks(env, "inst", "u1", engines, async () => conn);
		expect(out.node).toBe("Sergeys-Mac-mini.local");
		expect(out.unavailable).toBeNull();
		expect(out.engines.grok).toMatchObject({ installed: true, path: "/Users/serge/.grok/bin/grok", version: "1.0.62", vendor: "xai", login: "missing" });
		expect(out.engines.grok.problem).toMatch(/not signed in there.*grok login/);
		expect(out.engines.codex).toEqual({ installed: true, path: "/usr/local/bin/codex", version: "0.162.1", login: "found", problem: null });
		expect(out.engines.gemini.problem).toMatch(/Gemini CLI is not installed/);
	});

	it("a community `grok` is named as such, with xAI's installer as the fix", async () => {
		runner.answers.set("grok", { checked: true, bin: "grok", binaryFound: true, binaryPath: "/x/bin/grok", version: "1.0.1", vendor: "community", login: "missing" });
		const out = await machineEngineChecks(env, "inst", "u1", engines.slice(0, 1), async () => conn);
		expect(out.engines.grok.problem).toBe(grokCommunityMessage('machine "Sergeys-Mac-mini.local"'));
		expect(out.engines.grok.problem).toMatch(/@vibe-kit\/grok-cli.*x\.ai\/cli\/install\.sh.*install\.ps1/);
	});

	it("no runner, or one too old to answer, is a sentence — never a failed read", async () => {
		expect(await machineEngineChecks(env, "inst", "u1", engines, async () => null)).toMatchObject({ node: null, engines: {}, unavailable: expect.stringMatching(/No runner is connected/) });
		runner.answers.set("grok", new Error("/coding/engine-check → 404"));
		const old = await machineEngineChecks(env, "inst", "u1", engines.slice(0, 1), async () => conn);
		expect(old.unavailable).toMatch(/older than/);
	});

	it("the install line for Grok is xAI's installer on each OS, never an npm package", () => {
		const msg = enginePreflightMessage("no-binary", { clientType: "grok", bin: "grok", machine: 'machine "dell-laptop"' });
		expect(msg).toContain("curl -fsSL https://x.ai/cli/install.sh | bash");
		expect(msg).toContain("irm https://x.ai/cli/install.ps1 | iex");
		expect(msg).not.toMatch(/npm i/);
	});
});
