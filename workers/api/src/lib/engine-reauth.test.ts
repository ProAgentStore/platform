/**
 * #881: the re-auth relay's pure rules — which subscription login it runs, where that login lands,
 * and how the login CLI's pane is read. The landing rules are the #867 lesson: a login the engine
 * does not read fixes nothing.
 */
import { describe, expect, it } from "vitest";
import {
	extractSetupToken,
	planReauth,
	reauthInputError,
	reauthNextStep,
	reauthSessionName,
	readReauthPane,
	redactPane,
	subscriptionMenuChoice,
	unwrapPane,
} from "./engine-reauth.js";

const TOKEN = `sk-ant-oat01-${"A".repeat(40)}_${"b".repeat(40)}-XYZ`;

describe("planReauth — the login lands where the engine reads", () => {
	it("Claude with a platform-stored token replaces THAT token, since it would shadow a machine login", () => {
		const p = planReauth({ clientType: "claude", auth: "auto", hasStoredClaudeToken: true });
		expect(p.ok && p.method).toBe("claude-setup-token");
		if (p.ok) {
			expect(p.command).toBe("env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN claude setup-token");
			expect(p.lands).toContain("platform-stored");
		}
		expect(planReauth({ clientType: "claude", auth: "subscription", hasStoredClaudeToken: true })).toMatchObject({ method: "claude-setup-token" });
	});

	it("Claude with no stored token runs the machine /login the engine falls through to (#867)", () => {
		const p = planReauth({ clientType: "claude", auth: "auto", hasStoredClaudeToken: false });
		expect(p).toMatchObject({ ok: true, method: "claude-login", warning: null });
		if (p.ok) {
			expect(p.command).toBe("env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN claude /login");
			expect(p.lands).toContain("#867");
		}
	});

	it("`machine` mode logs the machine in even with a stored token, and warns when an exported token will still win", () => {
		expect(planReauth({ clientType: "claude", auth: "machine", hasStoredClaudeToken: true })).toMatchObject({ method: "claude-login", warning: null });
		const shadowed = planReauth({ clientType: "claude", auth: "machine", hasStoredClaudeToken: false, authResolved: "subscription" });
		expect(shadowed.ok && shadowed.warning).toContain("CLAUDE_CODE_OAUTH_TOKEN");
	});

	it("Codex uses the device-code flow with OPENAI_API_KEY stripped", () => {
		const p = planReauth({ clientType: "codex", auth: "auto", hasStoredClaudeToken: true });
		expect(p).toMatchObject({ ok: true, method: "codex-device-auth", command: "env -u OPENAI_API_KEY codex login --device-auth" });
	});

	it("never plans an API-key sign-in, and names unsupported engines", () => {
		const k = planReauth({ clientType: "claude", auth: "api-key", hasStoredClaudeToken: false });
		expect(k.ok).toBe(false);
		if (!k.ok) expect(k.reason).toContain("subscription login only");
		expect(planReauth({ clientType: "gemini", auth: "auto", hasStoredClaudeToken: false }).ok).toBe(false);
		for (const clientType of ["claude", "codex"] as const)
			for (const auth of ["auto", "machine", "subscription"] as const)
				for (const hasStoredClaudeToken of [true, false]) {
					const p = planReauth({ clientType, auth, hasStoredClaudeToken });
					expect(p.ok && /api[_-]?key\b(?!=)/i.test(p.command.replace(/-u \w+/g, ""))).toBe(false);
				}
	});

	it("runs each engine's login in its own session", () => {
		expect(reauthSessionName("claude")).toBe("pags-signin-claude");
		expect(reauthSessionName("codex")).toBe("pags-signin-codex");
	});
});

describe("readReauthPane", () => {
	const CLAUDE_URL = `https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=${"s".repeat(120)}`;

	it("rejoins an authorize URL the 200-column pane hard-wrapped, and sees the paste prompt", () => {
		const pane = ["Browser didn't open? Use the url below to sign in:", "", CLAUDE_URL.slice(0, 200), CLAUDE_URL.slice(200), "", "Paste code here if prompted >"].join("\n");
		const r = readReauthPane(pane, "claude-login");
		expect(r).toEqual({ state: "awaiting_code", url: CLAUDE_URL, deviceCode: null });
		expect(reauthNextStep(r, "claude-login")).toContain('action "input"');
	});

	it("does not glue an ordinary line onto a URL", () => {
		expect(unwrapPane("see https://claude.ai/x\nPaste code here")).toBe("see https://claude.ai/x\nPaste code here");
	});

	it("reads Codex's device code and URL", () => {
		const pane = [
			"Follow these steps to sign in with ChatGPT using device code authorization:",
			"1. Open this link in your browser and sign in to your account",
			"   https://auth.openai.com/codex/device",
			"2. Enter this one-time code (expires in 15 minutes)",
			"   ABCD-EFGH2",
		].join("\n");
		const r = readReauthPane(pane, "codex-device-auth");
		expect(r).toEqual({ state: "device_code", url: "https://auth.openai.com/codex/device", deviceCode: "ABCD-EFGH2" });
		expect(reauthNextStep(r, "codex-device-auth")).toContain("ABCD-EFGH2");
	});

	it("ignores a link to a host that is not a sign-in host", () => {
		const r = readReauthPane("Paste code here\nhttps://claude.ai.evil.example/oauth", "claude-login");
		expect(r.url).toBeNull();
		expect(r.state).not.toBe("awaiting_code");
	});

	it("knows success and failure", () => {
		expect(readReauthPane("Login successful. Press Enter to continue", "claude-login").state).toBe("succeeded");
		expect(readReauthPane("Successfully logged in", "codex-device-auth").state).toBe("succeeded");
		expect(readReauthPane("OAuth error: invalid code", "claude-login").state).toBe("failed");
		expect(readReauthPane("Select login method:\n❯ 1. Claude account with subscription", "claude-login").state).toBe("menu");
		expect(readReauthPane("Starting…", "claude-login").state).toBe("working");
	});

	it("reads Codex's unattended timeout as a failure, even with the code still in the scrollback (#890)", () => {
		const pane = "https://auth.openai.com/codex/device\n   ABCD-EFGH2\nError: device auth timed out after 15 minutes";
		expect(readReauthPane(pane, "codex-device-auth").state).toBe("failed");
	});

	it("setup-token succeeds when the token is printed — and the token is stored, never shown", () => {
		const pane = `Your OAuth token (valid for 1 year):\n\n${TOKEN}\n\nStore this token securely.`;
		expect(readReauthPane(pane, "claude-setup-token").state).toBe("succeeded");
		expect(extractSetupToken(pane)).toBe(TOKEN);
		expect(redactPane(pane)).not.toContain(TOKEN.slice(13));
		expect(redactPane(pane)).toContain("sk-ant-…[redacted]");
	});

	it("extracts a token the pane wrapped", () => {
		expect(extractSetupToken(`token: ${TOKEN.slice(0, 50)}\n${TOKEN.slice(50)}\n`)).toBe(TOKEN);
	});
});

describe("subscriptionMenuChoice — only ever the subscription option", () => {
	it("finds the subscription option's number", () => {
		const menu = [
			"Select login method:",
			"❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise",
			"  2. Anthropic Console account · API usage billing",
			"  3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI",
		].join("\n");
		expect(subscriptionMenuChoice(menu)).toBe("1");
	});

	it("returns null rather than guessing when no option is the subscription one", () => {
		expect(subscriptionMenuChoice("  1. Anthropic Console account · API usage billing\n  2. 3rd-party platform")).toBeNull();
	});
});

describe("reauthInputError — what may be typed into a live login CLI", () => {
	it("accepts a code and menu keys", () => {
		expect(reauthInputError({ text: "abc123#def456" })).toBeNull();
		expect(reauthInputError({ keys: ["Down", "Enter"] })).toBeNull();
	});
	it("refuses newlines, control keys, arbitrary keys and empty input", () => {
		expect(reauthInputError({})).not.toBeNull();
		expect(reauthInputError({ text: "code\nrm -rf ~" })).toContain("control characters");
		expect(reauthInputError({ text: "" })).not.toBeNull();
		expect(reauthInputError({ keys: ["C-c"] })).not.toBeNull();
		expect(reauthInputError({ text: "x".repeat(513) })).toContain("too long");
	});
});
