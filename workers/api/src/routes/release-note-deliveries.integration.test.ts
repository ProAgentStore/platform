/**
 * #1348 acceptance, through the real routes over the real schema (migration 0290 included), with the real
 * queue tick and the real Slack delivery. Only Slack and GitHub are faked, and every request to them is
 * recorded, so "it posted exactly once" and "it did not post again" are measured.
 *
 *   • A subscriber can answer "was SHA X announced to channel Y?" from the list alone.
 *   • A known failure is retryable once the cause is fixed; concurrent and repeated retries re-queue once.
 *   • A send whose outcome is unknown is never re-posted by a tick, and only the owner can settle it.
 *   • Another account can neither list nor change these rows.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { DUPLICATE_WARNING, RECONCILE_RETRY_CONFIRM, retryDelivery, UNCERTAIN_AFTER_MS } from "../lib/release-note-deliveries.js";
import { runReleaseNoteQueue } from "../lib/release-note-queue.js";
import type { Env } from "../types.js";

const who = vi.hoisted(() => ({ uid: "u1" }));
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: who.uid, roles: [] }) };
});
const { slackRoutes } = await import("./slack.js");
const { instanceReleaseNotesRoutes } = await import("./instances-release-notes.js");

const BOT = "xoxb-1348-workspace";
const CH_ENG = "C0ENG00001";
const CH_OUTSIDE = "C0OUT00003"; // the bot starts outside this channel
const SHA = "b".repeat(40);
const REQ = [
	{ path: ".github/workflows/ci.yml", role: "check" as const },
	{ path: ".github/workflows/deploy.yml", role: "production_deploy" as const, jobName: "deploy", stepName: "Upload to R2" },
];
const HOUR = 3_600_000;

let d1: RealSchemaD1;
let env: Env;
let posts: Array<{ channel: string; text: string }>;
let invited: boolean;
let githubMode: "ok" | "no_deploy" | "skipped_step" | "error";

const app = new Hono<{ Bindings: Env }>();
app.route("/v1/slack", slackRoutes);
app.route("/v1/instances", instanceReleaseNotesRoutes);
app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function slack(method: string, auth: string | null, form: URLSearchParams): Response {
	if (auth?.replace(/^Bearer /, "") !== BOT) return json({ ok: false, error: "invalid_auth" });
	if (method === "auth.test") return json({ ok: true, team: "Acme", team_id: "T1", user_id: "U0BOT" });
	if (method === "conversations.info") {
		const id = form.get("channel");
		return id === CH_ENG ? json({ ok: true, channel: { id: CH_ENG, name: "eng", is_member: true } }) : id === CH_OUTSIDE ? json({ ok: true, channel: { id: CH_OUTSIDE, name: "release-notes", is_member: invited } }) : json({ ok: false, error: "channel_not_found" });
	}
	if (method === "chat.postMessage") {
		const channel = form.get("channel") ?? "";
		if (channel === CH_OUTSIDE && !invited) return json({ ok: false, error: "not_in_channel" });
		posts.push({ channel, text: form.get("text") ?? "" });
		return json({ ok: true, ts: `1700000000.00${String(posts.length).padStart(4, "0")}` });
	}
	return json({ ok: false, error: "unknown_method" });
}

/** GitHub as the retry recheck reads it: the runs of SHA, and the deploy run's attempt-1 jobs. */
function github(url: URL): Response {
	if (githubMode === "error") return json({ message: "boom" }, 500);
	if (url.pathname.endsWith("/actions/runs")) {
		const runs = [{ id: 1, path: REQ[0].path, head_sha: SHA, head_branch: "main", status: "completed", conclusion: "success", run_attempt: 1 }];
		if (githubMode !== "no_deploy") runs.push({ id: 2, path: REQ[1].path, head_sha: SHA, head_branch: "main", status: "completed", conclusion: "success", run_attempt: 1 });
		return json({ workflow_runs: runs });
	}
	if (url.pathname.endsWith("/attempts/1/jobs")) return json({ total_count: 1, jobs: [jobFor(githubMode === "skipped_step" ? "skipped" : "success")] });
	return json({ message: "not found" }, 404);
}
const jobFor = (stepConclusion: string) => ({ id: 777, name: "deploy", status: "completed", conclusion: "success", run_id: 2, run_attempt: 1, head_sha: SHA, steps: [{ name: "Upload to R2", number: 4, status: "completed", conclusion: stepConclusion }] });
const tickDeps = { readRuns: async () => [{ id: 1, path: REQ[0].path, head_sha: SHA, head_branch: "main", status: "completed", conclusion: "success", run_attempt: 1 }, { id: 2, path: REQ[1].path, head_sha: SHA, head_branch: "main", status: "completed", conclusion: "success", run_attempt: 1 }], readJobsPage: async () => ({ total_count: 1, jobs: [jobFor("success")] as never[] }) };

beforeEach(async () => {
	who.uid = "u1";
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')");
	const agent = JSON.stringify({ capabilities: { surfaces: ["coding"], runtime: "coding" } });
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 'rn-1348', 'Release-notes coder', '${agent}'), ('ag2', 'u2', 'rn-1348-b', 'Other coder', '${agent}')`);
	d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('inst-a', 'ag', 'u1', 'active', '{}'), ('inst-x', 'ag2', 'u2', 'active', '{}')");
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: "a".repeat(64), SESSION_SIGNING_KEY: "s".repeat(64) } as unknown as Env;
	posts = [];
	invited = false;
	githubMode = "ok";
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		if (url.hostname === "slack.com") return slack(url.pathname.replace("/api/", ""), new Headers(init?.headers).get("Authorization"), new URLSearchParams(String(init?.body ?? "")));
		if (url.hostname === "api.github.com") return github(url);
		throw new Error(`unexpected fetch to ${url.hostname}`);
	});
	await call("/v1/slack/bot", { method: "PUT", body: { token: BOT } });
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
	const res = await app.request(path, { method: init.method ?? "GET", headers: { "Content-Type": "application/json" }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }, env);
	const text = await res.text();
	// biome-ignore lint/suspicious/noExplicitAny: responses are read by path in the assertions; the shapes are the routes' own contract
	return { status: res.status, body: JSON.parse(text) as Record<string, any>, text };
};
const list = (qs = "", instance = "inst-a") => call(`/v1/instances/${instance}/release-notes/deliveries${qs}`);
const retry = (id: string, body: unknown = {}, instance = "inst-a") => call(`/v1/instances/${instance}/release-notes/deliveries/${id}/retry`, { method: "POST", body });
const reconcile = (id: string, body: unknown, instance = "inst-a") => call(`/v1/instances/${instance}/release-notes/deliveries/${id}/reconcile`, { method: "POST", body });

/** A granted Slack channel on inst-a, with the gate configured and selecting it. */
async function setup(channel = CH_OUTSIDE, gate: unknown[] = REQ) {
	const grant = (await call("/v1/slack/instances/inst-a/grants", { method: "POST", body: { channelId: channel } })).body.grant as { id: string };
	await d1.DB.prepare("UPDATE agent_instances SET config=?1 WHERE id='inst-a'").bind(JSON.stringify({ releaseNotes: { enabled: true, channels: [grant.id], requiredWorkflows: gate } })).run();
	return grant.id;
}

async function seed(id: string, grantId: string, over: { status?: string; createdAt?: number; updatedAt?: number; sha?: string; user?: string; instance?: string; reason?: string; permalink?: string; workflows?: unknown[] } = {}) {
	const created = over.createdAt ?? Date.now() - HOUR;
	const ctx = { instanceId: over.instance ?? "inst-a", runId: "run-1", repo: "acme/app", defaultBranch: "main", commitRange: "aaaaaaa…bbbbbbb", changes: ["fix: delivered"], changesCapped: false, closedIssues: [], ciStatus: "pending", headSha: over.sha ?? SHA, pushedAt: new Date().toISOString() };
	await d1.DB.prepare(`INSERT INTO release_note_queue (id,user_id,instance_id,repo_id,github_repo,default_branch,run_id,session_id,sha,grant_id,context_json,workflows_json,status,reason,permalink,created_at,updated_at) VALUES (?1,?2,?3,'repo-1','acme/app','main','run-1','sess-1',?4,?5,?6,?7,?8,?9,?10,?11,?12)`)
		.bind(id, over.user ?? "u1", over.instance ?? "inst-a", over.sha ?? SHA, grantId, JSON.stringify(ctx), JSON.stringify(over.workflows ?? REQ), over.status ?? "pending", over.reason ?? null, over.permalink ?? null, created, over.updatedAt ?? created).run();
}
const row = (id: string) => d1.DB.prepare("SELECT status, reason, permalink, updated_at FROM release_note_queue WHERE id=?1").bind(id).first<{ status: string; reason: string | null; permalink: string | null; updated_at: number }>();
const attempts = (id: string) => d1.DB.prepare("SELECT kind, outcome, reason, permalink FROM release_note_attempts WHERE queue_id=?1 ORDER BY created_at, rowid").bind(id).all<{ kind: string; outcome: string; reason: string | null; permalink: string | null }>().then((r) => r.results ?? []);
const tick = (deps: Parameters<typeof runReleaseNoteQueue>[1] = tickDeps) => runReleaseNoteQueue(env, deps);

/** A claimed send that never reported back: the Slack write happened, the process died. */
async function crashedSend(id: string, grantId: string, ageMs: number) {
	await seed(id, grantId);
	await tick({ ...tickDeps, deliver: () => async (channel) => { posts.push({ channel: channel.channelId, text: "accepted by Slack" }); throw new Error("worker died after Slack accepted"); } });
	await d1.DB.prepare("UPDATE release_note_queue SET updated_at=?1 WHERE id=?2").bind(Date.now() - ageMs, id).run();
}

describe("the owner can answer 'was SHA X announced to channel Y?' (#1348)", () => {
	it("lists the state, evidence and permalink of a sent note, with the attempt history, and leaks no credential or channel id", async () => {
		const grantId = await setup(CH_ENG);
		await seed("q1", grantId);
		await tick();
		const page = await list();
		expect(page.status).toBe(200);
		const d = page.body.deliveries[0];
		expect(d).toMatchObject({ id: "q1", repo: "acme/app", sha: SHA, status: "sent", state: "sent", destination: { provider: "slack", name: "#eng" }, actions: { retry: false, reconcile: false } });
		expect(d.permalink).toBe(`https://app.slack.com/archives/${CH_ENG}/p1700000000000001`);
		expect(d.links).toMatchObject({ permalink: d.permalink, deployJob: "https://github.com/acme/app/actions/runs/2/job/777" });
		expect(d.links.codingRun).toContain("inst-a");
		expect(d.evidence.workflowRuns).toEqual(["https://github.com/acme/app/actions/runs/1", "https://github.com/acme/app/actions/runs/2"]);
		expect(d.attempts.map((a: { kind: string; outcome: string }) => `${a.kind}:${a.outcome}`)).toEqual(["send:claimed", "send:sent"]);
		expect(page.text).not.toContain(BOT);
		// The provider channel id is not a field of its own; it appears only inside the message link Slack issued.
		expect(page.text.replaceAll(d.permalink, "")).not.toContain(CH_ENG);
		expect(page.text).not.toContain("channelId");
		const events = await d1.DB.prepare("SELECT context FROM agent_events WHERE event='release_note_sent'").all<{ context: string }>();
		expect(JSON.parse(events.results?.[0]?.context ?? "{}")).toMatchObject({ queueId: "q1", attemptId: expect.any(String) });
	});

	it.each([
		["pending", "waiting_for_checks"],
		["configuration_required", "configuration_required"],
		["cancelled", "configuration_changed"],
		["failed", "delivery_failed"],
		["expired", "expired"],
		["abandoned", "abandoned"],
	])("a %s row is reported as %s, distinct from delivery failure", async (status, state) => {
		const grantId = await setup(CH_ENG);
		await seed("q1", grantId, { status, reason: "why" });
		expect((await list()).body.deliveries[0]).toMatchObject({ status, state, reason: "why" });
	});

	it("a send claimed minutes ago is 'sending'; one never confirmed is 'outcome_uncertain'", async () => {
		const grantId = await setup(CH_ENG);
		await seed("young", grantId, { status: "sending", updatedAt: Date.now() - 60_000, sha: "c".repeat(40) });
		await seed("old", grantId, { status: "sending", updatedAt: Date.now() - UNCERTAIN_AFTER_MS - 1000, sha: "d".repeat(40) });
		const byId = Object.fromEntries((await list()).body.deliveries.map((d: { id: string }) => [d.id, d]));
		expect(byId.young).toMatchObject({ state: "sending", actions: { retry: false, reconcile: false } });
		expect(byId.old).toMatchObject({ state: "outcome_uncertain", actions: { retry: false, reconcile: true } });
	});
});

describe("the list is paged by a stable cursor, over the retention window", () => {
	it("walks newest first without repeats while newer notes arrive, refuses a forged cursor, and omits rows past 90 days", async () => {
		const grantId = await setup(CH_ENG);
		const base = Date.now() - 10 * HOUR;
		for (let i = 0; i < 7; i++) await seed(`q${i}`, grantId, { status: "sent", createdAt: base + i * 1000, sha: String(i).repeat(40) });
		await seed("ancient", grantId, { status: "sent", createdAt: Date.now() - 91 * 24 * HOUR, sha: "e".repeat(40) });
		const first = await list("?limit=3");
		expect(first.body.deliveries.map((d: { id: string }) => d.id)).toEqual(["q6", "q5", "q4"]);
		expect(first.body.hasMore).toBe(true);
		await seed("newer", grantId, { status: "sent", createdAt: Date.now() - 1000, sha: "f".repeat(40) }); // arrives mid-walk
		const second = await list(`?limit=3&cursor=${first.body.nextCursor}`);
		expect(second.body.deliveries.map((d: { id: string }) => d.id)).toEqual(["q3", "q2", "q1"]);
		const third = await list(`?limit=3&cursor=${second.body.nextCursor}`);
		expect(third.body.deliveries.map((d: { id: string }) => d.id)).toEqual(["q0"]);
		expect(third.body.hasMore).toBe(false);
		expect(third.body.retention.days).toBe(90);
		expect((await list("?limit=50")).body.deliveries.map((d: { id: string }) => d.id)).toEqual(["newer", "q6", "q5", "q4", "q3", "q2", "q1", "q0"]);
		expect((await list("?cursor=not-a-cursor")).status).toBe(400);
		expect((await list("?limit=lots")).status).toBe(400);
		expect((await list("?limit=500")).body.deliveries).toHaveLength(8); // clamped to the page maximum, not an error
	});
});

describe("another account sees and changes nothing", () => {
	it("cannot list this instance, cannot act on its rows, and its own instance does not expose them", async () => {
		const grantId = await setup(CH_ENG);
		await seed("mine-failed", grantId, { status: "failed", reason: "boom" });
		await seed("mine-stuck", grantId, { status: "sending", updatedAt: Date.now() - HOUR, sha: "c".repeat(40) });
		who.uid = "u2";
		expect((await list("", "inst-a")).status).toBe(404);
		expect((await retry("mine-failed", {}, "inst-a")).status).toBe(404);
		expect((await reconcile("mine-stuck", { action: "abandon" }, "inst-a")).status).toBe(404);
		// Through its OWN instance, a foreign row id is simply not there.
		expect((await list("", "inst-x")).body.deliveries).toEqual([]);
		expect((await retry("mine-failed", {}, "inst-x")).status).toBe(404);
		expect((await reconcile("mine-stuck", { action: "abandon" }, "inst-x")).status).toBe(404);
		who.uid = "u1";
		expect(await row("mine-failed")).toMatchObject({ status: "failed" });
		expect(await row("mine-stuck")).toMatchObject({ status: "sending" });
		expect(await attempts("mine-failed")).toEqual([]);
	});
});

describe("retrying a known failure (#1348)", () => {
	it("a bot-not-in-channel failure is retried after the bot is invited, and posts once", async () => {
		const grantId = await setup();
		await seed("q1", grantId);
		await tick();
		expect(posts).toHaveLength(0);
		const failed = (await list()).body.deliveries[0];
		expect(failed).toMatchObject({ state: "delivery_failed", actions: { retry: true, reconcile: false } });
		expect(failed.reason).toMatch(/not in that channel|not_in_channel|invite/i);
		invited = true;
		const res = await retry("q1", { idempotencyKey: "retry-key-0001" });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ replayed: false, delivery: { status: "pending", state: "waiting_for_checks" } });
		await tick();
		await tick();
		expect(posts).toHaveLength(1);
		expect(await row("q1")).toMatchObject({ status: "sent" });
		expect((await attempts("q1")).map((a) => `${a.kind}:${a.outcome}`)).toEqual(["send:claimed", "send:failed", "retry:requeued", "send:claimed", "send:sent"]);
	});

	it("concurrent retries re-queue once, and a repeated key changes nothing", async () => {
		const grantId = await setup();
		await seed("q1", grantId, { status: "failed", reason: "not_in_channel" });
		invited = true;
		const [a, b] = await Promise.all([retry("q1", { idempotencyKey: "same-key-0001" }), retry("q1", { idempotencyKey: "other-key-0002" })]);
		expect([a.status, b.status].sort()).toEqual([200, 409]);
		expect(await row("q1")).toMatchObject({ status: "pending" });
		expect((await attempts("q1")).filter((x) => x.kind === "retry")).toHaveLength(1);
		const key = a.status === 200 ? "same-key-0001" : "other-key-0002";
		const again = await retry("q1", { idempotencyKey: key });
		expect(again.status).toBe(200);
		expect(again.body.replayed).toBe(true);
		expect((await attempts("q1")).filter((x) => x.kind === "retry")).toHaveLength(1);
		await tick();
		await tick();
		expect(posts).toHaveLength(1);
	});

	it.each([
		["sent", /Already delivered/],
		["pending", /still waiting for its checks/],
		["cancelled", /cancelled because the setting or channel grant changed/],
		["expired", /expired after the 48-hour/],
		["abandoned", /abandoned/],
		["configuration_required", /held until the release gate/],
	])("refuses a %s row with its own reason, changing nothing", async (status, reason) => {
		const grantId = await setup(CH_ENG);
		await seed("q1", grantId, { status });
		const res = await retry("q1");
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(reason);
		expect(await row("q1")).toMatchObject({ status });
		expect(await attempts("q1")).toEqual([]);
	});

	it("refuses an uncertain send and points at reconcile; Retry never touches it", async () => {
		const grantId = await setup(CH_ENG);
		await seed("q1", grantId, { status: "sending", updatedAt: Date.now() - HOUR });
		const res = await retry("q1");
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/uncertain.*Reconcile/);
		expect(await row("q1")).toMatchObject({ status: "sending" });
	});

	describe("is blocked, with the specific reason, when", () => {
		const blocked = async (setupFn: () => Promise<void>, status: number, reason: RegExp) => {
			const res = await retry("q1");
			expect(res.status, JSON.stringify(res.body)).toBe(status);
			expect(res.body.error).toMatch(reason);
			expect(await row("q1")).toMatchObject({ status: "failed" });
			expect(await attempts("q1")).toEqual([]);
			void setupFn;
		};
		it("the channel grant was revoked", async () => {
			const grantId = await setup(CH_ENG);
			await seed("q1", grantId, { status: "failed", reason: "x" });
			await call(`/v1/slack/instances/inst-a/grants/${grantId}`, { method: "DELETE" });
			await blocked(async () => undefined, 409, /grant was revoked or is no longer selected/);
		});
		it("the channel is no longer selected for release notes", async () => {
			const grantId = await setup(CH_ENG);
			await seed("q1", grantId, { status: "failed", reason: "x" });
			await d1.DB.prepare("UPDATE agent_instances SET config=?1 WHERE id='inst-a'").bind(JSON.stringify({ releaseNotes: { enabled: true, channels: [], requiredWorkflows: REQ } })).run();
			await blocked(async () => undefined, 409, /grant was revoked or is no longer selected/);
		});
		it("release notes were turned off", async () => {
			const grantId = await setup(CH_ENG);
			await seed("q1", grantId, { status: "failed", reason: "x" });
			await d1.DB.prepare("UPDATE agent_instances SET config=?1 WHERE id='inst-a'").bind(JSON.stringify({ releaseNotes: { enabled: false, channels: [grantId], requiredWorkflows: REQ } })).run();
			await blocked(async () => undefined, 409, /turned off/);
		});
		it("the workflow configuration changed since the note was queued", async () => {
			const grantId = await setup(CH_ENG);
			await seed("q1", grantId, { status: "failed", reason: "x" });
			await d1.DB.prepare("UPDATE agent_instances SET config=?1 WHERE id='inst-a'").bind(JSON.stringify({ releaseNotes: { enabled: true, channels: [grantId], requiredWorkflows: [REQ[0], { ...REQ[1], stepName: "Upload to S3" }] } })).run();
			await blocked(async () => undefined, 409, /gate changed since this note was queued/);
		});
		it("the gate is now an old one without the deploy job and step", async () => {
			const grantId = await setup(CH_ENG, REQ.map(({ path, role }) => ({ path, role })));
			await seed("q1", grantId, { status: "failed", reason: "x" });
			await blocked(async () => undefined, 409, /missing or incomplete/);
		});
		it("the required workflows are not all green for that SHA", async () => {
			const grantId = await setup(CH_ENG);
			await seed("q1", grantId, { status: "failed", reason: "x" });
			githubMode = "no_deploy";
			await blocked(async () => undefined, 409, /have not all succeeded on b+ and main/);
		});
		it("the deploy step did not succeed", async () => {
			const grantId = await setup(CH_ENG);
			await seed("q1", grantId, { status: "failed", reason: "x" });
			githubMode = "skipped_step";
			await blocked(async () => undefined, 409, /Production deploy not proven: Step "Upload to R2".*skipped/);
		});
		it("GitHub cannot be read right now (retryable, not a refusal of the note)", async () => {
			const grantId = await setup(CH_ENG);
			await seed("q1", grantId, { status: "failed", reason: "x" });
			githubMode = "error";
			await blocked(async () => undefined, 503, /could not be read just now/);
		});
		it("the note is past the 48-hour window the queue would expire it in", async () => {
			const grantId = await setup(CH_ENG);
			await seed("q1", grantId, { status: "failed", reason: "x", createdAt: Date.now() - 49 * HOUR });
			await blocked(async () => undefined, 409, /older than the 48-hour evidence window/);
		});
		it("the provider bot is not connected", async () => {
			const grantId = await setup(CH_ENG);
			await seed("q1", grantId, { status: "failed", reason: "x" });
			await expect(retryDelivery(env, "u1", "inst-a", "q1", {}, { botConnected: async () => false, readRuns: tickDeps.readRuns, readJobsPage: tickDeps.readJobsPage })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("slack bot is not connected") });
			expect(await row("q1")).toMatchObject({ status: "failed" });
		});
	});

	it("an unknown body field is refused, never dropped", async () => {
		const grantId = await setup(CH_ENG);
		await seed("q1", grantId, { status: "failed", reason: "x" });
		const res = await retry("q1", { force: true });
		expect(res.status).toBe(400);
		expect(res.body.error).toMatch(/Unknown field `force`/);
		expect(await row("q1")).toMatchObject({ status: "failed" });
	});
});

describe("a send whose outcome is unknown (#1348)", () => {
	it("a crash after Slack accepts leaves an uncertain row, and no later tick posts it again", async () => {
		const grantId = await setup(CH_ENG);
		await crashedSend("q1", grantId, UNCERTAIN_AFTER_MS + 5000);
		expect(posts).toHaveLength(1);
		expect(await row("q1")).toMatchObject({ status: "sending" });
		await tick();
		await tick();
		expect(posts).toHaveLength(1);
		expect((await list()).body.deliveries[0]).toMatchObject({ state: "outcome_uncertain", actions: { retry: false, reconcile: true } });
	});

	it("reconciling with the observed permalink marks it sent without a second post, and a sent note can never be retried", async () => {
		const grantId = await setup(CH_ENG);
		await crashedSend("q1", grantId, UNCERTAIN_AFTER_MS + 5000);
		const seen = `https://acme.slack.com/archives/${CH_ENG}/p1700000000000001`;
		const res = await reconcile("q1", { action: "mark_delivered", permalink: seen });
		expect(res.status).toBe(200);
		expect(res.body.delivery).toMatchObject({ status: "sent", state: "sent", permalink: seen });
		await tick();
		expect(posts).toHaveLength(1);
		expect((await attempts("q1")).map((a) => `${a.kind}:${a.outcome}`)).toEqual(["send:claimed", "reconcile_delivered:sent"]);
		expect((await retry("q1")).status).toBe(409);
		expect((await reconcile("q1", { action: "abandon" })).status).toBe(409);
	});

	it("refuses a permalink for another channel, an empty one, and a non-link", async () => {
		const grantId = await setup(CH_ENG);
		await crashedSend("q1", grantId, UNCERTAIN_AFTER_MS + 5000);
		for (const permalink of [`https://acme.slack.com/archives/C0OTHER999/p1700000000000001`, "", "https://evil.example/archives/" + CH_ENG + "/p1700000000000001", "yesterday"]) {
			expect((await reconcile("q1", { action: "mark_delivered", permalink })).status, permalink).toBe(400);
		}
		expect((await reconcile("q1", { action: "mark_delivered" })).status).toBe(400);
		expect(await row("q1")).toMatchObject({ status: "sending" });
	});

	it("abandoning is its own status, not 'cancelled', and is audited", async () => {
		const grantId = await setup(CH_ENG);
		await crashedSend("q1", grantId, UNCERTAIN_AFTER_MS + 5000);
		const res = await reconcile("q1", { action: "abandon" });
		expect(res.body.delivery).toMatchObject({ status: "abandoned", state: "abandoned" });
		expect((await attempts("q1")).at(-1)).toMatchObject({ kind: "reconcile_abandoned", outcome: "abandoned" });
		await tick();
		expect(posts).toHaveLength(1);
	});

	it("an attested retry needs the warning's confirmation, then releases the row for exactly one more send", async () => {
		const grantId = await setup(CH_ENG);
		await crashedSend("q1", grantId, UNCERTAIN_AFTER_MS + 5000);
		const bare = await reconcile("q1", { action: "retry_after_channel_check" });
		expect(bare.status).toBe(409);
		expect(bare.body.error).toContain("Duplicate risk");
		expect((await reconcile("q1", { action: "retry_after_channel_check", channelChecked: true, confirm: "yes" })).status).toBe(409);
		expect((await reconcile("q1", { action: "retry_after_channel_check", confirm: RECONCILE_RETRY_CONFIRM })).status).toBe(409);
		expect(await row("q1")).toMatchObject({ status: "sending" });
		expect(posts).toHaveLength(1);

		const ok = await reconcile("q1", { action: "retry_after_channel_check", channelChecked: true, confirm: RECONCILE_RETRY_CONFIRM, idempotencyKey: "reconcile-key-0001" });
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ replayed: false, warning: DUPLICATE_WARNING, delivery: { status: "pending" } });
		const repeat = await reconcile("q1", { action: "retry_after_channel_check", channelChecked: true, confirm: RECONCILE_RETRY_CONFIRM, idempotencyKey: "reconcile-key-0001" });
		expect(repeat.body.replayed).toBe(true);
		await tick();
		await tick();
		expect(posts).toHaveLength(2); // the original (uncertain) one, plus exactly one resend
		expect((await attempts("q1")).map((a) => `${a.kind}:${a.outcome}`)).toEqual(["send:claimed", "reconcile_retry:requeued", "send:claimed", "send:sent"]);
		expect((await reconcile("q1", { action: "abandon" })).status).toBe(409);
	});

	it("refuses to reconcile a send still in flight, a failed row, and a bad action", async () => {
		const grantId = await setup(CH_ENG);
		await seed("young", grantId, { status: "sending", updatedAt: Date.now() - 30_000 });
		await seed("failed", grantId, { status: "failed", sha: "c".repeat(40) });
		expect((await reconcile("young", { action: "abandon" })).body.error).toMatch(/may still be in flight/);
		expect((await reconcile("failed", { action: "abandon" })).body.error).toMatch(/use Retry/);
		expect((await reconcile("young", { action: "delete" })).status).toBe(400);
		expect((await reconcile("young", { action: "abandon", extra: 1 })).status).toBe(400);
		expect(await row("young")).toMatchObject({ status: "sending" });
	});

	it("a retry through reconcile is blocked by the same checks as Retry", async () => {
		const grantId = await setup(CH_ENG);
		await crashedSend("q1", grantId, UNCERTAIN_AFTER_MS + 5000);
		await call(`/v1/slack/instances/inst-a/grants/${grantId}`, { method: "DELETE" });
		const res = await reconcile("q1", { action: "retry_after_channel_check", channelChecked: true, confirm: RECONCILE_RETRY_CONFIRM });
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/grant was revoked/);
		expect(await row("q1")).toMatchObject({ status: "sending" });
	});
});

describe("the receipt trail is append-only", () => {
	it("refuses an UPDATE or DELETE of any attempt", async () => {
		const grantId = await setup(CH_ENG);
		await seed("q1", grantId);
		await tick();
		await expect(d1.DB.prepare("UPDATE release_note_attempts SET outcome='x'").run()).rejects.toThrow(/append-only/);
		await expect(d1.DB.prepare("DELETE FROM release_note_attempts").run()).rejects.toThrow(/append-only/);
		expect((await attempts("q1")).length).toBe(2);
	});
});
