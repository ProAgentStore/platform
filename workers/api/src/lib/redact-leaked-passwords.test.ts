import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant } from "./d1-sqlite.js";

/**
 * #631 data remediation — migration `0129_redact_leaked_job_passwords.sql`.
 *
 * The code fix stops NEW rows carrying the credential. This is the other half: the rows already
 * in production. Run against the REAL schema (every migration applied to node:sqlite), because
 * the whole technique rests on SQLite semantics — `instr`/`substr` lifting the literal secret out
 * of a row so `replace` can remove it without anyone knowing the value — and a string-matching
 * stub would assert nothing about whether that actually works.
 */
const MIGRATION = readFileSync(join(import.meta.dirname, "../../migrations/0129_redact_leaked_job_passwords.sql"), "utf-8");

/** The real shape: `deriveJobPassword` returns `Pj9!` + 10 chars, 14 in total. */
const PASSWORD = "Pj9!aB3xQ9mZk1";
const OTHER_USERS_PASSWORD = "Pj9!ZZ88ttQQ44";

function db() {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	return d1;
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

describe("#631 — the credential is removed from the rows that already hold it", () => {
	it("scrubs a leaked task event, in the message AND the nested action, leaving the rest intact", () => {
		const d1 = db();
		// The exact production shape, quoted from the leaked row: an `agent.decision` whose control
		// name is the EMPTY STRING, carrying the password twice.
		const payload = JSON.stringify({
			type: "agent.decision",
			message: `type "${PASSWORD}" into textbox ""`,
			data: { action: { action: "type", ref: "f8e193", role: "textbox", name: "", text: PASSWORD }, url: "https://career10.successfactors.com/career" },
		});
		d1.exec(
			`INSERT INTO instance_runtime_task_events (id, instance_id, user_id, task_id, type, payload, created_at)
			 VALUES ('e1', 'i1', 'u1', 'task_1', 'agent.decision', ${q(payload)}, '2026-07-05T03:56:54.517Z')`,
		);

		d1.exec(MIGRATION);

		const row = d1.sqlite.prepare("SELECT payload FROM instance_runtime_task_events WHERE id = 'e1'").get() as { payload: string };
		expect(row.payload).not.toContain(PASSWORD);
		// Both occurrences, not just the first.
		expect(row.payload.match(/••••/g)).toHaveLength(2);
		// Still a usable event: valid JSON, same type, and the diagnostic fields survive.
		const parsed = JSON.parse(row.payload) as { type: string; data: { action: { ref: string }; url: string } };
		expect(parsed.type).toBe("agent.decision");
		expect(parsed.data.action.ref).toBe("f8e193");
		expect(parsed.data.url).toBe("https://career10.successfactors.com/career");
		d1.close();
	});

	it("scrubs every user's password in one pass, because the needle is derived per row", () => {
		// A hardcoded value could only ever have cleaned one account — the password is a function
		// of the user id, so each row carries a different 14 characters.
		const d1 = db();
		seedTenant(d1, { userId: "u2", instanceIds: ["i2"] });
		for (const [id, user, inst, pw] of [["e1", "u1", "i1", PASSWORD], ["e2", "u2", "i2", OTHER_USERS_PASSWORD]] as const) {
			d1.exec(
				`INSERT INTO instance_runtime_task_events (id, instance_id, user_id, task_id, type, payload, created_at)
				 VALUES (${q(id)}, ${q(inst)}, ${q(user)}, 't', 'agent.shot', ${q(JSON.stringify({ message: `type "${pw}" into textbox ""` }))}, '2026-07-05T00:00:00Z')`,
			);
		}
		d1.exec(MIGRATION);
		const all = (d1.sqlite.prepare("SELECT payload FROM instance_runtime_task_events").all() as { payload: string }[]).map((r) => r.payload).join("\n");
		expect(all).not.toContain(PASSWORD);
		expect(all).not.toContain(OTHER_USERS_PASSWORD);
		d1.close();
	});

	it("scrubs the per-ATS cache, the sink the console shows back to the owner", () => {
		const d1 = db();
		d1.exec(
			`INSERT INTO ats_apply_cache (user_id, host, notes, steps, updated_at)
			 VALUES ('u1', 'career10.successfactors.com', ${q(`1. click button "Apply"\n2. type "${PASSWORD}" into textbox ""`)}, 2, '2026-07-05T09:00:00Z')`,
		);
		d1.exec(MIGRATION);
		const row = d1.sqlite.prepare("SELECT notes FROM ats_apply_cache WHERE host = 'career10.successfactors.com'").get() as { notes: string };
		expect(row.notes).not.toContain(PASSWORD);
		expect(row.notes).toContain('click button "Apply"'); // the route it exists to remember survives
		d1.close();
	});

	it("scrubs the unified trace's message and context", () => {
		const d1 = db();
		d1.exec(
			`INSERT INTO agent_events (id, ts, user_id, instance_id, trace_id, source, level, event, message, context)
			 VALUES ('t1', 1, 'u1', 'i1', 'task_1', 'apply', 'info', 'agent.decision',
			         ${q(`type "${PASSWORD}" into textbox ""`)}, ${q(JSON.stringify({ action: { text: PASSWORD } }))})`,
		);
		d1.exec(MIGRATION);
		const row = d1.sqlite.prepare("SELECT message, context FROM agent_events WHERE id = 't1'").get() as { message: string; context: string };
		expect(`${row.message}\n${row.context}`).not.toContain(PASSWORD);
		d1.close();
	});

	it("leaves a coincidental `Pj9` alone — base64 has no `!`, so a screenshot URI is not a false positive", () => {
		// Three such hits were measured inside embedded data URIs on the real instance. Matching
		// them would corrupt a screenshot reference to clean a credential that was never there.
		const d1 = db();
		const innocent = JSON.stringify({ message: "agent.shot", data: { key: "runshot/aPj9kLmNoPqRsT/00038.jpg" } });
		d1.exec(
			`INSERT INTO instance_runtime_task_events (id, instance_id, user_id, task_id, type, payload, created_at)
			 VALUES ('e9', 'i1', 'u1', 't', 'agent.shot', ${q(innocent)}, '2026-07-05T00:00:00Z')`,
		);
		d1.exec(MIGRATION);
		expect((d1.sqlite.prepare("SELECT payload FROM instance_runtime_task_events WHERE id = 'e9'").get() as { payload: string }).payload).toBe(innocent);
		d1.close();
	});

	it("is idempotent — a second run is a no-op, not a second bite", () => {
		const d1 = db();
		d1.exec(
			`INSERT INTO instance_runtime_task_events (id, instance_id, user_id, task_id, type, payload, created_at)
			 VALUES ('e1', 'i1', 'u1', 't', 'agent.decision', ${q(JSON.stringify({ message: `type "${PASSWORD}" x` }))}, '2026-07-05T00:00:00Z')`,
		);
		d1.exec(MIGRATION);
		const once = (d1.sqlite.prepare("SELECT payload FROM instance_runtime_task_events WHERE id = 'e1'").get() as { payload: string }).payload;
		d1.exec(MIGRATION);
		expect((d1.sqlite.prepare("SELECT payload FROM instance_runtime_task_events WHERE id = 'e1'").get() as { payload: string }).payload).toBe(once);
		d1.close();
	});
});
