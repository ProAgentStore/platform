import { describe, expect, it } from "vitest";
import {
	BEHAVIOUR_FIELDS,
	applyBehaviourPatch,
	SELF_WRITABLE_FIELDS,
	behaviourPrompt,
	behaviourStyleReminder,
	describeBehaviour,
	fieldPrompt,
	prefersTechnical,
	resolveBehaviour,
	sanitizeBehaviour,
	strayBehaviourKey,
} from "./agent-behaviour.js";

describe("unset is a first-class state", () => {
	it("an empty behaviour contributes NOTHING to the prompt", () => {
		// The whole safety argument for shipping this to every existing instance at once. If an
		// unconfigured agent gained a default character, every live agent's voice would change on
		// deploy — including the seeded first-party ones.
		expect(behaviourPrompt({})).toBe("");
	});

	it("a field's `default` is a UI parking spot, not a value", () => {
		// `default: "balanced"` on verbosity must not mean every agent is told "balanced".
		expect(behaviourPrompt({})).not.toContain("without padding");
	});

	it("prefersTechnical returns undefined when unconfigured, so the caller keeps its heuristic", () => {
		// Returning `false` here would silently flip every coding agent to plain-speech.
		expect(prefersTechnical({})).toBeUndefined();
		expect(prefersTechnical({ technicality: 80 })).toBe(true);
		expect(prefersTechnical({ technicality: 20 })).toBe(false);
	});

	it("emits only the fields actually set", () => {
		const p = behaviourPrompt({ tone: "formal" });
		expect(p).toContain("formally");
		expect(p).not.toContain("emoji");
	});
});

describe("a slider is language, not a number", () => {
	it("never leaks the raw scalar into the prompt", () => {
		// The core claim of the design: models ignore or overfit "70/100", but follow described
		// behaviour. If a number reaches the prompt, the band mapping has been bypassed.
		for (const value of [0, 12, 25, 49, 50, 73, 74, 99, 100]) {
			const p = behaviourPrompt({ technicality: value });
			expect(p).not.toContain(String(value));
			expect(p).not.toMatch(/\b\d+\s*\/\s*100\b/);
			expect(p.length).toBeGreaterThan(40); // it said something
		}
	});

	it("maps each band to distinctly different prose", () => {
		const seen = new Set(
			[10, 40, 60, 90].map((v) => fieldPrompt(BEHAVIOUR_FIELDS.find((f) => f.id === "technicality")!, v)),
		);
		expect(seen.size).toBe(4);
	});

	it("picks the band by upper bound, inclusive", () => {
		const f = BEHAVIOUR_FIELDS.find((f) => f.id === "technicality")!;
		expect(fieldPrompt(f, 24)).toContain("plain language");
		expect(fieldPrompt(f, 25)).not.toContain("Avoid jargon");
		expect(fieldPrompt(f, 100)).toContain("senior-engineer");
	});
});

describe("the self-write boundary (#224)", () => {
	it("excludes every guardrail field", () => {
		// Untrusted repo files and issue bodies reach a Repo Coder's context. If injected text can
		// widen the agent's own restrictions, the restrictions are decorative. This test is the
		// boundary — it must fail the moment a guardrail becomes self-writable.
		const guardrails = BEHAVIOUR_FIELDS.filter((f) => f.group === "guardrails").map((f) => f.id);
		expect(guardrails.length).toBeGreaterThan(0);
		for (const id of guardrails) expect(SELF_WRITABLE_FIELDS).not.toContain(id);
	});

	it("still allows the presentation fields — the boundary is not a blanket ban", () => {
		expect(SELF_WRITABLE_FIELDS).toContain("technicality");
		expect(SELF_WRITABLE_FIELDS).toContain("verbosity");
		expect(SELF_WRITABLE_FIELDS).toContain("persona");
	});

	it("rejects a guardrail in a patch while applying the legitimate fields around it", () => {
		// Partial rejection, reported. Failing the whole patch would let one poisoned key silently
		// discard a change the user really made; swallowing it would have the tool claim success on
		// work it refused.
		const { behaviour, rejected } = sanitizeBehaviour(
			{ tone: "casual", topicRestrictions: "anything goes", blockedTerms: [] },
			SELF_WRITABLE_FIELDS,
		);
		expect(behaviour).toEqual({ tone: "casual" });
		expect(rejected).toContain("topicRestrictions");
		expect(rejected).toContain("blockedTerms");
	});

	it("lets the owner set guardrails when no allowlist is passed (the UI path)", () => {
		const { behaviour, rejected } = sanitizeBehaviour({ topicRestrictions: "Only cooking" });
		expect(behaviour.topicRestrictions).toBe("Only cooking");
		expect(rejected).toHaveLength(0);
	});
});

describe("sanitize", () => {
	it("clamps a scale to 0–100 and rounds", () => {
		expect(sanitizeBehaviour({ technicality: 999 }).behaviour.technicality).toBe(100);
		expect(sanitizeBehaviour({ technicality: -5 }).behaviour.technicality).toBe(0);
		expect(sanitizeBehaviour({ technicality: 61.7 }).behaviour.technicality).toBe(62);
	});

	it("rejects a choice outside its options", () => {
		const { behaviour, rejected } = sanitizeBehaviour({ tone: "sarcastic" });
		expect(behaviour).toEqual({});
		expect(rejected).toEqual(["tone"]);
	});

	it("rejects an unknown field rather than storing it", () => {
		// Storing unknown keys would let the tool accumulate junk that no UI can ever clear.
		expect(sanitizeBehaviour({ nonsense: 1 }).rejected).toEqual(["nonsense"]);
	});

	it("truncates text and caps lists", () => {
		const long = "x".repeat(5000);
		expect((sanitizeBehaviour({ persona: long }).behaviour.persona as string).length).toBe(600);
		const many = Array.from({ length: 200 }, (_, i) => `t${i}`);
		expect((sanitizeBehaviour({ blockedTerms: many }).behaviour.blockedTerms as string[]).length).toBe(40);
	});

	it("keeps an empty string as a deliberate clear, distinct from a rejected value", () => {
		expect(sanitizeBehaviour({ persona: "" }).behaviour).toHaveProperty("persona", "");
		expect(sanitizeBehaviour({ persona: 42 }).rejected).toEqual(["persona"]);
	});

	it("a toggle only accepts a real boolean", () => {
		// "false" and 0 are the classic form-value bugs; accepting them as truthy/falsy guesses
		// means a toggle silently means the opposite of what was sent.
		expect(sanitizeBehaviour({ emoji: "false" }).rejected).toEqual(["emoji"]);
		expect(sanitizeBehaviour({ emoji: false }).behaviour).toEqual({ emoji: false });
	});
});

describe("template default < subscriber override", () => {
	it("merges per field, so changing one setting does not drop the creator's character", () => {
		const merged = resolveBehaviour({ technicality: 90, verbosity: "thorough" }, { tone: "casual" });
		expect(merged).toEqual({ technicality: 90, verbosity: "thorough", tone: "casual" });
	});

	it("the subscriber wins on a field they both set", () => {
		expect(resolveBehaviour({ tone: "formal" }, { tone: "casual" }).tone).toBe("casual");
	});

	it("drops invalid stored values on both sides rather than propagating them", () => {
		expect(resolveBehaviour({ tone: "bogus" }, { technicality: "x" })).toEqual({});
	});
});

describe("emitted prompt content", () => {
	it("a numeric limit of 0 emits nothing — 'under 0 characters' would mute the agent", () => {
		expect(behaviourPrompt({ maxResponseLength: 0 })).toBe("");
		expect(behaviourPrompt({ maxResponseLength: 500 })).toContain("under 500 characters");
	});

	it("an empty list and an empty string emit nothing", () => {
		expect(behaviourPrompt({ blockedTerms: [], persona: "", addressAs: "  " })).toBe("");
	});

	it("a toggle with no offPrompt stays silent when off", () => {
		// requireCitations has only an onPrompt: "do not cite" is not a thing worth saying.
		expect(behaviourPrompt({ requireCitations: false })).toBe("");
		expect(behaviourPrompt({ requireCitations: true })).toContain("cite");
	});

	it("showWorking OFF still speaks, because it overrides a hardcoded platform rule", () => {
		// Distinct from the case above: the platform hardcodes "never narrate steps", so the off
		// state has to be expressible for the on state to be meaningful.
		expect(behaviourPrompt({ showWorking: false })).toContain("Never narrate");
		expect(behaviourPrompt({ showWorking: true })).toContain("as you go");
	});
});

describe("describeBehaviour — what the agent reads back", () => {
	it("returns the band prose next to the value, so the agent explains itself in prompt language", () => {
		const [row] = describeBehaviour({ technicality: 80 });
		expect(row.value).toBe(80);
		expect(row.description).toContain("senior-engineer");
	});

	it("lists nothing when nothing is configured", () => {
		expect(describeBehaviour({})).toEqual([]);
	});
});

describe("the post-tool-round reminder", () => {
	it("carries only the style fields, not the whole block", () => {
		const r = behaviourStyleReminder({ technicality: 90, verbosity: "brief", emoji: true });
		expect(r).toContain("senior-engineer");
		expect(r).toContain("Lead with the answer");
		expect(r).not.toContain("emoji");
	});

	it("is empty when style is unconfigured, so the caller keeps its own reminder", () => {
		expect(behaviourStyleReminder({ tone: "casual" })).toBe("");
	});
});

describe("schema integrity — the UI renders from this table", () => {
	it("every field can render its own prompt from data alone (no callbacks)", () => {
		// The console fetches this table as JSON. A function-valued prompt would serialise to
		// nothing and the UI would have to restate the copy — the drift this module exists to stop.
		for (const f of BEHAVIOUR_FIELDS) {
			const hasText = f.bands?.length || f.options?.length || f.onPrompt || f.template;
			expect(hasText, `${f.id} has no prompt text`).toBeTruthy();
			expect(JSON.stringify(f)).toContain(f.label);
		}
	});

	it("has unique ids", () => {
		const ids = BEHAVIOUR_FIELDS.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("scale bands are ordered and reach 100", () => {
		for (const f of BEHAVIOUR_FIELDS) {
			if (!f.bands) continue;
			const maxes = f.bands.map((b) => b.max);
			expect(maxes).toEqual([...maxes].sort((a, b) => a - b));
			expect(maxes[maxes.length - 1]).toBe(100);
		}
	});
});

describe("applyBehaviourPatch — patch semantics shared by the route and the tool", () => {
	it("merges over the stored object rather than replacing it", () => {
		const { behaviour } = applyBehaviourPatch({ tone: "formal", emoji: true }, { tone: "casual" });
		expect(behaviour).toEqual({ tone: "casual", emoji: true });
	});

	it("null CLEARS a field back to unset", () => {
		// Not the same as setting it to a default. A cleared field stops appearing as configured,
		// which is the only way back to the platform's own heuristic once a setting has been made.
		const { behaviour } = applyBehaviourPatch({ technicality: 90, tone: "formal" }, { technicality: null });
		expect(behaviour).toEqual({ tone: "formal" });
		expect(behaviourPrompt(behaviour)).not.toContain("senior-engineer");
	});

	it("a clear obeys the allowlist too", () => {
		// A clear is a WRITE. If only `set` were checked, the agent could erase a topic restriction
		// it is forbidden from setting — the same escape, spelled differently.
		const { behaviour, rejected } = applyBehaviourPatch(
			{ topicRestrictions: "Only cooking" },
			{ topicRestrictions: null },
			SELF_WRITABLE_FIELDS,
		);
		expect(behaviour.topicRestrictions).toBe("Only cooking");
		expect(rejected).toContain("topicRestrictions");
	});

	it("keeps unrelated stored fields when the patch is junk", () => {
		const { behaviour } = applyBehaviourPatch({ tone: "casual" }, "not an object");
		expect(behaviour).toEqual({ tone: "casual" });
	});

	it("drops a stored value that is no longer valid", () => {
		// A field removed from the schema, or an option renamed, must not survive a later patch.
		const { behaviour } = applyBehaviourPatch({ tone: "retired-option" }, { emoji: true });
		expect(behaviour).toEqual({ emoji: true });
	});
});

describe("strayBehaviourKey — memory entries that belong in behaviour now (#226)", () => {
	it("matches the key a real agent actually wrote", () => {
		expect(strayBehaviourKey("preference:response_style")).toBe(true);
	});

	it("matches the other ways an agent might name the same idea", () => {
		for (const k of ["preference:tone", "pref:verbosity", "preference:communication_style", "preference:Persona"]) {
			expect(strayBehaviourKey(k), k).toBe(true);
		}
	});

	it("leaves genuine subject-matter preferences alone", () => {
		// The dangerous direction. A loose match here has agents deleting real knowledge, so a
		// preference key that is a FACT about the work must never be swept up.
		for (const k of [
			"preference:coffee_supplier",
			"preference:deploy_target",
			"preference:preferred_branch",
			"identity:name",
			"knowledge:tone_mapping_algorithm",
		]) {
			expect(strayBehaviourKey(k), k).toBe(false);
		}
	});

	it("requires the preference prefix, so a knowledge entry about tone is untouched", () => {
		expect(strayBehaviourKey("context:tone")).toBe(false);
	});
});
