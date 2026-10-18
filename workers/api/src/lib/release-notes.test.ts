/**
 * #1216 — one release note per coder run that shipped to the trunk, to each granted channel.
 *
 * Over the real schema: the run's pushes are written by `recordEngineActs`, the path the workflow
 * drains acts through, and the Discord grants by `upsertConnectorGrant`. GitHub and the channel are
 * the only fakes. `notifyUser` is mocked so the alert can be asserted without web push.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { notifyUser } = vi.hoisted(() => ({ notifyUser: vi.fn() }));
vi.mock("../routes/push.js", async (orig) => ({ ...(await orig<typeof import("../routes/push.js")>()), notifyUser }));

import { upsertConnectorGrant } from "./connector-grants.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { recordEngineActs, type EngineActReport } from "./engine-acts.js";
import { buildReleaseNoteText, closedIssueNumbers, postReleaseNotes, RELEASE_NOTE_MAX_CHARS, type ReleaseChannel, type ReleaseNoteContext, type ReleaseNoteDeps, type ReleaseNoteInput } from "./release-notes.js";
import type { Env } from "../types.js";

const RUN = "run-1";
const RUN_STARTED = Date.parse("2026-10-19T10:00:00Z");

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, branch) VALUES ('repo-1', 'inst-1', 'u1', 'platform', 'acme/platform', 'main')");
	env = { DB: d1.DB } as unknown as Env;
	notifyUser.mockReset().mockResolvedValue(undefined);
});
afterEach(() => d1.close());

const act = (id: string, kind: string, command: string): EngineActReport => ({ id, kind, command, target: null, irreversible: true, ok: true, at: "2026-10-19T10:05:00Z", atReliable: true });

const pushes = (...acts: EngineActReport[]) => recordEngineActs(env, { userId: "u1", instanceId: "inst-1", sessionId: "sess-1", traceId: RUN }, acts);

const grant = (resourceId: string, resourceName: string) => upsertConnectorGrant(env, "inst-1", "u1", { provider: "discord", resourceId, resourceName, resourceType: "discord_channel" });

const input = (): ReleaseNoteInput => ({ env, userId: "u1", instanceId: "inst-1", runId: RUN, sessionId: "sess-1", repoId: "repo-1", repoLabel: "platform", runStartedAt: RUN_STARTED });

/** GitHub as it answers for a run that pushed two commits, the newer closing #12. */
const GITHUB: Record<string, unknown> = {
	"/repos/acme/platform/commits?sha=main&since=2026-10-19T10%3A00%3A00.000Z&per_page=50": [
		{ sha: "bbbbbbb2222222", commit: { message: "fix(tools): refuse unknown keys\n\ncloses #12" } },
		{ sha: "aaaaaaa1111111", commit: { message: "feat: add the thing" } },
	],
	"/repos/acme/platform/issues/12": { title: "Connector tools ignore unknown keys" },
	"/repos/acme/platform/actions/runs?head_sha=bbbbbbb2222222&per_page=30": { workflow_runs: [{ status: "in_progress", conclusion: null }] },
};

function deps(deliver: ReleaseNoteDeps["deliver"] = async () => ({ ok: true })): ReleaseNoteDeps & { posts: Array<{ channel: ReleaseChannel; text: string }>; githubCalls: string[] } {
	const posts: Array<{ channel: ReleaseChannel; text: string }> = [];
	const githubCalls: string[] = [];
	return {
		posts,
		githubCalls,
		now: () => Date.parse("2026-10-19T11:00:00Z"),
		githubGet: async (path) => {
			githubCalls.push(path);
			return GITHUB[path] ?? null;
		},
		deliver: async (channel, text) => {
			posts.push({ channel, text });
			return deliver(channel, text);
		},
	};
}

const events = (name: string) => d1.DB.prepare("SELECT message, context, level FROM agent_events WHERE event = ?1").bind(name).all<{ message: string; context: string; level: string }>().then((r) => r.results ?? []);

describe("one note per run, per granted channel (#1216 acceptance)", () => {
	it("a run that pushed to main three times posts ONE note to the channel, covering every commit, the closed issue by title, and pending CI", async () => {
		await pushes(act("a1", "push.trunk", "git push origin main"), act("a2", "push.trunk", "git push origin main"), act("a3", "push.trunk", "git push origin HEAD:main"));
		await grant("111111111111111111", "#releases");
		const d = deps();
		const outcome = await postReleaseNotes(input(), d);
		expect(outcome).toMatchObject({ status: "posted", failed: [] });
		expect(d.posts).toHaveLength(1);
		const text = d.posts[0].text;
		expect(text).toContain("acme/platform (main)");
		expect(text).toContain("aaaaaaa…bbbbbbb (2 commits)");
		expect(text).toContain("fix(tools): refuse unknown keys");
		expect(text).toContain("feat: add the thing");
		expect(text).toContain("#12 Connector tools ignore unknown keys");
		expect(text).toContain("pending for bbbbbbb — not yet verified");
		expect(text).not.toMatch(/\blive\b/i);
		expect(await events("release_note_sent")).toHaveLength(1);
	});

	it("two granted channels get one note each — the same note", async () => {
		await pushes(act("a1", "push.trunk", "git push origin main"));
		await grant("111111111111111111", "#releases");
		await grant("222222222222222222", "#team");
		const d = deps();
		expect((await postReleaseNotes(input(), d)).sent).toHaveLength(2);
		expect(d.posts.map((p) => p.channel.channelId).sort()).toEqual(["111111111111111111", "222222222222222222"]);
		expect(d.posts[0].text).toBe(d.posts[1].text);
	});

	it("a merged pull request counts as shipping to the trunk", async () => {
		await pushes(act("m1", "pr.merge", "gh pr merge 7 --squash"));
		await grant("111111111111111111", "#releases");
		const d = deps();
		expect((await postReleaseNotes(input(), d)).status).toBe("posted");
		expect(d.posts).toHaveLength(1);
	});

	it("a run that pushed only a branch, or dry-ran the push, posts nothing — and reads nothing from GitHub", async () => {
		await pushes(act("b1", "push", "git push origin feature/x"), act("b2", "push.trunk", "git push --dry-run origin main"));
		await grant("111111111111111111", "#releases");
		const d = deps();
		expect((await postReleaseNotes(input(), d)).status).toBe("not_shipped");
		expect(d.posts).toHaveLength(0);
		expect(d.githubCalls).toHaveLength(0);
	});
});

describe("the instance's release-notes setting decides who receives the note (#1217)", () => {
	const setInstance = (releaseNotes: unknown) => d1.exec(`UPDATE agent_instances SET config = '${JSON.stringify({ releaseNotes })}' WHERE id = 'inst-1'`);
	const setAccount = (releaseNotes: unknown) => d1.exec(`UPDATE users SET preferences = '${JSON.stringify({ releaseNotes })}' WHERE id = 'u1'`);

	it("turned off on the instance: nothing is posted, GitHub is not read, and the skip is recorded", async () => {
		await pushes(act("a1", "push.trunk", "git push origin main"));
		await grant("111111111111111111", "#releases");
		setInstance({ enabled: false });
		const d = deps();
		expect((await postReleaseNotes(input(), d)).status).toBe("disabled");
		expect(d.posts).toHaveLength(0);
		expect(d.githubCalls).toHaveLength(0);
		expect(await events("release_note_skipped_disabled")).toHaveLength(1);
	});

	it("turned off for the account: an instance with no setting of its own inherits it; one set on still posts", async () => {
		await pushes(act("a1", "push.trunk", "git push origin main"));
		await grant("111111111111111111", "#releases");
		setAccount({ enabled: false });
		expect((await postReleaseNotes(input(), deps())).status).toBe("disabled");
		setInstance({ enabled: true });
		const d = deps();
		expect((await postReleaseNotes(input(), d)).status).toBe("posted");
		expect(d.posts).toHaveLength(1);
	});

	it("chosen channels: only those receive it, out of everything granted", async () => {
		await pushes(act("a1", "push.trunk", "git push origin main"));
		const chosen = await grant("111111111111111111", "#releases");
		await grant("222222222222222222", "#team");
		setInstance({ channels: [chosen.id] });
		const d = deps();
		await postReleaseNotes(input(), d);
		expect(d.posts.map((p) => p.channel.grantId)).toEqual([chosen.id]);
	});

	it("a granted Slack channel receives it beside Discord, through the same delivery", async () => {
		await pushes(act("a1", "push.trunk", "git push origin main"));
		await grant("111111111111111111", "#releases");
		await upsertConnectorGrant(env, "inst-1", "u1", { provider: "slack", resourceId: "C0123456789", resourceName: "#eng", resourceType: "slack_channel" });
		const d = deps();
		await postReleaseNotes(input(), d);
		expect(d.posts.map((p) => p.channel.provider).sort()).toEqual(["discord", "slack"]);
	});
});

describe("no channel granted: no post, nothing breaks (#1216 acceptance)", () => {
	it("records the skip, sends nothing, and never asks GitHub", async () => {
		await pushes(act("a1", "push.trunk", "git push origin main"));
		const d = deps();
		const outcome = await postReleaseNotes(input(), d);
		expect(outcome).toEqual({ status: "no_channels", sent: [], failed: [] });
		expect(d.posts).toHaveLength(0);
		expect(d.githubCalls).toHaveLength(0);
		expect(await events("release_note_skipped_no_grants")).toHaveLength(1);
		expect(notifyUser).not.toHaveBeenCalled();
	});
});

describe("a failed delivery is logged and surfaced, never dropped (#1216 acceptance)", () => {
	it("one channel failing (or throwing) does not stop the next; each failure is in error_log and the trace, and the owner gets one alert", async () => {
		await pushes(act("a1", "push.trunk", "git push origin main"));
		await grant("111111111111111111", "#releases");
		await grant("222222222222222222", "#team");
		await grant("333333333333333333", "#ops");
		const d = deps(async (channel) => {
			if (channel.channelId === "111111111111111111") return { ok: false, error: "The bot lacks access or permission there." };
			if (channel.channelId === "222222222222222222") throw new Error("Discord could not be reached.");
			return { ok: true };
		});
		const outcome = await postReleaseNotes(input(), d);
		expect(d.posts).toHaveLength(3);
		expect(outcome.sent).toHaveLength(1);
		expect(outcome.failed.map((f) => f.error).sort()).toEqual(["Discord could not be reached.", "The bot lacks access or permission there."]);
		const errors = (await d1.DB.prepare("SELECT message FROM error_log WHERE source = 'release-notes'").all<{ message: string }>()).results ?? [];
		expect(errors).toHaveLength(2);
		expect(errors.some((e) => e.message.includes("#releases") && e.message.includes("lacks access"))).toBe(true);
		const failed = await events("release_note_failed");
		expect(failed).toHaveLength(2);
		expect(failed.every((e) => e.level === "error")).toBe(true);
		expect(notifyUser).toHaveBeenCalledTimes(1);
		expect(notifyUser).toHaveBeenCalledWith(env, "u1", "coding", "⚠️ Release note not delivered", expect.stringContaining("2 of 3 channel(s)"), expect.anything(), expect.objectContaining({ kind: "alert", key: `release-note-failed:${RUN}` }));
	});

	it("each delivery is its own step, so a journalled replay does not post twice", async () => {
		await pushes(act("a1", "push.trunk", "git push origin main"));
		await grant("111111111111111111", "#releases");
		const journal = new Map<string, unknown>();
		const runStep = async (name: string, fn: () => Promise<unknown>) => {
			if (!journal.has(name)) journal.set(name, await fn());
			return journal.get(name);
		};
		const d = deps();
		await postReleaseNotes(input(), d, runStep);
		await postReleaseNotes(input(), d, runStep);
		expect(d.posts).toHaveLength(1);
		expect([...journal.keys()]).toEqual(["release-notes-plan", expect.stringMatching(/^release-note:/)]);
	});
});

describe("the note's text", () => {
	const ctx = (over: Partial<ReleaseNoteContext> = {}): ReleaseNoteContext => ({
		instanceId: "inst-1",
		runId: RUN,
		repo: "acme/platform",
		defaultBranch: "main",
		commitRange: "aaaaaaa…bbbbbbb (2 commits)",
		changes: ["feat: one", "fix: two"],
		changesCapped: false,
		closedIssues: [],
		ciStatus: "pending",
		headSha: "bbbbbbb2222222",
		pushedAt: "2026-10-19T11:00:00.000Z",
		...over,
	});

	it("stays under Discord's limit however much shipped, saying how much was left out", () => {
		const text = buildReleaseNoteText(ctx({ changes: Array.from({ length: 50 }, (_, i) => `feat: change number ${i} ${"x".repeat(80)}`), closedIssues: Array.from({ length: 40 }, (_, i) => ({ number: i, title: "y".repeat(120) })), changesCapped: true }));
		expect(text.length).toBeLessThanOrEqual(RELEASE_NOTE_MAX_CHARS);
		expect(text).toMatch(/…and \d+ more/);
	});

	it("never claims a pass it did not read: success, failure and unknown each say what GitHub said", () => {
		expect(buildReleaseNoteText(ctx({ ciStatus: "success" }))).toContain("✅ every workflow run for bbbbbbb passed");
		expect(buildReleaseNoteText(ctx({ ciStatus: "failure" }))).toContain("❌ a workflow run for bbbbbbb failed");
		expect(buildReleaseNoteText(ctx({ ciStatus: "unknown", headSha: null, commitRange: null }))).toContain("CI/deploy: unknown — not verified");
	});

	it("has no markdown headings", () => {
		expect(buildReleaseNoteText(ctx())).not.toMatch(/^#/m);
	});

	it("reads the closing keywords GitHub honours, once each", () => {
		expect(closedIssueNumbers(["fix: x\n\ncloses #12", "Fixes #3 and resolves #12", "Refs #99"])).toEqual([12, 3]);
	});
});
