/**
 * #1391 — the workflow side of the provider-retry policy: it is read from the instance only when a transient park needs it, journalled so a
 * replay agrees with the first pass, seeded by the run so two runs do not wake together, and every retry fact lands on the run's DURABLE trace
 * (`agent_events`, keyed by run id), where the runner's bounded event ring and the 2,000-character run detail cannot cut it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../../lib/d1-sqlite.js";
import { DEFAULT_PROVIDER_RETRY } from "../../lib/provider-retry.js";
import type { Env } from "../../types.js";
import { makePauseEffects } from "./pause-effects.js";

let d1: RealSchemaD1;
let env: Env;
let labels: string[];

const effects = (loopRunId: string | null = "run-9") =>
	makePauseEffects({
		env,
		step: {} as never,
		goal: { repo: "acme/app" } as never,
		instanceId: "i1",
		userId: "u1",
		sessionId: "s1",
		repoId: "r1",
		boardTaskId: undefined,
		loopRunId,
		driverId: null,
		workflowInstanceId: undefined,
		cloneUrl: undefined,
		branch: undefined,
		token: undefined,
		tokenUsername: undefined,
		cardId: null,
		runRetry: (async (label: string, fn: () => Promise<unknown>) => {
			labels.push(label);
			return fn();
		}) as never,
		postToChat: async () => {},
		getConn: () => ({}) as never,
		setConn: () => {},
		nextN: () => 0,
		startOnRunner: async () => undefined,
		getObjective: () => null,
	});
const events = () =>
	d1.sqlite.prepare("SELECT trace_id, source, level, event, message, context FROM agent_events WHERE source = 'coding' ORDER BY ts, rowid").all() as Array<{ trace_id: string; source: string; level: string; event: string; message: string; context: string }>;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB } as unknown as Env;
	labels = [];
});
afterEach(() => d1.close());

describe("the policy is read lazily and journalled (#1391)", () => {
	it("building a pause's effects takes no step at all: a run that never meets a provider outage is byte-for-byte what it was", () => {
		effects().deps(0, "engine_limit");
		effects().deps(3, "platform_interrupt");
		expect(labels).toEqual([]);
	});

	it("with nothing configured, the defaults — seeded by the run id", async () => {
		const got = await effects("run-9").deps(0, "platform_interrupt").providerRetry?.();
		expect(got).toEqual({ policy: DEFAULT_PROVIDER_RETRY, seed: "run-9" });
		expect(labels).toEqual(["provider-retry-policy"]);
	});

	it("reads the instance's own policy from its stored loop limits, over the defaults", async () => {
		d1.exec(`UPDATE agent_instances SET config = '{"loopLimits":{"providerRetry":{"attempts":2,"baseMs":30000}}}' WHERE id = 'i1'`);
		const got = await effects().deps(0, "platform_interrupt").providerRetry?.();
		expect(got?.policy).toEqual({ ...DEFAULT_PROVIDER_RETRY, attempts: 2, baseMs: 30_000 });
	});

	it("a hand-edited blob that is not a policy degrades to the defaults, never to a crash", async () => {
		d1.exec(`UPDATE agent_instances SET config = '{"loopLimits":{"providerRetry":"often"}}' WHERE id = 'i1'`);
		expect((await effects().deps(0, "platform_interrupt").providerRetry?.())?.policy).toEqual(DEFAULT_PROVIDER_RETRY);
	});

	it("is read once per run however many parks ask: the second call is the same answer, and no second step", async () => {
		const e = effects();
		const a = await e.deps(0, "platform_interrupt").providerRetry?.();
		d1.exec(`UPDATE agent_instances SET config = '{"loopLimits":{"providerRetry":{"attempts":1}}}' WHERE id = 'i1'`); // the owner changes it mid-run
		const b = await e.deps(1, "platform_interrupt").providerRetry?.();
		expect(b).toBe(a);
		expect(b?.policy.attempts).toBe(DEFAULT_PROVIDER_RETRY.attempts);
		expect(labels).toEqual(["provider-retry-policy"]);
	});

	it("a pause with no run row seeds by the session instead", async () => {
		expect((await effects(null).deps(0, "platform_interrupt").providerRetry?.())?.seed).toBe("s1");
	});
});

describe("every retry fact is written to the run's durable trace (#1391)", () => {
	const long = `[codex] error: Selected model is at capacity. Please try a different model.\n${"x".repeat(1_500)}\n[codex exited with code 1]`;

	it("keyed by the run id, as the event the park named, once per attempt, with its structured fields", async () => {
		const d = effects("run-9").deps(2, "platform_interrupt");
		await d.trace?.("provider_retry_scheduled", "Retry 1 of 4 in 2 min (openai (codex)).", { attempt: 1, of: 4, waitMs: 120_000, rule: "openai (codex)/transient", exitCode: 1, error: long });
		await d.trace?.("provider_retry_attempt", "Retry 1 of 4: resending.", { attempt: 1, of: 4, waitedMs: 120_000 });
		const rows = events();
		expect(rows.map((r) => [r.trace_id, r.event])).toEqual([
			["run-9", "coding.run.provider_retry_scheduled"],
			["run-9", "coding.run.provider_retry_attempt"],
		]);
		expect(JSON.parse(rows[0].context)).toMatchObject({ attempt: 1, of: 4, waitMs: 120_000, rule: "openai (codex)/transient", exitCode: 1, sessionId: "s1", runId: "run-9", repo: "acme/app" });
		expect(labels).toEqual(["ptrace-2-retry_scheduled-1", "ptrace-2-retry_attempt-1"]);
	});

	it("keeps the provider's long error in the context even though the one-line message is clipped", async () => {
		await effects().deps(0, "platform_interrupt").trace?.("provider_retry_exhausted", `The provider kept failing. ${"y".repeat(1_000)}`, { attempts: 4, taken: 4, error: long.slice(0, 1_200) });
		const [row] = events();
		expect(row.message.length).toBeLessThanOrEqual(400); // the one-liner is bounded…
		expect(JSON.parse(row.context).error).toContain("Selected model is at capacity"); // …the context carries the provider's words
		expect(JSON.parse(row.context).error.length).toBeGreaterThan(1_000);
	});

	it("a retry that ran out is a warning, so a reader filtering the level for 'why is nothing happening' finds it", async () => {
		const d = effects().deps(0, "platform_interrupt");
		await d.trace?.("provider_retry_scheduled", "wait", { attempt: 1 });
		await d.trace?.("provider_retry_exhausted", "gave up", { attempts: 4 });
		expect(events().map((r) => r.level)).toEqual(["info", "warn"]);
	});

	it("is journalled by attempt: a replay of the same park does not file the same fact twice", async () => {
		const seen = new Map<string, unknown>();
		const replaying = makePauseEffects({
			env, step: {} as never, goal: { repo: "acme/app" } as never, instanceId: "i1", userId: "u1", sessionId: "s1", repoId: "r1", boardTaskId: undefined, loopRunId: "run-9", driverId: null,
			workflowInstanceId: undefined, cloneUrl: undefined, branch: undefined, token: undefined, tokenUsername: undefined, cardId: null,
			// A step journal: a label already run returns its recorded answer without running again.
			runRetry: (async (label: string, fn: () => Promise<unknown>) => {
				if (seen.has(label)) return seen.get(label);
				const v = await fn();
				seen.set(label, v);
				return v;
			}) as never,
			postToChat: async () => {}, getConn: () => ({}) as never, setConn: () => {}, nextN: () => 0, startOnRunner: async () => undefined, getObjective: () => null,
		});
		const d = replaying.deps(1, "platform_interrupt");
		await d.trace?.("provider_retry_scheduled", "Retry 1 of 4", { attempt: 1 });
		await d.trace?.("provider_retry_scheduled", "Retry 1 of 4", { attempt: 1 }); // the replay
		await d.trace?.("provider_retry_scheduled", "Retry 2 of 4", { attempt: 2 }); // the next attempt is a new fact
		expect(events()).toHaveLength(2);
	});
});
