/**
 * The coder brain is BYOK (#1025, owner decision 2026-10-14): it runs on the owner's own key and the
 * platform never pays. These tests use the REAL production model call — no fake model — so an owner
 * with no key proves both halves: the platform `env.AI` binding is never touched, and the question
 * escalates to the human instead of being decided.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { setCoderBrain } from "./coder-brain.js";
import { byokBrainCall } from "./coder-brain-decide.js";
import { getCoderQuestion } from "./coder-question-store.js";
import { type CoderQuestionEffects, captureAndAnnounceQuestion, defaultEffects, runDueCoderQuestions } from "./coder-question-sweep.js";
import { UserAiCredentialsError } from "./user-ai.js";
import type { Env } from "../types.js";

const MIN = 60_000;
let d1: RealSchemaD1;
let env: Env;
let platformAi: ReturnType<typeof vi.fn>;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('repo-1', 'coder', 'u1', 'app', 'acme/app')");
	d1.exec("INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, issue_number) VALUES ('s1', 'coder', 'repo-1', 'u1', 7)");
	platformAi = vi.fn(() => {
		throw new Error("the platform AI binding must never run the coder brain");
	});
	env = { DB: d1.DB, AI: { run: platformAi } } as unknown as Env;
});
afterEach(() => d1.close());

describe("the coder brain runs on the owner's key only", () => {
	it.each(["claude-sonnet-4-6", "@cf/meta/llama-4-scout-17b-16e-instruct"])("%s with no owner key: UserAiCredentialsError, platform AI untouched", async (model) => {
		const call = byokBrainCall(env, "u1", "coder", model);
		await expect(call({ system: "decide", user: "Which table layout?" })).rejects.toBeInstanceOf(UserAiCredentialsError);
		expect(platformAi).not.toHaveBeenCalled();
	});

	it("the sweep with the brain on and no owner key escalates to the human — alert + issue comment, no decision, no platform AI", async () => {
		await setCoderBrain(env, "coder", "u1", { enabled: true, humanTimeoutMinutes: 30, escalationTimeoutMinutes: 60 });
		const log = { comments: [] as string[], notified: [] as Array<{ title: string; alert: boolean }>, delivered: [] as string[] };
		const effects: Partial<CoderQuestionEffects> = {
			postComment: async (_q, body) => {
				log.comments.push(body);
				return true;
			},
			notify: async (_q, title, _body, alert) => {
				log.notified.push({ title, alert });
			},
			deliver: async (_q, value) => {
				log.delivered.push(value);
			},
			context: async (q) => ({ question: q.question, options: q.options, why: "denser list", repo: "acme/app", issue: { number: 7, title: "Denser list", body: "", labels: [] }, comments: [], claudeMd: null }),
			proRefusal: async () => null,
			audit: async () => undefined,
			// The production model call, unchanged.
			model: defaultEffects(env).model,
		};
		const { question } = await captureAndAnnounceQuestion(
			env,
			{ instanceId: "coder", userId: "u1", sessionId: "s1", runId: "run-1", taskId: "csess-s1", question: "Which table layout?", options: ["compact", "comfortable"], why: "denser list" },
			effects as CoderQuestionEffects,
		);

		const r = await runDueCoderQuestions(env, question.askedAt + 31 * MIN, effects);

		expect(r.decided ?? 0).toBe(0);
		const row = await getCoderQuestion(env, question.id);
		expect(row?.state).toBe("escalated");
		expect(JSON.stringify(row?.history)).toMatch(/could not be reached.*Add an API key/);
		expect(log.notified).toContainEqual({ title: "⚠️ Coder still needs your answer", alert: true });
		expect(log.comments.at(-1)).toMatch(/The coder brain could not decide\*\* because the brain model could not be reached/);
		expect(log.delivered).toEqual([]);
		expect(platformAi).not.toHaveBeenCalled();
	});
});
