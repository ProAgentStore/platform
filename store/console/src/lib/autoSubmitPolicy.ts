/**
 * Standing auto-submit, made unmistakable (#1039). Pure: the words, the rule summary and the exact
 * request bodies the console sends — so they are tested as data, and stay the same three requests the
 * server and MCP's set_application_runner_settings accept.
 *
 * Manual review (fill_and_review) is the default. Enabling auto-submit needs the owner's explicit
 * acknowledgement — `acknowledgeRealSubmissions: true`, which the server requires and stamps as
 * `autoSubmit.acknowledgedAt` — and disabling is one request that needs nothing.
 */
export const AUTO_SUBMIT_WARNING =
	"Auto-submit sends real, irreversible job applications to third-party sites on your behalf. These cannot be undone once submitted.";
export const AUTO_SUBMIT_ACKNOWLEDGEMENT = "I understand that auto-submit will submit real job applications that cannot be undone";
export const AUTO_SUBMIT_DANGER = "Auto-submit is ON — real applications are being submitted automatically";

export interface AutoSubmitRules {
	allowDomains: string[];
	roles: string[];
	locations: string[];
	exclude: string[];
	minSalary: number | null;
	dailyCap: number;
}

/** The queue's per-Runner allowance (`limits` in the applications view). */
export interface AutoSubmitAllowance {
	dailyCap: number;
	usedToday: number;
	remaining: number;
}

const listed = (items: string[], empty: string) => (items.length ? items.join(", ") : empty);

/**
 * Every rule an application must match to be submitted without review, in the order the server's gate
 * checks them — and the allowance left today. Nothing is summarised away: an empty list says what it
 * means ("any location", "nothing excluded") rather than disappearing.
 */
export function buildPolicySummary(rules: AutoSubmitRules, allowance?: AutoSubmitAllowance | null): Array<{ label: string; value: string }> {
	const cap = rules.dailyCap;
	const used = allowance?.usedToday ?? null;
	return [
		{ label: "Allowed sites", value: listed(rules.allowDomains, "none — no application qualifies") },
		{ label: "Approved roles", value: listed(rules.roles, "none — no application qualifies") },
		{ label: "Locations", value: listed(rules.locations, "any location") },
		{ label: "Excluded when the job mentions", value: listed(rules.exclude, "nothing excluded") },
		{ label: "Minimum salary", value: rules.minSalary === null ? "no minimum" : rules.minSalary.toLocaleString("en-US") },
		{ label: "Daily cap", value: `${cap} per 24 hours` },
		{ label: "Remaining today", value: used === null ? "not known yet" : `${Math.max(0, cap - used)} of ${cap}` },
	];
}

/** The ONE request that turns auto-submit on: the rules shown in the confirmation, and the acknowledgement. */
export function enablePayload(rules: AutoSubmitRules): Record<string, unknown> {
	return {
		allowDomains: rules.allowDomains,
		autoSubmit: { enabled: true, roles: rules.roles, locations: rules.locations, exclude: rules.exclude, minSalary: rules.minSalary, dailyCap: rules.dailyCap },
		acknowledgeRealSubmissions: true,
	};
}

/** One click, nothing else: turning auto-submit off never needs a confirmation. */
export function disablePayload(): Record<string, unknown> {
	return { autoSubmit: { enabled: false } };
}

/** Saving the rules never changes whether auto-submit is on — that is only enable/disable above. */
export function rulesPayload(rules: AutoSubmitRules, sources: { profile: string | null; answers: string | null }): Record<string, unknown> {
	return {
		sources,
		allowDomains: rules.allowDomains,
		autoSubmit: { roles: rules.roles, locations: rules.locations, exclude: rules.exclude, minSalary: rules.minSalary, dailyCap: rules.dailyCap },
	};
}
