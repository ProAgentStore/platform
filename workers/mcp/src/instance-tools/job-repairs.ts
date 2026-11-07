import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * The one-off repairs of #1606 (`repair_job_leads`, on a Scout) and #1609 (`rekey_job_applications`, on a Tailor).
 * Both are a dry run by default, which calls the route with `dry_run: true` and returns its counts, writing nothing.
 * A real run (`dry_run: false`) archives leads or rewrites keys, so it needs the destructive scope and `confirm` set to the tool name. Same input and result as the routes.
 */
export function registerJobRepairs(server: McpServer, ctx: Pick<InstanceToolsCtx, "env" | "tokenFor" | "safetyFor">, pinnedInstanceId?: string): void {
	const { env, tokenFor, safetyFor } = ctx;
	const who: z.ZodRawShape = pinnedInstanceId ? {} : {
		token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		instance_id: z.string().describe("The instance ID from my_instances."),
	};
	const shape: z.ZodRawShape = {
		...who,
		dry_run: z.boolean().optional().describe("Default true: report the counts and change nothing. Pass false to apply."),
		confirm: z.string().optional().describe("Required for a real run: the tool name."),
	};
	const scopeShape: z.ZodRawShape = {
		scope: z.enum(["identity", "infrastructure_failures"]).optional().describe("identity (default): the job identity repair. infrastructure_failures: reopen leads closed unverifiable only because the engine hit its usage limit or the runner was overloaded."),
	};
	const handler = (name: string, path: string) =>
		async (input: Record<string, unknown>) => {
			const instanceId = pinnedInstanceId ?? String(input.instance_id);
			const token = pinnedInstanceId ? undefined : (input.token as string | undefined);
			const session = tokenFor(token);
			if (!session) return authRequired();
			const real = input.dry_run === false;
			const auditInput = { instance_id: instanceId, dry_run: !real };
			const denied = await requirePermission(safetyFor(token), real ? "destructive" : "write", name, auditInput);
			if (denied) return denied;
			if (real) {
				const unconfirmed = await requireConfirmation(safetyFor(token), name, input.confirm as string | undefined, name, auditInput);
				if (unconfirmed) return unconfirmed;
			}
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instanceId)}/${path}`, session, { method: "POST", body: JSON.stringify({ dry_run: !real, ...(typeof input.scope === "string" ? { scope: input.scope } : {}) }) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			if (real) await audit(safetyFor(token), { tool: name, action: "completed", input: auditInput, result: data });
			return jsonText(data);
		};
	server.tool(
		"repair_job_leads",
		"One-off, idempotent repair (#1606) of a Job Search Scout's stored leads to the current job identity: re-keys them (https, tracking parameters stripped, SEEK/Indeed/PageUp ids), links duplicates and reposts to the first lead and archives them, archives search-result pages, fills the employer of careers-site leads. Dry run by default: returns { repair: { dryRun, scanned, rekeyed, duplicatesLinked, repostsLinked, searchPagesArchived, companiesFilled, protectedKept, truncated } } and changes nothing. A real run needs dry_run=false and confirm=\"repair_job_leads\". A lead applied for is never archived. Run rekey_job_applications on the downstream Tailor first. scope=\"infrastructure_failures\" (#1611) instead reopens leads closed unverifiable where EVERY attempt failed only on the engine's usage limit or the runner's overload (no browser run read the page) back to awaiting with no attempts counted; returns { repair: { dryRun, scanned, reopened, engineQuota, runnerOverloaded, notInfrastructure, leadMovedOn, truncated } }.",
		{ ...shape, ...scopeShape },
		handler("repair_job_leads", "gmail-scout/repair-leads"),
	);
	server.tool(
		"rekey_job_applications",
		"One-off, idempotent re-key (#1609) of an Application Tailor's applications to the current job identity (seek:<id>, indeed:<jk>, pageup:<host>:<id>, else the canonical URL), so a re-alerted job cannot start a second application. Dry run by default: returns { rekey: { dryRun, scanned, rekeyed, unidentifiable, collisions } } and changes nothing. Two applications for one job are reported under collisions and left as they are: nothing is merged or deleted. A real run needs dry_run=false and confirm=\"rekey_job_applications\". Run once per Tailor instance.",
		shape,
		handler("rekey_job_applications", "job-applications/rekey"),
	);
}
