import { defineConfig, devices } from "@playwright/test";
import { resolveE2EPort } from "./e2e/run-port.mjs";

const externalBaseURL = process.env.E2E_BASE_URL;

/**
 * ONE port per run, and every process in the run agrees on it (#452).
 *
 * Before this, the port was a fixed `4273` here and `Number(process.env.E2E_PORT || 4273)` in
 * `e2e/console-server.mjs`. `E2E_PORT` therefore moved the SERVER and nothing else: set it, and
 * the managed server bound your port while `baseURL` and the `webServer.url` Playwright waits on
 * both stayed 4273. `reuseExistingServer: false` only rejects a port that is ALREADY answering
 * when Playwright pre-flights it; a neighbouring run whose server comes up a moment later sails
 * through, and the whole suite executes against their server and their bundle. Reproduced
 * end-to-end on 2026-08-08: `E2E_PORT=5001` + a decoy on 4273 three seconds late →
 * `console.spec.ts` "machine-readable skill discovery files are served" failed with
 * `Received: "I-AM-THE-NEIGHBOURS-SERVER"`. That spec is a bare `request.get`, so it cannot be
 * explained by a shared build output; it is this. It is also the failure that was relayed round
 * this repo all day as known-bad on `main`, and it is not a defect in anything it names.
 *
 * The resolution rules, and why the default is unique per run rather than a constant, live in
 * `e2e/run-port.mjs` next to the tests that hold them — including the one property that cannot be
 * seen by reading the expression: Playwright re-evaluates THIS FILE in every worker process, so
 * the port has to be a decision published into the inherited environment, not an expression
 * recomputed per process.
 *
 * `E2E_BASE_URL` still wins over all of it and still disables the managed server, so pointing a
 * run at production keeps working.
 */
const port = externalBaseURL ? 0 : resolveE2EPort(process.env, process.pid);
const baseURL = externalBaseURL || `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: "./e2e",
	/**
	 * Playwright owns `*.spec.ts` in here. Vitest owns `*.test.mjs` (#413).
	 *
	 * Pinned because Playwright's DEFAULT `testMatch` is
	 * `**\/*.@(spec|test).?(c|m)[jt]s?(x)` — it claims `.test.mjs` too. `e2e/build-inputs.mjs`
	 * decides what gets built before any spec runs, and its unit tests live beside it rather
	 * than in a package, so without this line `pnpm test:e2e` loads a vitest file and dies in
	 * `createExpect` with "Vitest failed to access its internal state" — an error that names
	 * neither the file nor the reason. Every spec in this directory is `.spec.ts`, so pinning
	 * costs nothing and states the boundary once.
	 */
	testMatch: /.*\.spec\.ts$/,
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
				// Hand the server the port this config resolved. It must not derive its own —
				// that is the mismatch #452 was.
				env: { E2E_PORT: String(port) },
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
