// Which coding engine an instance runs, and which model (#792).
//
// An owner whose run burned one model's usage window had no way — here or in the console — to
// say "use another one" ahead of time; `engine_id` on `coding_session_open` chooses per call, and
// the run that mattered was one nobody opened by hand. These two are the instance's standing
// choice. They read and write the SAME state as the console's CLI engines panel
// (`defaultEngineId`, and the model as a flag in the preset's own command), so there is no
// second setting to disagree with what launches — the failure migration 0126 records.
//
// Its own file rather than two more blocks in `coding-tools.ts`, which they took past the #302
// size limit. `registerCodingSessionTools` calls this from the position the blocks occupied, so
// the published tool order did not move.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, type McpEnv, jsonText } from "./http.js";
import { audit, dryRun, requirePermission, type SafetyContext } from "./safety.js";

export function registerCodingEngineTools(
	server: McpServer,
	env: McpEnv,
	tokenFor: (provided?: string) => string | null,
	safetyFor: (provided?: string) => SafetyContext,
): void {
	server.tool(
		"coding_engine_get",
		"Which coding CLI this instance opens sessions with, and which model it runs. Answers `{defaultEngineId, engines, lastObserved, appliesTo}`: each engine has its `id`, launch `command`, the `model` that command pins (null = the CLI's own default), `modelSelectable`, and `suggestions` (aliases the CLI documents; any id the CLI accepts also works). `lastObserved` is the model the most recent MEASURED engine turn actually ran — observed from the CLI's usage report, not read from the setting — or null when none is recorded. Read this before coding_engine_set.",
		{
			instance_id: z.string().describe("Instance ID"),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "coding_engine_get", { instance_id });
			if (denied) return denied;
			return jsonText(await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/coding/engine-choice`, sessionToken, {}, env));
		},
	);

	server.tool(
		"coding_engine_set",
		"Choose which coding CLI this instance opens sessions with, and optionally the model it runs — e.g. switch to another engine, or off a model whose usage limit is spent. `engine_id` must be an `id` that coding_engine_get returned. `model`: omit to leave the engine's command as it is, pass an id or alias to pin it (written as `--model` into that engine's launch command), or an empty string to hand the choice back to the CLI. Takes effect on the NEXT session: one already running keeps the engine it was started with until coding_session_restart or coding_session_fresh. An unknown engine, an invalid model id, or a model on an engine with no known model flag is refused, and nothing is written.",
		{
			instance_id: z.string().describe("Instance ID"),
			engine_id: z.string().describe("Engine preset id, from coding_engine_get."),
			model: z.string().optional().describe("Model id or alias to pin. Empty string = the CLI's own default. Omit to leave the command unchanged."),
			dry_run: z.boolean().optional().describe("Report what would be written, without writing it."),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, engine_id, model, dry_run, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, engine_id, model };
			const denied = await requirePermission(safetyFor(token), "write", "coding_engine_set", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "coding_engine_set", "choose the instance's coding engine and model", input, {
					endpoint: `/v1/instances/${instance_id}/coding/engine-choice`,
					method: "PUT",
					effect: `${instance_id} would open its next coding session with engine "${engine_id}"${model === undefined ? ", its command unchanged" : model === "" ? ", on the CLI's own default model" : `, pinned to model "${model}"`}. A session already running is not touched.`,
				});
			}
			const body = model === undefined ? { engineId: engine_id } : { engineId: engine_id, model: model === "" ? null : model };
			const r = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/coding/engine-choice`, sessionToken, { method: "PUT", body: JSON.stringify(body) }, env)) as { error?: string };
			if (!r.error) await audit(safetyFor(token), { tool: "coding_engine_set", action: "completed", input, result: { ok: true } });
			return jsonText(r);
		},
	);
}
