import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { norm } from "./run-worktree.js";

/**
 * #1710 — the managed-checkout path comparison, in the three OS path shapes, on any host.
 *
 * `verifyManaged` decides "is this checkout ours" by comparing a path git printed (`git worktree list` prints
 * forward slashes even on Windows) with the path the runner computed (native separators). The platform is injected
 * into `norm`, so the Windows, macOS and Linux shapes are exercised here as pure functions. Real git-on-Windows and
 * git-on-macOS runs are NOT covered here: CI has only a Linux runner for the unit suite (tracked separately).
 */
describe("norm across OS path shapes", () => {
	it("Linux: case is significant, trailing slash is not", () => {
		expect(norm("/home/dev/Managed/repo-1234/", "linux")).toBe("/home/dev/Managed/repo-1234");
		expect(norm("/home/dev/Managed", "linux")).not.toBe(norm("/home/dev/managed", "linux"));
	});

	it("macOS: same rules as Linux, paths are left as given", () => {
		expect(norm("/Users/owner/.pags/managed/repo-ab12cd34ef", "darwin")).toBe("/Users/owner/.pags/managed/repo-ab12cd34ef");
		expect(norm("/Users/owner/Dev", "darwin")).not.toBe(norm("/Users/owner/dev", "darwin"));
	});

	it("Windows: backslashes, drive-letter case and trailing separators all compare equal to git's forward-slash form", () => {
		const computed = win32.join("C:\\Users\\Dev\\AppData\\Local\\pags", "repo-ab12cd34ef", "run-1");
		const fromGit = "c:/users/dev/appdata/local/pags/repo-ab12cd34ef/run-1";
		expect(norm(computed, "win32")).toBe(norm(fromGit, "win32"));
		expect(norm("C:\\Repo\\", "win32")).toBe("c:/repo");
		expect(norm("D:/Repo", "win32")).not.toBe(norm("C:/Repo", "win32"));
	});

	it("a native-joined path survives the round trip on each shape", () => {
		expect(norm(posix.join("/srv/pags", "repo-1", "run"), "linux")).toBe("/srv/pags/repo-1/run");
		expect(norm(win32.join("C:\\pags", "repo-1", "run"), "win32")).toBe("c:/pags/repo-1/run");
	});
});
