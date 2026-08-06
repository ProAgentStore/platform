import { configDefaults, defineConfig } from "vitest/config";

/**
 * The heavy-integration set (#253). Everything under `packages/browser-runner` drives
 * something real — a full Chrome over CDP, a bound TCP socket, a spawned tmux pane, a
 * `git clone` — so every one of these files has a wall-clock budget that a busy machine
 * can blow. They are the only tests in the suite whose result depends on how much CPU is
 * left over.
 *
 * A DIRECTORY, deliberately, not a list of file names. The first cut of this fix named
 * `runner-browser.test.ts` because that is the file we had watched fail; the next
 * full-suite run failed `test-job-server.test.ts` as well — a plain HTTP-server test with
 * no browser in it, blowing vitest's default 5s budget. A list only ever contains the
 * failures someone has already seen. A path covers the ones nobody has seen yet, and a new
 * test added next to its subject is isolated by construction.
 */
const INTEGRATION_TESTS = ["packages/browser-runner/src/**/*.test.ts"];

const UNIT_TESTS = [
	"packages/*/src/**/*.test.ts",
	"workers/*/src/**/*.test.ts",
	"agents/job-application-assistant/src/**/*.test.ts",
	// The console had NO unit tests and was not even in this glob, so anything added
	// there would have passed locally and never run in CI.
	"store/*/src/**/*.test.ts",
	// Same gap for the Coder web UI. Named explicitly rather than `agents/*` — most
	// dirs under agents/ are inert vendored seed copies (see pags/CLAUDE.md) and must
	// not be swept into the suite.
	"agents/coder/web/src/**/*.test.ts",
];

export default defineConfig({
	test: {
		/**
		 * Two projects (#253).
		 *
		 * ── The mechanism, stated plainly, because it keeps getting misdiagnosed ──
		 *
		 * These tests are sensitive to CPU AVAILABILITY, not to anything in the code
		 * under test. There is no race here, no port collision, no leaked browser
		 * between files. Every observed failure was `Test timed out in Nms` on code that
		 * passes every time the machine is quiet.
		 *
		 * Measured on a 10-core machine, per-test wall time for the same passing code:
		 *
		 *   test                     isolated   in-suite   in-suite + a 2nd full suite
		 *   heaviest browser test      11.4s      20.6s          39.3s
		 *   captcha challenge           1.7s       1.7s           9.9s
		 *   invisible reCAPTCHA         2.7s       2.7s          11.1s
		 *
		 * And the decisive one: when the box was fully saturated, the run that failed
		 * failed in `rate-limit.test.ts`, `publish.test.ts` and `storage-tools.test.ts`
		 * — three PURE UNIT files, no browser, no socket — all with `Test timed out in
		 * 5000ms`. Browser tests starve first because they are the heaviest, not because
		 * they are browser tests.
		 *
		 * So: if this flakes for you, do not weaken an assertion. Look at what else is
		 * running. (On a dev machine, also look for orphaned Chromes from killed runs:
		 * `ps ax | grep -c playwright_chromiumdev_profile`. Playwright's cleanup does not
		 * run when a runner is SIGKILLed, and they accumulate invisibly for days.)
		 *
		 * CI is NOT affected and never has been — it executes the suite alone on a
		 * dedicated runner, which is exactly why it has been green. This split is for
		 * the shared dev machine, where several agents run full suites at once.
		 *
		 * ── What the split actually buys ──
		 *
		 * 1. A budget sized for the work. Most files under `packages/browser-runner`
		 *    never declared a timeout, so they inherited vitest's 5s default — a number
		 *    chosen for pure functions, applied to binding a socket and cloning a repo.
		 *    A per-directory project is how vitest lets you fix that in one place.
		 * 2. A fast loop: `pnpm test:unit` is the ~3100 quick tests without the ~10 that
		 *    take longer than all of them combined.
		 * 3. `groupOrder` keeps the heavy set from competing with the unit fork pool
		 *    within a single run. Note the limit honestly: this only controls contention
		 *    INSIDE one vitest process. It does nothing about four other agents building
		 *    on the same laptop, which is the larger effect.
		 *
		 * `pnpm test` still runs everything in one command, so nothing can be quietly
		 * skipped — but a failure now carries the `integration` project label.
		 */
		projects: [
			{
				extends: true,
				test: {
					name: "unit",
					include: UNIT_TESTS,
					exclude: [...configDefaults.exclude, ...INTEGRATION_TESTS],
					sequence: { groupOrder: 0 },
				},
			},
			{
				extends: true,
				test: {
					name: "integration",
					include: INTEGRATION_TESTS,
					sequence: { groupOrder: 1 },
					// One file at a time, one fork. Two real Chromes, or a Chrome next to a
					// spawned CLI waiting on a 1.5s stdout-silence latch, is the same
					// starvation at a smaller scale.
					fileParallelism: false,
					maxWorkers: 1,
					minWorkers: 1,
					// A floor, not the fix. Most files here never declared a budget, so they
					// inherited vitest's 5s default — a number chosen for pure functions, not
					// for binding a socket or cloning a repo.
					//
					// 120s is derived from a DELIBERATELY LOADED run, not a quiet one: with the
					// machine saturated, `mcp-runtime.test.ts`'s navigate test went from 2.4s to
					// 22.2s — 9x — and the heaviest browser test blew its own 120s budget. A
					// threshold picked while the box is idle is optimistic by roughly that
					// factor. This matches the number `runner-browser.test.ts` already chose by
					// hand for its own tests, so nothing in this category silently keeps a
					// budget meant for a pure function, and a real hang still fails in 2min.
					testTimeout: 120_000,
				},
			},
		],
		coverage: {
			provider: "v8",
			reporter: ["text-summary", "json-summary"],
			reportsDirectory: "coverage",
			// Measure the unit-testable backend (Workers + packages), plus the front-end's
			// PURE layer.
			//
			// This used to say the React UIs "are exercised by Playwright e2e, not vitest"
			// and exclude `store/**` wholesale. That was only ever half-true, and #282
			// re-checked it: `e2e/console.spec.ts` is the only spec in the repo, so
			// `store/console` was e2e-covered and `store/admin` — which owns suspend,
			// unpublish, delete, cancel, roles and key-revoke — was covered by neither.
			//
			// The honest split is by KIND, not by directory. Components stay excluded and
			// stay e2e's job; the `lib/*.ts` modules the convention pushes decisions into
			// (#280, #282 option b) are unit-tested and belong in the report — an untested
			// one showing 0% is a true and actionable signal, which is the whole point of
			// the convention. `.tsx` under lib/ is still a component and stays out.
			all: true,
			include: [
				"workers/api/src/**/*.ts",
				"workers/mcp/src/**/*.ts",
				"packages/browser-runner/src/**/*.ts",
				"packages/cli/src/**/*.ts",
				"packages/sdk/src/**/*.ts",
				"agents/job-application-assistant/src/**/*.ts",
				"store/*/src/lib/**/*.ts",
			],
			exclude: [
				"**/*.test.ts",
				"**/*.d.ts",
				"**/dist/**",
				"**/node_modules/**",
				"workers/host/src/pages.ts",
			],
		},
	},
});
