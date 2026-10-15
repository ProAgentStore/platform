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

/** Session-identifying argument names a FreeWebStore call may carry. */
const SESSION_ARGS = ["session_id", "sessionId"] as const;

/**
 * Bind a call to THIS run's draft (PR842 review): the run's credential authorizes one draft, not every
 * draft the owner's FreeWebStore account can reach.
 *
 *   list_templates  takes no session — any session argument is dropped;
 *   create_site     only while the run has no session yet, and never naming one (it makes a new
 *                   session; it does not adopt an existing one);
 *   everything else needs the run's own session — supplied when the call names none, refused (403)
 *                   when it names another. Before create_site there is nothing to work on (409).
 */
export function bindRunSession(sessionId: string | null | undefined, tool: string, args: Record<string, unknown>): Record<string, unknown> {
	const named = SESSION_ARGS.filter((k) => k in args);
	const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !(SESSION_ARGS as readonly string[]).includes(k)));
	if (tool === "list_templates") return rest;
	if (tool === "create_site") {
		if (sessionId) throw new HttpError(409, `This run already has its draft (session ${sessionId}); one run builds one draft.`);
		if (named.length) throw new HttpError(403, "create_site starts a new draft; it cannot adopt an existing session.");
		return rest;
	}
	if (!sessionId) throw new HttpError(409, "This run has no draft yet: call create_site first.");
	if (named.some((k) => args[k] !== sessionId)) throw new HttpError(403, "This run may only work on its own draft session.");
	return { ...rest, session_id: sessionId };
}
