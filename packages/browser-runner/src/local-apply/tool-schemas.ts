import { QUESTION_ASSESSMENT_SCHEMA } from "./question-assessment.js";
import { LOCAL_APPLY_CAPS } from "./contract.js";
import { ANSWER_DECISION_SCHEMA, DECISION_SCHEMA } from "./answer-decision.js";
const QUOTE_PROP = { type: "string", description: "The exact text from the owner's profile, answers or materials that this answer comes from. Required. Literal answers must appear in it; delegated interpretations also need decision with trusted sourceId." };

/** A browser tool's schema with `source_quote` added — the CLI must say where an answer comes from. */
export function withQuote(schema: unknown, required: boolean, extra: Record<string, unknown> = {}): unknown {
	const s = (schema && typeof schema === "object" ? schema : { type: "object" }) as { properties?: Record<string, unknown>; required?: string[] };
	return { ...s, type: "object", properties: { ...(s.properties ?? {}), source_quote: QUOTE_PROP, decision: ANSWER_DECISION_SCHEMA, ...extra }, ...(required ? { required: [...(s.required ?? []), "source_quote"] } : {}) };
}

const READ_TOOLS = new Set(["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_wait_for", "browser_take_screenshot"]);
const FILL_TOOLS = new Set(["browser_type", "browser_select_option"]);

export function applyTools(nativeTools: Array<{ name: string; description?: string; inputSchema: unknown }>, visionEnabled: boolean): Array<{ name: string; description?: string; inputSchema: unknown }> {
	const own = nativeTools.filter((t) => t.name !== "browser_take_screenshot" && (READ_TOOLS.has(t.name) || FILL_TOOLS.has(t.name) || t.name === "browser_click" || t.name === "browser_press_key"));
	const tools = own.map((t) => {
		if (t.name === "browser_click")
			return { ...t, description: "Click an observed control. Answers need source_quote. To focus/open a combobox or use a non-submit editor button, declare action_intent=edit_form only when live context establishes local form editing, never consent, sharing or submission. Verify the resulting state. Submission policy cannot be overridden by intent.", inputSchema: withQuote(t.inputSchema, false, { action_intent: { type: "string", enum: ["edit_form"], description: "Required for generic editor buttons and combobox focus/open: local noncommitting form editing only. Opening is not answering; take a fresh snapshot before choosing an option with source_quote. Never terms/consent, sharing, submission or unrelated actions. This declaration cannot override submission policy." }, answer_value: { type: "string", description: "For an option whose name is omitted from the snapshot: its complete observed accessible label. Requires source_quote. The runner verifies this exact ref and native name; never supply a guessed label or an internal value." } }) };
		if (t.name === "browser_press_key") return { ...t, description: "Press Tab, Shift+Tab, an arrow key, Escape, Home/End or PageUp/PageDown. Nothing that types or submits." };
		if (FILL_TOOLS.has(t.name)) return { ...t, ...(t.name === "browser_select_option" ? { description: "Select options in a native HTML select only. For custom comboboxes/autocomplete, use current observed option clicks or supported keyboard interactions, then verify fresh evidence. Requires source_quote." } : {}), inputSchema: withQuote(t.inputSchema, true) };
		return t;
	});
	return [
		...tools,
		...(visionEnabled ? [{ name: "browser_take_screenshot", description: "Read current viewport pixels when a snapshot does not explain layout, a control or feedback. Uses the run's screenshot privacy settings. Refresh the snapshot for actionable element refs.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] : []),
		{
			name: "upload_artifact",
			description: "Attach an approved document. Obtain the page's supervisor approval before clicking its upload control, then complete the opened chooser with this tool. A same-page chooser retains that approval; do not insert another checkpoint or page read. Each document can be selected once; verify website acceptance afterward.",
			inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["resume", "cover_letter"] } }, required: ["kind"] },
		},
		{
			name: "request_answer",
			description: "Record or reassess a source-missing question without inventing an answer. An optional assessment with current evidence, verified safe omission and delegated risk may remain blank without blocking submission. Required, material and unknown omissions remain blockers. Autonomous runs defer blockers and continue independent work; other levels ask the owner.",
			inputSchema: { type: "object", properties: { question: { type: "string", maxLength: LOCAL_APPLY_CAPS.questionChars }, assessment: QUESTION_ASSESSMENT_SCHEMA, kind: { type: "string", enum: ["missing_answer", "screening_ambiguity"] } }, required: ["question"] },
		},
		{
			name: "ready_for_review",
			description: "The form is filled as far as the sources allow. Stop here; the owner reviews it. Call once, last.",
			inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
		},
		{
			name: "supervisor_checkpoint",
			description: "Obtain supervisor approval after the initial snapshot, after page changes, or immediately before final submission. Choose a stable checkpointId. A continue covers subsequent same-page fills and uploads. Do not insert this into an already approved file-chooser upload. For uncertain, include decision risk and reason; the owner escalation setting determines whether that decision needs review. request_review and stop end the run.",
			inputSchema: { type: "object", properties: { checkpointId: { type: "string", minLength: 1, maxLength: 300 }, phase: { type: "string", enum: ["initial", "post_navigation", "before_submit", "uncertain"] }, decision: DECISION_SCHEMA }, required: ["checkpointId", "phase"], additionalProperties: false },
		},
		{
			name: "report_job_unavailable",
			description: "End the run when a fresh browser snapshot shows that this job is expired, closed or unavailable. The runner independently verifies the page notice; it refuses unsupported reports.",
			inputSchema: { type: "object", properties: { reason: { type: "string", enum: ["expired", "unavailable"] } }, required: ["reason"] },
		},
		{
			name: "request_sign_in_code",
			description: "Only while PAGS has asked you to sign in: after clicking the button that emails a sign-in code, call this and wait. When it returns, type the name PAGS_LOGIN_CODE into the code box; the runner substitutes the code.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		},
	];
}

/** Independent observation/reconciliation helpers do not replace or rewrite native tools. */
export function recoveryTools(vision: boolean, recover: boolean) {
	return [
		...(vision ? [{ name: "browser_read_screenshot", description: "Read fresh current-page pixels directly, independently of native MCP transport. Use after native timeouts or when snapshots cannot explain the page. Obeys frozen screenshot privacy, page identity and Stop. Read-only; does not replay or settle an uncertain action.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] : []),
		...(recover ? [{ name: "browser_recover", description: "Reconcile an unhealthy native transport without repeating the failed action or replacing the browser context. Pending actions remain quarantined. Read the recovery evidence, then inspect current state before deciding any new action.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] : []),
	];
}
