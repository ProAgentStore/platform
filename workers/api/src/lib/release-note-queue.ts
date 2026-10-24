/** Durable, fail-closed delivery for coder release notes with an exact-SHA workflow gate. */
import { resolveGithubRead } from "./github-cache.js";
import { clipMarked } from "./clip-marked.js";
import { logEvent } from "./events.js";
import { logError } from "./error-log.js";
import { loadReleaseNotes } from "./release-notes-settings.js";
import { liveDeliver, type Deliver, type ReleaseNoteContext } from "./release-notes.js";
import { safeFetch } from "./ssrf.js";
import { deepLinkFor } from "./console-links.js";
import { notifyUser } from "../routes/push.js";
import type { InstanceReleaseNotes } from "../agent-types.js";
import type { Env } from "../types.js";

type RequiredWorkflows = NonNullable<InstanceReleaseNotes["requiredWorkflows"]>;
type Run = { id?: number; path?: string; name?: string; head_sha?: string; head_branch?: string; status?: string; conclusion?: string | null; updated_at?: string; run_attempt?: number; html_url?: string };
type Row = { id: string; user_id: string; instance_id: string; session_id: string; github_repo: string; default_branch: string; run_id: string; sha: string; grant_id: string; context_json: string; workflows_json: string; created_at: number };
export interface ReleaseQueueDeps { readRuns?: (row: Row) => Promise<Run[]>; deliver?: (env: Env, userId: string) => Deliver }

const normalPath = (path: string) => path.split("@")[0].replace(/^.*?(?=\.github\/workflows\/)/, "");

/** Null means keep waiting. A failed or missing required run can be rerun on the same SHA. */
export function completedReleaseEvidence(runs: Run[], sha: string, branch: string, required: RequiredWorkflows): Run[] | null {
	const evidence: Run[] = [];
	for (const item of required) {
		const matches = runs.filter((run) => run.head_sha === sha && run.head_branch === branch && normalPath(run.path ?? "") === item.path);
		matches.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) || (b.id ?? 0) - (a.id ?? 0) || (b.run_attempt ?? 0) - (a.run_attempt ?? 0));
		const latest = matches[0];
		if (latest?.status !== "completed" || latest.conclusion !== "success" || !Number.isSafeInteger(latest.id) || (latest.id ?? 0) <= 0) return null;
		evidence.push(latest);
	}
	return evidence;
}

export function verifiedReleaseText(ctx: ReleaseNoteContext, required: RequiredWorkflows, runs: Run[]): string {
	const lines = [`🚀 Production release: ${ctx.repo}`, `Commit: ${ctx.headSha}`, `Environment: production`, `Run: ${ctx.runId}`, "", "Checks for this commit:"];
	for (const [index, item] of required.entries()) lines.push(`• ${item.role === "production_deploy" ? "Production deploy" : "Check"}: ${item.path} — https://github.com/${ctx.repo}/actions/runs/${runs[index].id}`);
	if (ctx.changes.length) {
		lines.push("", "What changed:", ...ctx.changes.filter((_x, index) => index < 8).map((x) => `• ${clipMarked(x, 160, { within: true })}`));
		if (ctx.changes.length > 8) lines.push(`…and ${ctx.changes.length - 8} more changes`);
	}
	if (ctx.closedIssues.length) {
		lines.push("", "Issues:", ...ctx.closedIssues.filter((_x, index) => index < 8).map((x) => `• #${x.number} ${clipMarked(x.title ?? "", 160, { within: true })}`));
		if (ctx.closedIssues.length > 8) lines.push(`…and ${ctx.closedIssues.length - 8} more issues`);
	}
	const text = lines.join("\n");
	return clipMarked(text, 1800, { within: true });
}

const setStatus = (env: Env, id: string, status: string, reason: string | null = null, permalink: string | null = null) => env.DB.prepare("UPDATE release_note_queue SET status=?1, reason=?2, permalink=?3, updated_at=?4 WHERE id=?5").bind(status, reason, permalink, Date.now(), id).run();

/** One bounded cron tick. An uncertain Slack send remains `sending`; it is never posted twice. */
export async function runReleaseNoteQueue(env: Env, deps: ReleaseQueueDeps = {}): Promise<void> {
	const rows = (await env.DB.prepare("SELECT * FROM release_note_queue WHERE status='pending' ORDER BY updated_at, created_at LIMIT 20").all<Row>()).results ?? [];
	for (const row of rows) {
		let claimed = false;
		try {
			if (Date.now() - row.created_at > 48 * 60 * 60_000) {
				await setStatus(env, row.id, "expired", "Required workflows did not all succeed within 48 hours");
				await logEvent(env, { source: "coding", userId: row.user_id, instanceId: row.instance_id, traceId: row.run_id, event: "release_note_expired", level: "warn", message: `Release note held for ${row.sha}: required workflows did not all succeed within 48 hours.` });
				await notifyUser(env, row.user_id, "coding", "⚠️ Release note held", `${row.github_repo}: required workflows did not all succeed for ${row.sha}.`, deepLinkFor({ kind: "coding-session", instanceId: row.instance_id, sessionId: row.session_id }), { key: `release-note-expired:${row.id}`, kind: "alert", instanceId: row.instance_id }).catch(() => undefined);
				continue;
			}
			const settings = await loadReleaseNotes(env, row.instance_id, row.user_id);
			const required = JSON.parse(row.workflows_json) as RequiredWorkflows;
			const channel = settings?.effective.channels.find((c) => c.grantId === row.grant_id && c.selected);
			if (!settings?.effective.enabled || !channel || JSON.stringify(settings.instance.requiredWorkflows) !== JSON.stringify(required)) { await setStatus(env, row.id, "cancelled", "Release note setting or channel grant changed"); continue; }
			const runs = deps.readRuns ? await deps.readRuns(row) : await (async () => {
				const { token } = await resolveGithubRead(env, row.user_id, row.github_repo.split("/")[0]);
				const response = await safeFetch(`https://api.github.com/repos/${row.github_repo}/actions/runs?head_sha=${row.sha}&per_page=100`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "ProAgentStore", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
				if (!response.ok) throw new Error(`GitHub workflow read returned ${response.status}`);
				const body = await response.json() as { workflow_runs?: Run[] };
				if (!Array.isArray(body.workflow_runs)) throw new Error("GitHub returned no workflow_runs list");
				return body.workflow_runs;
			})();
			const evidence = completedReleaseEvidence(runs, row.sha, row.default_branch, required);
			if (!evidence) { await env.DB.prepare("UPDATE release_note_queue SET updated_at=?1 WHERE id=?2 AND status='pending'").bind(Date.now(), row.id).run(); continue; }
			// Claim BEFORE the external write. If a worker dies during Slack's response, a second tick never guesses it failed.
			const claim = await env.DB.prepare("UPDATE release_note_queue SET status='sending', updated_at=?1 WHERE id=?2 AND status='pending'").bind(Date.now(), row.id).run();
			if (!claim.meta.changes) continue;
			claimed = true;
			const ctx = JSON.parse(row.context_json) as ReleaseNoteContext;
			const result = await (deps.deliver ?? liveDeliver)(env, row.user_id)(channel, verifiedReleaseText(ctx, required, evidence));
			await setStatus(env, row.id, result.ok ? "sent" : "failed", result.ok ? null : result.error, result.ok ? result.permalink ?? null : null);
			await logEvent(env, { source: "coding", userId: row.user_id, instanceId: row.instance_id, traceId: row.run_id, event: result.ok ? "release_note_sent" : "release_note_failed", level: result.ok ? "info" : "error", message: result.ok ? `Verified release note posted to ${channel.provider} ${channel.name} for ${row.sha}` : `Verified release note failed: ${result.error}`, context: { sha: row.sha, grantId: row.grant_id, evidence: evidence.map((run) => `https://github.com/${row.github_repo}/actions/runs/${run.id}`), ...(result.ok && result.permalink ? { permalink: result.permalink } : {}) } });
			if (!result.ok) await notifyUser(env, row.user_id, "coding", "⚠️ Release note not delivered", `${row.github_repo}: ${result.error}`, deepLinkFor({ kind: "coding-session", instanceId: row.instance_id, sessionId: row.session_id }), { key: `release-note-failed:${row.id}`, kind: "alert", instanceId: row.instance_id }).catch(() => undefined);
		} catch (error) {
			await logError(env, { source: "release-note-queue", userId: row.user_id, message: `Release note ${row.id}: ${error instanceof Error ? error.message : String(error)}`, context: { instanceId: row.instance_id, sha: row.sha } }).catch(() => undefined);
			if (!claimed) await env.DB.prepare("UPDATE release_note_queue SET updated_at=?1 WHERE id=?2 AND status='pending'").bind(Date.now(), row.id).run().catch(() => undefined);
			if (claimed) await notifyUser(env, row.user_id, "coding", "⚠️ Release note outcome unknown", `${row.github_repo}: the Slack send for ${row.sha} may have succeeded. Check the channel before retrying.`, deepLinkFor({ kind: "coding-session", instanceId: row.instance_id, sessionId: row.session_id }), { key: `release-note-unknown:${row.id}`, kind: "alert", instanceId: row.instance_id }).catch(() => undefined);
		}
	}
}
