import { describe, expect, it } from "vitest";
import { signInEngine, signInOptions } from "./engine-sign-in.js";

const values = (cmd: string) => signInOptions(cmd).map((o) => o.value);
const label = (cmd: string, v: string) => signInOptions(cmd).find((o) => o.value === v)?.label ?? "";

describe("signInOptions — API key vs subscription, per engine (#732)", () => {
	it("offers Codex a ChatGPT-subscription option named for `codex login`", () => {
		const cmd = "codex exec --json --sandbox danger-full-access";
		expect(values(cmd)).toEqual(["auto", "machine", "subscription", "api-key"]);
		expect(label(cmd, "subscription")).toMatch(/ChatGPT subscription \(from `codex login`\)/);
		expect(label(cmd, "subscription")).toMatch(/no per-token charge/);
		expect(label(cmd, "api-key")).toMatch(/^OpenAI API key — billed per token/);
		expect(label(cmd, "auto")).toMatch(/ChatGPT login if present/);
		expect(label(cmd, "machine")).toMatch(/codex login/);
	});

	it("keeps Claude's four options, naming `claude setup-token`", () => {
		const cmd = "claude --dangerously-skip-permissions";
		expect(values(cmd)).toEqual(["auto", "machine", "subscription", "api-key"]);
		expect(label(cmd, "subscription")).toMatch(/claude setup-token/);
		expect(label(cmd, "api-key")).toMatch(/^Anthropic API key/);
		expect(label(cmd, "auto")).toBe("Auto — subscription token if saved, else machine login");
	});

	it("offers no subscription to engines without one", () => {
		expect(values("gemini --approval-mode yolo --prompt")).toEqual(["auto", "machine", "api-key"]);
		expect(label("grok -p", "api-key")).toMatch(/^xAI API key/);
		expect(label("ollama run llama3", "api-key")).toMatch(/^provider API key/);
	});

	it("reads the real binary past wrappers", () => {
		expect(signInEngine("FOO=1 npx codex exec")).toBe("codex");
		expect(signInEngine("")).toBe("claude");
	});
});
