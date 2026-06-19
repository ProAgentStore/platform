import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
			"packages/*/src/**/*.test.ts",
			"workers/*/src/**/*.test.ts",
			"agents/job-application-assistant/src/**/*.test.ts",
		],
	},
});
