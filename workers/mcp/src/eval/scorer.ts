/**
 * Scoring one eval call (#1244). Pure: it reads what the tool answered and what the stubbed API received, nothing else.
 *
 * FIRST-CALL SUCCESS is the strict measure: the first call named the right tool, was valid as sent, needed no rewrite or retry, and
 * did the thing. Any #1241 note — a renamed key, a converted list, a coerced boolean, an argument dropped — means the schema or
 * description misled the caller, so it is NOT a first-call success even though the server recovered. `effective` is the lenient
 * companion: did the task get done at all, notes or not. The gap between them is what the server's tolerance is hiding.
 */
import type { ToolCall } from "./driver.js";

export interface Recorded {
	method: string;
	path: string;
	body: unknown;
}

/** What a task is for, in terms of the stubbed API: the request that proves it was done. `null` = the tool answers without the API. */
export interface Effect {
	method: string;
	path: RegExp;
	/** Every key here must be present, equal, in the JSON body that was sent. */
	body?: Record<string, unknown>;
}

export interface CallOutcome {
	isError: boolean;
	texts: string[];
	requests: Recorded[];
}

export interface CallScore {
	tool: string;
	toolMatches: boolean;
	/** The stubbed API received the request that does the task. */
	effective: boolean;
	/** Number of "Note:" lines the reply carried (#1241 alias/coercion/unknown-argument notes). */
	notes: number;
	/** The reply says the tool name is a deprecated alias (#1243). */
	deprecated: boolean;
	invalidInput: boolean;
	unknownTool: boolean;
	isError: boolean;
	firstCallSuccess: boolean;
	noteText: string[];
}

const NOTE_BLOCK = /^Note:\n((?:- .*(?:\n|$))+)/;
export const DEPRECATED = /This tool name is deprecated/;
// Matched anywhere in the reply, not anchored: the SDK has framed these refusals differently across revisions ("MCP error -32602: Input
// validation error…"), and the eval must read an older checkout's replies too. The call audit classifies by the same phrase.
export const INVALID_INPUT = /Input validation error/;
export const UNKNOWN_TOOL = /Tool \S+ not found/;

export function effectHappened(effect: Effect | null, requests: readonly Recorded[]): boolean {
	if (effect === null) return true;
	return requests.some((r) => {
		if (r.method !== effect.method || !effect.path.test(r.path)) return false;
		if (!effect.body) return true;
		let sent: unknown = r.body;
		if (typeof sent === "string") {
			try {
				sent = JSON.parse(sent);
			} catch {
				return false;
			}
		}
		return !!sent && typeof sent === "object" && Object.entries(effect.body).every(([k, v]) => JSON.stringify((sent as Record<string, unknown>)[k]) === JSON.stringify(v));
	});
}

export function scoreCall(expected: { tool: string; effect: Effect | null }, call: ToolCall | null, out: CallOutcome | null): CallScore {
	const texts = out?.texts ?? [];
	const head = texts[0] ?? "";
	const noteText = texts.flatMap((t) => {
		const m = NOTE_BLOCK.exec(t);
		return m ? m[1].split("\n").filter(Boolean).map((l) => l.replace(/^- /, "")) : [];
	});
	const invalidInput = INVALID_INPUT.test(head);
	const unknownTool = UNKNOWN_TOOL.test(head);
	const deprecated = texts.some((t) => DEPRECATED.test(t));
	const toolMatches = call?.name === expected.tool;
	const effective = !!out && !out.isError && effectHappened(expected.effect, out.requests) && !invalidInput && !unknownTool;
	return {
		tool: call?.name ?? "(no call)",
		toolMatches,
		effective,
		notes: noteText.length,
		deprecated,
		invalidInput,
		unknownTool,
		isError: out?.isError ?? true,
		firstCallSuccess: toolMatches && effective && noteText.length === 0 && !deprecated,
		noteText,
	};
}

export interface Totals {
	calls: number;
	firstCallSuccess: number;
	effective: number;
	noted: number;
	deprecated: number;
	invalidInput: number;
	unknownTool: number;
	wrongTool: number;
}

export const emptyTotals = (): Totals => ({ calls: 0, firstCallSuccess: 0, effective: 0, noted: 0, deprecated: 0, invalidInput: 0, unknownTool: 0, wrongTool: 0 });

export function summarize(scores: readonly CallScore[]): Totals {
	const t = emptyTotals();
	for (const s of scores) {
		t.calls++;
		if (s.firstCallSuccess) t.firstCallSuccess++;
		if (s.effective) t.effective++;
		if (s.notes > 0) t.noted++;
		if (s.deprecated) t.deprecated++;
		if (s.invalidInput) t.invalidInput++;
		if (s.unknownTool) t.unknownTool++;
		if (!s.toolMatches) t.wrongTool++;
	}
	return t;
}

export const rate = (n: number, of: number): number => (of === 0 ? 0 : Math.round((n / of) * 1000) / 1000);

/** What kind of call this was, for reading a corpus: the first rule that fits. */
export type Outcome = "clean" | "invalid_input" | "unknown_tool" | "deprecated" | "wrong_tool" | "recovered" | "refused";

export function classify(s: CallScore): Outcome {
	if (s.invalidInput) return "invalid_input";
	if (s.unknownTool) return "unknown_tool";
	if (s.deprecated) return "deprecated";
	if (!s.toolMatches) return "wrong_tool";
	if (s.firstCallSuccess) return "clean";
	if (s.effective) return "recovered";
	return "refused";
}
