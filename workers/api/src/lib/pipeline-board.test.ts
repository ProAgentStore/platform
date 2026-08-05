import { describe, expect, it } from "vitest";
import { closePipelineRunCard, pipelineCardId, pipelineCardStatus, pipelineRunTaskRecord, upsertPipelineRunCard } from "./pipeline-board.js";
import { columnForStatus, defaultBoardColumns } from "./agent-capabilities.js";
import { summarizeSubordinates } from "./subordinate-observation.js";
import type { Env } from "../types.js";

const NOW = "2026-08-05T12:00:00.000Z";

function stubEnv(row: Record<string, string> | null = null) {
	const writes: Array<{ sql: string; args: unknown[] }> = [];
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
							async first() { return row; },
						};
					},
				};
			},
		},
	} as unknown as Env;
	return { env, writes };
}

describe("pipelineRunTaskRecord — a run as a generic card", () => {
	it("maps `interrupted` onto a column that exists", () => {
		// `interrupted` is the pipeline vocabulary's own word and no default column claims it.
		// DEFAULT_BOARD_COLUMNS has no catchAll either, so passing it through would put the card in
		// no column at all — present in the data, invisible on the board.
		const cols = defaultBoardColumns([]);
		expect(columnForStatus(cols, "interrupted")).toBeNull();
		expect(pipelineCardStatus("interrupted")).toBe("cancelled");
		expect(columnForStatus(cols, pipelineCardStatus("interrupted"))?.title).toBe("Cancelled");
	});

	it("leaves the other statuses alone — they are already the platform's words", () => {
		const cols = defaultBoardColumns([]);
		for (const s of ["running", "completed", "failed"]) {
			expect(pipelineCardStatus(s)).toBe(s);
			expect(columnForStatus(cols, s), s).not.toBeNull();
		}
	});

	it("uses a stable id so open and close address one row", () => {
		expect(pipelineRunTaskRecord({ runId: "r1", pipeline: "lead_finder", trigger: "cron", status: "running", now: NOW }).id)
			.toBe(pipelineCardId("r1"));
	});

	it("names the pipeline and the trigger, and stamps completedAt only when terminal", () => {
		const open = pipelineRunTaskRecord({ runId: "r", pipeline: "lead_finder", trigger: "cron", status: "running", now: NOW });
		expect(open).toMatchObject({ type: "pipeline.run", title: "Pipeline: lead_finder", subtitle: "cron" });
		expect(open).not.toHaveProperty("completedAt");
		const done = pipelineRunTaskRecord({ runId: "r", pipeline: "lead_finder", trigger: "cron", status: "completed", now: NOW, detail: "116 seen · 64 added" });
		expect(done).toMatchObject({ completedAt: NOW, description: "116 seen · 64 added" });
	});
});

describe("closePipelineRunCard — identity comes off the run row", () => {
	it("reads owner + instance back from pipeline_runs rather than making callers thread them", async () => {
		const { env, writes } = stubEnv({ user_id: "u1", instance_id: "i1", pipeline: "lead_finder", trigger: "cron" });
		await closePipelineRunCard(env, "r1", "completed", "116 seen · 64 added");
		const w = writes.find((x) => x.sql.includes("instance_runtime_tasks"));
		expect(w?.args).toContain("i1");
		expect(w?.args).toContain("u1");
	});

	it("does nothing when the run row is gone — no orphan card, no throw", async () => {
		const { env, writes } = stubEnv(null);
		await expect(closePipelineRunCard(env, "missing", "failed", "x")).resolves.toBeUndefined();
		expect(writes).toHaveLength(0);
	});

	it("never throws when the write fails", async () => {
		const env = {
			DB: {
				prepare() {
					return { bind() { return { async run() { throw new Error("d1 down"); }, async first() { return { user_id: "u", instance_id: "i", pipeline: "p", trigger: "t" }; } }; } };
				},
			},
		} as unknown as Env;
		await expect(upsertPipelineRunCard(env, { instanceId: "i", userId: "u", runId: "r", pipeline: "p", trigger: "t", status: "running" }))
			.resolves.toBeUndefined();
	});
});

describe("the architectural test — supervision needs no change to see a pipeline", () => {
	it("a supervisor buckets a pipeline card correctly knowing nothing about pipelines", () => {
		// The claim #207A was filed to prove: the ONLY thing that changed is that a domain started
		// writing a generic record. `summarizeSubordinates` has no pipeline concept, no import from
		// pipeline-runs, and no new status — and it still reports the run as Running.
		const card = pipelineRunTaskRecord({ runId: "r1", pipeline: "lead_finder", trigger: "cron", status: "running", now: NOW });
		const out = summarizeSubordinates({
			now: Date.parse(NOW),
			subordinates: [{ instanceId: "i1", name: "Lead Finder", subscription: "active", columns: defaultBoardColumns([]) }],
			work: [{
				instanceId: "i1",
				id: String(card.id),
				kind: String(card.type),
				status: String(card.status),
				title: String(card.title),
				detail: "",
				updatedAt: NOW,
			}],
			runs: [],
		});
		expect(out.subordinates[0].work[0]).toMatchObject({ kind: "pipeline.run", columnTitle: "Running", title: "Pipeline: lead_finder" });
		expect(out.subordinates[0].buckets).toEqual([{ id: "running", title: "Running", count: 1 }]);
	});
});
