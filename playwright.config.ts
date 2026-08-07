import { defineConfig, devices } from "@playwright/test";

const externalBaseURL = process.env.E2E_BASE_URL;
const baseURL = externalBaseURL || "http://127.0.0.1:4273";

export default defineConfig({
	testDir: "./e2e",
	timeout: 30_000,
	expect: { timeout: 10_000 },
	fullyParallel: true,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
	},
	webServer: externalBaseURL
		? undefined
		: {
				command: "node e2e/console-server.mjs",
				url: baseURL,
				reuseExistingServer: false,
				timeout: 10_000,
			},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
		/**
		 * WebKit, for the mobile geometry guards only (#384).
		 *
		 * Every phone runs WebKit, and every guard this repo built for "the page scrolls sideways on
		 * a phone" ran only in Chromium — so #333 measured Preferences 153 times, correctly found
		 * nothing, and closed a defect that pans `<main>` 59px at 320px in Safari. An engine the
		 * suite never runs is a class of bug the suite cannot see, however thorough it is about
		 * widths and text scales.
		 *
		 * Scoped by `grep` rather than run whole. The reasoning that scoped it was cost — WebKit
		 * doubles ~50 specs, and the rest of the file is behaviour (clicks, fetches, routing) that
		 * is not engine-specific and is already covered — but the reasoning that KEPT it blocking is
		 * measurement: the first WebKit run failed 9 of 51 and all 9 were this one page. There is no
		 * batch of unrelated red to soak first, so `continue-on-error` would only delay the signal.
		 *
		 * `mobile — ` is the prefix every geometry block already uses. A new block that measures a
		 * phone layout must carry it or it silently runs in one engine again.
		 */
		{
			name: "webkit",
			use: { ...devices["Desktop Safari"] },
			grep: /mobile — /,
		},
	],
});
