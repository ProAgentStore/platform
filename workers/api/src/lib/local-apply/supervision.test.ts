/**
 * One directive per checkpoint, and a retry that cannot become a second one (#970).
 *
 * `issueSupervisorDirective`'s four non-trivial outcomes had their only coverage in
 * `application-runner-routes.test.ts`, through the HTTP route. #4672d6f2 gave the Runner's own
 * cloud brain the checkpoint (`directApplicationCheckpoint`, called from `syncApplyRun`), which is
 * right — but it also means the route directs the checkpoint itself before it reads the caller's
 * body, so an HTTP caller now gets `checkpoint_already_directed` and `issued`/`existing` became
 * unreachable from there. The replay assertion went with them.
 *
 * These are the guarantees that disappeared, tested where the decision actually lives: a dropped
 * response must be retryable without delivering a SECOND directive into a live browser run, and a
 * reused idempotency key must be refused rather than silently adopted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../types.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../d1-sqlite.js";
import type { LocalApplySupervisorFacts } from "./contract.js";
import { SUPERVISOR_SCHEMA_VERSION, issueSupervisorDirective, receiveSupervisorCheckpoint } from "./supervision.js";

const UID = "u1";
const RUN = { id: "run-1", instanceId: "inst-1" };
const FACTS: LocalApplySupervisorFacts = { phase: "before_submit", actions: 7, filled: 5, uploaded: 1, blockers: [], url: "https://jobs.example.com/apply", domain: "jobs.example.com" };

let d1: RealSchemaD1;
let env: Pick<Env, "DB">;

/** The one checkpoint every case below directs. */
async function checkpoint(id = "before-submit-1") {
	const received = await receiveSupervisorCheckpoint(env, RUN, UID, { schemaVersion: SUPERVISOR_SCHEMA_VERSION, checkpointId: id, facts: FACTS, runnerSeq: 4 }, 1_000);
	expect(received?.directive).toBeNull();
	return id;
}

const issue = (input: { checkpointId: string; idempotencyKey: string; directive: "continue" | "request_review" | "stop" }, now = 2_000) =>
	issueSupervisorDirective(env, RUN, UID, { schemaVersion: SUPERVISOR_SCHEMA_VERSION, ...input }, now);

const directiveRows = async () => (await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_apply_supervisor_directives").first<{ n: number }>())?.n;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: UID, instanceIds: [RUN.instanceId] });
	d1.exec(
		`INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, created_at, updated_at)
		 VALUES ('${RUN.id}', '${RUN.instanceId}', '${UID}', 'app-1', 'req-1', 'paused', '{}', 1000, 1000)`,
	);
	env = { DB: d1.DB } as unknown as Pick<Env, "DB">;
});
afterEach(() => d1.close());

describe("a directive is issued once and replayed, never decided twice (#970)", () => {
	it("records the first decision as `issued`, carrying the key it was claimed under", async () => {
		const id = await checkpoint();
		const out = await issue({ checkpointId: id, idempotencyKey: "directive-1", directive: "continue" });
		expect(out.kind).toBe("issued");
		expect(out).toMatchObject({ directive: { checkpointId: id, directive: "continue", idempotencyKey: "directive-1", createdAt: 2_000, deliveredAt: null } });
		expect(await directiveRows()).toBe(1);
	});

	it("an identical retry is `existing` with the SAME directive row — a dropped response costs no second delivery", async () => {
		const id = await checkpoint();
		const first = await issue({ checkpointId: id, idempotencyKey: "directive-1", directive: "continue" });
		const replay = await issue({ checkpointId: id, idempotencyKey: "directive-1", directive: "continue" }, 9_000);
		expect(replay.kind).toBe("existing");
		// The same row, not a re-decision: same id, and the original `createdAt` rather than `now`.
		expect(replay).toMatchObject({ directive: { id: (first as { directive: { id: string } }).directive.id, createdAt: 2_000 } });
		expect(await directiveRows()).toBe(1);
	});

	it("reusing a key for a DIFFERENT decision is a conflict, and the stored decision stands", async () => {
		const id = await checkpoint();
		await issue({ checkpointId: id, idempotencyKey: "directive-1", directive: "continue" });
		const conflict = await issue({ checkpointId: id, idempotencyKey: "directive-1", directive: "stop" });
		expect(conflict.kind).toBe("idempotency_conflict");
		expect(conflict).toMatchObject({ directive: { directive: "continue" } });
		expect(await directiveRows()).toBe(1);
	});

	it("reusing a key for another CHECKPOINT is a conflict too — a key names one decision", async () => {
		const first = await checkpoint();
		const second = await checkpoint("uncertain-2");
		await issue({ checkpointId: first, idempotencyKey: "directive-1", directive: "continue" });
		const conflict = await issue({ checkpointId: second, idempotencyKey: "directive-1", directive: "continue" });
		expect(conflict.kind).toBe("idempotency_conflict");
		expect(conflict).toMatchObject({ directive: { checkpointId: first } });
		expect(await directiveRows()).toBe(1);
	});

	it("a fresh key cannot revise a checkpoint that is already directed", async () => {
		const id = await checkpoint();
		await issue({ checkpointId: id, idempotencyKey: "brain:before-submit-1", directive: "request_review" });
		const revision = await issue({ checkpointId: id, idempotencyKey: "directive-revision", directive: "continue" });
		expect(revision.kind).toBe("checkpoint_already_directed");
		expect(revision).toMatchObject({ directive: { directive: "request_review", idempotencyKey: "brain:before-submit-1" } });
		expect(await directiveRows()).toBe(1);
	});

	it("a checkpoint the runner never reported takes no directive at all", async () => {
		expect(await issue({ checkpointId: "never-reported", idempotencyKey: "directive-1", directive: "continue" })).toEqual({ kind: "missing_checkpoint" });
		expect(await directiveRows()).toBe(0);
	});

	it("refuses malformed input rather than storing an unvalidated decision", async () => {
		const id = await checkpoint();
		await expect(issueSupervisorDirective(env, RUN, UID, { checkpointId: id, schemaVersion: 2, idempotencyKey: "k", directive: "continue" }, 2_000)).rejects.toThrow(/Invalid supervisor directive/);
		await expect(issue({ checkpointId: id, idempotencyKey: "bad key with spaces", directive: "continue" })).rejects.toThrow(/Invalid supervisor directive/);
		await expect(issue({ checkpointId: id, idempotencyKey: "k", directive: "proceed" as "continue" })).rejects.toThrow(/Invalid supervisor directive/);
		expect(await directiveRows()).toBe(0);
	});
});
