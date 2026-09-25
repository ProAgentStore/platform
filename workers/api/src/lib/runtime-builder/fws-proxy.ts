import { HttpError } from "../auth.js";
import type { FwsToolCall, RuntimeBuilderEvidence } from "./types.js";

/** The local model is an author, never an authority to publish. */
export const FWS_AUTHORING_TOOLS = new Set([
	"list_templates", "create_site", "list_sections", "read_section", "add_section",
	"bulk_update_sections", "set_meta", "set_contact", "set_social", "get_quality_report",
	"capture_preview", "get_rendered_preview",
]);
export const FWS_DEPLOY_TOOLS = new Set(["deploy", "push_update"]);

export function assertFwsAuthoringTool(tool: unknown): string {
	if (typeof tool !== "string" || !FWS_AUTHORING_TOOLS.has(tool)) {
		if (typeof tool === "string" && FWS_DEPLOY_TOOLS.has(tool)) throw new HttpError(403, "FWS deployment is only available after PAGS approval");
		throw new HttpError(400, "FWS tool is not granted to runtime Website Builder");
	}
	return tool;
}

/**
 * Builds the relay payload for the runner. OAuth tokens and consent are deliberately absent:
 * the runner receives only a PAGS-issued, tool-scoped proxy description.
 */
export function fwsProxyInput(runId: string, mcpUrl: string): Record<string, unknown> {
	return { runId, mcpUrl, allowedTools: [...FWS_AUTHORING_TOOLS], deploymentRequiresPagsApproval: true };
}

export function appendFwsEvidence(evidence: RuntimeBuilderEvidence, call: FwsToolCall): RuntimeBuilderEvidence {
	return { ...evidence, fwsTranscript: [...evidence.fwsTranscript, call].slice(-200) };
}

/** capture_preview must prove both responsive layouts, not just provide a preview URL. */
export function hasVisualQa(evidence: RuntimeBuilderEvidence): boolean {
	const devices = new Set(evidence.screenshots.map((s) => s.device));
	return devices.has("desktop") && devices.has("mobile") && !!evidence.qualityReport;
}
