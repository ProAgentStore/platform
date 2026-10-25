/** #1325 — a signed `workflow_run` completion resumes the run parked on that commit's CI, over the real schema. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { resumeRunsOnCiCompletion, runsWaitingOnCommit, verifyGithubSignature } from "./ci-resume.js";
import { getCoderQuestion, storedAnswer } from "./coder-question-store.js";
import { answerEventType } from "./coding-park.js";
import { githubRoutes } from "../routes/github.js";
import type { Env } from "../types.js";

const SHA = "b5719be8c0ffee0123456789abcdef0123456789";
const DAY = 86_400_000;
let d1: RealSchemaD1;
let env: Env;
let sent: Array<{ instance: string; type: string }>;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'i1', 'u1', 'repo', 'Acme/Repo')`);
	const at = Date.now() - DAY;
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, last_activity_at, updated_at) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'claude', ${at}, datetime('now'))`);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, last_alive_at, waiting_reason, parked_since, workflow_instance_id)
	  VALUES ('run-1', 'u1', 'i1', 'x', 'running', 10, ${at}, 's1', ${at}, 'decision', ${at}, 'wf-1')`);
	d1.exec(`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, task_id, question, state, asked_at, expires_at)
	  VALUES ('q1', 'i1', 'u1', 's1', 'run-1', 'csess-s1', 'Wait silently until monitor task ends, then run gh run list --commit b5719be8', 'waiting_human', ${at}, ${at + 900_000})`);
	sent = [];
	env = { DB: d1.DB, CODING_SESSION: { get: async (instance: string) => ({ sendEvent: async (e: { type: string }) => void sent.push({ instance, type: e.type }) }) } } as unknown as Env;
});
afterEach(() => {
	d1.close();
	vi.unstubAllGlobals();
});

const payload = (over: Record<string, unknown> = {}) => ({ action: "completed", workflow_run: { head_sha: SHA, status: "completed", conclusion: "success", name: "CI" }, repository: { full_name: "acme/repo" }, ...over });

function githubReturns(runs: Array<Record<string, unknown>>, jobs: Array<Record<string, unknown>> = []) {
	vi.stubGlobal("fetch", async (url: string) => {
		const body = String(url).includes("/jobs") ? { jobs } : { workflow_runs: runs };
		return new Response(JSON.stringify(body), { status: 200 });
	});
}

async function sign(body: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
	return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("verifyGithubSignature", () => {
	it("accepts the right HMAC and refuses anything else", async () => {
		const sig = await sign("{}", "s3cret");
		expect(await verifyGithubSignature("{}", sig, "s3cret")).toBe(true);
		expect(await verifyGithubSignature("{ }", sig, "s3cret")).toBe(false);
		expect(await verifyGithubSignature("{}", sig, "other")).toBe(false);
		expect(await verifyGithubSignature("{}", null, "s3cret")).toBe(false);
		expect(await verifyGithubSignature("{}", "sha256=zz", "s3cret")).toBe(false);
	});
});

describe("runsWaitingOnCommit", () => {
	it("finds the parked run whose question names the commit, case-insensitively on the repo", async () => {
		expect((await runsWaitingOnCommit(env, "ACME/repo", SHA)).map((r) => r.runId)).toEqual(["run-1"]);
		expect(await runsWaitingOnCommit(env, "acme/repo", "1234567".padEnd(40, "0"))).toEqual([]);
		expect(await runsWaitingOnCommit(env, "acme/other", SHA)).toEqual([]);
	});
});

describe("resumeRunsOnCiCompletion", () => {
	it("answers the question with the CI result and wakes the run", async () => {
		githubReturns([{ id: 1, name: "CI", status: "completed", conclusion: "success", html_url: "https://gh/1" }, { id: 2, name: "Deploy", status: "completed", conclusion: "success" }]);
		expect(await resumeRunsOnCiCompletion(env, payload())).toEqual({ resumed: ["run-1"] });
		expect(sent).toEqual([{ instance: "wf-1", type: answerEventType("q1") }]);
		const answer = await storedAnswer(env, "q1");
		expect(answer?.value).toMatch(/CI PASSED for acme\/repo@b5719be8/);
		expect(answer?.value).toContain("Deploy: success");
	});

	it("names the failed job and step when CI failed", async () => {
		githubReturns([{ id: 1, name: "CI", status: "completed", conclusion: "failure" }], [{ id: 9, name: "test", status: "completed", conclusion: "failure", html_url: "https://gh/job", steps: [{ number: 1, name: "vitest", status: "completed", conclusion: "failure" }] }]);
		await resumeRunsOnCiCompletion(env, payload({ workflow_run: { head_sha: SHA, conclusion: "failure" } }));
		const value = (await storedAnswer(env, "q1"))?.value ?? "";
		expect(value).toContain("CI FAILED");
		expect(value).toContain('CI / test: failure, failed at step "vitest"');
	});

	it("waits for the last workflow of the commit: nothing is answered while another is still running", async () => {
		githubReturns([{ id: 1, name: "CI", status: "completed", conclusion: "success" }, { id: 2, name: "Publish", status: "in_progress", conclusion: null }]);
		expect(await resumeRunsOnCiCompletion(env, payload())).toEqual({ pending: 1 });
		expect(sent).toEqual([]);
		expect((await getCoderQuestion(env, "q1"))?.answeredAt).toBeNull();
	});

	it("a duplicate delivery wakes nothing more", async () => {
		githubReturns([{ id: 1, name: "CI", status: "completed", conclusion: "success" }]);
		await resumeRunsOnCiCompletion(env, payload());
		expect(await resumeRunsOnCiCompletion(env, payload())).toEqual({ ignored: "no parked run is waiting on this commit" });
		expect(sent).toHaveLength(1);
	});

	it("ignores events that are not a completed workflow_run for a commit, or a commit nobody waits on", async () => {
		expect(await resumeRunsOnCiCompletion(env, payload({ action: "requested" }))).toHaveProperty("ignored");
		expect(await resumeRunsOnCiCompletion(env, payload({ workflow_run: { head_sha: "abc" } }))).toHaveProperty("ignored");
		expect(await resumeRunsOnCiCompletion(env, payload({ workflow_run: { head_sha: "f".repeat(40) } }))).toHaveProperty("ignored");
		expect(sent).toEqual([]);
	});

	it("falls back to the delivery's own run when GitHub cannot be read", async () => {
		vi.stubGlobal("fetch", async () => new Response("down", { status: 502 }));
		expect(await resumeRunsOnCiCompletion(env, payload())).toEqual({ resumed: ["run-1"] });
	});
});

describe("POST /webhook", () => {
	const call = async (body: string, headers: Record<string, string>, e: Partial<Env> = { GITHUB_WEBHOOK_SECRET: "s3cret" }) =>
		githubRoutes.request("/webhook", { method: "POST", body, headers }, { ...env, ...e } as Env);

	it("is off without a secret, and refuses a bad signature", async () => {
		expect((await call("{}", {}, {})).status).toBe(503);
		expect((await call("{}", { "x-hub-signature-256": "sha256=" + "0".repeat(64) })).status).toBe(401);
		expect(sent).toEqual([]);
	});

	it("resumes the run on a signed workflow_run delivery and acknowledges other events", async () => {
		githubReturns([{ id: 1, name: "CI", status: "completed", conclusion: "success" }]);
		const body = JSON.stringify(payload());
		const headers = { "x-hub-signature-256": await sign(body, "s3cret"), "x-github-event": "workflow_run" };
		const res = await call(body, headers);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ received: true, resumed: ["run-1"] });
		const ping = await call("{}", { "x-hub-signature-256": await sign("{}", "s3cret"), "x-github-event": "ping" });
		expect(await ping.json()).toEqual({ received: true });
	});
});
