/**
 * How an application run launches its CLI (#957). The research launch (`local-browser/engine.ts`) —
 * no built-in web or shell tools, the bridge as the only MCP server — with two differences:
 *
 *  - Codex pre-approves the APPLY bridge's own tool names, not the research set;
 *  - subscription-only, like the Tailor: provider API keys are always stripped, `machine` also
 *    drops the Claude subscription token, and the runtime refuses a run whose spawn env would
 *    still carry a key.
 */
import { artifactEngineEnv, observedArtifactAuth } from "../local-artifact/engine.js";
import { type BridgeLaunch, type EngineSpec, buildEngineSpec, BRIDGE_SERVER_NAME } from "../local-browser/engine.js";
import { APPLY_BRIDGE_TOOL_NAMES } from "./bridge.js";
import type { LocalApplyTaskEnvelope } from "./contract.js";

export { observedArtifactAuth as observedApplyAuth };

export function buildApplyEngineSpec(e: LocalApplyTaskEnvelope, prompt: string, bridge: BridgeLaunch, mcpConfigPath: string): EngineSpec {
	return buildEngineSpec({
		engine: e.engine,
		authMode: e.authMode,
		prompt,
		bridge,
		mcpConfigPath,
		toolTimeoutMs: e.limits.maxMinutes * 60_000,
		baseEnv: artifactEngineEnv(e.authMode),
		toolNames: APPLY_BRIDGE_TOOL_NAMES,
	});
}

export interface SourceBlock {
	label: string;
	text: string;
}

/** The brief. The bridge, not this text, is what enforces the rules. */
export function applyPrompt(e: LocalApplyTaskEnvelope, sources: readonly SourceBlock[]): string {
	const t = (name: string) => `mcp__${BRIDGE_SERVER_NAME}__${name}`;
	const job = [`Title: ${e.job.title}`, e.job.company ? `Company: ${e.job.company}` : "", e.job.location ? `Location: ${e.job.location}` : "", `Application page: ${e.applicationUrl}`].filter(Boolean).join("\n");
	const finish =
		e.policy.mode === "auto_submit"
			? `- When every field you can ground is filled and the documents are attached, you may press the final submit button ONCE. If anything is uncertain, call ${t("ready_for_review")} instead.`
			: `- Do NOT submit. When every field you can ground is filled and the documents are attached, call ${t("ready_for_review")} with a short summary and stop.`;
	return [
		"You fill in ONE job application for the owner of this machine, in their browser, from their own information.",
		"",
		"<job>",
		job,
		"</job>",
		"",
		...sources.map((s) => `<source name="${s.label}">\n${s.text}\n</source>\n`),
		"How to work:",
		`- Your only tools are from the ${BRIDGE_SERVER_NAME} server. Open the application page with ${t("browser_navigate")}, read it with ${t("browser_snapshot")}, and act on elements by their ref.`,
		`- Before any fill, upload, form-step click, or final submit, call ${t("supervisor_checkpoint")} and wait for its persisted continue directive. Call it after the initial snapshot (phase initial), after every page-changing move (phase post_navigation), and immediately before a final submit (phase before_submit). Use a stable safe checkpointId for each point. A page change clears the previous approval; request_review and stop end the run locally.`,
		`- Every answer — ${t("browser_type")}, ${t("browser_select_option")}, or a click on a checkbox, radio or option — must carry source_quote: the exact text from a source above that the value comes from. Type values exactly as the source writes them.`,
		`- If a question has no answer in the sources, or is ambiguous, call ${t("request_answer")}. Never guess, never invent, never pick a "safe" default.`,
		`- To attach a document, click the field's upload control, then call ${t("upload_artifact")} with kind resume or cover_letter.`,
		"- Never sign in, solve a captcha, accept terms or work around any block; the run pauses for the owner by itself.",
		`- If a fresh snapshot shows the job itself is expired, closed or unavailable, call ${t("report_job_unavailable")} with reason expired or unavailable. The runner will independently verify the page notice; do not report it from inference alone.`,
		`- Stay on the application's site. Limits: ${e.limits.maxPages} pages, ${e.limits.maxActions} browser actions, ${e.limits.maxMinutes} minutes.`,
		finish,
	].join("\n");
}
