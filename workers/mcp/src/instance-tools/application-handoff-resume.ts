import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/** Resume the exact owner handoff through the same route as the console (#1569). */
export function registerApplicationHandoffResume(server: McpServer, ctx: Pick<InstanceToolsCtx, "env" | "tokenFor" | "safetyFor">, pinnedInstanceId?: string): void {
	const { env, tokenFor, safetyFor } = ctx;
	const who: z.ZodRawShape = pinnedInstanceId ? {} : {
		token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		instance_id: z.string().min(1).describe("The Application Runner instance that owns this exact run."),
	};
	server.tool(
		"resume_application_handoff",
		"Return control from an existing exact-owner Application Runner browser handoff to the paused AI run. Copy run_id and handoff_id from the current handoff. The existing owner-scoped route checks run and handoff identity, closes owner control through the Runner, then resumes that same run. Stale, expired, closed or lost handoffs are refused; there is no fallback or fresh fill. Does not supply answers, authorize submission or change frozen submission permission. Full browser mode retains its accepted arbitrary-code risks. Use dry_run first.",
		{
			...who,
			run_id: z.string().min(1).describe("The exact existing Application Runner fill run id."),
			handoff_id: z.string().min(1).describe("The opaque continuity id returned by create_application_handoff for this exact run."),
			dry_run: z.boolean().optional(),
		},
		async (input: Record<string, unknown>) => {
			const instance_id = pinnedInstanceId ?? String(input.instance_id);
			const token = pinnedInstanceId ? undefined : input.token as string | undefined;
			const session = tokenFor(token);
			if (!session) return authRequired();
			const run_id = String(input.run_id);
			const handoff_id = String(input.handoff_id);
			const auditInput = { instance_id, run_id, handoff_id };
			const denied = await requirePermission(safetyFor(token), "runtime", "resume_application_handoff", auditInput);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/application-runs/${encodeURIComponent(run_id)}/handoff/resume?handoff_id=${encodeURIComponent(handoff_id)}`;
			if (input.dry_run) return dryRun(safetyFor(token), "resume_application_handoff", "close owner control and resume the exact existing application run", auditInput, { endpoint, method: "POST", body: {}, effect: "The Runner must close this exact live handoff before continuing the same paused run. No new run or submission permission is created." });
			const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/application-runs/${encodeURIComponent(run_id)}/handoff/resume?handoff_id=${encodeURIComponent(handoff_id)}`, session, { method: "POST", body: "{}" }, env) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "resume_application_handoff", action: "completed", input: auditInput });
			return jsonText(data);
		},
	);
}
