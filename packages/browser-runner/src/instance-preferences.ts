import { RunnerInputError } from "./errors.js";
import { type InstancePreferences, type InstancePreferenceField, parseInstancePreferences } from "./instance-preferences-contract.js";

export interface PreferenceSource { text: string; label?: string; role?: string; answerText?: string; answerQuestion?: string }
export type PreferenceField = InstancePreferenceField | "salary_super_basis" | "disclosures";
export type PreferenceDecision = { kind: "legacy" | "allow" } | { kind: "refuse"; reason: string };
const canonical = (s: string) => s.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
const roleOf = (s: PreferenceSource) => s.label ?? s.role;

export function validatePreferences(raw: unknown, instanceId: string, now = Date.now()): InstancePreferences | undefined {
	if (raw === undefined) return undefined;
	const parsed = parseInstancePreferences(raw, instanceId, now);
	if ("error" in parsed) throw new RunnerInputError(`Invalid instance preferences: ${parsed.error}`);
	return parsed;
}

/** Closed screening identities; no inference from a bare answer such as No or Immediately. */
export function preferenceField(label: string): PreferenceField | null {
	const name = canonical(label);
	if (/\b(disclos(?:e|ure|ures)|conflicts? of interest|criminal|convictions?)\b/.test(name)) return "disclosures";
	if (/\b(salary|remuneration|pay expectation|compensation)\b/.test(name)) return /\b(super|superannuation|package)\b/.test(name) ? "salary_super_basis" : "salary_expectation";
	if (/employment[ _-]?type|preferred working arrangement|employment arrangement|full.?time.*part.?time/.test(name)) return "employment_type";
	if (/availability|available.*start|how soon.*start|notice period|commencement date/.test(name)) return "availability";
	if (/planned_holidays_next_6_months|(?:holidays?|planned leave).*(?:6|six|next).*months?/.test(name)) return "planned_holidays_next_6_months";
	if (/recruitment_adjustments_needed|(?:recruitment|interview|application|process).*adjustments?|adjustments?.*(?:recruitment|interview|application|process)|^adjustments needed$/.test(name)) return "recruitment_adjustments_needed";
	return null;
}

const profileKeys: Record<string, PreferenceField> = {
	"salary expectation": "salary_expectation", "expected salary": "salary_expectation", "salary_expectation": "salary_expectation",
	"employment type": "employment_type", "employment_type": "employment_type",
	"availability": "availability", "notice period": "availability", "start availability": "availability",
	"planned holidays next 6 months": "planned_holidays_next_6_months", "planned_holidays_next_6_months": "planned_holidays_next_6_months",
	"recruitment adjustments needed": "recruitment_adjustments_needed", "recruitment_adjustments_needed": "recruitment_adjustments_needed",
};

export function preferencesSourceText(p: InstancePreferences): string {
	const safe = JSON.stringify({ version: p.version, source: p.source, instanceId: p.instanceId, memoryKey: p.memoryKey, memoryUpdatedAt: p.memoryUpdatedAt, sha256: p.sha256, facts: p.facts, pendingFields: p.pendingFields ?? [] }, null, 2).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
	return `<owner_confirmed_facts>\n${safe}\n</owner_confirmed_facts>`;
}

export function preferenceReceipt(p: InstancePreferences) {
	return { role: "instance_preferences", path: `instance/${p.instanceId}/${p.memoryKey}@${p.memoryUpdatedAt}`, sha256: p.sha256, count: p.facts.length };
}

/** Only the in-memory view changes. Callers keep original blocks for byte-identical exports. */
export function projectPreferenceSources<T extends PreferenceSource>(sources: readonly T[], p: InstancePreferences | undefined, key?: "label"): Array<T | (PreferenceSource & { label: "instance_preferences" })>;
export function projectPreferenceSources<T extends PreferenceSource>(sources: readonly T[], p: InstancePreferences | undefined, key: "role"): Array<T | (PreferenceSource & { role: "instance_preferences" })>;
export function projectPreferenceSources(sources: readonly PreferenceSource[], p: InstancePreferences | undefined, key: "label" | "role" = "label"): PreferenceSource[] {
	if (!p) return sources.map((source) => ({ ...source }));
	const active = new Set(p.facts.map((fact) => fact.field));
	const projected = sources.map((source) => {
		if (roleOf(source) === "profile") return { ...source, text: source.text.split(/\r?\n/).filter((line) => {
			const colon = line.indexOf(":");
			const field = colon >= 0 ? profileKeys[canonical(line.substring(0, colon)).replace(/^[-*]\s*/, "").replace(/\*\*/g, "")] : undefined;
			return !field || !active.has(field as InstancePreferenceField);
		}).join("\n") };
		// Tailor's legacy account-wide Q+A is historical, not a current application answer.
		if (roleOf(source) === "owner_answers") return { ...source, text: source.text.split(/\r?\n\s*\r?\n/).filter((pair) => {
			const question = pair.split(/\r?\n/)[0]?.replace(/^Q:\s*/, "") ?? "";
			const field = preferenceField(question);
			return !field || !active.has(field as InstancePreferenceField);
		}).join("\n\n") };
		return { ...source };
	});
	projected.push({ [key]: "instance_preferences", text: preferencesSourceText(p) });
	return projected;
}

function valueMatches(value: string, answer: string, field: PreferenceField): boolean {
	const wanted = canonical(value), fact = canonical(answer);
	if (wanted === fact) return true;
	if (field === "employment_type") return wanted.replace(/[ -]/g, "") === fact.replace(/[ -]/g, "") && /^(fulltime|parttime|casual)$/.test(wanted.replace(/[ -]/g, ""));
	return false;
}

/** Scoped new-source precedence. Existing fields with no preference retain their existing guard. */
export function preferenceDecision(input: { preferences?: InstancePreferences; fieldLabel: string | null; value: string; sourceQuote: unknown; sources: readonly PreferenceSource[]; now?: number }): PreferenceDecision {
	const p = input.preferences;
	if (!p) return { kind: "legacy" };
	const checked = parseInstancePreferences(p, p.instanceId, input.now ?? Date.now());
	if ("error" in checked) return { kind: "refuse", reason: checked.error };
	const q = typeof input.sourceQuote === "string" ? canonical(input.sourceQuote) : "";
	const field = input.fieldLabel ? preferenceField(input.fieldLabel) : null;
	const preferenceQuote = !!q && input.sources.some((source) => roleOf(source) === "instance_preferences" && canonical(source.text).includes(q));
	if (!field) return preferenceQuote ? { kind: "refuse", reason: "This preference needs the website's associated screening question; a bare option cannot identify which fact it answers." } : { kind: "legacy" };
	const question = (value: string) => canonical(value).replace(/[?:*\s]+$/, "").trim();
	const owner = input.sources.filter((source) => source.answerText !== undefined && source.answerQuestion !== undefined && question(source.answerQuestion) === question(input.fieldLabel ?? ""));
	if (owner.length) {
		const answers = new Set(owner.map((source) => canonical(source.answerText ?? "")));
		if (answers.size !== 1) return { kind: "refuse", reason: "Application-specific answers conflict for this screening field. Ask the owner to clarify." };
		return owner.some((source) => !!q && canonical(source.text).includes(q) && q.includes(canonical(source.answerText ?? "")) && valueMatches(input.value, source.answerText ?? "", field))
			? { kind: "allow" } : { kind: "refuse", reason: "Use the actual application-specific answer for this field, not an older profile or preference." };
	}
	if (field === "salary_super_basis" || field === "disclosures") return { kind: "refuse", reason: "This question remains unanswered: salary super basis and disclosures cannot be inferred from another preference. Call request_answer." };
	const fact = p.facts.find((item) => item.field === field);
	if (!fact) return preferenceQuote ? { kind: "refuse", reason: "The quoted preference answers a different screening field. Call request_answer." } : { kind: "legacy" };
	return preferenceQuote && q.includes(canonical(fact.answer)) && valueMatches(input.value, fact.answer, field)
		? { kind: "allow" } : { kind: "refuse", reason: "A fresh owner-confirmed instance preference supersedes older values for this field. Quote that fact exactly; if the website asks something different, call request_answer." };
}

/** Native field association; caller-supplied labels and page instructions do not establish it. */
export const PREFERENCE_FIELD_PROBE_FN = `(el) => {
 const doc = el.ownerDocument;
 const labels = [];
 const add = (node) => {
  if (!node) return;
  const ids = (node.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
  const named = ids.map(id => doc.getElementById(id)?.textContent || '').join(' ').trim();
  if (named) labels.push(named);
  if (node.getAttribute('aria-label')) labels.push(node.getAttribute('aria-label'));
  if (node.labels) for (const label of node.labels) labels.push(label.textContent || '');
 };
 add(el);
 const select = el.closest('select'); if (select) add(select);
 const group = el.closest('[role="listbox"], [role="radiogroup"], fieldset');
 if (group) {
  add(group);
  const legend = group.querySelector(':scope > legend'); if (legend) labels.push(legend.textContent || '');
  if (group.id) for (const control of doc.querySelectorAll('[aria-controls], [aria-owns]')) {
   if ((control.getAttribute('aria-controls') || '').split(/\\s+/).includes(group.id) || (control.getAttribute('aria-owns') || '').split(/\\s+/).includes(group.id)) add(control);
  }
 }
 return { labels: [...new Set(labels.map(label => label.trim()).filter(Boolean))] };
}`;
