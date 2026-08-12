// GitHub connector — issue #88, first customer of the connector/tool registry #85/#86.
// Defined as a declarative connector MANIFEST (#146): shape as data (GITHUB_MANIFEST), auth
// "app" (GitHub-App installation token, so access is naturally scoped to the repos the owner's
// installation covers). Each tool keeps its custom logic (repo validation, per_page clamp, issue
// delegation, create-issue POST) via the manifest `handler` escape hatch.
//
// THE WRITE SURFACE IS ISSUE LIFECYCLE, AND STOPS THERE (#507). Open an issue, comment on it,
// close/reopen/relabel/assign it — the three things that happen to a ticket after it exists. Before
// #507 the connector could only OPEN one, so an agent that filed a ticket could never touch it
// again and the workaround was a whole Engine run to shell out to `gh`. All three writes ride the
// same GitHub-App installation token, which already carries `issues: write` — no new scope, no new
// auth, and the per-instance write-consent gate (#90) covers them exactly as it covers create.
//
// Deliberately absent, and not an oversight: PR merge/close (`github_list_pulls`'s own description
// records that the repo's merge policy governs that, and issue state does not reopen the question)
// and issue DELETION (irreversible, and nothing has asked for it).
import type { ToolDef, RegistryToolCtx } from "./types.js";
import { compileConnector, type ConnectorManifest } from "./manifest.js";
import type { Connector } from "./types.js";
import { githubAppConfigured } from "../github-app.js";
import { invalidateIssueCaches, invalidateIssuesCache, listIssues, readIssue } from "../github-issues.js";
import { listPulls, readPull } from "../github-prs.js";
import { fetchWorkflowRuns, mapWorkflowRun } from "../github-actions.js";

const GH = (token: string) => ({
	Authorization: `token ${token}`,
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
	"User-Agent": "proagentstore-connector/1.0",
});

// Valid GitHub owner/repo segments are [A-Za-z0-9._-] only. Enforcing the charset here
// (not just the 2-part shape) stops query/path smuggling — e.g. "owner/name?per_page=100"
// splits into 2 parts but would otherwise be concatenated raw into an authenticated
// api.github.com URL. A rejected repo returns the same "invalid repo" message.
const SEGMENT = /^[A-Za-z0-9._-]+$/;
function ownerOf(repo: string): string {
	const p = String(repo || "").split("/");
	return p.length === 2 && SEGMENT.test(p[0]) && SEGMENT.test(p[1]) ? p[0] : "";
}

/**
 * Resolve an installation token for the repo's owner, or a helpful error string. Auth is
 * minted via the connectorClient (issue #86): `token({resourceId: repo})` runs the same
 * installation-token path (the "github" connector is auth:"app"), so behaviour is identical —
 * same token, same scoping. The platform-configured + owner-parse checks stay here because they
 * are answerable with no network call at all; everything past them is CLASSIFIED by the minter
 * (#321), and this function only decides how to phrase what it decided.
 */
async function resolveRepo(ctx: RegistryToolCtx, repo: string): Promise<{ token: string } | { error: string }> {
	if (!githubAppConfigured(ctx.env)) return { error: "GitHub is not connected on this platform (GitHub App not configured)." };
	const owner = ownerOf(repo);
	if (!owner) {
		return {
			error: `Invalid repo "${repo}" — a GitHub tool takes the full "owner/name". If you have a coding agent's repository from subordinate_status, that value is \`repo.githubRepo\`; \`repo.name\` is a display label and is not a path.`,
		};
	}
	// #321. This branch used to GUESS: any throw became "usually transient — try again", on the
	// reasoning that "a retryable fault names itself; 'not installed' does not fail, it returns
	// nothing". That reasoning was wrong — the token minter throws for every failure, so a
	// PERMANENT one (an owner that is not a GitHub account at all) was advertised as worth
	// retrying, forever. The minter now classifies the condition itself and reserves HTTP 502 for
	// the one genuinely transient state, so there is nothing left to infer here.
	let token: string | null = null;
	let cause: unknown = null;
	try {
		token = (await ctx.connectorClient?.("github").token({ resourceId: repo })) ?? null;
	} catch (e) {
		cause = e;
	}
	if (!token) {
		if (cause) {
			const msg = (cause instanceof Error ? cause.message : String(cause)).slice(0, 240);
			// Read structurally, not with `instanceof`: what matters is the CONTRACT (an HTTP
			// status the minter set), and an error crossing a module or realm boundary keeps its
			// fields but not always its prototype. A missing status means unclassified.
			const status = Number((cause as { status?: unknown }).status) || 0;
			// 502 — and ONLY 502 — is the state where trying again can succeed on its own.
			if (status === 502 || status === 0) {
				return { error: `Couldn't reach GitHub for "${owner}" just now (${msg}). This is usually transient — try again.` };
			}
			// Permanent: the minter's message already names the actual condition and its remedy.
			// Adding "try again" here is what sent a user to re-authorize a working installation.
			return { error: msg };
		}
		return { error: `GitHub access for "${owner}" could not be established, and no reason was reported.` };
	}
	return { token };
}

const workflowRunsHandler: ToolDef["handler"] = async (ctx, input) => {
	const repo = String(input.repo || "");
	const r = await resolveRepo(ctx, repo);
	if ("error" in r) return { content: r.error, success: false };
	const n = Math.min(Math.max(Number(input.per_page) || 5, 1), 20);
	const res = await fetchWorkflowRuns(repo, r.token, { perPage: n });
	if ("status" in res) {
		return { content: res.status != null ? `GitHub returned ${res.status} for ${repo}` : `Could not reach GitHub for ${repo}`, success: false };
	}
	const runs = res.runs.map(mapWorkflowRun);
	return { content: JSON.stringify(runs, null, 2), success: true };
};

const listIssuesHandler: ToolDef["handler"] = async (ctx, input) => {
	const repo = String(input.repo || "");
	const r = await resolveRepo(ctx, repo);
	if ("error" in r) return { content: r.error, success: false };
	const state = ["open", "closed", "all"].includes(String(input.state)) ? (input.state as "open" | "closed" | "all") : "open";
	const issues = await listIssues(ctx.env, ctx.userId ?? "", repo, { state, labels: input.labels ? String(input.labels) : undefined, limit: 30 });
	return { content: JSON.stringify(issues, null, 2), success: true };
};

const readIssueHandler: ToolDef["handler"] = async (ctx, input) => {
	const repo = String(input.repo || "");
	const r = await resolveRepo(ctx, repo);
	if ("error" in r) return { content: r.error, success: false };
	const num = Number(input.number);
	if (!num) return { content: "An issue `number` is required.", success: false };
	const issue = await readIssue(ctx.env, ctx.userId ?? "", repo, num);
	return issue ? { content: JSON.stringify(issue, null, 2), success: true } : { content: `Issue #${num} not found in ${repo}.`, success: false };
};

const listPullsHandler: ToolDef["handler"] = async (ctx, input) => {
	const repo = String(input.repo || "");
	const r = await resolveRepo(ctx, repo);
	if ("error" in r) return { content: r.error, success: false };
	const state = ["open", "closed", "all"].includes(String(input.state)) ? (input.state as "open" | "closed" | "all") : "open";
	const pulls = await listPulls(ctx.env, ctx.userId ?? "", repo, { state, limit: 30 });
	return { content: JSON.stringify(pulls, null, 2), success: true };
};

const readPullHandler: ToolDef["handler"] = async (ctx, input) => {
	const repo = String(input.repo || "");
	const r = await resolveRepo(ctx, repo);
	if ("error" in r) return { content: r.error, success: false };
	const num = Number(input.number);
	if (!num) return { content: "A pull request `number` is required.", success: false };
	const pull = await readPull(ctx.env, ctx.userId ?? "", repo, num);
	return pull ? { content: JSON.stringify(pull, null, 2), success: true } : { content: `Pull request #${num} not found in ${repo}.`, success: false };
};

const createIssueHandler: ToolDef["handler"] = async (ctx, input) => {
	const repo = String(input.repo || "");
	const title = String(input.title || "").trim();
	if (!title) return { content: "An issue `title` is required.", success: false };
	const r = await resolveRepo(ctx, repo);
	if ("error" in r) return { content: r.error, success: false };
	const labels = String(input.labels || "").split(",").map((s) => s.trim()).filter(Boolean);
	const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
		method: "POST",
		headers: { ...GH(r.token), "Content-Type": "application/json" },
		body: JSON.stringify({ title, body: input.body ? String(input.body) : undefined, ...(labels.length ? { labels } : {}) }),
	});
	if (!res.ok) return { content: `GitHub returned ${res.status} creating the issue in ${repo}`, success: false };
	const data = (await res.json()) as { number?: number; html_url?: string };
	// The platform just changed this list, so this user's cached copy of it is wrong (#401). An
	// agent that opens an issue and then calls github_list_issues would otherwise read its own
	// pre-write copy and conclude the write did not happen — the get_tasks-after-create_task
	// failure `agent-think.ts` documents for the dedup guard, one layer out. One line here beats a
	// TTL short enough to hide it. Best-effort: a failed invalidation must not fail a real write.
	await invalidateIssuesCache(ctx.env, ctx.userId ?? "", repo).catch(() => undefined);
	return { content: `Opened issue #${data.number} — ${data.html_url}`, success: true };
};

/** A comma-separated arg → a trimmed, de-duplicated list. `undefined` when the arg was absent. */
function csvArg(raw: unknown): string[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	const items = String(raw)
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	// An empty/whitespace string is treated as ABSENT, not as "clear the list". PATCH semantics say
	// `[]` empties the field, so the other reading would let a model that passed `labels: ""` to
	// mean "leave them alone" silently strip every label off the issue. Clearing is therefore not
	// expressible here, which is stated in the tool description and is the safe direction to be
	// incomplete in.
	return items.length ? [...new Set(items)] : undefined;
}

const commentIssueHandler: ToolDef["handler"] = async (ctx, input) => {
	const repo = String(input.repo || "");
	const num = Number(input.number);
	if (!Number.isFinite(num) || num <= 0) return { content: "An issue `number` is required.", success: false };
	const body = String(input.body ?? "").trim();
	if (!body) return { content: "A comment `body` is required — GitHub rejects an empty comment.", success: false };
	const r = await resolveRepo(ctx, repo);
	if ("error" in r) return { content: r.error, success: false };
	const res = await fetch(`https://api.github.com/repos/${repo}/issues/${num}/comments`, {
		method: "POST",
		headers: { ...GH(r.token), "Content-Type": "application/json" },
		body: JSON.stringify({ body }),
	});
	if (!res.ok) return { content: `GitHub returned ${res.status} commenting on issue #${num} in ${repo}`, success: false };
	const data = (await res.json()) as { html_url?: string };
	// A comment changes the issue's `comments` count and its `updated_at`, both of which the cached
	// list AND the cached single read carry. Same reasoning as the create path (#401), one resource
	// wider — see `invalidateIssueCaches`.
	await invalidateIssueCaches(ctx.env, ctx.userId ?? "", repo).catch(() => undefined);
	return { content: `Commented on ${repo}#${num} — ${data.html_url ?? "(no url returned)"}`, success: true };
};

const updateIssueHandler: ToolDef["handler"] = async (ctx, input) => {
	const repo = String(input.repo || "");
	const num = Number(input.number);
	if (!Number.isFinite(num) || num <= 0) return { content: "An issue `number` is required.", success: false };

	const patch: Record<string, unknown> = {};
	if (input.state !== undefined && input.state !== null && String(input.state) !== "") {
		const state = String(input.state).trim().toLowerCase();
		if (state !== "open" && state !== "closed") {
			return { content: `\`state\` must be "open" or "closed" — got "${input.state}".`, success: false };
		}
		patch.state = state;
	}
	const labels = csvArg(input.labels);
	if (labels) patch.labels = labels;
	const assignees = csvArg(input.assignees);
	if (assignees) patch.assignees = assignees;
	const title = input.title === undefined || input.title === null ? "" : String(input.title).trim();
	if (title) patch.title = title;
	if (input.body !== undefined && input.body !== null && String(input.body) !== "") patch.body = String(input.body);

	// A PATCH with nothing in it is a 200 that changes nothing, and reporting that as success is
	// exactly the "claimed an action that did not happen" failure the platform's honesty rule is
	// about. Refuse before the request, and say which fields would have worked.
	if (Object.keys(patch).length === 0) {
		return {
			content: `Nothing to update on ${repo}#${num} — supply at least one of state, labels, assignees, title or body.`,
			success: false,
		};
	}

	const r = await resolveRepo(ctx, repo);
	if ("error" in r) return { content: r.error, success: false };
	const res = await fetch(`https://api.github.com/repos/${repo}/issues/${num}`, {
		method: "PATCH",
		headers: { ...GH(r.token), "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) return { content: `GitHub returned ${res.status} updating issue #${num} in ${repo}`, success: false };
	const data = (await res.json()) as {
		state?: string;
		html_url?: string;
		labels?: Array<{ name?: string } | string>;
		assignees?: Array<{ login?: string }>;
	};
	await invalidateIssueCaches(ctx.env, ctx.userId ?? "", repo).catch(() => undefined);

	// Report the issue's RESULTING state, read off the PATCH response, rather than echoing back
	// what was asked for. GitHub does not error on an assignee who lacks push access on the repo —
	// it accepts the request and silently drops the name — so "assign this to me" can return 200
	// having assigned nobody. Echoing the request would turn that into an agent confidently
	// reporting an assignment that does not exist, which is the #398 class (a claim that is
	// indistinguishable from a result). The response body is already in hand, so this costs
	// nothing and is the only version of the sentence that is always true.
	const names = (data.labels ?? []).map((l) => (typeof l === "string" ? l : (l?.name ?? ""))).filter(Boolean);
	const who = (data.assignees ?? []).map((a) => a?.login ?? "").filter(Boolean);
	const parts = [`state: ${data.state ?? "unknown"}`, `labels: ${names.length ? names.join(", ") : "none"}`, `assignees: ${who.length ? who.join(", ") : "none"}`];
	return { content: `Updated ${repo}#${num} — now ${parts.join(" · ")} — ${data.html_url ?? ""}`.trim(), success: true };
};

export const GITHUB_MANIFEST: ConnectorManifest = {
	id: "github",
	label: "GitHub",
	auth: { type: "app" },
	tools: [
		{
			name: "github_workflow_runs",
			scope: "read",
			description: "List recent GitHub Actions workflow runs for a repo (status, conclusion, branch, url) — check CI / deploy status.",
			handler: "github_workflow_runs",
			params: {
				repo: { type: "string", required: true, description: 'The repository, "owner/name".' },
				per_page: { type: "number", description: "How many recent runs to return (default 5, max 20)." },
			},
		},
		{
			name: "github_list_issues",
			scope: "read",
			description: "List issues for a repo (excludes pull requests). Filter by state and labels.",
			handler: "github_list_issues",
			params: {
				repo: { type: "string", required: true, description: 'The repository, "owner/name".' },
				state: { type: "string", description: '"open" | "closed" | "all" (default open).' },
				labels: { type: "string", description: "Comma-separated label filter." },
			},
		},
		{
			name: "github_read_issue",
			scope: "read",
			description: "Read one issue (title, body, labels, state) by number.",
			handler: "github_read_issue",
			params: {
				repo: { type: "string", required: true, description: 'The repository, "owner/name".' },
				number: { type: "number", required: true, description: "The issue number." },
			},
		},
		{
			name: "github_list_pulls",
			scope: "read",
			description: "List a repo's pull requests — number, title, author, draft, branch, mergeable/conflicted, review state and CI status. Read-only; there is deliberately no merge tool (the repo's merge policy governs that).",
			handler: "github_list_pulls",
			params: {
				repo: { type: "string", required: true, description: 'The repository, "owner/name".' },
				state: { type: "string", description: '"open" | "closed" | "all" (default open).' },
			},
		},
		{
			name: "github_read_pull",
			scope: "read",
			description: "Read one pull request by number — body, diff size, mergeability, review state and whether its checks are green.",
			handler: "github_read_pull",
			params: {
				repo: { type: "string", required: true, description: 'The repository, "owner/name".' },
				number: { type: "number", required: true, description: "The pull request number." },
			},
		},
		{
			name: "github_create_issue",
			scope: "write",
			description: "Open a new GitHub issue in a repo. WRITE — the issue is really created.",
			handler: "github_create_issue",
			params: {
				repo: { type: "string", required: true, description: 'The repository, "owner/name".' },
				title: { type: "string", required: true, description: "Issue title." },
				body: { type: "string", description: "Issue body (markdown)." },
				labels: { type: "string", description: "Comma-separated labels to apply." },
			},
		},
		{
			name: "github_comment_issue",
			scope: "write",
			description:
				"Add a comment to an existing GitHub issue. WRITE — the comment is really posted. Use this to record WHY something was done (why an issue was closed, what a run changed) instead of spending a coding session on `gh issue comment`.",
			handler: "github_comment_issue",
			params: {
				repo: { type: "string", required: true, description: 'The repository, "owner/name".' },
				number: { type: "number", required: true, description: "The issue number to comment on." },
				body: { type: "string", required: true, description: "The comment text (markdown)." },
			},
		},
		{
			name: "github_update_issue",
			scope: "write",
			description:
				"Change an existing GitHub issue: close or reopen it, relabel it, assign it, or edit its title/body. WRITE — the change is really made. Supply only the fields you want to change. IMPORTANT: `labels` and `assignees` REPLACE what the issue currently has, they are not added to it — so to ADD a label, first read the issue (github_read_issue) and pass the existing labels along with the new one. There is no way to clear a field here: an empty value means 'leave it alone'.",
			handler: "github_update_issue",
			params: {
				repo: { type: "string", required: true, description: 'The repository, "owner/name".' },
				number: { type: "number", required: true, description: "The issue number to update." },
				state: { type: "string", description: '"closed" to close it, "open" to reopen it. Omit to leave the state alone.' },
				labels: { type: "string", description: "Comma-separated labels — REPLACES the issue's current labels. Omit to leave them alone." },
				assignees: { type: "string", description: "Comma-separated GitHub logins — REPLACES the issue's current assignees. Omit to leave them alone." },
				title: { type: "string", description: "A new title. Omit to leave it alone." },
				body: { type: "string", description: "A new body (markdown). This overwrites the existing body — omit to leave it alone." },
			},
		},
	],
};

const compiled = compileConnector(GITHUB_MANIFEST, {
	github_workflow_runs: workflowRunsHandler,
	github_list_issues: listIssuesHandler,
	github_read_issue: readIssueHandler,
	github_list_pulls: listPullsHandler,
	github_read_pull: readPullHandler,
	github_create_issue: createIssueHandler,
	github_comment_issue: commentIssueHandler,
	github_update_issue: updateIssueHandler,
});
/** Tool defs (kept for direct-import tests). */
export const GITHUB_TOOLS: ToolDef[] = compiled.tools;
/** Compiled Connector — consumed by the registry exactly like a hand-written connector. */
export const GITHUB_CONNECTOR: Connector = compiled.connector;
