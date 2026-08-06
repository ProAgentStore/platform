import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.fn();
const writeLine = vi.fn();
const writeError = vi.fn();

vi.mock("node:child_process", () => ({
	execFileSync,
}));

vi.mock("../output.js", () => ({
	writeError,
	writeLine,
}));

describe("publish command process execution", () => {
	let dir: string;

	beforeEach(() => {
		vi.resetModules();
		execFileSync.mockReset();
		writeLine.mockReset();
		writeError.mockReset();
		dir = mkdtempSync(join(tmpdir(), "pags-publish-"));
		writeFileSync(
			join(dir, "agent.json"),
			JSON.stringify({
				id: "safe-agent",
				name: "Safe Agent",
			}),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("passes command arguments as arrays instead of shell strings", async () => {
		const { publishCommand } = await import("./publish.js");
		publishCommand.exitOverride();

		await publishCommand.parseAsync(["node", "publish", "--dir", dir]);

		expect(execFileSync).toHaveBeenCalledWith("pags", ["check"], {
			cwd: dir,
			stdio: "inherit",
		});
		expect(execFileSync).toHaveBeenCalledWith(
			"gh",
			["api", "repos/ProAgentStore/safe-agent", "--jq", ".name"],
			{ stdio: "pipe" },
		);
		expect(execFileSync).toHaveBeenCalledWith("git", ["remote", "get-url", "origin"], {
			cwd: dir,
			stdio: "pipe",
		});
		expect(execFileSync).toHaveBeenCalledWith(
			"git",
			["push", "-u", "origin", "main"],
			{ cwd: dir, stdio: "inherit" },
		);
	});

	// #325 — the swallow here reported the opposite of what happened. `git push` with nothing
	// to push EXITS 0, so this branch only ever ran on a real failure (rejected non-fast-forward,
	// no auth, no network) and its one message — "Push skipped (up to date or no commits)" — was
	// false every time it fired. The code never left the machine while the CLI said "Published!".
	it("fails the publish when git push fails, instead of calling it 'skipped'", async () => {
		execFileSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === "git" && args[0] === "push") throw new Error("failed to push some refs");
			return "";
		});
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("__exit__");
		}) as never);

		const { publishCommand } = await import("./publish.js");
		publishCommand.exitOverride();

		await expect(publishCommand.parseAsync(["node", "publish", "--dir", dir])).rejects.toThrow("__exit__");
		expect(exit).toHaveBeenCalledWith(1);
		const said = writeLine.mock.calls.concat(writeError.mock.calls).map((c) => String(c[0])).join("\n");
		expect(said).toContain("Push failed");
		expect(said).not.toContain("Published!");
		expect(said).not.toContain("Push skipped");
	});

	it("names agent.json when it is not valid JSON, rather than throwing a bare SyntaxError", async () => {
		writeFileSync(join(dir, "agent.json"), "{ id: nope, }");
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("__exit__");
		}) as never);

		const { publishCommand } = await import("./publish.js");
		publishCommand.exitOverride();

		await expect(publishCommand.parseAsync(["node", "publish", "--dir", dir])).rejects.toThrow("__exit__");
		expect(exit).toHaveBeenCalledWith(1);
		expect(writeError.mock.calls.map((c) => String(c[0])).join("\n")).toContain("agent.json is not valid JSON");
	});
});
