import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { supervisorPaths } from "../actions-supervisor.js";
import { actionsCommand } from "./actions.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function runner() {
  const dir = mkdtempSync(join(tmpdir(), "pags-actions-policy-")); dirs.push(dir);
  for (const file of [".runner", ".credentials", "runsvc.sh"]) writeFileSync(join(dir, file), "test");
  mkdirSync(supervisorPaths(dir).base);
  writeFileSync(supervisorPaths(dir).config, JSON.stringify({ version: 1, acRecoveryEnabled: true }), { mode: 0o600 });
  return dir;
}

it("shows policy and atomically disables AC recovery through the CLI", async () => {
  const dir = runner();
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  await actionsCommand.parseAsync(["policy", "--dir", dir, "--ac-recovery", "off"], { from: "user" });
  expect(JSON.parse(output.join(""))).toEqual({ runnerDir: dir, version: 1, acRecoveryEnabled: false });
  expect(JSON.parse(readFileSync(supervisorPaths(dir).config, "utf8"))).toEqual({ version: 1, acRecoveryEnabled: false });
  expect(statSync(supervisorPaths(dir).config).mode & 0o777).toBe(0o600);
  expect(existsSync(`${supervisorPaths(dir).config}.tmp`)).toBe(false);
});
