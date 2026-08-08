/**
 * The STYLE block, and the length rule that was computed for every agent and emitted for one (#430).
 *
 * ── What was wrong
 *
 * `agent-think.ts` resolved a `lengthRule` — the subscriber's `verbosity` band, or a fallback —
 * unconditionally, and `styleGuidance` used it at exactly one site, inside `if (plainSpeech)`.
 * `plainSpeech` was `!codingContext && !technical`, and `codingContext` is true for ANY instance
 * with a repo attached. So a coding agent had no length instruction anywhere in its system prompt:
 * not its own `verbosity`, not the 2-sentence fallback, nothing. Unset did not mean "balanced" —
 * the value the Behaviour tab was showing — it meant unbounded.
 *
 * ── What these tests hold
 *
 * The deliverable of the ticket is the test that fails when someone re-breaks it, so the check is
 * structural rather than a list of four expected strings: for EVERY combination of a real agent's
 * capabilities and the three style flags, the block either is empty or ends in a length slot, and
 * the default that fills that slot is different for a read-aloud reply than for a code explainer.
 * A fifth branch cannot pass this without stating what an unset `verbosity` means for it — and it
 * cannot compile without saying so either, because `StyleBranch.lengthDefault` is required.
 */
import { describe, expect, it } from "vitest";
import { resolveResponseStyle } from "./agent-behaviour.js";
import { resolveSelfModel, type SelfModel } from "./agent-self-description.js";
import { styleGuidance } from "./agent-style-prompt.js";
import { CODER_LEAD, CODER_REPO, FIRST_PARTY_AGENTS, LEGACY_CODER, PLAIN_CHAT, REPO_CHAT } from "./first-party-agents.js";
import { describeViolation, promptClaimViolations } from "./prompt-claims.js";

/** Deliberately unlike any real band text, so "did the caller's rule land" is unambiguous. */
const SENTINEL = "SENTINEL-LENGTH-RULE";

interface Shape {
	model: SelfModel;
	codingContext: boolean;
	hasCodingContext: boolean;
	plainSpeech: boolean;
}

/** Every shape `runAgentThink` can hand this function, over every first-party agent. */
const SHAPES: { name: string; shape: Shape }[] = FIRST_PARTY_AGENTS.flatMap((agent) =>
	[true, false].flatMap((codingContext) =>
		[true, false].flatMap((hasCodingContext) =>
			[true, false].map((plainSpeech) => ({
				name: `${agent.name} coding=${codingContext} repos=${hasCodingContext} plain=${plainSpeech}`,
				shape: { model: resolveSelfModel(agent.capabilities), codingContext, hasCodingContext, plainSpeech },
			})),
		),
	),
);

/** The block minus its final bullet, and that bullet — the length slot. */
function split(block: string): { body: string; length: string } {
	const at = block.lastIndexOf("\n- ");
	return at === -1 ? { body: block, length: "" } : { body: block.slice(0, at), length: block.slice(at + 3) };
}

describe("every styleGuidance branch carries a length rule (#430)", () => {
	it("puts the caller's rule in the last slot of every non-empty branch", () => {
		// The regression in one assertion: `lengthRule` reached exactly one of the four branches, so
		// setting `verbosity` on a coding agent changed nothing about this block.
		const missing: string[] = [];
		for (const { name, shape } of SHAPES) {
			const block = styleGuidance({ ...shape, lengthRule: SENTINEL });
			if (!block) continue;
			if (!block.endsWith(`\n- ${SENTINEL}`)) missing.push(`${name}: ${block.slice(-120)}`);
		}
		expect(missing, `a branch dropped the subscriber's length rule:\n${missing.join("\n")}`).toEqual([]);
	});

	it("fills the same slot with a real default when the subscriber declared no verbosity", () => {
		// Unset is the live case — `verbosity` was absent on the instance that raised this — and it
		// is the one that produced nothing. The default must occupy the SAME slot as an explicit
		// rule, so a branch cannot satisfy the test above and still say nothing here.
		const missing: string[] = [];
		for (const { name, shape } of SHAPES) {
			const declared = styleGuidance({ ...shape, lengthRule: SENTINEL });
			const unset = styleGuidance(shape);
			if (!declared) {
				expect(unset, name).toBe("");
				continue;
			}
			expect(unset, name).not.toContain(SENTINEL);
			const { body, length } = split(unset);
			if (length.length < 20) missing.push(`${name}: ${JSON.stringify(length)}`);
			// Identical up to the slot: the default replaces the rule, it does not shift the block.
			expect(body, name).toBe(split(declared).body);
		}
		expect(missing, `a branch has no length rule when verbosity is unset:\n${missing.join("\n")}`).toEqual([]);
	});

	it("covers at least the four branches, so the sweep above is not vacuous", () => {
		const bodies = new Set(SHAPES.map(({ shape }) => split(styleGuidance(shape)).body).filter(Boolean));
		expect(bodies.size).toBeGreaterThanOrEqual(4);
	});
});

describe("the unset default is honest for the branch it is in (#430)", () => {
	const codingShape = (caps = CODER_REPO, plainSpeech = false): Shape => ({
		model: resolveSelfModel(caps),
		codingContext: true,
		hasCodingContext: true,
		plainSpeech,
	});

	it("gives a coding-capable instance with verbosity unset a length instruction", () => {
		// The acceptance criterion, stated against the resolution the route actually performs: a
		// Coder whose owner has set only `technicality` still gets told how long a reply should be.
		const { codingContext, plainSpeech } = resolveResponseStyle({
			repoChatStyle: false,
			hasCodingContext: true,
			behaviour: { technicality: 100 },
		});
		const block = styleGuidance({
			model: resolveSelfModel(CODER_REPO),
			codingContext,
			hasCodingContext: true,
			plainSpeech,
			lengthRule: undefined,
		});
		expect(block).not.toBe("");
		expect(split(block).length).toMatch(/paragraph|bullet|sentence/i);
	});

	it("does not hand a code explainer the read-aloud 2-sentence cap", () => {
		// "MAXIMUM 2 sentences" is right for a reply that will be spoken and absurd for a code
		// explainer — which is why it lived inside plain speech. The fix is a per-branch default,
		// not the same one everywhere.
		for (const [name, caps] of [
			["repo-chat", REPO_CHAT],
			["coder-repo", CODER_REPO],
			["coder", LEGACY_CODER],
			["coder-lead", CODER_LEAD],
		] as const) {
			const block = styleGuidance(codingShape(caps));
			expect(split(block).length, name).not.toMatch(/2 sentences/);
		}
	});

	it("keeps the 2-sentence cap where it was always right — a reply being read aloud", () => {
		const plain = styleGuidance({
			model: resolveSelfModel(PLAIN_CHAT),
			codingContext: false,
			hasCodingContext: false,
			plainSpeech: true,
		});
		expect(split(plain).length).toContain("MAXIMUM 2 sentences");
	});
});

describe("plain speech is reachable for a coding agent, and still tells it no lies (#430, #254, #255)", () => {
	/** A Coder whose owner dragged technicality to the bottom. */
	const lowTechnicality = (caps: typeof CODER_REPO, repoChatStyle: boolean, hasRepos: boolean) => {
		const { codingContext, plainSpeech } = resolveResponseStyle({
			repoChatStyle,
			hasCodingContext: hasRepos,
			behaviour: { technicality: 0 },
		});
		return {
			plainSpeech,
			block: styleGuidance({ model: resolveSelfModel(caps), codingContext, hasCodingContext: hasRepos, plainSpeech }),
		};
	};

	it("stops it citing file paths", () => {
		const { plainSpeech, block } = lowTechnicality(CODER_REPO, false, true);
		expect(plainSpeech).toBe(true);
		expect(block).toContain("Never mention filenames, paths, line numbers");
		expect(block).toContain("READ ALOUD");
		// And the opposite instruction is gone — the two used to be unreachable and reachable
		// respectively, which is the whole complaint.
		expect(block).not.toContain("cite real file paths");
	});

	it("keeps the grounding that stops it inventing an index", () => {
		// Capability decides WHICH grounding block; preference decides the language. Dropping the
		// grounding with the voice would trade #430 for the hallucinated indexing status of #254.
		const { block } = lowTechnicality(CODER_REPO, false, true);
		expect(block).toContain("You do NOT have a searchable code index");
		expect(block).toContain("Attached Repositories");
	});

	it("names no tab or index the agent does not have, in either voice", () => {
		// The regression #430 explicitly warns about: making plain speech reachable for coding
		// agents re-opens #254/#255 territory. Adjudicated by the guard rather than by reading.
		for (const [name, caps, repoChatStyle, hasRepos] of [
			["coder-repo", CODER_REPO, false, true],
			["coder", LEGACY_CODER, false, true],
			["repo-chat", REPO_CHAT, true, false],
			["coder-lead", CODER_LEAD, true, false],
		] as const) {
			const { block } = lowTechnicality(caps, repoChatStyle, hasRepos);
			const violations = promptClaimViolations(block, caps);
			expect(violations, `${name}:\n${violations.map(describeViolation).join("\n")}`).toEqual([]);
		}
	});

	it("leaves an unconfigured coding agent's block exactly as it was", () => {
		// The change must be invisible to everyone who set nothing, apart from the length rule that
		// was missing. `plainSpeech` is false for them, so the branch text is untouched.
		const { codingContext, plainSpeech } = resolveResponseStyle({ repoChatStyle: false, hasCodingContext: true, behaviour: {} });
		expect(plainSpeech).toBe(false);
		const block = styleGuidance({ model: resolveSelfModel(CODER_REPO), codingContext, hasCodingContext: true, plainSpeech });
		expect(block).toContain("You are a precise code explainer helping a developer understand their repositories");
		expect(block).not.toContain("READ ALOUD");
	});
});
