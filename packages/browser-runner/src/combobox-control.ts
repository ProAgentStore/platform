/** Native control semantics for a focus/open action, never for choosing an answer. */
export interface ComboboxControlFacts {
	tag: string;
	type: string;
	role?: string;
	submits: boolean;
	delegatesActivation?: boolean;
}
const TEXT_ENTRY_TYPES = new Set(["", "text", "search", "email", "tel", "url"]);
export function canOpenCombobox(facts: ComboboxControlFacts): boolean {
	if (facts.submits !== false || facts.delegatesActivation) return false;
	if (facts.tag === "button" || (facts.tag === "input" && facts.type === "button")) return facts.role === "combobox" && facts.type === "button";
	if (facts.tag === "input") return (!facts.role || facts.role === "combobox") && TEXT_ENTRY_TYPES.has(facts.type);
	return facts.role === "combobox" && !["select", "textarea", "option", "a"].includes(facts.tag);
}
