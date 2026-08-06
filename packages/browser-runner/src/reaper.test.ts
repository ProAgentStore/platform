import { describe, expect, it } from "vitest";
import { isPlaywrightTempProfile, isReapable, parseEtime, parsePsOutput, profileIdleMs, userDataDirOf } from "./reaper.js";

/**
 * Pure tests only — no browser, no `ps`, no filesystem. This file lives in the
 * repo's INTEGRATION project (`packages/browser-runner/**`), which is the
 * CPU-sensitive set the bug under test was degrading; adding anything heavy here
 * would reproduce the problem it fixes.
 *
 * The predicate is the whole safety story, so it is tested against the shape of
 * the REAL measurement in #274 (a genuine orphan) and against the user's real
 * Chrome, which must survive every variation.
 */

const TMP = "/var/folders/7z/wtxzgwln35gdlmr0y638ll1c0000gp/T";
const ROOTS = [TMP];
const NOW = 1_000_000_000_000;
const TEN_MIN = 10 * 60 * 1000;

/** Verbatim shape of an orphan from the ticket, trimmed to the flags that matter. */
const ORPHAN_CMD =
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --disable-field-trial-config --headless --no-sandbox " +
	`--disable-blink-features=AutomationControlled --user-data-dir=${TMP}/playwright_chromiumdev_profile-QygdDy --remote-debugging-pipe --no-startup-window`;

/** The user's everyday browser — same executable, real profile. */
const REAL_CHROME_CMD =
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome " +
	"--user-data-dir=/Users/serge-ivo/Library/Application Support/Google/Chrome --profile-directory=Default";

const orphan = { pid: 4212, ppid: 1, ageSeconds: 4310, userDataDir: `${TMP}/playwright_chromiumdev_profile-QygdDy` };

describe("userDataDirOf", () => {
	it("extracts the profile flag from a real orphan command line", () => {
		expect(userDataDirOf(ORPHAN_CMD)).toBe(`${TMP}/playwright_chromiumdev_profile-QygdDy`);
	});

	it("returns empty when there is no such flag", () => {
		expect(userDataDirOf("/usr/bin/node server.js")).toBe("");
	});
});

describe("isPlaywrightTempProfile", () => {
	it("matches the throwaway profile Playwright mkdtemps per launch", () => {
		expect(isPlaywrightTempProfile(`${TMP}/playwright_chromiumdev_profile-QygdDy`, ROOTS)).toBe(true);
		expect(isPlaywrightTempProfile(`${TMP}/playwright_firefoxdev_profile-aB3xQz`, ROOTS)).toBe(true);
	});

	it("matches the throwaway profile McpRuntime mkdtemps for an isolated launch", () => {
		expect(isPlaywrightTempProfile(`${TMP}/pags-mcp-profile-inUfRi`, ROOTS)).toBe(true);
	});

	it("does not match other pags temp dirs, which belong to tests, not browsers", () => {
		expect(isPlaywrightTempProfile(`${TMP}/pags-compliance-Ab12Cd`, ROOTS)).toBe(false);
		expect(isPlaywrightTempProfile(`${TMP}/pags-brain-Ab12Cd`, ROOTS)).toBe(false);
	});

	it("NEVER matches the user's real Chrome profile", () => {
		// The single most important assertion in this file: the orphans run the same
		// executable as the user's browser, so the profile path is the only thing
		// separating "abandoned automation" from "the user's open tabs".
		expect(isPlaywrightTempProfile(userDataDirOf(REAL_CHROME_CMD), ROOTS)).toBe(false);
		expect(isPlaywrightTempProfile("/Users/me/Library/Application Support/Google/Chrome", ROOTS)).toBe(false);
		expect(isPlaywrightTempProfile("/Users/me/.config/google-chrome", ROOTS)).toBe(false);
	});

	it("never matches the runner's own persistent profiles", () => {
		expect(isPlaywrightTempProfile("/Users/me/.config/proagentstore/browser-runner/chrome-profile", ROOTS)).toBe(false);
		expect(isPlaywrightTempProfile("/Users/me/.config/proagentstore/browser-runner/real-profile-copy", ROOTS)).toBe(false);
	});

	it("rejects a lookalike outside the temp root", () => {
		// Same basename, wrong parent — a user could plausibly own this one.
		expect(isPlaywrightTempProfile("/Users/me/playwright_chromiumdev_profile-QygdDy", ROOTS)).toBe(false);
	});

	it("rejects a directory that merely contains the pattern", () => {
		expect(isPlaywrightTempProfile(`${TMP}/my-playwright_chromiumdev_profile-QygdDy`, ROOTS)).toBe(false);
		expect(isPlaywrightTempProfile(`${TMP}/playwright_chromiumdev_profile-QygdDy/Default`, ROOTS)).toBe(false);
		expect(isPlaywrightTempProfile(`${TMP}/playwright_chromiumdev_profile-`, ROOTS)).toBe(false);
	});

	it("rejects empty input", () => {
		expect(isPlaywrightTempProfile("", ROOTS)).toBe(false);
	});
});

describe("parseEtime", () => {
	it("parses every ps duration shape", () => {
		expect(parseEtime("00:42")).toBe(42);
		expect(parseEtime("23:00")).toBe(1380);
		expect(parseEtime("01:11:50")).toBe(4310); // the 2h-ish orphan in the ticket
		expect(parseEtime("2-03:04:05")).toBe(183845);
	});

	it("reads unparseable input as brand new, so it can never be reaped", () => {
		expect(parseEtime("?")).toBe(0);
		expect(parseEtime("")).toBe(0);
	});
});

describe("parsePsOutput", () => {
	it("keeps only rows carrying a --user-data-dir", () => {
		const out = [`  4212     1 01:11:50 ${ORPHAN_CMD}`, "  5000  4212 01:11:49 /usr/bin/node index.js", `  6182     1 01:10:10 ${REAL_CHROME_CMD}`].join("\n");
		const rows = parsePsOutput(out);
		expect(rows.map((r) => r.pid)).toEqual([4212, 6182]);
		expect(rows[0]).toMatchObject({ ppid: 1, ageSeconds: 4310 });
		expect(rows[1].userDataDir).toContain("Application");
	});
});

describe("isReapable", () => {
	const idleForever = () => Number.POSITIVE_INFINITY;
	const base = { now: NOW, minAgeMs: TEN_MIN, roots: ROOTS, idleMs: idleForever };

	it("reaps the orphan from the ticket", () => {
		expect(isReapable(orphan, base)).toBe(true);
	});

	it("spares a browser whose launcher is still alive", () => {
		// PPID != 1 means someone owns it — including every browser THIS process drives.
		expect(isReapable({ ...orphan, ppid: 4055 }, base)).toBe(false);
	});

	it("spares the user's real Chrome even when it is orphaned and ancient", () => {
		const real = { pid: 900, ppid: 1, ageSeconds: 86_400, userDataDir: userDataDirOf(REAL_CHROME_CMD) };
		expect(isReapable(real, base)).toBe(false);
	});

	it("spares a young orphan — it may still be starting up", () => {
		expect(isReapable({ ...orphan, ageSeconds: 30 }, base)).toBe(false);
	});

	it("spares an old process whose profile was written to recently", () => {
		// Chrome touches its profile constantly while it is doing anything, so a
		// fresh mtime means something is still using it despite the dead parent.
		expect(isReapable(orphan, { ...base, idleMs: () => 5_000 })).toBe(false);
	});

	it("reaps once both the process age and the profile idle time clear the bar", () => {
		expect(isReapable({ ...orphan, ageSeconds: 601 }, { ...base, idleMs: () => TEN_MIN })).toBe(true);
		expect(isReapable({ ...orphan, ageSeconds: 601 }, { ...base, idleMs: () => TEN_MIN - 1 })).toBe(false);
	});
});

describe("profileIdleMs", () => {
	it("treats a missing profile dir as infinitely idle", () => {
		// Playwright deletes this dir only on a clean close, so a live process on a
		// dir that is gone is unambiguously abandoned.
		expect(profileIdleMs("/nope", NOW, () => null)).toBe(Number.POSITIVE_INFINITY);
	});

	it("measures idleness from the last write", () => {
		expect(profileIdleMs("/x", NOW, () => NOW - 90_000)).toBe(90_000);
	});
});
