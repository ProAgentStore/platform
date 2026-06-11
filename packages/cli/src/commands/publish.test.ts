import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.fn();

vi.mock("node:child_process", () => ({
	execFileSync,
}));

describe("publish command process execution", () => {
	let dir: string;
	let log: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.resetModules();
		execFileSync.mockReset();
		dir = mkdtempSync(join(tmpdir(), "pags-publish-"));
		writeFileSync(
			join(dir, "agent.json"),
			JSON.stringify({
				id: "safe-agent",
				name: "Safe Agent",
			}),
		);
		log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		log.mockRestore();
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
});
