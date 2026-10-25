import { describe, expect, it } from "vitest";
import { INSTALL_CLIENTS, installSessionName, planInstall, readInstallPane } from "./engine-install.js";

describe("planInstall (#1156)", () => {
	it("is a fixed command per engine: xAI's installer for Grok, npm for the rest", () => {
		const grok = planInstall("grok");
		expect(grok).toMatchObject({ ok: true, clientType: "grok", command: "curl -fsSL https://x.ai/cli/install.sh | bash" });
		expect(planInstall("claude")).toMatchObject({ command: "npm i -g @anthropic-ai/claude-code" });
		expect(planInstall("codex")).toMatchObject({ command: "npm i -g @openai/codex" });
		expect(planInstall("gemini")).toMatchObject({ command: "npm i -g @google/gemini-cli" });
		expect(INSTALL_CLIENTS).toEqual(["claude", "codex", "gemini", "grok"]);
	});
	it("types the command with an exit marker, in a subshell so a failing installer still reports", () => {
		const p = planInstall("grok");
		expect(p.ok && p.typed).toBe('( curl -fsSL https://x.ai/cli/install.sh | bash ); echo "PAGS_INSTALL_EXIT=$?"');
	});
	it("never takes a command from the caller: anything else is refused", () => {
		for (const bad of ["generic", "grok; rm -rf ~", "", undefined, null, 5, { command: "x" }]) expect(planInstall(bad)).toMatchObject({ ok: false, reason: expect.stringContaining("must be one of") });
	});
	it("names one terminal per engine", () => {
		expect(installSessionName("grok")).toBe("pags-install-grok");
	});
});

describe("readInstallPane", () => {
	const typed = '$ ( curl -fsSL https://x.ai/cli/install.sh | bash ); echo "PAGS_INSTALL_EXIT=$?"';
	it("is running until the exit line is printed — the echoed command is not the exit line", () => {
		expect(readInstallPane(typed)).toEqual({ state: "running" });
		expect(readInstallPane(`${typed}\nDownloading grok 1.0.62…\n`)).toEqual({ state: "running" });
	});
	it("reads success and failure from the exit status", () => {
		expect(readInstallPane(`${typed}\nInstalled to ~/.grok/bin\nPAGS_INSTALL_EXIT=0\n$ `)).toEqual({ state: "succeeded", exitCode: 0 });
		expect(readInstallPane(`${typed}\ncurl: (6) Could not resolve host\nPAGS_INSTALL_EXIT=6\n$ `)).toEqual({ state: "failed", exitCode: 6 });
	});
	it("takes the last exit line when a terminal was reused", () => {
		expect(readInstallPane("PAGS_INSTALL_EXIT=1\n$ again\nPAGS_INSTALL_EXIT=0\n")).toEqual({ state: "succeeded", exitCode: 0 });
	});
	it("does not take the marker from the middle of a line", () => {
		expect(readInstallPane("note: PAGS_INSTALL_EXIT=0 appears in a log line")).toEqual({ state: "running" });
	});
});
