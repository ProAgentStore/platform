// GitHub connector — read-only tools any permitted agent can call (issue #88, first
// customer of the connector/tool registry #85/#86). Backed by the existing GitHub-App
// installation token (`installationTokenForOwner`), so access is naturally scoped to
// the repos the owner's installation covers. Writes (create issue/PR, trigger) come
// later behind consent (#90). These replace Coder's hard-wired GH logic over time.
import type { ToolDef, RegistryToolCtx } from "../tool-registry.js";
import { githubAppConfigured } from "../github-app.js";
import { listIssues, readIssue } from "../github-issues.js";

const GH = (token: string) => ({
	Authorization: `token ${token}`,
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
	"User-Agent": "proagentstore-connector/1.0",
});

function ownerOf(repo: string): string {
	const p = String(repo || "").split("/");
	return p.length === 2 && p[0] && p[1] ? p[0] : "";
}

/**
 * Resolve an installation token for the repo's owner, or a helpful error string. Auth is
 * minted via the connectorClient (issue #86): `token({resourceId: repo})` runs the same
 * installationTokenForOwner path (the "github" connector is auth:"app"), so behaviour is
 * identical — same token, same scoping. The platform-configured + owner-parse checks stay
 * here so their user-facing messages are unchanged.
 */
async function resolveRepo(ctx: RegistryToolCtx, repo: string): Promise<{ token: string } | { error: string }> {
	if (!githubAppConfigured(ctx.env)) return { error: "GitHub is not connected on this platform (GitHub App not configured)." };
	const owner = ownerOf(repo);
	if (!owner) return { error: `Invalid repo "${repo}" — use the form "owner/name".` };
	const token = await ctx.connectorClient?.("github").token({ resourceId: repo }).catch(() => null);
	if (!token) return { error: `No GitHub access for "${owner}". Install/authorize the ProAgentStore GitHub App for that account, then try again.` };
	return { token };
}

export const GITHUB_TOOLS: ToolDef[] = [
	{
		name: "github_workflow_runs",
		tier: "connector",
		connector: "github",
		scope: "read",
		description: "List recent GitHub Actions workflow runs for a repo (status, conclusion, branch, url) — check CI / deploy status.",
		jsonSchema: {
			type: "object",
			properties: {
				repo: { type: "string", description: 'The repository, "owner/name".' },
				per_page: { type: "number", description: "How many recent runs to return (default 5, max 20)." },
			},
			required: ["repo"],
		},
		handler: async (ctx, input) => {
			const repo = String(input.repo || "");
			const r = await resolveRepo(ctx, repo);
			if ("error" in r) return { content: r.error, success: false };
			const n = Math.min(Math.max(Number(input.per_page) || 5, 1), 20);
			const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=${n}`, { headers: GH(r.token) });
			if (!res.ok) return { content: `GitHub returned ${res.status} for ${repo}`, success: false };
			const data = (await res.json()) as { workflow_runs?: Array<Record<string, unknown>> };
			const runs = (data.workflow_runs || []).map((run) => ({
				status: run.status,
				conclusion: run.conclusion ?? null,
				name: run.name ?? "",
				runNumber: run.run_number ?? null,
				branch: run.head_branch ?? "",
				sha: typeof run.head_sha === "string" ? run.head_sha.slice(0, 7) : "",
				url: run.html_url ?? "",
				updatedAt: run.updated_at ?? "",
			}));
			return { content: JSON.stringify(runs, null, 2), success: true };
		},
	},
	{
		name: "github_list_issues",
		tier: "connector",
		connector: "github",
		scope: "read",
		description: "List issues for a repo (excludes pull requests). Filter by state and labels.",
		jsonSchema: {
			type: "object",
			properties: {
				repo: { type: "string", description: 'The repository, "owner/name".' },
				state: { type: "string", description: '"open" | "closed" | "all" (default open).' },
				labels: { type: "string", description: "Comma-separated label filter." },
			},
			required: ["repo"],
		},
		handler: async (ctx, input) => {
			const repo = String(input.repo || "");
			const r = await resolveRepo(ctx, repo);
			if ("error" in r) return { content: r.error, success: false };
			const state = ["open", "closed", "all"].includes(String(input.state)) ? (input.state as "open" | "closed" | "all") : "open";
			const issues = await listIssues(ctx.env, ctx.userId ?? "", repo, { state, labels: input.labels ? String(input.labels) : undefined, limit: 30 });
			return { content: JSON.stringify(issues, null, 2), success: true };
		},
	},
	{
		name: "github_read_issue",
		tier: "connector",
		connector: "github",
		scope: "read",
		description: "Read one issue (title, body, labels, state) by number.",
		jsonSchema: {
			type: "object",
			properties: {
				repo: { type: "string", description: 'The repository, "owner/name".' },
				number: { type: "number", description: "The issue number." },
			},
			required: ["repo", "number"],
		},
		handler: async (ctx, input) => {
			const repo = String(input.repo || "");
			const r = await resolveRepo(ctx, repo);
			if ("error" in r) return { content: r.error, success: false };
			const num = Number(input.number);
			if (!num) return { content: "An issue `number` is required.", success: false };
			const issue = await readIssue(ctx.env, ctx.userId ?? "", repo, num);
			return issue ? { content: JSON.stringify(issue, null, 2), success: true } : { content: `Issue #${num} not found in ${repo}.`, success: false };
		},
	},
	{
		name: "github_create_issue",
		tier: "connector",
		connector: "github",
		scope: "write",
		description: "Open a new GitHub issue in a repo. WRITE — requires the GitHub connector's write consent for this instance.",
		jsonSchema: {
			type: "object",
			properties: {
				repo: { type: "string", description: 'The repository, "owner/name".' },
				title: { type: "string", description: "Issue title." },
				body: { type: "string", description: "Issue body (markdown)." },
				labels: { type: "string", description: "Comma-separated labels to apply." },
			},
			required: ["repo", "title"],
		},
		handler: async (ctx, input) => {
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
		},
	},
];
