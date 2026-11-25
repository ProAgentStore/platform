import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, jsonText } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Branches and stashes in a repo's checkout, on the machine that holds it (#1700, #1701), and the owner's two endings for a run (#1709):
 * abandon it, discard its isolated worktree, and publish the worktree of a run that ended by hand (#1717). All three are owner-only: no agent tool reaches them.
 *
 * The git is the runner's; the API route is `workers/api/src/routes/coding-branch-actions.ts`. Two shapes:
 *
 *   READS (`coding_branches`, `coding_stashes`): inventory, comparison, inspection, and the PREVIEW of each
 *   mutation (`preview`), which asks the machine what the change would do — the unique commits and files, the
 *   tip to pass back, the checks — and changes nothing. They are `read` scope.
 *
 *   MUTATIONS (`coding_branch_integrate`, `coding_branch_delete`, `coding_stash_drop`): `destructive` scope and
 *   an exact `confirm`. Each names the machine (`runner_node`) and the tip or SHA the caller read; the machine
 *   re-reads it and refuses a stale one. Their own `dry_run` is the usual no-network description — the preview
 *   that touches the machine is the read tool's `preview`, so a dry run never leaves this Worker.
 */
export function registerBranchTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	const tokenField = z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.");
	const route = (instance_id: string, repo_id: string, sub: "branches" | "branches/integrate" | "branches/delete" | "stashes" | "stashes/drop" | "worktrees/discard" | "worktrees/publish") => `/v1/instances/${encodeURIComponent(instance_id)}/coding/repos/${encodeURIComponent(repo_id)}/${sub}`;
	const common = {
		token: tokenField,
		instance_id: z.string().describe("Instance ID or slug"),
		repo_id: z.string().describe("Repo ID from coding_repos_list."),
	};
	const node = z.string().describe("Machine (node) holding the checkout, from list_runner_nodes. Required: the same repo on another machine has different refs.");
	const optionalNode = z.string().optional().describe("Machine (node) holding the checkout. Default: the machine this agent is pinned to; the answer names which one replied.");

	server.tool(
		"coding_branches",
		"List a repo's branches on the machine that holds its checkout (#1700): local branches (tip, upstream, ahead/behind its upstream and the default branch, default / protected / checked-out-in-which-work-tree, linked worktrees included) and the remote's heads. Remote heads are read LIVE (`ls-remote`) and marked `source: \"live\"`; tracking refs the remote no longer reports are `cached-only` and `cacheStale` marks a cache behind the remote — a cached ref is never presented as live. `protected.onRemote` is GitHub's answer, or null when it could not be read (`protectionKnown: false`); `protected.byName` is the conventional names (main, master, release/*...). With `compare: <branch>` it compares that branch against the default (freshly fetched): ahead/behind, the unique commits (50) and changed files (200) with totals. With `preview` it shows what integrating or deleting that branch would do (or, with `discard_worktree` and `session_id`, what discarding that run's isolated worktree would remove: the changed files and the exact `head` to pass back as `expected_head`; with `publish_worktree` and `session_id`, what publishing it would do: direct or pull request, the target, the commits, any uncommitted files that would NOT be published, and the `head` to pass back) — unique commits and files, the exact `tip` to pass back as `expected_tip`, the checks state, and the refusal that would apply — changing nothing. A machine that is offline, too old, or lacks access is named with a `reason`, never an empty list. Read-only.",
		{
			...common,
			runner_node: optionalNode,
			compare: z.string().optional().describe("Branch to compare against the default branch."),
			base: z.string().optional().describe("With compare: compare against this branch instead of the default."),
			preview: z.enum(["integrate", "delete_local", "delete_remote", "discard_worktree", "publish_worktree"]).optional().describe("Preview that mutation for `branch` (read-only; nothing is changed). Needs runner_node. `discard_worktree` previews coding_worktree_discard, and `publish_worktree` coding_worktree_publish, for `session_id` instead of a branch."),
			branch: z.string().optional().describe("The branch a preview is for."),
			session_id: z.string().optional().describe("With preview `discard_worktree` or `publish_worktree`: the session (csess_...) whose isolated worktree it is."),
		},
		async ({ token, instance_id, repo_id, runner_node, compare, base: baseBranch, preview, branch, session_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "coding_branches", { instance_id, repo_id, runner_node, compare, preview, branch, session_id });
			if (denied) return denied;
			const q = new URLSearchParams();
			if (preview === "discard_worktree" || preview === "publish_worktree") {
				if (!session_id || !runner_node) return jsonText({ error: `preview ${preview} needs both \`session_id\` and \`runner_node\`` });
				q.set("runner_node", runner_node);
				q.set("session_id", session_id);
				return jsonText(await authedCall(`${route(instance_id, repo_id, preview === "discard_worktree" ? "worktrees/discard" : "worktrees/publish")}?${q}`, sessionToken, {}, env));
			}
			if (runner_node) q.set("runner_node", runner_node);
			if (compare) q.set("compare", compare);
			if (compare && baseBranch) q.set("base", baseBranch);
			if (preview) {
				if (!branch || !runner_node) return jsonText({ error: "preview needs both `branch` and `runner_node`" });
				q.set("preview", preview);
				q.set("branch", branch);
			}
			return jsonText(await authedCall(`${route(instance_id, repo_id, "branches")}${q.size ? `?${q}` : ""}`, sessionToken, {}, env));
		},
	);

	server.tool(
		"coding_branch_integrate",
		"Integrate one local branch into the repo's default branch on the remote, as a plain fast-forward push of the branch's exact tip (#1700) — the default branch's own protection and required checks still decide, and are read first. It never merges, never force-pushes and never bypasses a check. Preview first with coding_branches `preview: \"integrate\"`: it shows the unique commits and files and the `tip` to pass as `expected_tip`. Refused with a named `reason` when the tip moved since the preview (`stale_tip`), the default branch has changes the branch lacks (`diverged` — update the branch first), the branch is the default, required checks are failing, pending or unreadable (`checks_failed|checks_pending|checks_unverifiable`), the remote is unreachable, or the remote declines the push (`push_rejected`, e.g. a repo that requires pull requests: opening PRs is a separate decision). On success the default branch is read back from the remote and a receipt gives before/after and the time. Requires `confirm: \"coding_branch_integrate\"`, `runner_node` and `expected_tip`. `destructive` scope.",
		{
			...common,
			runner_node: node,
			branch: z.string().describe("The local branch to integrate."),
			expected_tip: z.string().describe("The branch's full 40-character tip SHA, as the preview returned it. A different current tip refuses."),
			confirm: z.string().optional().describe('Must be "coding_branch_integrate".'),
			dry_run: z.boolean().optional().describe("Describe the request without contacting anything. For the machine's own preview use coding_branches preview."),
		},
		async ({ token, instance_id, repo_id, runner_node, branch, expected_tip, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, repo_id, runner_node, branch, expected_tip };
			const denied = await requirePermission(safetyFor(token), "destructive", "coding_branch_integrate", input);
			if (denied) return denied;
			const endpoint = route(instance_id, repo_id, "branches/integrate");
			if (dry_run) return dryRun(safetyFor(token), "coding_branch_integrate", "fast-forward the default branch to a branch's exact tip", input, { endpoint, method: "POST", effect: "The machine would re-read the branch tip and the remote's default tip, require a fast-forward and passing checks, push the tip with a plain (non-forced) push, and read the remote back. Nothing is merged or forced.", reversible: "Not automatically: the receipt names the default branch's previous tip." });
			const unconfirmed = await requireConfirmation(safetyFor(token), "coding_branch_integrate", confirm, "coding_branch_integrate", input);
			if (unconfirmed) return unconfirmed;
			const data = (await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({ runner_node, branch, expected_tip, dry_run: false }) }, env)) as { error?: string };
			await audit(safetyFor(token), { tool: "coding_branch_integrate", action: data.error ? "failed" : "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"coding_branch_delete",
		"Delete one exact branch, locally or on the remote (#1700). Preview first with coding_branches `preview: \"delete_local\"` or `\"delete_remote\"`: it shows the commits and files the branch holds that the default branch does not, how many commits exist on no remote head (local), and the `tip` to pass as `expected_tip`. The machine re-reads the tip and refuses a moved one (`stale_tip`); a local delete is one atomic `update-ref -d <ref> <old tip>`, a remote delete is a plain delete push. Refused with a named `reason` for the default branch (`default_branch`), a protected one (`protected`: GitHub's answer or a conventional name like main/master/release/*), and any branch checked out in any work tree including linked ones (`checked_out`). Never force-pushes. Reads back that the branch is gone and returns a receipt with the one-line recovery (`git branch <name> <tip>` / `git push origin <tip>:refs/heads/<name>`). Requires `confirm: \"coding_branch_delete\"`, `runner_node` and `expected_tip`. `destructive` scope.",
		{
			...common,
			runner_node: node,
			scope: z.enum(["local", "remote"]).describe("Which ref to delete: the local branch or the branch on the remote."),
			branch: z.string().describe("The exact branch name."),
			expected_tip: z.string().describe("The branch's full 40-character tip SHA, as the preview returned it."),
			confirm: z.string().optional().describe('Must be "coding_branch_delete".'),
			dry_run: z.boolean().optional().describe("Describe the request without contacting anything. For the machine's own preview use coding_branches preview."),
		},
		async ({ token, instance_id, repo_id, runner_node, scope, branch, expected_tip, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, repo_id, runner_node, scope, branch, expected_tip };
			const denied = await requirePermission(safetyFor(token), "destructive", "coding_branch_delete", input);
			if (denied) return denied;
			const endpoint = route(instance_id, repo_id, "branches/delete");
			if (dry_run) return dryRun(safetyFor(token), "coding_branch_delete", `delete a ${scope} branch at its exact tip`, input, { endpoint, method: "POST", effect: "The machine would re-read the tip, refuse a default, protected or checked-out branch, delete only that ref (a local delete is guarded by the old tip), and read back that it is gone.", reversible: "Yes while the commits exist: the receipt carries the command that recreates the branch at its tip." });
			const unconfirmed = await requireConfirmation(safetyFor(token), "coding_branch_delete", confirm, "coding_branch_delete", input);
			if (unconfirmed) return unconfirmed;
			const data = (await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({ runner_node, scope, branch, expected_tip, dry_run: false }) }, env)) as { error?: string };
			await audit(safetyFor(token), { tool: "coding_branch_delete", action: data.error ? "failed" : "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"coding_stashes",
		"List a repo's git stashes on the machine that holds its checkout (#1701), or inspect one. Each entry carries its immutable commit `sha` (the only handle that stays valid — `index` shifts whenever any stash is pushed or dropped), date, message, base commit, the branch it was made on, the pins (`refs/pags/*`) pointing at it, the number of changed files, and `attribution`: `run` (a parked run, from its own message), `checkout-stash` (stash_checkout, with its label) or `unknown` — never guessed. With `sha` it inspects that stash: every changed path (tracked and untracked) with `onDefault` marking content the default branch already holds, `uniqueFiles`, how far the default branch has moved since the stash's base, and a diffstat. An unknown sha answers `found: false`. An offline or old machine is named with a `reason`, never an empty list. Nothing is applied or changed. Read-only.",
		{
			...common,
			runner_node: optionalNode,
			sha: z.string().optional().describe("Full 40-character stash commit SHA to inspect. Omit to list."),
		},
		async ({ token, instance_id, repo_id, runner_node, sha }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "coding_stashes", { instance_id, repo_id, runner_node, sha });
			if (denied) return denied;
			const q = new URLSearchParams();
			if (runner_node) q.set("runner_node", runner_node);
			if (sha) q.set("sha", sha);
			return jsonText(await authedCall(`${route(instance_id, repo_id, "stashes")}${q.size ? `?${q}` : ""}`, sessionToken, {}, env));
		},
	);

	server.tool(
		"coding_stash_drop",
		"Drop one git stash, addressed by its immutable commit SHA — never by `stash@{n}` (#1701). Inspect it first with coding_stashes `sha`: that shows every path it holds and which are not on the default branch yet — what you are about to lose. The machine looks the entry up by SHA inside the call, drops exactly it, checks that git dropped that SHA (if the list shifted under it, the wrong entry is put straight back and the call refuses with `index_shifted`), and reads the list back. A SHA already gone answers `alreadyGone: true` and touches nothing. The commit stays recoverable: the receipt carries the `git stash store` line, and any `refs/pags/*` pin to it is left in place and reported. It never applies or pops a stash. Requires `confirm: \"coding_stash_drop\"`, `runner_node` and `sha`. `destructive` scope.",
		{
			...common,
			runner_node: node,
			sha: z.string().describe("The stash's full 40-character commit SHA from coding_stashes."),
			confirm: z.string().optional().describe('Must be "coding_stash_drop".'),
			dry_run: z.boolean().optional().describe("Describe the request without contacting anything. To see what the stash holds use coding_stashes with sha."),
		},
		async ({ token, instance_id, repo_id, runner_node, sha, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, repo_id, runner_node, sha };
			const denied = await requirePermission(safetyFor(token), "destructive", "coding_stash_drop", input);
			if (denied) return denied;
			const endpoint = route(instance_id, repo_id, "stashes/drop");
			if (dry_run) return dryRun(safetyFor(token), "coding_stash_drop", "drop one stash by its immutable SHA", input, { endpoint, method: "POST", effect: "The machine would find the stash by SHA, drop only that entry, verify git dropped that SHA, and read the list back. Nothing is applied.", reversible: "Yes: `git stash store -m <message> <sha>` in that checkout, given in the receipt." });
			const unconfirmed = await requireConfirmation(safetyFor(token), "coding_stash_drop", confirm, "coding_stash_drop", input);
			if (unconfirmed) return unconfirmed;
			const data = (await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({ runner_node, sha, dry_run: false }) }, env)) as { error?: string };
			await audit(safetyFor(token), { tool: "coding_stash_drop", action: data.error ? "failed" : "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"coding_run_abandon",
		"Abandon a coding run: the owner's decision that this run is over (#1709). Stopping a run only asks it to stop; abandoning also clears what could resume it. Every question the run still holds is closed and marked used, so a parked question stops waiting, the brain and the minute sweep leave it alone, and an answer that arrives later is only recorded (`already_applied`), never acted on. The run is then asked to stop and its parked workflow woken; a parked run whose workflow is already gone is settled `cancelled` here. Idempotent, and on a run that already ended it only clears leftovers (`outcome: \"already_ended\"`). It never touches the run's worktree or branch: discard an isolated run's worktree separately with coding_worktree_discard. Owner only; an agent has no tool for this. Requires `confirm: \"coding_run_abandon\"`. `destructive` scope.",
		{
			token: tokenField,
			instance_id: z.string().describe("Instance ID or slug"),
			run_id: z.string().describe("The run id from coding_loop_status or coding_loop_start."),
			confirm: z.string().optional().describe('Must be "coding_run_abandon".'),
			dry_run: z.boolean().optional().describe("Describe the request without contacting anything."),
		},
		async ({ token, instance_id, run_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, run_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "coding_run_abandon", input);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/coding/runs/${encodeURIComponent(run_id)}/abandon`;
			if (dry_run) return dryRun(safetyFor(token), "coding_run_abandon", "abandon a run and clear what could resume it", input, { endpoint, method: "POST", effect: "Every unused question of the run would be closed and marked used, the run asked to stop and its parked workflow woken. Nothing in the repository is touched.", reversible: "No: the run cannot be resumed. Its work stays in the repository; start a new run for the objective." });
			const unconfirmed = await requireConfirmation(safetyFor(token), "coding_run_abandon", confirm, "coding_run_abandon", input);
			if (unconfirmed) return unconfirmed;
			const data = (await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({}) }, env)) as { error?: string };
			await audit(safetyFor(token), { tool: "coding_run_abandon", action: data.error ? "failed" : "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"coding_worktree_discard",
		"Discard ONE run's isolated worktree on the machine that holds it (#1709, #1670): the owner's explicit decision to throw that run's uncommitted work away. Preview first with coding_branches `preview: \"discard_worktree\"` and `session_id`: it lists the changed files (untracked included) and the `head` to pass as `expected_head`. The machine removes only a worktree it can verify it manages (inside its managed root, listed by the repository, marked for that run), never the shared checkout and never another run's worktree. Nothing is committed. A commit that exists only in that worktree is first pinned on `refs/pags/discarded/<run>`, so it stays recoverable; the uncommitted files are not. Refused with a named `reason` for a worktree it does not manage (`not_managed`), a run whose engine is still running (`session_live`: abandon the run first), a moved head (`stale_head`) and a removal the repository declined (`refused`). Reads back that the worktree is gone and returns a receipt. Owner only; an agent has no tool for this. Requires `confirm: \"coding_worktree_discard\"`, `runner_node`, `session_id` and `expected_head`. `destructive` scope.",
		{
			...common,
			runner_node: node,
			session_id: z.string().describe("The session (csess_...) whose isolated worktree to discard; its uuid is the worktree's run id."),
			expected_head: z.string().describe("The worktree's full 40-character HEAD SHA, as the preview returned it. A different current head refuses."),
			confirm: z.string().optional().describe('Must be "coding_worktree_discard".'),
			dry_run: z.boolean().optional().describe("Describe the request without contacting anything. For the machine's own preview use coding_branches preview discard_worktree."),
		},
		async ({ token, instance_id, repo_id, runner_node, session_id, expected_head, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, repo_id, runner_node, session_id, expected_head };
			const denied = await requirePermission(safetyFor(token), "destructive", "coding_worktree_discard", input);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/coding/repos/${encodeURIComponent(repo_id)}/worktrees/discard`;
			if (dry_run) return dryRun(safetyFor(token), "coding_worktree_discard", "discard one run's isolated worktree", input, { endpoint, method: "POST", effect: "The machine would verify it manages that run's worktree, refuse a live engine or a moved head, pin any commit that exists only there, remove just that worktree and read back that it is gone. Nothing is committed.", reversible: "Committed work: yes, from refs/pags/discarded/<run>. Uncommitted files: no." });
			const unconfirmed = await requireConfirmation(safetyFor(token), "coding_worktree_discard", confirm, "coding_worktree_discard", input);
			if (unconfirmed) return unconfirmed;
			const data = (await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({ runner_node, session_id, expected_head, dry_run: false }) }, env)) as { error?: string };
			await audit(safetyFor(token), { tool: "coding_worktree_discard", action: data.error ? "failed" : "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"coding_worktree_publish",
		"Publish ONE run's isolated worktree on the machine that holds it, for a run the owner ended by hand (#1717). A run that ends on its own publishes automatically; a session the owner ends does not, and its worktree is kept. This is that decision, with the same read-back and the same choice the repository stored: an isolated-direct repository gets a plain, never-forced push of the run's commits to its target (the target's own checks and protection still decide), read back from the remote; an isolated-pr repository gets the run branch pushed and a pull request opened through the GitHub App, and nothing is pushed to the target. The worktree is removed only after that read-back; uncommitted files are never published (`dirty`: commit them first) and keep the worktree. A repository that stored no isolated strategy is refused and nothing changes. Preview first with coding_branches `preview: \"publish_worktree\"` and `session_id`: it names the mode, target, commits and the `head` to pass as `expected_head`. Refused with a named `reason` for a moved head (`stale_head`), a run whose engine is still running (`session_live`), a target that moved (`target_moved`), a worktree cut the other way from the repository's setting (`mode_mismatch`) and a failed push. Owner only; an agent has no tool for this. Requires `confirm: \"coding_worktree_publish\"`, `runner_node`, `session_id` and `expected_head`. `destructive` scope.",
		{
			...common,
			runner_node: node,
			session_id: z.string().describe("The session (csess_...) whose isolated worktree to publish; its uuid is the worktree's run id."),
			expected_head: z.string().describe("The worktree's full 40-character HEAD SHA, as the preview returned it. A different current head refuses."),
			confirm: z.string().optional().describe('Must be "coding_worktree_publish".'),
			dry_run: z.boolean().optional().describe("Describe the request without contacting anything. For the machine's own preview use coding_branches preview publish_worktree."),
		},
		async ({ token, instance_id, repo_id, runner_node, session_id, expected_head, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, repo_id, runner_node, session_id, expected_head };
			const denied = await requirePermission(safetyFor(token), "destructive", "coding_worktree_publish", input);
			if (denied) return denied;
			const endpoint = route(instance_id, repo_id, "worktrees/publish");
			if (dry_run) return dryRun(safetyFor(token), "coding_worktree_publish", "publish one ended run's isolated worktree", input, { endpoint, method: "POST", effect: "The machine would refuse a live engine or a moved head, then push the run's commits with a plain push (to the target for isolated-direct, to the run branch plus an opened pull request for isolated-pr), read the remote back, and remove the worktree only if that read back and it is clean. Uncommitted files are never published.", reversible: "Not automatically: a published commit is on the remote. A pushed run branch can be deleted; the receipt names what was pushed." });
			const unconfirmed = await requireConfirmation(safetyFor(token), "coding_worktree_publish", confirm, "coding_worktree_publish", input);
			if (unconfirmed) return unconfirmed;
			const data = (await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({ runner_node, session_id, expected_head, dry_run: false }) }, env)) as { error?: string };
			await audit(safetyFor(token), { tool: "coding_worktree_publish", action: data.error ? "failed" : "completed", input, result: data });
			return jsonText(data);
		},
	);
}
