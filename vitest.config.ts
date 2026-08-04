import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
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
		],
		coverage: {
			provider: "v8",
			reporter: ["text-summary", "json-summary"],
			reportsDirectory: "coverage",
			// Measure the unit-testable backend (Workers + packages). The React UIs
			// (store/**, agents/*/web) are exercised by Playwright e2e, not vitest, so
			// including them here would report misleading 0% for code that IS tested.
			all: true,
			include: [
				"workers/api/src/**/*.ts",
				"workers/mcp/src/**/*.ts",
				"packages/browser-runner/src/**/*.ts",
				"packages/cli/src/**/*.ts",
				"packages/sdk/src/**/*.ts",
				"agents/job-application-assistant/src/**/*.ts",
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
