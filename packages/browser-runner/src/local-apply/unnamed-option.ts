import { ELEMENT_PROBE_FN, type ElementFacts } from "../commit-guard.js";
import { type BrowserTools, evaluateResult } from "../local-browser/bridge.js";
import type { ExpectedAccessibility } from "../native-accessibility.js";
import { classifyApplyClick } from "./contract.js";

/** A model's answer is a candidate; the native dispatch must still prove this exact ref has that name. */
export async function unnamedOptionAnswer(browser: BrowserTools, ref: string, value: unknown): Promise<{ value: string; expected: ExpectedAccessibility } | { error: string }> {
	if (typeof value !== "string" || !value.trim()) return { error: "This option's name is omitted from the snapshot. Supply answer_value with its complete observed option label and source_quote from the owner's information. Do not guess or click a text descendant instead." };
	const result = await browser.callTool("browser_evaluate", { target: ref, element: "observed option", function: ELEMENT_PROBE_FN }, { internal: true }).catch(() => null);
	const facts = result && !result.isError ? evaluateResult((result.content ?? []).map((block) => block.text ?? "").join("\n")) as ElementFacts | null : null;
	if (facts?.submits !== false || (facts.role !== "option" && facts.tag !== "option")) return { error: "This ref is not currently a non-submitting option. Take a fresh snapshot; no answer was clicked." };
	const classified = classifyApplyClick({ role: "option", names: [facts.name, value], submits: facts.submits, method: facts.method, filled: 0, uploaded: 0 });
	if (classified.klass === "submit") return { error: "An option answer cannot authorize a submission. No answer was clicked." };
	return { value, expected: { role: "option", name: value } };
}
