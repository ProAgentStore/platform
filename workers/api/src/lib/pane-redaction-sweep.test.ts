/** #1195 — terminal text stored before it was masked on the way in is re-redacted, in bounded resumable batches. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { redactStoredPanes, SWEEP_BATCH, SWEEP_BATCHES_PER_TICK } from "./pane-redaction-sweep.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
const secret = `ghp_${"B".repeat(30)}`;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'app')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status) VALUES ('s1', 'i1', 'r1', 'u1', 'claude', 'active')`);
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

const history = (content: string, type = "terminal") => d1.sqlite.prepare("INSERT INTO terminal_history (instance_id, user_id, target, type, content) VALUES ('i1', 'u1', 'tmux:shell', ?, ?)").run(type, content);
const timeline = (type: string, content: string) => d1.sqlite.prepare("INSERT INTO coding_timeline (session_id, instance_id, user_id, type, content) VALUES ('s1', 'i1', 'u1', ?, ?)").run(type, content);
const errorRow = (id: string, message: string, context: string | null) => d1.sqlite.prepare("INSERT INTO error_log (id, source, message, context) VALUES (?, 'tmux', ?, ?)").run(id, message, context);
const all = (sql: string) => d1.sqlite.prepare(sql).all() as Array<Record<string, string | null>>;
const progress = () => Object.fromEntries((all("SELECT source, last_rowid, rows_changed FROM pane_redaction_progress") as unknown as Array<{ source: string; last_rowid: number; rows_changed: number }>).map((r) => [r.source, r]));

describe("redactStoredPanes", () => {
	it("masks old terminal history, terminal and command timeline rows and error_log pane text — and nothing else", async () => {
		history(`$ echo ${secret}`);
		history(`typed: export T=${secret}`, "command");
		timeline("terminal", `snapshot ${secret}`);
		timeline("command", `curl -H "Authorization: Bearer abcdefgh12345678"`);
		timeline("narrative", `the owner wrote ${secret} on purpose`); // not terminal text
		errorRow("e1", `pane said ${secret}`, JSON.stringify({ pane: `token=${"c".repeat(20)}`, path: "/x" }));
		errorRow("e2", "a clean failure", null);
		const changed = await redactStoredPanes(env);
		expect(changed).toBe(5);
		for (const r of all("SELECT content FROM terminal_history")) expect(r.content).not.toContain(secret);
		const t = all("SELECT type, content FROM coding_timeline ORDER BY seq");
		expect(t[0].content).toBe("snapshot [redacted]");
		expect(t[1].content).not.toContain("abcdefgh12345678");
		expect(t[2].content).toContain(secret);
		const e = all("SELECT id, message, context FROM error_log ORDER BY id");
		expect(e[0].message).toBe("pane said [redacted]");
		expect(JSON.parse(e[0].context as string)).toEqual({ pane: "token=[redacted]", path: "/x" }); // still valid JSON
		expect(e[1]).toMatchObject({ message: "a clean failure", context: null });
	});
	it("is idempotent, and a finished walk changes nothing and costs no rewrites", async () => {
		history(`$ echo ${secret}`);
		expect(await redactStoredPanes(env)).toBe(1);
		expect(await redactStoredPanes(env)).toBe(0);
		expect(progress().terminal_history.rows_changed).toBe(1);
	});
	it("resumes from its watermark: rows written after a tick are picked up by the next, earlier ones are not revisited", async () => {
		history("clean one");
		await redactStoredPanes(env);
		const mark = progress().terminal_history.last_rowid;
		history(`late ${secret}`);
		expect(await redactStoredPanes(env)).toBe(1);
		expect(progress().terminal_history.last_rowid).toBeGreaterThan(mark);
	});
	it("is bounded per tick: a long backlog takes several, and finishes", async () => {
		const perTick = SWEEP_BATCH * SWEEP_BATCHES_PER_TICK;
		const total = perTick + 50;
		const insert = d1.sqlite.prepare("INSERT INTO terminal_history (instance_id, user_id, target, type, content) VALUES ('i1', 'u1', 'tmux:shell', 'terminal', ?)");
		d1.sqlite.exec("BEGIN");
		for (let i = 0; i < total; i++) insert.run(`row ${i} ${secret}`);
		d1.sqlite.exec("COMMIT");
		expect(await redactStoredPanes(env)).toBe(perTick);
		expect(await redactStoredPanes(env)).toBe(50);
		expect(await redactStoredPanes(env)).toBe(0);
		expect(all("SELECT content FROM terminal_history WHERE content LIKE '%ghp_%'")).toEqual([]);
	});
	it("one source's trouble does not stop the others", async () => {
		d1.exec("DROP TABLE terminal_history");
		timeline("terminal", `snapshot ${secret}`);
		expect(await redactStoredPanes(env)).toBe(1);
		expect(all("SELECT content FROM coding_timeline")[0].content).toBe("snapshot [redacted]");
	});
});
