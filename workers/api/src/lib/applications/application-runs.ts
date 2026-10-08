/**
 * An application card, reconciled against the runs behind it (#987) — the read-time join the board
 * never had for the apply domain, written the same way #592 wrote it for coding (`board-runs.ts`).
 *
 * ── What `attempts` was reporting, and why it was wrong here
 *
 * `attempts` counts CARD ROWS sharing a job key, not executions. For an application that number is
 * 1 by construction and correctly so at the layer that does it: `applicationCardId` is
 * `app-<applicationId>` and `upsertWorkCard` is `ON CONFLICT(id) DO UPDATE`, so one application is
 * one row forever — the dedup is the feature (#978: "a retry must land on the same card").
 *
 * But an application's executions are its `local_apply_runs` and `local_artifact_runs`, which live
 * in other tables and were never read. Measured live on `435d31c8…`: FOUR correlated fill runs
 * (`207849f1…`, `da669896…`, `1b4963e7…`, `286bbb8a…`), reported as `attempts: 1`. So the card
 * carried the product model correctly and the execution history not at all, and an owner could not
 * tell a first try from a fourth.
 *
 * The fix is the read-time join, not a write-through: a run changes state in the runner's own sync
 * path, the workflow, the cron and the owner's retry, and a write-through would have to be added to
 * each and kept there. The same argument `board-runs.ts` makes, for the same reason.
 *
 * PURE where it can be: {@link reconcileApplicationCard} takes facts and returns a patch, so "a
 * card agrees with the runs correlated to it" is testable without D1.
 */
import type { ApplicationCardExecutions, ApplicationCardPayload } from "./application-card-payload.js";
import type { Env } from "../../types.js";

/** An attempt as the board reports it. Structurally `BoardAttempt` — declared here rather than
 * imported, because `board.ts` imports this module (the same reason `board-runs.ts` declares its
 * own). */
export interface ReconciledAttempt {
	id: string;
	status: string;
	updatedAt: string;
}

/** One correlated execution of an application, reduced to what a reader needs. */
export interface ApplicationRunFact {
	runId: string;
	/** Which pipeline stage ran: the Tailor's artifact run, or the Runner's fill. */
	kind: "tailor" | "fill";
	status: string;
	/** ms epoch — when it ended, else when it started, else when it was created. */
	at: number;
	/** The instance that executed it, so a deep link goes to the right agent's trace. */
	instanceId: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Every run correlated to these applications, newest first, in ONE read per table.
 *
 * Grouped rather than a read per card because the board polls every 2.5s — the same constraint the
 * coding join is written under. Scoped by `user_id`, like every other read in this domain.
 */
export async function applicationRunsForCards(env: Pick<Env, "DB">, userId: string, applicationIds: readonly string[]): Promise<Map<string, ApplicationRunFact[]>> {
	const out = new Map<string, ApplicationRunFact[]>();
	if (!applicationIds.length) return out;
	const ids = [...new Set(applicationIds)].slice(0, 200);
	const placeholders = ids.map((_, i) => `?${i + 2}`).join(",");
	const read = async (table: "local_apply_runs" | "local_artifact_runs", kind: ApplicationRunFact["kind"]) => {
		const { results } = await env.DB.prepare(
			`SELECT id, instance_id, application_id, status, created_at, started_at, ended_at
			   FROM ${table} WHERE user_id = ?1 AND application_id IN (${placeholders})`,
		)
			.bind(userId, ...ids)
			.all<{ id: string; instance_id: string; application_id: string; status: string; created_at: number; started_at: number | null; ended_at: number | null }>()
			.catch(() => ({ results: [] as never[] }));
		for (const r of results ?? []) {
			const fact: ApplicationRunFact = { runId: r.id, kind, status: r.status, at: num(r.ended_at) || num(r.started_at) || num(r.created_at), instanceId: r.instance_id };
			const arr = out.get(r.application_id);
			if (arr) arr.push(fact);
			else out.set(r.application_id, [fact]);
		}
	};
	await Promise.all([read("local_apply_runs", "fill"), read("local_artifact_runs", "tailor")]);
	for (const arr of out.values()) arr.sort((a, b) => b.at - a.at);
	return out;
}

/** How many executions a card reports individually before it only counts them. */
export const APPLICATION_EXECUTION_LIMIT = 20;

/**
 * The card's view of its own execution history, and the attempts a reader sees.
 *
 * `attempts` becomes the RUNS, exactly as a coding card's attempts became its loop runs: a reader
 * asking "how many tries has this had" is asking about executions, and the one-row-per-application
 * card cannot answer it. The card's product model is untouched — still one card per application.
 */
export function reconcileApplicationCard(input: { attempts: readonly ReconciledAttempt[]; runs: readonly ApplicationRunFact[]; application?: ApplicationCardPayload }): { attempts: ReconciledAttempt[]; executions: ApplicationCardExecutions } {
	const runs = [...input.runs].sort((a, b) => b.at - a.at);
	const fills = runs.filter((r) => r.kind === "fill");
	const tailorings = runs.filter((r) => r.kind === "tailor");
	const latest = runs[0];
	// The run the card's own payload names, when it still exists — a card written mid-run points at
	// the run that wrote it, and that is the one its trace link belongs to.
	const named = input.application?.runId ? runs.find((r) => r.runId === input.application?.runId) : undefined;
	const executions: ApplicationCardExecutions = {
		total: runs.length,
		fills: fills.length,
		tailorings: tailorings.length,
		runs: runs.slice(0, APPLICATION_EXECUTION_LIMIT).map((r) => ({ runId: r.runId, kind: r.kind, status: r.status, instanceId: r.instanceId })),
		...(latest ? { latest: { runId: latest.runId, kind: latest.kind, status: latest.status, instanceId: latest.instanceId } } : {}),
		...(named ? { card: { runId: named.runId, kind: named.kind, status: named.status, instanceId: named.instanceId } } : {}),
	};
	// No runs at all (an application still being tailored before its first run, or a card whose runs
	// were deleted with their agent): the generic attempts are the honest answer, not an empty list.
	const attempts: ReconciledAttempt[] = runs.length
		? runs.slice(0, APPLICATION_EXECUTION_LIMIT).map((r) => ({ id: r.runId, status: r.status, updatedAt: r.at ? new Date(r.at).toISOString() : "" }))
		: [...input.attempts];
	return { attempts, executions };
}
