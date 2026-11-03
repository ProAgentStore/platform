import { commitLabelRe, ELEMENT_PROBE_FN, FOCUS_PROBE_FN, refuseClick, refuseKey, type CommitGuardSpec, type ElementFacts, type FocusFacts } from "./commit-guard.js";

/** Owner/run policy, supplied by the runner. Never read from model tool arguments. */
export interface McpCallPolicy {
	guard?: CommitGuardSpec;
	isCancelled?: () => boolean;
}

/** Saved owner policy and a policy already seen on this task cannot be weakened by an action. */
export function taskCommitGuard(input: Record<string, unknown> | undefined, requested: CommitGuardSpec | undefined, previous: CommitGuardSpec | undefined): CommitGuardSpec | undefined {
	const mode = input?.readOnly === true || previous?.mode === "read_only" || requested?.mode === "read_only" ? "read_only"
		: input?.dryRun === true || previous?.mode === "dry_run" || requested?.mode === "dry_run" ? "dry_run" : undefined;
	if (!mode) return undefined;
	if (previous?.mode === mode) return previous;
	if (requested?.mode === mode) return { ...requested };
	return { mode };
}

export function navigationRefusal(value: unknown): string | null {
	if (value === "about:blank") return null;
	try {
		const url = new URL(String(value));
		if (url.protocol === "http:" || url.protocol === "https:") return null;
	} catch { /* An invalid URL is not permission to navigate. */ }
	return "BLOCKED by the runner — browser navigation requires an http(s) URL. Local files, executable URLs and browser-internal pages are not available to an agent.";
}

type Probe = <T>(args: Record<string, unknown>) => Promise<T | null>;
const GUARDED_TOOLS = new Set([
	"browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_wait_for", "browser_click", "browser_type",
	"browser_press_key", "browser_handle_dialog", "browser_file_upload", "browser_select_option", "browser_fill_form",
	"browser_tabs", "browser_close", "browser_resize", "browser_hover", "browser_take_screenshot", "browser_console_messages", "browser_network_requests",
]);

/** The standard tool boundary, including calls made by check/upload helper actions. */
export async function guardedToolRefusal(name: string, args: Record<string, unknown>, guard: CommitGuardSpec | undefined, probe: Probe, internal: boolean): Promise<string | null> {
	if (!internal && (name === "browser_evaluate" || name === "browser_run_code" || name === "browser_run_code_unsafe")) return "BLOCKED by the runner — arbitrary page code is reserved for the runner's own fixed probes.";
	if (name === "browser_navigate" || (name === "browser_tabs" && args.action === "new" && args.url !== undefined)) {
		const refused = navigationRefusal(args.url);
		if (refused) return refused;
	}
	if (!guard) return null;
	if (!GUARDED_TOOLS.has(name) && !(internal && name === "browser_evaluate")) return "BLOCKED by the runner — this browser tool has no approved behavior under the run's commit policy.";
	if (guard.mode === "read_only" && (name === "browser_fill_form" || name === "browser_select_option")) return "BLOCKED by the runner — this agent is READ-ONLY and cannot change form controls.";
	if (guard.mode === "read_only" && name === "browser_type") {
		const target = args.target ?? args.ref;
		const facts = typeof target === "string" ? await probe<ElementFacts>({ target, element: String(args.element ?? "field"), function: ELEMENT_PROBE_FN }) : null;
		if (!facts || facts.method === "post" || facts.type === "password" || facts.type === "file") return "BLOCKED by the runner — this agent is READ-ONLY and may type only in a search/filter field, not a write form or credential field.";
	}
	if (name === "browser_click") {
		const target = args.target ?? args.ref;
		const facts = typeof target === "string" ? await probe<ElementFacts>({ target, element: String(args.element ?? "control"), function: ELEMENT_PROBE_FN }) : null;
		return refuseClick(guard, facts, typeof args.element === "string" ? args.element : undefined, commitLabelRe(guard));
	}
	if (name === "browser_type" && args.submit === true) return "BLOCKED by the runner — implicit submission during typing is not permitted in a guarded run. Type first, then use an explicitly permitted action.";
	if (name === "browser_press_key") {
		const key = String(args.key ?? "");
		return refuseKey(guard, key, await probe<FocusFacts>({ function: `() => ${FOCUS_PROBE_FN}` }));
	}
	if (name === "browser_handle_dialog") return "BLOCKED by the runner — a guarded run cannot resolve a page dialog: accepting or dismissing it can continue a submission. Ask the owner.";
	if (name === "browser_file_upload" && guard.mode === "read_only") return "BLOCKED by the runner — this agent is READ-ONLY and cannot upload files.";
	if (!internal && name === "browser_drag") return "BLOCKED by the runner — drag actions cannot be shown to preserve this run's commit policy.";
	return null;
}
