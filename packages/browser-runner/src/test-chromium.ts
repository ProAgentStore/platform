/**
 * Launch Chromium for a test that runs real DOM — after making sure Chromium is installed.
 *
 * In CI the browsers are installed AFTER the unit + integration step (ci.yml). The binary those tests
 * use arrives mid-run, because `LocalRunner` installs it on first launch (`ensureChromiumInstalled`,
 * `runner-browser.test.ts`). A file that called `chromium.launch()` on its own passed only if vitest
 * happened to schedule it after that download finished. `masked-page-screenshot.test.ts` (#1067) lost
 * that race on every CI run from 98b25b98: "Executable doesn't exist … chrome-headless-shell", 1.7s
 * before the download completed. `inspect-page.test.ts` won it by scheduling luck.
 *
 * So this runs the same idempotent `playwright install chromium` the runner runs. It is a quick check
 * when the binary is present, and Playwright's own install lock makes a concurrent install wait rather
 * than collide. `PAGS_SKIP_PLAYWRIGHT_INSTALL=1` skips it, as it does for the runner. Test-only.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { type Browser, chromium } from "playwright";

let installed = false;

export async function launchTestChromium(): Promise<Browser> {
	if (!installed && process.env.PAGS_SKIP_PLAYWRIGHT_INSTALL !== "1") {
		const cli = join(dirname(createRequire(import.meta.url).resolve("playwright")), "cli.js");
		const r = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit", env: process.env });
		if (r.status !== 0) throw new Error("`playwright install chromium` failed — real-DOM tests cannot run without it.");
		installed = true;
	}
	return chromium.launch();
}
