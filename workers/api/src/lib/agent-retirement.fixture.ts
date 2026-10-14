/**
 * A retirement notice for TESTS (#1062). The real table is empty since JOB_APPLY was restored, but
 * the machinery that reads it — the capability field, `my_instances`, the Loop gate, the console's
 * badge and banner — is kept for a real future retirement, and is tested against this fixture.
 * Imported only by tests; nothing at runtime reads it.
 */
import type { RetirementNotice } from "./agent-retirement.js";

export const FIXTURE_RETIREMENT: RetirementNotice = {
	workflow: "BROWSER_TASK",
	status: "retired",
	label: "Retired — disabled",
	since: "2026-01-01",
	summary: "This agent's fixture workflow was retired. It is kept for its history: nothing it recorded has been deleted, and nothing it can be asked to do will run.",
	migration: "This fixture workflow no longer accepts new work. Use the Scout → Tailor → Runner pipeline instead.",
	preserved: "Its board, tasks, activity and trace stay readable.",
	replacement: {
		pipeline: "Scout → Tailor → Runner",
		roles: [
			{ role: "scout", runtime: "local_browser", label: "Job Search Scout", does: "finds and triages job leads" },
			{ role: "tailor", runtime: "local_artifact", label: "Application Tailor", does: "writes the résumé and cover letter for one job" },
			{ role: "runner", runtime: "local_apply", label: "Application Runner", does: "fills the employer's form on your machine" },
		],
	},
};
