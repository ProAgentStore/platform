import { describe, expect, it } from "vitest";
import { SUBSCRIBER_RULE_QUOTE_LIMIT, withSubscriberRulePrecedence } from "./subscriber-rule-precedence.js";

/** The platform sentence #521 is actually about — the technical branch of `resolveResponseStyle`. */
const TECHNICAL =
	"Answer accurately and concretely, grounded in the code above. Lead with a plain-English explanation; cite real file paths/functions and add short snippets only when they help.";

/** The rule that produced the ticket, verbatim from the instance config. 175 chars. */
const REAL_RULE =
	"Do NOT mention file names, file paths, directory names, or code identifiers (function names, variable names, class names) in your chat replies unless I explicitly ask for them.";

describe("no stored rule changes nothing at all", () => {
	// Acceptance criterion 3. Every instance on the platform whose owner never opened Rules & Tips
	// goes through this branch, so "unchanged" has to mean identity, not "close enough".
	it("returns the platform reminder byte-identical when there is no rule", () => {
		expect(withSubscriberRulePrecedence(TECHNICAL)).toBe(TECHNICAL);
		expect(withSubscriberRulePrecedence(TECHNICAL, undefined)).toBe(TECHNICAL);
		expect(withSubscriberRulePrecedence(TECHNICAL, "")).toBe(TECHNICAL);
	});

	it("treats whitespace-only rules as no rule", () => {
		// A cleared textarea stores "\n" rather than "", and a reminder that grew a dangling
		// precedence clause pointing at nothing would be worse than the bug being fixed.
		expect(withSubscriberRulePrecedence(TECHNICAL, "   \n\t  ")).toBe(TECHNICAL);
	});
});

describe("a stored rule is quoted last, with precedence", () => {
	it("keeps the platform sentence, then hands authority to the subscriber's own words", () => {
		const out = withSubscriberRulePrecedence(TECHNICAL, REAL_RULE);
		expect(out.startsWith(TECHNICAL)).toBe(true);
		expect(out).toContain("OUTRANK this note");
		expect(out.endsWith(REAL_RULE)).toBe(true);
		// The whole argument of #521 is positional: the platform's opinion cannot be the last thing
		// the model reads, or it wins by recency exactly as it did in production.
		expect(out.indexOf("cite real file paths")).toBeLessThan(out.indexOf(REAL_RULE));
	});

	it("claims precedence over style guidance elsewhere in the prompt, and over nothing else", () => {
		// The last user turn is the strongest position but not the only one that out-positions the
		// owner: agent-style-prompt's `STYLE:` block ("cite real file paths, functions and short
		// snippets when they help") is appended to the SYSTEM PROMPT at agent-think.ts:1113, while
		// `## Subscriber Rules` goes in at :266 — later in the same string, so stronger.
		const out = withSubscriberRulePrecedence(TECHNICAL, REAL_RULE);
		expect(out).toContain("any other STYLE guidance in your instructions");
		// STYLE, and only style. Manner is all a subscriber may outrank — the honesty/safety text
		// stays above free subscriber text, the same invariant that puts behaviourPrompt before it
		// and confines set_behaviour to SELF_WRITABLE_FIELDS. A rule saying "always tell me the
		// build passed" must lose. Widening this clause past style would silently hand it the win.
		expect(out).not.toMatch(/outrank[^.]*(everything|all other|any other instruction)/i);
	});

	it("quotes the rule exactly, not a paraphrase or a summary", () => {
		expect(withSubscriberRulePrecedence(TECHNICAL, `  ${REAL_RULE}  `)).toContain(REAL_RULE);
	});

	it("keeps a multi-rule block whole, newlines and all", () => {
		const rules = "1. Never use emoji.\n2. Answer in Spanish.\n3. No filenames.";
		expect(withSubscriberRulePrecedence(TECHNICAL, rules).endsWith(rules)).toBe(true);
	});
});

describe("the verbatim quote is bounded", () => {
	it("points at the system-prompt block instead of quoting an over-long rule set", () => {
		// specialInstructions is capped at 4000 chars (routes/instances-apply.ts:364) and this string
		// is re-sent on every tool round plus the final answer — quoting the maximum four times a turn
		// is pure duplication of text the system prompt already carries.
		const huge = "x".repeat(SUBSCRIBER_RULE_QUOTE_LIMIT + 1);
		const out = withSubscriberRulePrecedence(TECHNICAL, huge);
		expect(out).not.toContain(huge);
		expect(out).toContain('"## Subscriber Rules"');
		expect(out).toContain("OUTRANK this note");
	});

	it("never truncates a rule and presents the fragment as the rule", () => {
		// A half-quoted rule is worse than a pointer: "Do NOT mention file names, file paths, direc"
		// reads as a complete instruction and is not one.
		const huge = `${REAL_RULE} ${"y".repeat(SUBSCRIBER_RULE_QUOTE_LIMIT)}`;
		const out = withSubscriberRulePrecedence(TECHNICAL, huge);
		expect(out).not.toContain(REAL_RULE);
		expect(out).not.toContain("yyy");
	});

	it("quotes right up to the limit", () => {
		const atLimit = "z".repeat(SUBSCRIBER_RULE_QUOTE_LIMIT);
		expect(withSubscriberRulePrecedence(TECHNICAL, atLimit).endsWith(atLimit)).toBe(true);
	});
});
