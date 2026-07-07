/**
 * Parse the loop orchestrator's LLM reply into a decision. The model is asked for
 * strict JSON, but BYOK Claude sometimes wraps it in ```fences```, appends a trailing
 * sentence, emits an example object first, or answers in prose. The old greedy
 * `/\{[\s\S]*\}/` match broke on all of those and dead-ended the loop with "Could not
 * parse LLM response". This is pure + tested so that robustness is locked in.
 */

export type LoopDecision = "continue" | "done" | "escalate" | "failed";

export interface LoopDecisionResult {
	decision: LoopDecision;
	nextInstruction: string;
	reason: string;
}

const VALID = new Set<LoopDecision>(["continue", "done", "escalate", "failed"]);

function normalizeDecision(v: unknown): LoopDecision | null {
	if (typeof v !== "string") return null;
	const s = v.trim().toLowerCase();
	return VALID.has(s as LoopDecision) ? (s as LoopDecision) : null;
}

/**
 * Extract the first BALANCED `{…}` object from text (string-aware, brace-counted), so
 * prose/fences around it, a trailing sentence, or a `}` inside a JSON string value
 * don't corrupt the span the way a greedy regex does. Returns null if none.
 */
export function extractJsonObject(text: string): string | null {
	const start = text.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/** Parse a loop-decide reply. Always returns a usable decision — never throws. */
export function parseLoopDecision(raw: string): LoopDecisionResult {
	const text = (raw || "").trim();

	// 1. Preferred path: a JSON object embedded anywhere in the reply.
	const jsonStr = extractJsonObject(text);
	if (jsonStr) {
		try {
			const p = JSON.parse(jsonStr) as Record<string, unknown>;
			const decision = normalizeDecision(p.decision);
			if (decision) {
				return {
					decision,
					nextInstruction: typeof p.nextInstruction === "string" ? p.nextInstruction : "",
					reason: typeof p.reason === "string" ? p.reason : "",
				};
			}
		} catch {
			// fall through to prose inference
		}
	}

	// 2. No usable JSON — infer from the prose so a slightly-off reply still drives the
	//    loop instead of dead-ending. Order matters: terminal states before "continue".
	const lower = text.toLowerCase();
	let inferred: LoopDecision | null = null;
	if (/\b(objective|task|goal)\b[^.]*\b(met|complete|completed|done|finished)\b|\ball done\b|\bnothing (more|left) to do\b/.test(lower)) {
		inferred = "done";
	} else if (/\bfail(ed|ure)?\b|\bkeeps? repeating\b|\bstuck in a loop\b|\bgiving up\b/.test(lower)) {
		inferred = "failed";
	} else if (/\bescalat/.test(lower) || /\bneeds?\b[^.]*\b(human|you|your|help|input)\b|\basking (a )?question|\bclarif/.test(lower)) {
		inferred = "escalate";
	} else if (/\bcontinue\b|\bnext (step|instruction|action)\b|\bproceed\b|\bkeep going\b/.test(lower)) {
		inferred = "continue";
	}
	if (inferred) {
		return {
			// For "continue" the whole reply is the best available next instruction.
			decision: inferred,
			nextInstruction: inferred === "continue" ? text.slice(0, 2000) : "",
			reason: inferred === "continue" ? "" : text.slice(0, 500),
		};
	}

	// 3. Genuinely unusable — escalate to a human, but surface an excerpt so it's debuggable
	//    (the old code returned a bare "Could not parse LLM response").
	return {
		decision: "escalate",
		nextInstruction: "",
		reason: text ? `Could not parse a decision from the reply: ${text.slice(0, 200)}` : "Empty LLM response",
	};
}
