// GitHub connector — issue #88, first customer of the connector/tool registry #85/#86.
// Defined as a declarative connector MANIFEST (#146): shape as data (GITHUB_MANIFEST), auth
// "app" (GitHub-App installation token, so access is naturally scoped to the repos the owner's
// installation covers). Each tool keeps its custom logic (repo validation, per_page clamp, issue
// delegation, create-issue POST) via the manifest `handler` escape hatch.
import type { ToolDef, RegistryToolCtx } from "./types.js";
import { compileConnector, type ConnectorManifest } from "./manifest.js";
import type { Connector } from "./types.js";
import { githubAppConfigured } from "../github-app.js";
import { listIssues, readIssue } from "../github-issues.js";
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
	return { content: `Opened issue #${data.number} — ${data.html_url}`, success: true };
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
			name: "github_create_issue",
			scope: "write",
			description: "Open a new GitHub issue in a repo. WRITE — requires the GitHub connector's write consent for this instance.",
			handler: "github_create_issue",
			params: {
				repo: { type: "string", required: true, description: 'The repository, "owner/name".' },
				title: { type: "string", required: true, description: "Issue title." },
				body: { type: "string", description: "Issue body (markdown)." },
				labels: { type: "string", description: "Comma-separated labels to apply." },
			},
		},
	],
};

const compiled = compileConnector(GITHUB_MANIFEST, {
	github_workflow_runs: workflowRunsHandler,
	github_list_issues: listIssuesHandler,
	github_read_issue: readIssueHandler,
	github_create_issue: createIssueHandler,
});
/** Tool defs (kept for direct-import tests). */
export const GITHUB_TOOLS: ToolDef[] = compiled.tools;
/** Compiled Connector — consumed by the registry exactly like a hand-written connector. */
export const GITHUB_CONNECTOR: Connector = compiled.connector;
