// Retarget a coding repo binding in place after its GitHub repository was renamed (#1012).
//
// Removing and re-adding a binding deletes its sessions, timeline and instructions. This keeps the
// row and moves only its GitHub coordinate — for the SAME numeric repository, on an idle binding,
// once the machine's checkout already points at the destination. The API side is
// `workers/api/src/routes/coding-repo-retarget.ts`; the store half holds the compare-and-set.
//
// Its own file for the reason `coding-reauth-tools.ts` is: `coding-tools.ts` is at its size limit.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, type McpEnv, jsonText } from "./http.js";
import { audit, requirePermission, type SafetyContext } from "./safety.js";

export function registerCodingRetargetTools(
	server: McpServer,
	env: McpEnv,
	tokenFor: (provided?: string) => string | null,
	safetyFor: (provided?: string) => SafetyContext,
): void {
	server.tool(
		"retarget_repository_binding",
		"Move one coding repo binding to the new name of the SAME GitHub repository after a rename or transfer, keeping its id, instructions, sessions, timeline and receipts (remove + re-add would delete them). Pass the binding's current `github_repo`, `githubRepositoryId` (when coding_repos_list shows one) and `bindingVersion` as expected_current, and the destination owner/name plus the repository's numeric GitHub id. GitHub must report that exact name for that id through the owner's GitHub App; a different repository that took the old name is refused — bind it separately with coding_repo_add. Refused while the binding has an active/suspended session, a driver lock, a running or parked run, queued objectives or an in-flight start; nothing is killed or redirected. The connected machine's checkout `origin` must already name the destination — this tool never changes a remote, and a mismatch answers with the exact `git remote set-url` command to run. Call with dry_run first: it runs every check and answers `{ready, changes, blockers}` without writing. A retry after a lost reply answers `idempotent: true`; a stale version answers 412 with the actual state. The applied answer carries `rollback`, the exact input of the reverse retarget.",
		{
			instance_id: z.string().describe("Coding instance ID"),
			repo_id: z.string().describe("Binding id from coding_repos_list"),
			expected_current: z
				.object({
					owner: z.string(),
					name: z.string(),
					github_id: z.coerce.number().int().positive().optional().describe("Required once the binding records githubRepositoryId, and for a binding without one"),
					version: z.coerce.number().int().positive().describe("The binding's bindingVersion"),
				})
				.describe("The binding's current GitHub coordinate and version, exactly as coding_repos_list shows them"),
			destination: z
				.object({ owner: z.string(), name: z.string(), github_id: z.coerce.number().int().positive() })
				.describe("The repository's new owner/name and its numeric GitHub id"),
			dry_run: z.boolean().optional().describe("Run every check and report the changes and blockers without writing. Recommended first."),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, repo_id, expected_current, destination, dry_run, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, repo_id, expected_current, destination, dry_run: dry_run === true };
			const denied = await requirePermission(safetyFor(token), "write", "retarget_repository_binding", input);
			if (denied) return denied;
			const body = {
				expectedCurrent: { owner: expected_current.owner, name: expected_current.name, githubId: expected_current.github_id, version: expected_current.version },
				destination: { owner: destination.owner, name: destination.name, githubId: destination.github_id },
				dryRun: dry_run === true,
			};
			const path = `/v1/instances/${encodeURIComponent(instance_id)}/coding/repos/${encodeURIComponent(repo_id)}/retarget`;
			const r = await authedCall(path, sessionToken, { method: "POST", body: JSON.stringify(body) }, env);
			if (!(r as { error?: string } | null)?.error) {
				await audit(safetyFor(token), { tool: "retarget_repository_binding", action: dry_run === true ? "dry_run" : "completed", input, result: r });
			}
			return jsonText(r);
		},
	);
}
