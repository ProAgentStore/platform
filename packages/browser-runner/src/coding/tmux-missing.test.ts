import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerInputError } from "../errors.js";
import { TMUX_MISSING, TmuxMissingError, createSession, sessionExists, tmuxAvailable, tmuxExec, tmuxInstallHint } from "./tmux.js";

// #461: a clean runner has no tmux. These run with an EMPTY PATH, so they behave the same whether
// or not the machine running the suite has tmux installed.

let emptyDir: string;
let savedPath: string | undefined;
beforeEach(() => {
	emptyDir = mkdtempSync(join(tmpdir(), "pags-no-tmux-"));
	savedPath = process.env.PATH;
	process.env.PATH = emptyDir;
});
afterEach(() => {
	process.env.PATH = savedPath;
	rmSync(emptyDir, { recursive: true, force: true });
});

describe("a runner without tmux (#461)", () => {
	it("reports tmux as unavailable", () => {
		expect(tmuxAvailable()).toBe(false);
	});

	it("creating a session fails with a typed 424 that names the prerequisite, not a bare spawn error", () => {
		let thrown: unknown;
		try {
			createSession("pags-signin-claude", "/tmp");
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(TmuxMissingError);
		expect(thrown).toBeInstanceOf(RunnerInputError);
		expect((thrown as TmuxMissingError).status).toBe(424);
		expect((thrown as Error).message).toContain(TMUX_MISSING);
		expect((thrown as Error).message).not.toContain("ENOENT");
		expect((thrown as Error).message).toMatch(/install/i);
	});

	it("tmuxExec fails the same way", () => {
		expect(() => tmuxExec(["list-sessions"])).toThrow(TmuxMissingError);
	});

	it("read-only probes stay quiet: no session exists, nothing throws", () => {
		expect(sessionExists("anything")).toBe(false);
	});

	it("the install hint is specific to the platform", () => {
		expect(tmuxInstallHint("darwin")).toContain("brew install tmux");
		expect(tmuxInstallHint("linux")).toContain("apt install tmux");
		expect(tmuxInstallHint("win32")).toContain("WSL");
	});
});
