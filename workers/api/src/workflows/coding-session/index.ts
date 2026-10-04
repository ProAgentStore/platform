import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { CodingResult } from "../../lib/coding-loop.js";
import { runWatchSession } from "../coding-watch.js";
import type { CodingSessionParams } from "../coding-session-params.js";
import { runCodingSessionWorkflow } from "./workflow-run.js";
import type { Env } from "../../types.js";

export type { CodingSessionParams } from "../coding-session-params.js";

export class CodingSessionWorkflow extends WorkflowEntrypoint<Env, CodingSessionParams> {
	async run(event: WorkflowEvent<CodingSessionParams>, step: WorkflowStep): Promise<CodingResult> {
		if (event.payload.mode === "watch") return runWatchSession(this.env, event, step);
		return await runCodingSessionWorkflow(this.env, event, step);
	}
}
