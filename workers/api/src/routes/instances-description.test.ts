import { afterEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";
import { describeInstance } from "./instances-description.js";

const OWNER = "owner-1";
const INSTANCE = "apply-runner-1";

function fixture(): RealSchemaD1 {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: OWNER, instanceIds: [INSTANCE] });
	d1.exec(`UPDATE agents SET name = 'Application Runner', slug = 'application-runner', category = 'apply', config =
		'{"capabilities":{"surfaces":["apply"],"runtime":"local_apply","workflow":"JOB_APPLY","tools":["gmail_search","gmail_read_message"]}}' WHERE id = 'agent-1'`);
	d1.exec(`UPDATE agent_instances SET config = '{"runnerNode":"work-laptop"}' WHERE id = '${INSTANCE}'`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('tailor-agent', '${OWNER}', 'application-tailor', 'Application Tailor')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id) VALUES ('tailor-1', 'tailor-agent', '${OWNER}')`);
	d1.exec(`INSERT INTO instance_runtimes (instance_id, user_id, placement, endpoint_url, token_plaintext, capabilities, runner_version, runner_node, status)
		VALUES ('${INSTANCE}', '${OWNER}', 'local', 'https://runner.example.test', 'runtime-secret-token', '["browser"]', '0.4.74', 'work-laptop', 'online')`);
	d1.exec(`INSERT INTO agent_credentials (id, instance_id, user_id, domain, username, secrets_ciphertext, secrets_dek, secrets_iv, comments)
		VALUES ('cred-1', '${INSTANCE}', '${OWNER}', 'example.com', 'private@example.com', X'01', X'02', X'03', 'private notes')`);
	d1.exec(`INSERT INTO agent_connections (id, user_id, source_instance_id, event_type, target_instance_id, action, config, enabled)
		VALUES ('handoff-1', '${OWNER}', '${INSTANCE}', 'job.application.materials_ready', 'tailor-1', 'run_pipeline', '{"private":"connection-config"}', 1)`);
	d1.exec(`INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, engine_auth, runner_node, created_at, updated_at)
		VALUES ('run-1', '${INSTANCE}', '${OWNER}', 'application-1', 'request-1', 'running', '{"engine":"codex","authMode":"machine","browserProfile":"default"}', 'machine', 'work-laptop', 10, 20)`);
	return d1;
}

describe("describeInstance (#1002)", () => {
	it("joins named execution metadata without exposing runtime or credential secrets", async () => {
		const d1 = fixture();
		try {
			const view = await describeInstance({ DB: d1.DB } as Env, INSTANCE, OWNER);
			expect(view).toMatchObject({
				instance: { id: INSTANCE },
				template: { name: "Application Runner", slug: "application-runner" },
				execution: { kind: "local_cli_apply", engine: "codex", browser: "playwright" },
				capabilities: { runtime: "local_apply", declaredTools: ["gmail_search", "gmail_read_message"] },
				runtime: { boundNode: "work-laptop", default: { runnerVersion: "0.4.74", hasToken: true } },
				credentialPosture: { stored: 1, protected: 1 },
				currentRun: { id: "run-1", kind: "apply", engine: "codex" },
				handoffs: [{ direction: "outgoing", eventType: "job.application.materials_ready", peer: { name: "Application Tailor", slug: "application-tailor" } }],
				storageMigrations: { handoffs: "0056_agent_connections", applicationRuns: "0181_application_runner" },
			});
			const serialized = JSON.stringify(view);
			for (const secret of ["runtime-secret-token", "private@example.com", "private notes", "connection-config", "secrets_ciphertext", "token_plaintext"]) {
				expect(serialized, `description must not reveal ${secret}`).not.toContain(secret);
			}
		} finally {
			d1.close();
		}
	});

	it("fails closed for another owner before reading any related execution data", async () => {
		const d1 = fixture();
		try {
			await expect(describeInstance({ DB: d1.DB } as Env, INSTANCE, "other-owner")).rejects.toMatchObject({ status: 404 });
		} finally {
			d1.close();
		}
	});
});

afterEach(() => {
	// `realSchemaD1` owns no globals; this hook documents that every fixture above closes itself.
});
