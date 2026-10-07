/**
 * Live machine-login smoke test (#956): the REAL Claude Code and Codex CLIs, signed in on this
 * machine, tailor a fixture lead from fixture sources. Skipped unless `PAGS_ENGINE_SMOKE=1` — it
 * spends the machine's subscription and needs both CLIs signed in.
 *
 *   PAGS_ENGINE_SMOKE=1 pnpm vitest run --project integration packages/browser-runner/src/local-artifact/smoke.test.ts
 *
 * A provider API key set in the shell is deliberately left in place: the run must strip it and
 * still report `machine-login`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalArtifactRuntime } from "./runtime.js";

const RESUME = `# Jane Citizen
jane.citizen@example.com · Sydney, NSW

## Experience
Senior TypeScript Engineer, Acme Pty Ltd, 2019 - 2024
- Led the migration of 40 services to Cloudflare Workers.
- Mentored a team of five engineers.

Software Engineer, Initech, 2015 - 2019
- Built the billing API in Node.js and PostgreSQL.

## Education
Bachelor of Computer Science, University of Sydney, 2014
`;
const PROFILE = `Work rights: Australian citizen.
Location: Sydney. Open to hybrid work.
Notice period: four weeks.
`;

describe.skipIf(process.env.PAGS_ENGINE_SMOKE !== "1")("live machine-login tailoring", () => {
	it.each(["claude", "codex"] as const)(
		"%s creates both artifacts with engineAuth machine-login",
		async (engine) => {
			const home = mkdtempSync(join(tmpdir(), `la-smoke-home-${engine}-`));
			const data = mkdtempSync(join(tmpdir(), `la-smoke-data-${engine}-`));
			mkdirSync(join(home, "jobs"));
			writeFileSync(join(home, "jobs", "resume.md"), RESUME);
			writeFileSync(join(home, "jobs", "profile.md"), PROFILE);
			const rt = new LocalArtifactRuntime({ dataDir: data, homeDir: home });
			const runId = `smoke-${engine}`;
			rt.start({
				type: "local_artifact.generate",
				runId,
				requestId: `smoke:${engine}`,
				instanceId: "smoke-tailor",
				engine,
				authMode: "machine",
				workspace: "~/jobs",
				sources: [
					{ role: "resume", path: "resume.md" },
					{ role: "profile", path: "profile.md" },
				],
				lead: {
					eventId: "smoke-scout:lead-smoke:1",
					sourceInstanceId: "smoke-scout",
					leadId: "lead-smoke",
					leadUrl: "https://jobs.example.com/staff-engineer",
					lifecycleVersion: 1,
					requestedAt: new Date().toISOString(),
					lead: { title: "Staff Platform Engineer (TypeScript, Cloudflare)", company: "Globex", location: "Sydney", match_rationale: "TypeScript + Workers experience" },
				},
				policy: { retainDays: 0, maxMinutes: 8, maxConcurrent: 1 },
			});
			let status = rt.status({ runId });
			for (let i = 0; i < 480 && status.state !== "ended"; i++) {
				await new Promise((r) => setTimeout(r, 1000));
				status = rt.status({ runId });
			}
			const r = status.result;
			console.log(`[smoke:${engine}]`, JSON.stringify({ outcome: r?.outcome, engineAuth: r?.engineAuth, blockReason: r?.blockReason, questions: r?.questions, error: r?.error, artifacts: r?.artifacts, events: status.events.map((e) => e.type) }, null, 2));
			try {
				expect(r?.engineAuth).toBe("machine-login");
				expect(r?.outcome).toBe("completed");
				for (const a of r?.artifacts ?? []) expect(existsSync(join(home, a.path.slice(2)))).toBe(true);
				expect(r?.artifacts.map((a) => a.kind)).toEqual(["resume", "cover_letter"]);
			} finally {
				rmSync(home, { recursive: true, force: true });
				rmSync(data, { recursive: true, force: true });
			}
		},
		600_000,
	);
});
