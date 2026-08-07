import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, jsonText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/** Repo-chat tools — gated to users who have a repo-chat agent. */
export function registerRepoTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor, groups } = ctx;
	// ── Repo-chat tools — only for users who have a repo-chat agent ──
	if (groups.has("repo")) {
	server.tool(
		"ingest_repo",
		"Index a GitHub repository into a read-only repo-chat instance (the 'repo-chat' agent). Pulls the whole repo into the instance's vector store so you can ask how the code works. An instance can hold MANY repos — call again with a different URL to add another; call with the same URL to re-index that one. Public repos work as-is; private repos need GitHub connected.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			repo_url: z.string().describe("GitHub repo URL or owner/repo, e.g. https://github.com/sindresorhus/slugify"),
			branch: z.string().optional().describe("Optional branch (defaults to the repo's default branch)"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, repo_url, branch, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, repo_url, branch };
			const denied = await requirePermission(safetyFor(token), "write", "ingest_repo", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "ingest_repo", "index a GitHub repository into a repo-chat instance", input, {
					endpoint: `/v1/instances/${instance_id}/ingest-repo`,
					repo_url,
					branch,
				});
			}
			const data = (await authedCall(
				`/v1/instances/${instance_id}/ingest-repo`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ repoUrl: repo_url, branch }) },
				env,
			)) as { status?: string; repo?: string; error?: string };
			if (data.status) await audit(safetyFor(token), { tool: "ingest_repo", action: "completed", input: { instance_id, repo_url, branch }, result: { status: data.status } });
			return text(
				data.status
					? `Indexing started for ${data.repo || repo_url} (status: ${data.status}). Poll ingest_repo_status until it reads "done".`
					: `Error: ${data.error}`,
			);
		},
	);

	server.tool(
		"ingest_repo_status",
		"List the repositories indexed on a repo-chat instance and each one's progress (status: fetching | indexing | summarizing | done | error, with files indexed).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/ingest-repo/status`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"remove_repo",
		"Remove one indexed repository from a repo-chat instance (by repo_url or owner/repo), or all of them if neither is given. Deletes its vectors and overview.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			repo_url: z.string().optional().describe("Repo URL or owner/repo to remove. Omit to remove ALL repos."),
			confirm: z.string().optional().describe('Required when removing ALL repos: pass confirm="remove_all_repos".'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, repo_url, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, repo_url };
			// Removing ONE repo is an ordinary write. Omitting `repo_url` wipes the vectors and
			// overviews for up to 20 indexed repos in a single ungated call — and `repo_url` being
			// optional makes that an easy slip for a model. A default browser sign-in grants
			// ["read","write","runtime"] and no "destructive", so `write` alone let it through
			// unconfirmed, unlike every sibling bulk/irreversible tool
			// (delete_instance_knowledge, clear_instance_messages, cancel_instance, …).
			const removingAll = !repo_url;
			const denied = await requirePermission(safetyFor(token), removingAll ? "destructive" : "write", "remove_repo", input);
			if (denied) return denied;
			if (removingAll && !dry_run) {
				const unconfirmed = await requireConfirmation(safetyFor(token), "remove_repo", confirm, "remove_all_repos", input);
				if (unconfirmed) return unconfirmed;
			}
			if (dry_run) {
				return dryRun(safetyFor(token), "remove_repo", repo_url ? "remove one indexed repository" : "remove ALL indexed repositories", input, {
					endpoint: `/v1/instances/${instance_id}/ingest-repo/clear`,
					repo_url: repo_url || "(all)",
				});
			}
			const cleared = (await authedCall(
				`/v1/instances/${instance_id}/ingest-repo/clear`,
				sessionToken,
				{ method: "POST", body: JSON.stringify(repo_url ? { repoUrl: repo_url } : {}) },
				env,
			)) as { error?: string };
			// authedCall RETURNS `{error: "API <status>"}` on any non-2xx rather than throwing, so
			// discarding it (as this tool did) reported "Removed all repositories." for a call that
			// removed nothing — and wrote `action:"completed"` to the audit log, the one record an
			// operator would consult to answer whether a destructive removal happened. The vectors
			// survive and keep being cited, so the caller's next question is answered from an index
			// it was told is gone. Every sibling mutating tool already checks this (see
			// coding_session_message: "do NOT report 'sent' for a command that never ran").
			if (cleared?.error) return text(`Error removing ${repo_url || "all repositories"}: ${cleared.error}`);
			await audit(safetyFor(token), { tool: "remove_repo", action: "completed", input });
			return text(repo_url ? `Removed ${repo_url}.` : "Removed all repositories.");
		},
	);
	} // ── end repo-chat tools ──
}
