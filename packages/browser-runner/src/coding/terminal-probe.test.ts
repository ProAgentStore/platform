/**
 * #498: the pane-command probe, pinned against the case that defeated it.
 *
 * Measured on the owner's machine — tmux answers with Claude Code's VERSION because Claude Code
 * rewrites its process title and `#{pane_current_command}` reads the rewritten argv:
 *
 *     $ tmux list-panes -a -F '#{session_name}|#{pane_current_command}'
 *     heartfull-tmux|2.1.226
 *     $ pgrep -P <pane_pid> | xargs ps -o comm=
 *     claude
 *
 * `aiCliDrives` was 0 across a week of driving Claude Code through a tmux Operator. Without this
 * test the next title-rewriting CLI defeats the probe again, silently, which is how it lasted.
 */
import { describe, expect, it } from "vitest";
import { looksLikeCommandName, resolvePaneCommand } from "./terminal.js";

describe("looksLikeCommandName", () => {
	it("accepts the program names the AI-CLI list is made of", () => {
		for (const name of ["claude", "claude-code", "codex", "grok", "aider", "node", "zsh", "cursor-agent"]) {
			expect(looksLikeCommandName(name)).toBe(true);
		}
	});

	it("rejects a version string — the measured value, and one no list could ever contain", () => {
		for (const value of ["2.1.226", "v1.0", "0.4.45"]) expect(looksLikeCommandName(value)).toBe(false);
	});

	it("rejects a title, an empty value and a sentence", () => {
		for (const value of ["", "   ", "✳ List all open GitHub issues", "claude --resume abc"]) {
			expect(looksLikeCommandName(value)).toBe(false);
		}
	});
});

describe("resolvePaneCommand", () => {
	it("keeps what tmux said when it is a name — the fast path costs no extra exec", () => {
		let asked = 0;
		expect(resolvePaneCommand("claude", () => { asked++; return ["node"]; })).toBe("claude");
		expect(resolvePaneCommand("zsh", () => { asked++; return ["claude"]; })).toBe("zsh");
		expect(asked).toBe(0);
	});

	it("THE FIXTURE: a version from tmux, `claude` in the process tree", () => {
		expect(resolvePaneCommand("2.1.226", () => ["claude"])).toBe("claude");
	});

	it("skips shells and wrappers to the program actually running", () => {
		expect(resolvePaneCommand("2.1.226", () => ["zsh", "login", "claude"])).toBe("claude");
		expect(resolvePaneCommand("2.1.226", () => ["/opt/homebrew/bin/codex"])).toBe("codex");
	});

	it("hands back what it read when the tree says nothing — it never invents a name", () => {
		expect(resolvePaneCommand("2.1.226", () => [])).toBe("2.1.226");
		expect(resolvePaneCommand("2.1.226", () => ["zsh"])).toBe("2.1.226");
		expect(resolvePaneCommand("", () => [])).toBeNull();
	});

	it("a failing probe degrades to today's answer rather than throwing", () => {
		expect(resolvePaneCommand("2.1.226", () => { throw new Error("pgrep: not found"); })).toBe("2.1.226");
	});
});
