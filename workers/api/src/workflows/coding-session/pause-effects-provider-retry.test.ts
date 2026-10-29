/**
 * #1391 — the workflow side of the provider-retry policy: it is read from the instance only when a transient park needs it, journalled so a
 * replay agrees with the first pass, seeded by the run so two runs do not wake together, and every retry fact lands on the run's DURABLE trace
 * (`agent_events`, keyed by run id), where the runner's bounded event ring and the 2,000-character run detail cannot cut it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../../lib/d1-sqlite.js";
import { DEFAULT_PROVIDER_RETRY } from "../../lib/provider-retry.js";
import type { Env } from "../../types.js";
const { callRunner } = vi.hoisted(() => ({ callRunner: vi.fn() }));
vi.mock("../../lib/runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/runner-client.js")>("../../lib/runner-client.js");
	return { ...actual, callRunner: (...a: unknown[]) => callRunner(...a) };
});

const { makePauseEffects } = await import("./pause-effects.js");

let d1: RealSchemaD1;
let env: Env;
let labels: string[];
let starts: number;

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
		startOnRunner: async () => {
			starts++;
		},
		getObjective: () => null,
	});
const events = () =>
	d1.sqlite.prepare("SELECT trace_id, source, level, event, message, context FROM agent_events WHERE source = 'coding' ORDER BY ts, rowid").all() as Array<{ trace_id: string; source: string; level: string; event: string; message: string; context: string }>;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB } as unknown as Env;
	labels = [];
	starts = 0;
	callRunner.mockReset();
	callRunner.mockResolvedValue({ ok: true });
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

// ── #1392: switching the session's model for the run, and putting it back ───────────────────────────────────────────────────────────────
describe("the model switch rewrites the session's stored command and restarts its engine (#1392)", () => {
	const CODEX = "codex exec --model gpt-5.1-codex --json --sandbox danger-full-access";
	const sessionCommand = () => (d1.sqlite.prepare("SELECT launch_command FROM coding_sessions WHERE id = 's1'").get() as { launch_command: string | null }).launch_command;
	const seedSession = (command: string | null = CODEX) => {
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', 'i1', 'u1', 'owner/repo', '/w/repo', 'ready')`);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, launch_command) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'codex', ${command === null ? "NULL" : `'${command}'`})`);
	};

	it("writes the fallback model into the stored command, ends the engine on the runner and starts it again — each a journalled step, in that order", async () => {
		seedSession();
		const out = await effects().deps(2, "platform_interrupt").switchModel?.("gpt-5.1-codex-mini");
		expect(out).toEqual({ ok: true, from: "gpt-5.1-codex" });
		expect(sessionCommand()).toBe("codex exec --model gpt-5.1-codex-mini --json --sandbox danger-full-access");
		expect(callRunner.mock.calls.map((c) => [c[1], c[2]])).toEqual([["/coding/end", { sessionId: "s1" }]]);
		expect(starts).toBe(1); // the relaunch reads the command just stored
		expect(labels).toEqual(["fallback-read-2", "fallback-set-2", "fallback-end-2", "fallback-start-2"]);
	});

	it("changes nothing when the command takes no model flag: no write, no restart, and the reason names the engine", async () => {
		seedSession("ollama run llama3");
		const out = await effects().deps(0, "platform_interrupt").switchModel?.("gpt-x");
		expect(out).toEqual({ ok: false, why: "the engine's command (ollama) takes no --model flag" });
		expect(sessionCommand()).toBe("ollama run llama3");
		expect(callRunner).not.toHaveBeenCalled();
		expect(starts).toBe(0);
	});

	it("changes nothing when the session already runs that model", async () => {
		seedSession();
		expect(await effects().deps(0, "platform_interrupt").switchModel?.("gpt-5.1-codex")).toEqual({ ok: false, why: "the session already runs gpt-5.1-codex" });
		expect(sessionCommand()).toBe(CODEX);
		expect(starts).toBe(0);
	});

	it("changes nothing when the session has no recorded command, or no row at all", async () => {
		seedSession(null);
		expect(await effects().deps(0, "platform_interrupt").switchModel?.("gpt-x")).toMatchObject({ ok: false, why: expect.stringContaining("no recorded launch command") });
		d1.exec("DELETE FROM coding_sessions");
		expect(await effects().deps(0, "platform_interrupt").switchModel?.("gpt-x")).toMatchObject({ ok: false });
	});

	it("a restart that fails puts the stored command back, so nothing is left half-switched", async () => {
		seedSession();
		callRunner.mockRejectedValue(new Error("relay dropped"));
		const out = await effects().deps(0, "platform_interrupt").switchModel?.("gpt-5.1-codex-mini");
		expect(out).toMatchObject({ ok: false, why: expect.stringMatching(/the restart on gpt-5\.1-codex-mini failed: relay dropped/) });
		expect(sessionCommand()).toBe(CODEX);
		expect(starts).toBe(0);
	});

	it("never touches another session's command", async () => {
		seedSession();
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, launch_command) VALUES ('s2', 'i1', 'r1', 'u1', 'ended', 'codex', '${CODEX}')`);
		await effects().deps(0, "platform_interrupt").switchModel?.("gpt-5.1-codex-mini");
		expect((d1.sqlite.prepare("SELECT launch_command FROM coding_sessions WHERE id = 's2'").get() as { launch_command: string }).launch_command).toBe(CODEX);
	});
});

describe("the run's end puts the session's own model back (#1392)", () => {
	const CODEX = "codex exec --model gpt-5.1-codex --json --sandbox danger-full-access";
	const sessionCommand = () => (d1.sqlite.prepare("SELECT launch_command FROM coding_sessions WHERE id = 's1'").get() as { launch_command: string | null }).launch_command;
	beforeEach(() => {
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', 'i1', 'u1', 'owner/repo', '/w/repo', 'ready')`);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, launch_command) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'codex', '${CODEX}')`);
	});

	it("is a no-op when the run never switched: no step, no write, no runner call", async () => {
		await effects().restoreFallback({ endEngine: true });
		expect(labels).toEqual([]);
		expect(callRunner).not.toHaveBeenCalled();
		expect(sessionCommand()).toBe(CODEX);
	});

	it("restores the ORIGINAL command, so a later run on this session starts on the configured model, and records that it did", async () => {
		const e = effects();
		await e.deps(0, "platform_interrupt").switchModel?.("gpt-5.1-codex-mini");
		expect(sessionCommand()).toContain("gpt-5.1-codex-mini");
		callRunner.mockClear();
		await e.restoreFallback({ endEngine: false });
		expect(sessionCommand()).toBe(CODEX);
		expect(callRunner).not.toHaveBeenCalled(); // a session the run opened is about to be ended anyway
		const row = events().find((r) => r.event === "coding.run.provider_fallback_restored");
		expect(row?.trace_id).toBe("run-9");
		expect(JSON.parse(row?.context ?? "{}")).toMatchObject({ fallbackModel: "gpt-5.1-codex-mini", restoredTo: "gpt-5.1-codex", endedEngine: false });
	});

	it("also ends the runner's engine when the session outlives the run, so the next use relaunches on the original model instead of inheriting the fallback", async () => {
		const e = effects();
		await e.deps(0, "platform_interrupt").switchModel?.("gpt-5.1-codex-mini");
		callRunner.mockClear();
		await e.restoreFallback({ endEngine: true });
		expect(callRunner.mock.calls.map((c) => c[1])).toEqual(["/coding/end"]);
		expect(sessionCommand()).toBe(CODEX);
	});

	it("a replayed workflow still restores the ORIGINAL: the command it replaces is read through a journalled step", async () => {
		const journal = new Map<string, unknown>();
		const build = () =>
			makePauseEffects({
				env, step: {} as never, goal: { repo: "acme/app" } as never, instanceId: "i1", userId: "u1", sessionId: "s1", repoId: "r1", boardTaskId: undefined, loopRunId: "run-9", driverId: null,
				workflowInstanceId: undefined, cloneUrl: undefined, branch: undefined, token: undefined, tokenUsername: undefined, cardId: null,
				runRetry: (async (label: string, fn: () => Promise<unknown>) => {
					if (journal.has(label)) return journal.get(label);
					const v = await fn();
					journal.set(label, v);
					return v;
				}) as never,
				postToChat: async () => {}, getConn: () => ({}) as never, setConn: () => {}, nextN: () => 0, startOnRunner: async () => undefined, getObjective: () => null,
			});
		await build().deps(0, "platform_interrupt").switchModel?.("gpt-5.1-codex-mini"); // the first pass
		expect(sessionCommand()).toContain("gpt-5.1-codex-mini");
		// The Workflow is replayed from its journal: a fresh closure, the database already holding the FALLBACK command.
		const replay = build();
		const again = await replay.deps(0, "platform_interrupt").switchModel?.("gpt-5.1-codex-mini");
		expect(again).toEqual({ ok: true, from: "gpt-5.1-codex" }); // not "the session already runs it"
		await replay.restoreFallback({ endEngine: false });
		expect(sessionCommand()).toBe(CODEX);
	});
});
