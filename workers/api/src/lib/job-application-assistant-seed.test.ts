/**
 * Migration 0185 turns the Job Application Assistant from an operator-created production row
 * into a first-party catalog seed. Migration 0186 then converges that already-existing
 * production row on the autonomous-submission identity. Migration 0189 then retires the legacy
 * catalog entry without deleting it. These assertions execute the migrations against SQLite:
 * unlike a SQL text check, they prove the historic row and its capability/identity payload remain
 * readable while fresh subscribers can no longer discover it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentCapabilities } from "./agent-capabilities.js";
import { realSchemaD1 } from "./d1-sqlite.js";

interface AgentRow {
	id: string;
	owner_id: string;
	slug: string;
	visibility: string;
	status: string;
	store_type: string;
	category: string;
	description: string;
	config: string;
}

const AUTONOMOUS_SUBMISSION_SQL = readFileSync(fileURLToPath(new URL("../../migrations/0186_job_application_assistant_autonomous_submission.sql", import.meta.url).href), "utf8");

function jobAgent(d1: ReturnType<typeof realSchemaD1>): AgentRow {
	const row = d1.sqlite.prepare("SELECT id, owner_id, slug, visibility, status, store_type, category, description, config FROM agents WHERE slug = 'job-application-assistant'").get();
	if (!row) throw new Error("Job Application Assistant seed is missing");
	return row as unknown as AgentRow;
}

describe("legacy Job Application Assistant catalog row", () => {
	it("preserves one active but retired agent on a fresh database", () => {
		const d1 = realSchemaD1();
		try {
			const row = jobAgent(d1);
			expect(row.id).toBe("agent_job_application_assistant");
			expect(row.visibility).toBe("draft");
			expect(row.status).toBe("active");
			expect(row.store_type).toBe("agent");
			expect(row.category).toBe("productivity");
			expect(row.description).toMatch(/your own machine/i);
			expect(row.description).toMatch(/submit/i);
		} finally {
			d1.close();
		}
	});

	it("keeps its declared apply surface and JOB_APPLY workflow for existing-instance reads", () => {
		const d1 = realSchemaD1();
		try {
			const row = jobAgent(d1);
			const capabilities = agentCapabilities(row);
			expect(capabilities.surfaces).toEqual(["apply"]);
			expect(capabilities.runtime).toBe("browser");
			expect(capabilities.workflow).toBe("JOB_APPLY");
		} finally {
			d1.close();
		}
	});

	it("gives a new subscriber an autonomous identity that refuses fabrication and explains runner setup", () => {
		const d1 = realSchemaD1();
		try {
			const config = JSON.parse(jobAgent(d1).config) as { identity?: Record<string, unknown> };
			const identity = config.identity ?? {};
			expect(String(identity.personality)).toMatch(/Never invent/i);
			expect(String(identity.personality)).toMatch(/untrusted/i);
			expect(String(identity.personality)).toMatch(/submit truthful applications automatically/i);
			expect(String(identity.personality)).toMatch(/do not ask for a final review/i);
			expect(String(identity.welcomeMessage)).toMatch(/pags up/);
			expect(String(identity.welcomeMessage)).toMatch(/Claude API key/);
			expect(String(identity.welcomeMessage)).toMatch(/fill and submit it automatically/i);
		} finally {
			d1.close();
		}
	});
});

describe("migration 0186 — Job Application Assistant autonomous identity", () => {
	it("converges the operator-created production row without replacing its ownership, state, or unrelated config", () => {
		const d1 = realSchemaD1();
		try {
			d1.exec(`
				UPDATE agents
				   SET description = 'old fill-only copy',
				       config = '{"custom":{"preserve":"this"},"capabilities":{"surfaces":["obsolete"]},"identity":{"goal":"prepare only"}}'
				 WHERE slug = 'job-application-assistant'
			`);
			const before = jobAgent(d1);

			d1.exec(AUTONOMOUS_SUBMISSION_SQL);

			const after = jobAgent(d1);
			const config = JSON.parse(after.config) as { custom?: unknown; identity?: Record<string, unknown> };
			expect(after.id).toBe(before.id);
			expect(after.owner_id).toBe(before.owner_id);
			expect(after.visibility).toBe(before.visibility);
			expect(after.status).toBe(before.status);
			expect(after.description).toMatch(/complete and submit/i);
			expect(config.custom).toEqual({ preserve: "this" });
			expect(agentCapabilities(after)).toMatchObject({ surfaces: ["apply"], runtime: "browser", workflow: "JOB_APPLY" });
			expect(String(config.identity?.goal)).toMatch(/fill and submit/i);
		} finally {
			d1.close();
		}
	});
});
