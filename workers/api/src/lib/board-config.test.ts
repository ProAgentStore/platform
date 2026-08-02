import { describe, expect, it } from "vitest";
import {
	jobKeyForTask,
	boardConfigForInstance,
	columnsForInstance,
	setInstanceBoardConfig,
	configureBoardForAgent,
	setBoardItemStatus,
	deleteBoardItem,
	clearFinishedBoardItems,
	buildInstanceBoard,
	MAX_BOARD_COLUMNS,
	FINISHED_STATUSES,
} from "./board.js";
import type { Env } from "../types.js";

interface Write { sql: string; args: unknown[] }

/**
 * Configurable D1 stub for board.ts. `first(sql,args)` / `all(sql,args)` are resolved by
 * the test against the query text, and every INSERT/UPDATE/DELETE is recorded so a test
 * can assert exactly which mutation ran with which bound args (the real behavior — the
 * board-config functions are thin D1 read-modify-write helpers).
 */
function mockEnv(opts: {
	first?: (sql: string, args: unknown[]) => unknown;
	all?: (sql: string, args: unknown[]) => { results: unknown[] };
} = {}): { env: Env; writes: Write[] } {
	const writes: Write[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() { return opts.first ? opts.first(sql, args) : null; },
						async all() { return opts.all ? opts.all(sql, args) : { results: [] }; },
						async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Env, writes };
}

describe("boardConfigForInstance", () => {
	// An agent row whose slug/category yield the generic default columns.
	const agentRow = { slug: "some-agent", category: "other", agent_config: "{}", instance_config: "{}" };

	it("returns the agent's default columns + kanban view when no instance override is set", async () => {
		const { env } = mockEnv({ first: () => agentRow });
		const cfg = await boardConfigForInstance(env, "inst-1", "u1");
		expect(cfg.source).toBe("agent");
		expect(cfg.view).toBe("kanban");
		expect(cfg.columns).toEqual(cfg.agentColumns);
		expect(cfg.columns.length).toBeGreaterThan(0);
	});

	it("a per-instance override wins over the agent columns and marks source=instance", async () => {
		const override = { boardColumns: [{ id: "todo", title: "To do" }, { id: "done", title: "Done" }], boardView: "list" };
		const { env } = mockEnv({ first: () => ({ ...agentRow, instance_config: JSON.stringify(override) }) });
		const cfg = await boardConfigForInstance(env, "inst-1", "u1");
		expect(cfg.source).toBe("instance");
		expect(cfg.view).toBe("list");
		expect(cfg.columns.map((col) => col.id)).toEqual(["todo", "done"]);
		// agentColumns is still the underlying default (offered as "reset to agent's").
		expect(cfg.agentColumns).not.toEqual(cfg.columns);
	});

	it("defaults to kanban when the stored view is anything other than 'list'", async () => {
		const { env } = mockEnv({ first: () => ({ ...agentRow, instance_config: JSON.stringify({ boardView: "garbage" }) }) });
		const cfg = await boardConfigForInstance(env, "inst-1", "u1");
		expect(cfg.view).toBe("kanban");
		expect(cfg.source).toBe("agent");
	});

	it("columnsForInstance returns exactly boardConfigForInstance().columns", async () => {
		const { env } = mockEnv({ first: () => agentRow });
		const [cfg, cols] = await Promise.all([
			boardConfigForInstance(env, "inst-1", "u1"),
			columnsForInstance(env, "inst-1", "u1"),
		]);
		expect(cols).toEqual(cfg.columns);
	});
});

describe("setInstanceBoardConfig", () => {
	it("persists sanitized columns + view into the instance config JSON", async () => {
		const { env, writes } = mockEnv({
			first: (sql) => sql.includes("JOIN agents")
				? { slug: "a", category: "other", agent_config: "{}", instance_config: JSON.stringify({ boardColumns: [{ id: "c", title: "C" }], boardView: "list" }) }
				: { config: "{}" },
		});
		const cfg = await setInstanceBoardConfig(env, "inst-1", "u1", {
			columns: [{ id: "c", title: "C", color: "#fff" }],
			view: "list",
		});
		const update = writes.find((w) => w.sql.includes("UPDATE agent_instances"));
		expect(update).toBeTruthy();
		const savedCfg = JSON.parse(update!.args[0] as string);
		expect(savedCfg.boardColumns).toEqual([{ id: "c", title: "C", color: "#fff", statuses: undefined, catchAll: false }]);
		expect(savedCfg.boardView).toBe("list");
		// Returns the freshly resolved config (source=instance from the readback).
		expect(cfg.source).toBe("instance");
	});

	it("columns:null clears the override so the board resets to the agent's columns (siblings kept)", async () => {
		const { env, writes } = mockEnv({
			first: (sql) => sql.includes("JOIN agents")
				? { slug: "a", category: "other", agent_config: "{}", instance_config: "{}" }
				: { config: JSON.stringify({ boardColumns: [{ id: "old", title: "Old" }], keepMe: 1 }) },
		});
		await setInstanceBoardConfig(env, "inst-1", "u1", { columns: null });
		const update = writes.find((w) => w.sql.includes("UPDATE agent_instances"));
		const savedCfg = JSON.parse(update!.args[0] as string);
		expect(savedCfg.boardColumns).toBeUndefined(); // override deleted
		expect(savedCfg.keepMe).toBe(1); // sibling config fields preserved
	});

	it("caps the stored columns at MAX_BOARD_COLUMNS", async () => {
		const many = Array.from({ length: MAX_BOARD_COLUMNS + 5 }, (_, i) => ({ id: `c${i}`, title: `C${i}` }));
		const { env, writes } = mockEnv({
			first: (sql) => sql.includes("JOIN agents")
				? { slug: "a", category: "other", agent_config: "{}", instance_config: "{}" }
				: { config: "{}" },
		});
		await setInstanceBoardConfig(env, "inst-1", "u1", { columns: many });
		const update = writes.find((w) => w.sql.includes("UPDATE agent_instances"));
		const savedCfg = JSON.parse(update!.args[0] as string);
		expect(savedCfg.boardColumns).toHaveLength(MAX_BOARD_COLUMNS);
	});
});

describe("configureBoardForAgent (the agent's own configure_board tool)", () => {
	function setterEnv() {
		return mockEnv({
			first: (sql) => sql.includes("JOIN agents")
				? { slug: "a", category: "other", agent_config: "{}", instance_config: JSON.stringify({ boardColumns: [{ id: "todo", title: "Todo" }], boardView: "kanban" }) }
				: { config: "{}" },
		});
	}

	it("rejects a columns string that is not JSON without touching the DB", async () => {
		const { env, writes } = setterEnv();
		const res = await configureBoardForAgent(env, "inst-1", "u1", { columns: "{not json" });
		expect(res.success).toBe(false);
		expect(res.content).toContain("valid JSON");
		expect(writes).toHaveLength(0);
	});

	it("rejects a columns JSON string that is not an array", async () => {
		const { env, writes } = setterEnv();
		const res = await configureBoardForAgent(env, "inst-1", "u1", { columns: '{"id":"x"}' });
		expect(res.success).toBe(false);
		expect(res.content).toContain("must be a JSON array");
		expect(writes).toHaveLength(0);
	});

	it("fails when nothing to change is provided", async () => {
		const { env, writes } = setterEnv();
		const res = await configureBoardForAgent(env, "inst-1", "u1", {});
		expect(res.success).toBe(false);
		expect(res.content).toContain("Nothing to change");
		expect(writes).toHaveLength(0);
	});

	it("rejects columns that all fail validation (no id/title)", async () => {
		const { env, writes } = setterEnv();
		const res = await configureBoardForAgent(env, "inst-1", "u1", { columns: [{ color: "#fff" }] });
		expect(res.success).toBe(false);
		expect(res.content).toContain("id");
		expect(writes).toHaveLength(0);
	});

	it("applies a valid JSON-string columns arg and reports the result", async () => {
		const { env, writes } = setterEnv();
		const res = await configureBoardForAgent(env, "inst-1", "u1", {
			columns: JSON.stringify([{ id: "todo", title: "Todo" }]),
		});
		expect(res.success).toBe(true);
		expect(res.content).toContain("Board updated");
		expect(writes.some((w) => w.sql.includes("UPDATE agent_instances"))).toBe(true);
	});

	it("accepts a raw array columns arg + a view change", async () => {
		const { env, writes } = setterEnv();
		const res = await configureBoardForAgent(env, "inst-1", "u1", {
			columns: [{ id: "todo", title: "Todo" }],
			view: "kanban",
		});
		expect(res.success).toBe(true);
		expect(res.content).toContain("View: kanban");
		expect(writes.some((w) => w.sql.includes("UPDATE agent_instances"))).toBe(true);
	});

	it("reset:true clears the override (writes columns removed)", async () => {
		const { env, writes } = mockEnv({
			first: (sql) => sql.includes("JOIN agents")
				? { slug: "a", category: "other", agent_config: "{}", instance_config: "{}" }
				: { config: JSON.stringify({ boardColumns: [{ id: "old", title: "Old" }] }) },
		});
		const res = await configureBoardForAgent(env, "inst-1", "u1", { reset: true });
		expect(res.success).toBe(true);
		const update = writes.find((w) => w.sql.includes("UPDATE agent_instances"));
		expect(JSON.parse(update!.args[0] as string).boardColumns).toBeUndefined();
	});
});

describe("setBoardItemStatus / deleteBoardItem / clearFinishedBoardItems", () => {
	it("setBoardItemStatus upserts the override with meta bound in order", async () => {
		const { env, writes } = mockEnv();
		await setBoardItemStatus(env, "inst-1", "u1", "job-key", "interview", { title: "T", subtitle: "S", url: "https://x.co" });
		expect(writes).toHaveLength(1);
		expect(writes[0].sql).toContain("INSERT INTO board_items");
		expect(writes[0].sql).toContain("ON CONFLICT");
		expect(writes[0].args.slice(0, 5)).toEqual(["inst-1", "u1", "job-key", "interview", "T"]);
	});

	it("setBoardItemStatus with a null status DELETEs the override instead of inserting", async () => {
		const { env, writes } = mockEnv();
		await setBoardItemStatus(env, "inst-1", "u1", "job-key", null);
		expect(writes).toHaveLength(1);
		expect(writes[0].sql).toContain("DELETE FROM board_items");
		expect(writes[0].args).toEqual(["inst-1", "u1", "job-key"]);
	});

	it("deleteBoardItem removes the single job's durable row", async () => {
		const { env, writes } = mockEnv();
		await deleteBoardItem(env, "inst-1", "u1", "job-key");
		expect(writes[0].sql).toContain("DELETE FROM board_items");
		expect(writes[0].args).toEqual(["inst-1", "u1", "job-key"]);
	});

	it("clearFinishedBoardItems deletes only terminal statuses (never blocked/interview)", async () => {
		const { env, writes } = mockEnv();
		await clearFinishedBoardItems(env, "inst-1", "u1");
		expect(writes).toHaveLength(1);
		expect(writes[0].sql).toContain("DELETE FROM board_items");
		// The terminal set is bound after (instanceId, userId); blocked/interview excluded.
		expect(writes[0].args.slice(2)).toEqual(FINISHED_STATUSES);
		expect(FINISHED_STATUSES).not.toContain("blocked");
		expect(FINISHED_STATUSES).not.toContain("interview");
	});
});

describe("buildInstanceBoard", () => {
	// Two runtime tasks for the SAME job (a retry) + one for a different job. The board
	// must group by jobKey into one card each, newest attempt representing the card.
	const nowIso = "2026-08-02T10:00:00.000Z";
	const earlier = "2026-08-01T10:00:00.000Z";
	const tasks = [
		{ id: "t1", type: "job.apply_agent", status: "failed", input: { url: "https://acme.co/careers/eng" }, updatedAt: earlier },
		{ id: "t2", type: "job.apply_agent", status: "completed", input: { url: "https://acme.co/careers/eng" }, updatedAt: nowIso },
		{ id: "t3", type: "job.apply_agent", status: "running", input: { url: "https://other.co/careers/pm" }, updatedAt: nowIso },
	];

	function boardEnv(overlayRows: unknown[] = []) {
		return mockEnv({
			first: (sql) => sql.includes("JOIN agents")
				? { slug: "job-application-assistant", category: "productivity", agent_config: "{}", instance_config: "{}" }
				: null,
			all: (sql) => {
				if (sql.includes("instance_runtime_tasks")) {
					return { results: tasks.map((t) => ({ payload: JSON.stringify(t) })) };
				}
				if (sql.includes("board_items")) return { results: overlayRows };
				return { results: [] };
			},
		});
	}

	it("groups runtime tasks into one card per job, newest attempt as the representative", async () => {
		const { env } = boardEnv();
		const board = await buildInstanceBoard(env, "inst-1", "u1");
		expect(board.items).toHaveLength(2); // two jobs, not three tasks
		const acme = board.items.find((i) => i.url.includes("acme"))!;
		expect(acme.runStatus).toBe("completed"); // t2 (newest) wins over t1
		expect(acme.latestTaskId).toBe("t2");
		expect(acme.attempts).toHaveLength(2); // both retries retained under the card
		expect(board.truncated).toBe(false);
		expect(board.columns.length).toBeGreaterThan(0);
	});

	it("applies a human status overlay so the card lives in the moved column", async () => {
		const jobKey = jobKeyForTask(tasks[1]); // acme job key
		const overlay = [{ job_key: jobKey, user_status: "interview", title: "", subtitle: "", url: "", updated_at: nowIso }];
		const { env } = boardEnv(overlay);
		const board = await buildInstanceBoard(env, "inst-1", "u1");
		const acme = board.items.find((i) => i.url.includes("acme"))!;
		expect(acme.userStatus).toBe("interview");
		expect(acme.status).toBe("interview"); // effective = userStatus ?? runStatus
	});

	it("keeps a standalone durable card for a moved job whose runtime tasks are gone", async () => {
		const overlay = [{ job_key: "ghost-job", user_status: "offer", title: "Ghost Co", subtitle: "ghost.co", url: "https://ghost.co", updated_at: nowIso }];
		const { env } = boardEnv(overlay);
		const board = await buildInstanceBoard(env, "inst-1", "u1");
		const ghost = board.items.find((i) => i.jobKey === "ghost-job");
		expect(ghost).toBeTruthy();
		expect(ghost!.title).toBe("Ghost Co");
		expect(ghost!.status).toBe("offer");
		expect(ghost!.attempts).toHaveLength(0);
	});
});
