/**
 * #1252 — a write the runner's guard refused is read back out of the tool result that tried it, and
 * reaches the run's evidence check, the Pilot's step log, the instance activity log and the trace.
 * The lines below are the ones the GENERATED guards print (push-guard.ts, gh-guard.ts), byte for byte.
 *
 * #1403 adds a sibling shape: a push the SAME guard's bounded wait gave up on — in scope, outcome
 * unknown, never a refusal — through the identical per-step/activity/trace pipeline.
 */
import { describe, expect, it } from "vitest";
import { CompletionEvidence, evidenceNote, judgeCompletion } from "./coding-completion-evidence.js";
import { type CodingDeps, runCodingLoop } from "./coding-loop.js";
import { describePushTimeout, describeWriteRefusal, pushTimeoutsIn, recordPushTimeout, recordWriteRefusal, writeRefusalsIn } from "./write-scope-refusals.js";
import { logRunnerAttach } from "../agent-do-storage-routes.js";
import type { Env } from "../types.js";

const PUSH_LINE =
	"pags: refused write-scope: git push to proagentstore/runner-router — this agent session is registered for: proappstore-online/template-app";
const GH_LINE =
	"pags: refused: `gh run cancel` writes to proappstore-online/tennis-clubs, which this agent session is not registered for (allowed: proappstore-online/template-app).";
const TIMEOUT_LINE =
	"pags: push timed out: proappstore-online/platform did not complete within 45s — delegated to git-remote-https for auth, network and the remote's own response; nothing further is known from here. Check credential.helper / network / github.com reachability, then retry.";

/** The incident's shape: a push from the /tmp/rr temp clone, named by the remote alone. */
const PANE = [
	"\n❯ [10:02:11] push the router fix",
	'⚙ Bash {"command":"cd /tmp/rr/runner-router && git push origin main && git push origin v1 --force"}',
	`  ↳✗ ${PUSH_LINE}`,
	"  │ The push was refused before anything was sent. Ask the owner to register that repository with the agent, or push from a session that owns it.",
	"  │ error: failed to push some refs to 'github-personal:ProAgentStore/runner-router.git'",
	'⚙ Bash {"command":"gh run cancel 123 -R proappstore-online/tennis-clubs"}',
	`  ↳✗ ${GH_LINE}`,
	"[10:02:40] done",
].join("\n");

/** The #1403 incident's shape: an in-scope push the real transport never answered within the bound. */
const TIMEOUT_PANE = [
	"\n❯ [10:02:11] push the fix",
	'⚙ Bash {"command":"git push origin main"}',
	`  ↳✗ ${TIMEOUT_LINE}`,
	"[10:02:56] done",
].join("\n");

describe("reading a refusal out of a tool result (#1252)", () => {
	it("names what was refused and the repository it was aimed at, for both guards", () => {
		expect(writeRefusalsIn(`${PUSH_LINE}\n${GH_LINE}\n${PUSH_LINE}`)).toEqual([
			{ how: "git push", repo: "proagentstore/runner-router" },
			{ how: "gh run cancel", repo: "proappstore-online/tennis-clubs" },
		]);
	});

	it("an ordinary failure, or a mention of the marker in prose, is not a refusal", () => {
		expect(writeRefusalsIn("error: failed to push some refs\n! [rejected] main -> main (fetch first)")).toEqual([]);
		expect(writeRefusalsIn("grep 'pags: refused' src/*.ts")).toEqual([]);
	});
});

describe("reading a push timeout out of a tool result (#1403)", () => {
	it("names the repository and how long the guard waited", () => {
		expect(pushTimeoutsIn(TIMEOUT_LINE)).toEqual([{ repo: "proappstore-online/platform", seconds: 45 }]);
	});

	it("is a DIFFERENT marker from a refusal — never mixed up as the same thing", () => {
		expect(writeRefusalsIn(TIMEOUT_LINE)).toEqual([]);
		expect(pushTimeoutsIn(PUSH_LINE)).toEqual([]);
	});

	it("an ordinary rc=124, or a mention of the marker in prose, is not a timeout line", () => {
		expect(pushTimeoutsIn("error: failed to push some refs\nrc=124")).toEqual([]);
		expect(pushTimeoutsIn("grep 'pags: push timed out' src/*.ts")).toEqual([]);
	});

	it("deduplicates, in order, like a refusal does", () => {
		expect(pushTimeoutsIn(`${TIMEOUT_LINE}\n${TIMEOUT_LINE}`)).toEqual([{ repo: "proappstore-online/platform", seconds: 45 }]);
	});
});

describe("the run's evidence check states every refusal (#1252)", () => {
	it("whatever the claim, and even when the command named no repository", () => {
		const ev = new CompletionEvidence();
		ev.observe(PANE);
		const j = judgeCompletion("Fixed it and pushed to main.", ev);
		expect(j.refusals).toEqual([
			{ how: "git push", repo: "proagentstore/runner-router" },
			{ how: "gh run cancel", repo: "proappstore-online/tennis-clubs" },
		]);
		expect(j.verdicts.find((v) => v.claim === "pushed")?.status).toBe("contradicted");
		const note = evidenceNote(j);
		expect(note).toContain("- write scope: REFUSED — `git push` to proagentstore/runner-router, not a registered repository; nothing was written");
		expect(note).toContain("`gh run cancel` to proappstore-online/tennis-clubs");
		// A finish that claims nothing still carries them.
		expect(evidenceNote(judgeCompletion("Looked into it.", ev))).toMatch(/write scope: REFUSED/);
	});

	it("each refusal is handed out once, however many snapshots show it", () => {
		const ev = new CompletionEvidence();
		ev.observe(PANE);
		expect(ev.takeRefusals()).toHaveLength(2);
		ev.observe(PANE);
		expect(ev.takeRefusals()).toEqual([]);
	});
});

describe("a push timeout leaves a 'pushed' claim UNVERIFIED, never contradicted or supported (#1403)", () => {
	it("a timeout is not evidence the push failed — only that nothing is known", () => {
		// A refusal is CONTAINMENT (nothing was sent): the claim is actively wrong, hence "contradicted"
		// above. A timeout's outcome is genuinely unknown — it may have landed — so the SAME claim must
		// not read as contradicted, and must not read as supported either: there is no `push` evidence
		// (no "Everything up-to-date" / ref-update line) for judgeCompletion's push check to find.
		const ev = new CompletionEvidence();
		ev.observe(TIMEOUT_PANE);
		const j = judgeCompletion("Fixed it and pushed to main.", ev);
		expect(j.verdicts.find((v) => v.claim === "pushed")?.status).toBe("unverified");
		expect(j.refusals).toEqual([]); // not a write-scope refusal — the push was in scope
	});

	it("each timeout is handed out once, however many snapshots show it", () => {
		const ev = new CompletionEvidence();
		ev.observe(TIMEOUT_PANE);
		expect(ev.takePushTimeouts()).toEqual([{ repo: "proappstore-online/platform", seconds: 45 }]);
		ev.observe(TIMEOUT_PANE);
		expect(ev.takePushTimeouts()).toEqual([]);
	});
});

describe("the loop tells the Pilot and the owner (#1252)", () => {
	it("emits write_refused with the repository, and puts the sentence in the step log the Pilot reads", async () => {
		const events: Array<{ type: string; message: string; data?: unknown }> = [];
		const logs: string[][] = [];
		const snap = { alive: true, runState: "idle", pane: PANE } as unknown as Awaited<ReturnType<CodingDeps["snapshot"]>>;
		const deps: CodingDeps = {
			snapshot: async () => snap,
			act: async () => snap,
			waitIdle: async () => snap,
			decide: async ({ actionLog }) => {
				logs.push([...actionLog]);
				return { finish: { status: "failed", detail: "stopped" } } as unknown as Awaited<ReturnType<CodingDeps["decide"]>>;
			},
			onEvent: (type, message, data) => void events.push({ type, message, data }),
		};
		await runCodingLoop(deps, { objective: "x", repo: "template-app" } as Parameters<typeof runCodingLoop>[1]);
		const refused = events.filter((e) => e.type === "write_refused");
		expect(refused.map((e) => e.data)).toEqual([
			{ how: "git push", repo: "proagentstore/runner-router" },
			{ how: "gh run cancel", repo: "proappstore-online/tennis-clubs" },
		]);
		expect(logs[0]).toEqual(expect.arrayContaining([describeWriteRefusal({ how: "git push", repo: "proagentstore/runner-router" })]));
	});
});

describe("the loop tells the Pilot and the owner about a push timeout (#1403)", () => {
	it("emits push_timeout with the repository, and puts the sentence in the step log the Pilot reads", async () => {
		const events: Array<{ type: string; message: string; data?: unknown }> = [];
		const logs: string[][] = [];
		const snap = { alive: true, runState: "idle", pane: TIMEOUT_PANE } as unknown as Awaited<ReturnType<CodingDeps["snapshot"]>>;
		const deps: CodingDeps = {
			snapshot: async () => snap,
			act: async () => snap,
			waitIdle: async () => snap,
			decide: async ({ actionLog }) => {
				logs.push([...actionLog]);
				return { finish: { status: "failed", detail: "stopped" } } as unknown as Awaited<ReturnType<CodingDeps["decide"]>>;
			},
			onEvent: (type, message, data) => void events.push({ type, message, data }),
		};
		await runCodingLoop(deps, { objective: "x", repo: "platform" } as Parameters<typeof runCodingLoop>[1]);
		const timedOut = events.filter((e) => e.type === "push_timeout");
		expect(timedOut.map((e) => e.data)).toEqual([{ repo: "proappstore-online/platform", seconds: 45 }]);
		expect(logs[0]).toEqual(expect.arrayContaining([describePushTimeout({ repo: "proappstore-online/platform", seconds: 45 })]));
	});
});

describe("recording a refusal (#1252)", () => {
	it("writes the instance's activity log and the trace — and never throws", async () => {
		const activity: Array<{ url: string; body: unknown }> = [];
		const traced: unknown[][] = [];
		const env = {
			DB: { prepare: () => ({ bind: (...args: unknown[]) => ({ run: async () => void traced.push(args) }) }) },
			AGENT: {
				idFromName: (n: string) => n,
				get: () => ({
					fetch: async (req: Request) => {
						activity.push({ url: req.url, body: await req.json() });
						return Response.json({});
					},
				}),
			},
		} as unknown as Env;
		await recordWriteRefusal(env, { userId: "u1", instanceId: "e4d2d031", sessionId: "csess_b8fa9388" }, { how: "git push", repo: "proagentstore/runner-router" });
		expect(activity).toEqual([
			{
				url: "https://agent/activity/write-refused",
				body: { userId: "u1", data: expect.objectContaining({ how: "git push", repo: "proagentstore/runner-router", sessionId: "csess_b8fa9388" }) },
			},
		]);
		expect(JSON.stringify(traced)).toContain("write.refused");
		const broken = { DB: { prepare: () => { throw new Error("d1 down"); } }, AGENT: { idFromName: () => "x", get: () => ({ fetch: async () => { throw new Error("do down"); } }) } } as unknown as Env;
		await expect(recordWriteRefusal(broken, { userId: "u1", instanceId: "i", sessionId: "s" }, { how: "git push", repo: "a/b" })).resolves.toBeUndefined();
	});
});

describe("recording a push timeout (#1403)", () => {
	it("writes the instance's activity log and the trace — and never throws", async () => {
		const activity: Array<{ url: string; body: unknown }> = [];
		const traced: unknown[][] = [];
		const env = {
			DB: { prepare: () => ({ bind: (...args: unknown[]) => ({ run: async () => void traced.push(args) }) }) },
			AGENT: {
				idFromName: (n: string) => n,
				get: () => ({
					fetch: async (req: Request) => {
						activity.push({ url: req.url, body: await req.json() });
						return Response.json({});
					},
				}),
			},
		} as unknown as Env;
		await recordPushTimeout(env, { userId: "u1", instanceId: "e4d2d031", sessionId: "csess_b8fa9388" }, { repo: "proappstore-online/platform", seconds: 45 });
		expect(activity).toEqual([
			{
				url: "https://agent/activity/push-timeout",
				body: { userId: "u1", data: expect.objectContaining({ repo: "proappstore-online/platform", seconds: 45, sessionId: "csess_b8fa9388" }) },
			},
		]);
		expect(JSON.stringify(traced)).toContain("push.timeout");
		const broken = { DB: { prepare: () => { throw new Error("d1 down"); } }, AGENT: { idFromName: () => "x", get: () => ({ fetch: async () => { throw new Error("do down"); } }) } } as unknown as Env;
		await expect(recordPushTimeout(broken, { userId: "u1", instanceId: "i", sessionId: "s" }, { repo: "a/b", seconds: 45 })).resolves.toBeUndefined();
	});
});

describe("the instance DO's activity route (#1252)", () => {
	it("stores the refusal as a `write.refused` activity event — what instance_activity lists", async () => {
		const logged: unknown[][] = [];
		const engine = {
			logEvent: async (...args: unknown[]) => {
				logged.push(args);
				return { id: "e1" };
			},
		} as unknown as Parameters<typeof logRunnerAttach>[0];
		const req = new Request("https://agent/activity/write-refused", { method: "POST", body: JSON.stringify({ userId: "u1", data: { how: "git push", repo: "a/b" } }) });
		await logRunnerAttach(engine, req, "write.refused");
		expect(logged).toEqual([["write.refused", "u1", { how: "git push", repo: "a/b" }]]);
	});

	it("stores a push timeout as a `push.timeout` activity event (#1403)", async () => {
		const logged: unknown[][] = [];
		const engine = {
			logEvent: async (...args: unknown[]) => {
				logged.push(args);
				return { id: "e1" };
			},
		} as unknown as Parameters<typeof logRunnerAttach>[0];
		const req = new Request("https://agent/activity/push-timeout", { method: "POST", body: JSON.stringify({ userId: "u1", data: { repo: "a/b", seconds: 45 } }) });
		await logRunnerAttach(engine, req, "push.timeout");
		expect(logged).toEqual([["push.timeout", "u1", { repo: "a/b", seconds: 45 }]]);
	});
});
