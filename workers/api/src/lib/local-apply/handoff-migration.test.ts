import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { migrationFiles } from "../d1-sqlite.js";

// Invariant: changing the uniqueness boundary keeps old opaque ids and terminal history intact.
it("migrates existing closed handoffs without losing their identity or reopening them", () => {
	const db = new DatabaseSync(":memory:");
	const migrations = fileURLToPath(new URL("../../../migrations/", import.meta.url));
	try {
		for (const name of migrationFiles().filter((name) => name < "0315_")) db.exec(readFileSync(`${migrations}/${name}`, "utf8"));
		db.exec(`INSERT INTO users(id, github_login) VALUES ('owner', 'owner');
			INSERT INTO agents(id, owner_id, slug, name) VALUES ('agent', 'owner', 'agent', 'Agent');
			INSERT INTO agent_instances(id, agent_id, user_id, status) VALUES ('instance', 'agent', 'owner', 'active');
			INSERT INTO job_applications(id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, created_at, updated_at) VALUES ('app', 'instance', 'owner', 'instance', 'lead', 1, 'unique', 'filling', '{}', 1, 1);
			INSERT INTO local_apply_runs(id, instance_id, user_id, application_id, request_id, status, policy, created_at, updated_at) VALUES ('run', 'instance', 'owner', 'app', 'run', 'paused', '{}', 1, 1);
			INSERT INTO local_apply_handoffs(id, continuity_id, run_id, application_id, instance_id, user_id, browser_profile, state, terminal_reason, expires_at, created_at, ended_at, updated_at) VALUES ('old', 'opaque-old', 'run', 'app', 'instance', 'owner', 'isolated', 'closed', 'expired', 20, 1, 20, 20);`);
		db.exec(readFileSync(`${migrations}/0315_local_apply_handoff_requests.sql`, "utf8"));
		expect(db.prepare("SELECT id, continuity_id, state, terminal_reason, request_id FROM local_apply_handoffs").get()).toEqual({ id: "old", continuity_id: "opaque-old", state: "closed", terminal_reason: "expired", request_id: "legacy" });
		db.exec(`INSERT INTO local_apply_handoffs(id, continuity_id, run_id, application_id, instance_id, user_id, browser_profile, state, expires_at, created_at, updated_at, request_id) VALUES ('new', 'opaque-new', 'run', 'app', 'instance', 'owner', 'isolated', 'requested', 50, 30, 30, 'pause-new');`);
		expect(db.prepare("SELECT count(*) AS n FROM local_apply_handoffs").get()).toEqual({ n: 2 });
	} finally { db.close(); }
});
