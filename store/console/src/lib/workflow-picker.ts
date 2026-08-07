/**
 * The creator's Workflow picker renders the SERVER's vocabulary (#375).
 *
 * It used to hold its own `<option>` list, and a picker maintained separately from the enforcer
 * drifts in both directions at once: it offered `INSURANCE_QUOTES`, which no `[[workflows]]`
 * binding backs, and omitted `BROWSER_TASK`, the only value the platform actually refuses work
 * without. So the console taught a creator a vocabulary the platform does not speak, while the
 * one they needed was reachable only through MCP `update_agent`.
 *
 * The rows now come from `GET /v1/agents/:id/capabilities` → `workflowOptions`, built by
 * `workers/api/src/lib/agent-workflows.ts` — the same table `sanitizeDeclaredCapabilities`
 * validates against. This module holds the one decision the console still has to make: what to
 * render before or without that answer.
 */

/** One row of `workflowOptions`. `value` is the wrangler binding name; "" means no brain. */
export interface WorkflowChoice {
	value: string;
	label: string;
	description: string;
	unavailable?: boolean;
}

/**
 * The rows to render, given what the server served and what this agent currently stores.
 *
 * The stored value is ALWAYS in the list. A `<select>` whose value matches no option renders as
 * its first option, so a missing row would show "none" over a config that says otherwise and
 * clear it on the next Save without anyone choosing that — the same data-loss the server's
 * `workflowChoices` avoids by flagging a value it no longer runs.
 *
 * When the vocabulary is missing entirely (the fetch failed, or this console is deployed ahead of
 * the API) the stored value is added UNLABELLED: the console does not know whether it is a real
 * workflow, and guessing is what put a dead option in front of creators in the first place. That
 * degrades the picker to "shows what you have", never to "offers something wrong".
 */
export function workflowPickerRows(served: WorkflowChoice[] | null | undefined, current: string): WorkflowChoice[] {
	const rows = Array.isArray(served) ? served : [];
	if (rows.some((r) => r.value === current)) return rows;
	return [...rows, { value: current, label: current || "none", description: "" }];
}
