/**
 * Migration 0185 turns the Job Application Assistant from an operator-created production row
 * into a first-party catalog seed. These assertions execute the entire migration chain against
 * SQLite: unlike a SQL text check, they prove a fresh database has a row that a subscriber can
 * discover and that the capability/identity payload survives the platform's normal parser.
 */
import { describe, expect, it } from "vitest";
import { agentCapabilities } from "./agent-capabilities.js";
import { realSchemaD1 } from "./d1-sqlite.js";

interface AgentRow {
	id: string;
	slug: string;
	visibility: string;
	status: string;
	store_type: string;
	category: string;
	description: string;
	config: string;
}

function jobAgent(d1: ReturnType<typeof realSchemaD1>): AgentRow {
	const row = d1.sqlite.prepare("SELECT id, slug, visibility, status, store_type, category, description, config FROM agents WHERE slug = 'job-application-assistant'").get();
	if (!row) throw new Error("Job Application Assistant seed is missing");
	return row as unknown as AgentRow;
}

describe("migration 0185 — Job Application Assistant catalog seed", () => {
	it("creates one active, published agent on a fresh database", () => {
		const d1 = realSchemaD1();
		try {
			const row = jobAgent(d1);
			expect(row.id).toBe("agent_job_application_assistant");
			expect(row.visibility).toBe("published");
			expect(row.status).toBe("active");
			expect(row.store_type).toBe("agent");
			expect(row.category).toBe("productivity");
			expect(row.description).toMatch(/your own machine/i);
		} finally {
			d1.close();
		}
	});

	it("declares the apply surface and JOB_APPLY browser workflow, rather than relying on the legacy slug fallback", () => {
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

	it("gives a new subscriber an identity that refuses fabrication and explains runner setup", () => {
		const d1 = realSchemaD1();
		try {
			const config = JSON.parse(jobAgent(d1).config) as { identity?: Record<string, unknown> };
			const identity = config.identity ?? {};
			expect(String(identity.personality)).toMatch(/Never invent/i);
			expect(String(identity.personality)).toMatch(/untrusted/i);
			expect(String(identity.welcomeMessage)).toMatch(/pags up/);
			expect(String(identity.welcomeMessage)).toMatch(/Claude API key/);
		} finally {
			d1.close();
		}
	});
});
