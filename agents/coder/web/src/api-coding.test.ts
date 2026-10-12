/**
 * #1042 in the coder UI: choosing API-key coding goes through a blocking billing confirmation, and a
 * session coding on an API key carries a persistent banner. The components are rendered as real markup.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ApiCodingConfirmDialog from "./ApiCodingConfirmDialog";
import EngineCredentialStrip from "./EngineCredentialStrip";
import { apiCodingSessionBanner, apiKeyChoice, modelInCommand, pendingApiConfirmations, sessionEngineLine, subscriptionFirst, type ApiCodingView } from "./api-coding";
import type { EngineAuthReport } from "./engine-auth-view";
import type { CodingEngine } from "./types";

const VIEW: ApiCodingView = {
	options: [
		{ clientType: "claude", provider: "anthropic", providerLabel: "Anthropic", keyStored: true, warning: "API-key coding bills every token to your own Anthropic account…" },
		{ clientType: "codex", provider: "openai", providerLabel: "OpenAI", keyStored: false, warning: "…" },
		{ clientType: "gemini", provider: "google", providerLabel: "Google", keyStored: false, warning: "…" },
		{ clientType: "grok", provider: "xai", providerLabel: "xAI", keyStored: false, warning: "…" },
	],
	confirmed: { "claude-api": { command: "claude --model claude-sonnet-4-6", provider: "anthropic", model: "claude-sonnet-4-6", acknowledgedAt: "2026-10-13T00:00:00Z" } },
	migrated: [],
	cloudflare: null,
};
const SUB: CodingEngine = { id: "claude", label: "Claude Code", command: "claude --dangerously-skip-permissions" };
const API: CodingEngine = { id: "claude-api", label: "Claude (API)", command: "claude --model claude-sonnet-4-6", auth: "api-key" };

describe("choosing API-key coding (#1042)", () => {
	it("the API option is offered only with its provider key stored", () => {
		expect(apiKeyChoice("claude --x", VIEW)).toMatchObject({ available: true, option: { providerLabel: "Anthropic" } });
		expect(apiKeyChoice("codex exec", VIEW)).toMatchObject({ available: false, option: { providerLabel: "OpenAI" } });
		expect(apiKeyChoice("ollama run llama3", VIEW)).toEqual({ available: false, option: null });
	});

	it("a confirmed preset needs nothing; a new one, or the same one on another model, needs the dialog", () => {
		expect(pendingApiConfirmations([SUB, API], VIEW)).toEqual([]);
		const changed = { ...API, command: "claude --model claude-opus-5" };
		expect(pendingApiConfirmations([SUB, changed], VIEW)).toEqual([{ engine: changed, option: VIEW.options[0], model: "claude-opus-5" }]);
		const fresh = { id: "codex-api", label: "Codex (API)", command: "codex exec -m gpt-5", auth: "api-key" as const };
		expect(pendingApiConfirmations([fresh], VIEW)[0]).toMatchObject({ model: "gpt-5", option: { providerLabel: "OpenAI" } });
	});

	it("subscription engines are listed first", () => {
		expect(subscriptionFirst([API, SUB]).map((r) => r.engine.id)).toEqual(["claude", "claude-api"]);
		expect(subscriptionFirst([API, SUB]).map((r) => r.index)).toEqual([1, 0]);
	});

	it("reads the model from --model, --model=, and -m", () => {
		expect(modelInCommand("claude --model=opus")).toBe("opus");
		expect(modelInCommand("codex exec -m gpt-5 --json")).toBe("gpt-5");
		expect(modelInCommand("claude")).toBeNull();
	});

	it("the confirmation names provider, model and billing source, says it costs more and bills separately, and cannot be confirmed until acknowledged", () => {
		const pending = pendingApiConfirmations([{ ...API, command: "claude --model claude-opus-5" }], VIEW);
		const html = renderToStaticMarkup(createElement(ApiCodingConfirmDialog, { pending, onCancel: () => {}, onConfirm: () => {} }));
		expect(html).toContain('role="dialog"');
		expect(html).toMatch(/likely more costly/);
		expect(html).toMatch(/billed separately/);
		expect(html).toMatch(/Provider: <b>Anthropic<\/b>/);
		expect(html).toMatch(/Model: <b>claude-opus-5<\/b>/);
		expect(html).toMatch(/Billed to: <b>your Anthropic API key<\/b>/);
		expect(html).toMatch(/data-testid="api-coding-acknowledge"/);
		expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="api-coding-confirm-save"/);
	});
});

describe("the active session shows engine, model and billing — and a persistent banner on API-key coding (#1042)", () => {
	const apiAuth: EngineAuthReport = { clientType: "claude", mode: "api-key", resolved: "api-key", runtime: "child-process", warning: null };
	const subAuth: EngineAuthReport = { clientType: "claude", mode: "auto", resolved: "machine-login", runtime: "child-process", warning: null };

	it("names the engine, the model and how it bills", () => {
		expect(sessionEngineLine(subAuth, "claude --model sonnet")).toBe("Claude Code · model sonnet · subscription / local CLI login");
		expect(sessionEngineLine(apiAuth, "claude")).toBe("Claude Code · CLI default model · Anthropic API key — billed per token");
	});

	it("bans API-key coding loudly, and only API-key coding", () => {
		expect(apiCodingSessionBanner(apiAuth)).toMatch(/API-key coding is ON .*Anthropic account/);
		expect(apiCodingSessionBanner({ ...subAuth, resolved: "api-key" })).not.toBeNull();
		expect(apiCodingSessionBanner(subAuth)).toBeNull();
		expect(apiCodingSessionBanner(null)).toBeNull();
	});

	it("the strip renders the banner as an alert for an API-key session, and not for a subscription one", () => {
		const api = renderToStaticMarkup(createElement(EngineCredentialStrip, { auth: apiAuth, invocation: null, command: "claude --model x" }));
		expect(api).toMatch(/role="alert"[^>]*data-testid="api-coding-banner"/);
		expect(api).toContain('data-testid="session-engine-line"');
		const sub = renderToStaticMarkup(createElement(EngineCredentialStrip, { auth: subAuth, invocation: null, command: "claude" }));
		expect(sub).not.toContain("api-coding-banner");
		expect(sub).toContain("subscription / local CLI login");
	});
});
