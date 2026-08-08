/**
 * The prompt-drift guard (#315), asserted two ways.
 *
 *   1. SEMANTIC — build the real system prompt for a real agent, from the real builders, and
 *      assert that nothing in it names a capability the agent does not have. This is the half
 *      that catches the historical bugs, because it checks the shipped wording against the
 *      resolved data rather than against a reviewer's memory.
 *   2. RATCHET — scan the prompt modules' STRING LITERALS for capability-naming claims and pin
 *      the set. The semantic check can only see prompts a test can assemble; this one sees every
 *      literal, including in branches no fixture reaches. It cannot tell whether the branch
 *      around a literal is correctly gated, so it is a ratchet, not a verdict: a new claim has to
 *      be added deliberately, in review.
 *
 * See `prompt-claims.ts` for the full statement of what the guard cannot see. The short version:
 * it adjudicates claims keyed to a NAMED capability (a tab, a tool, a denial, a runtime) and
 * nothing else. Free-text advice is invisible to it, and that is a limit, not an oversight.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toolBlurbFor } from "../agent-think.js";
import { resolveResponseStyle } from "./agent-behaviour.js";
import { executionAuthorityPrompt, resolveSelfModel, selfDescriptionPrompt } from "./agent-self-description.js";
import { indexedReposPrompt, noActiveSessionPrompt, runnerStatusPrompt, styleGuidance, voiceControlPrompt } from "./agent-style-prompt.js";
import type { AgentCapabilities } from "./agent-capabilities.js";
import { CODER_LEAD, CODER_REPO, FIRST_PARTY_AGENTS, LEGACY_CODER, PLAIN_CHAT, REPO_CHAT } from "./first-party-agents.js";
import {
	DENIAL_RULES,
	describeViolation,
	findSourceClaims,
	findTabMentions,
	findToolMentions,
	promptClaimViolations,
	promptTextOf,
} from "./prompt-claims.js";
import { recentWorkPrompt } from "./work-report.js";

// ── 1. The inverse lexer ─────────────────────────────────────────────────────────────────────

describe("promptTextOf — keeps the strings, blanks the code", () => {
	it("blanks comments, which is the whole reason it exists", () => {
		// The real distribution in this repo: ~14 mentions of a tab in workers/api/src, nearly all
		// of them in comments explaining the very incidents this guard is about. A guard that read
		// its own documentation would be muted within a week.
		const text = promptTextOf(`// tell the user to open the Repo tab\nconst x = 1;`);
		expect(text).not.toContain("Repo tab");
	});

	it("keeps a prompt sentence, wherever it is quoted", () => {
		expect(promptTextOf(`p += "open the Coding tab";`)).toContain("open the Coding tab");
		expect(promptTextOf("p += `open the Coding tab`;")).toContain("open the Coding tab");
	});

	it("joins concatenated literals so a sentence split across a `+` still matches", () => {
		// "…start a session" + " in the Coding tab" is ONE sentence in the prompt. Fusing the words
		// either side of the join would hide it; so would dropping the second half.
		expect(promptTextOf(`p += "start a session" + " in the Coding tab";`)).toMatch(/start a session\s+in the Coding tab/);
	});

	it("blanks template interpolations — they are code, and their value is runtime data", () => {
		// Spelled in two halves so the lint rule that objects to a placeholder inside a plain string
		// does not fire on the very syntax under test.
		const interpolation = `$${"{tabsFor(caps)}"}`;
		expect(promptTextOf(`p += \`you have ${interpolation} tabs\`;`)).not.toContain("tabsFor");
	});

	it("ignores a single-token literal, which is an identifier and not a sentence", () => {
		expect(promptTextOf(`if (s.includes("tmux")) push("Terminal");`)).not.toContain("tmux");
	});

	it("does not run away on a regex literal containing what looks like a comment", () => {
		const text = promptTextOf(`const re = /https:\\/\\//; p += "the Repo tab";`);
		expect(text).toContain("the Repo tab");
	});

	it("preserves line numbers", () => {
		const src = `// a\n// b\np += "the Coding tab";`;
		expect(promptTextOf(src).split("\n").length).toBe(3);
	});
});

// ── 2. Claim detection ───────────────────────────────────────────────────────────────────────

describe("what counts as a claim", () => {
	it("finds a tab mention and says whether the console can render it", () => {
		const [known] = findTabMentions("open the Coding tab");
		expect(known).toMatchObject({ tab: "Coding", known: true });
		// A name outside the registry cannot be adjudicated — it may be a KB sub-tab or a section.
		// The ratchet still reports it; the semantic check deliberately does not fail on it.
		expect(findTabMentions("open the Sparkle tab")[0]).toMatchObject({ known: false });
	});

	it("finds only real tool names, not every snake_case word", () => {
		const found = findToolMentions("call start_work, not some_made_up_thing");
		expect(found.map((f) => f.tool)).toEqual(["start_work"]);
	});
});

// ── 3. The real prompt, for the real agents ──────────────────────────────────────────────────

/**
 * Assemble the system prompt from the same pure builders `runAgentThink` uses.
 *
 * This is a REBUILD, not the function itself: `runAgentThink` needs a Durable Object, D1 and a
 * live relay, and mocking those would test the mocks. What makes the rebuild trustworthy is the
 * ratchet below — every capability-naming literal in `agent-think.ts` was moved into these pure
 * builders by #315, so the file that cannot be called from a unit test no longer contains any
 * claim to check. If one is added back, the ratchet fails.
 */
function assemblePrompt(
	capabilities: AgentCapabilities,
	opts: {
		technicalSeed: boolean;
		hasRepos: boolean;
		runnerOnline: boolean;
		activeSession: boolean;
		indexedRepos: boolean;
		/**
		 * The owner dragged technicality to the bottom (#430).
		 *
		 * An axis rather than a separate test because it is a BRANCH: since #430 an explicit low
		 * technicality reaches `plainSpeech` on a coding agent, which pairs the read-aloud voice with
		 * a coding grounding block for the first time. #430's own regression note calls that
		 * #254/#255 territory, so every fixture is swept in both voices rather than trusted in one.
		 */
		lowTechnicality: boolean;
	},
): string {
	const model = resolveSelfModel(capabilities);
	const { codingContext, plainSpeech } = resolveResponseStyle({
		repoChatStyle: opts.technicalSeed,
		hasCodingContext: opts.hasRepos,
		behaviour: opts.lowTechnicality ? { technicality: 0 } : {},
	});
	const attached = opts.hasRepos ? [{ name: "platform", githubRepo: "ProAgentStore/platform", workdir: "~/dev/platform" }] : [];
	const parts = [
		`You have tools available. ${toolBlurbFor(capabilities)}`,
		selfDescriptionPrompt(model, { repoSetting: "ProAgentStore/platform", attached }),
		model.canStartWork || model.canDrive || model.canDelegate || model.surfaces.includes("coding")
			? executionAuthorityPrompt(model)
			: "",
		// `plainSpeech` threaded exactly as `runAgentThink` threads it (#453). Composing this block
		// in the default voice while `styleGuidance` below got the real one is what let the
		// contradiction sit in the sweep unnoticed.
		opts.indexedRepos ? indexedReposPrompt(model, plainSpeech) : "",
		opts.hasRepos ? runnerStatusPrompt(model, opts.runnerOnline) : "",
		opts.hasRepos && !opts.activeSession ? noActiveSessionPrompt(model) : "",
		// No `lengthRule`: the unset case is the one that shipped broken (#430), and the default it
		// falls back to is chosen inside `styleGuidance`, so passing one here would hide it.
		styleGuidance({ model, codingContext, hasCodingContext: opts.hasRepos, plainSpeech }),
		// Unconditional in `runAgentThink`, so unconditional here: the semantic check must see it for
		// every agent and every branch, not only the ones a condition happens to reach (#340).
		voiceControlPrompt,
		recentWorkPrompt([], Date.now(), { delegated: [] }),
	];
	return parts.join("\n");
}

/** Every runtime shape a prompt can be built in — the branches are what drift. */
const CONDITIONS = [true, false].flatMap((technicalSeed) =>
	[true, false].flatMap((hasRepos) =>
		[true, false].flatMap((runnerOnline) =>
			[true, false].flatMap((activeSession) =>
				[true, false].flatMap((indexedRepos) =>
					[true, false].map((lowTechnicality) => ({
						technicalSeed,
						hasRepos,
						runnerOnline,
						activeSession,
						indexedRepos,
						lowTechnicality,
					})),
				),
			),
		),
	),
);

describe("no first-party agent is told anything its capabilities contradict", () => {
	for (const agent of FIRST_PARTY_AGENTS) {
		it(`${agent.name} — every branch of its prompt`, () => {
			for (const c of CONDITIONS) {
				const prompt = assemblePrompt(agent.capabilities, c);
				const violations = promptClaimViolations(prompt, agent.capabilities);
				expect(
					violations,
					`${agent.name} with ${JSON.stringify(c)}:\n${violations.map(describeViolation).join("\n")}`,
				).toEqual([]);
			}
		});
	}
});

// ── 4. The four historical bugs, as assertions ───────────────────────────────────────────────
//
// Each of these is a known-true instance of the class. Reintroducing one is the mutation that
// proves the guard goes red, so each is pinned here directly against the capabilities it was
// wrong for — a regression test for a bug the guard exists to notice, not for the wording.

describe("the incidents that motivated this", () => {
	it("#255 — a `surfaces:['coding']` agent has no Repo tab", () => {
		const v = promptClaimViolations("attach a repository in the Repo tab", CODER_REPO);
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({ kind: "tab", claim: "Repo" });
	});

	it("#254 — denying execution to an agent that has an executor", () => {
		const v = promptClaimViolations("You cannot run shell commands, and you do not drive the engine.", CODER_REPO);
		// Only the first clause is a violation for a Repo Coder, and that is the finding of #254
		// stated precisely: `drive:false` means it genuinely does not type into the engine, so the
		// second clause is TRUE. What was false was the conclusion drawn from it — that nothing it
		// does reaches the engine — which `start_work` contradicts.
		expect(v.map((x) => x.claim)).toEqual(["cannot-act"]);
		// For the legacy Coder, which really does drive its own pane, the second clause is the lie.
		expect(promptClaimViolations("you do not drive the engine", LEGACY_CODER).map((x) => x.claim)).toEqual(["does-not-drive"]);
	});

	it("#318 — denying execution to a Lead, whose entire job is delegating", () => {
		const v = promptClaimViolations("You cannot run shell commands; never claim you fixed a bug.", CODER_LEAD);
		expect(v.map((x) => x.claim)).toEqual(["cannot-act"]);
		// The honesty instruction in the same sentence is NOT a capability claim and must stay legal
		// for every agent — a guard that flagged it would be telling us to delete the true half.
		expect(promptClaimViolations("Never claim you fixed a bug you did not fix.", CODER_LEAD)).toEqual([]);
	});

	it("#340 — the voice denial is honest today, and goes red the day it stops being", () => {
		// Legal for every real agent: none of them can touch the mic.
		expect(promptClaimViolations(voiceControlPrompt, CODER_LEAD)).toEqual([]);
		expect(promptClaimViolations(voiceControlPrompt, PLAIN_CHAT)).toEqual([]);
		// And the guard is a live check, not a constant. Granting a voice-control tool makes the same
		// sentence a lie, exactly as `start_work` joining BASE did in #254 — so the rule is asserted
		// against a model where it holds false rather than against a hypothetical.
		const v = DENIAL_RULES.filter((r) => r.id === "no-voice-control");
		expect(v).toHaveLength(1);
		expect(v[0].holds({ ...resolveSelfModel(PLAIN_CHAT), controlsVoice: true })).toBe(false);
		expect(v[0].holds(resolveSelfModel(PLAIN_CHAT))).toBe(true);
	});

	it("#247 — describing a tmux pane to an agent whose engine is a child process", () => {
		const v = promptClaimViolations("Read the tmux pane to see what the engine is doing.", LEGACY_CODER);
		expect(v.map((x) => x.claim)).toEqual(["tmux"]);
	});

	it("the same sentences are legal for the agent they are TRUE of", () => {
		// Repo Chat really is read-only, really has an index, really has a Repo tab. The guard must
		// not push a prompt toward vagueness — a true claim is the thing worth keeping.
		expect(
			promptClaimViolations(
				"You are READ-ONLY. Ground answers in the indexed code, and suggest adding the repo in the Repo tab.",
				REPO_CHAT,
			),
		).toEqual([]);
	});

	it("`pags up` is only offered to an agent that has a runner", () => {
		expect(promptClaimViolations("start the runner first with `pags up`", CODER_REPO)).toEqual([]);
		const v = promptClaimViolations("start the runner first with `pags up`", PLAIN_CHAT);
		// Both halves of the sentence are separately a claim about a runner this agent has not got;
		// the guard reports each, because each is a place the wording has to change.
		expect(v.length).toBeGreaterThan(0);
		expect(v.every((x) => x.claim === "local-runner" && x.kind === "runtime")).toBe(true);
	});

	it("#453 — a Repo Chat owner at technicality 0 is not told to cite paths and never to name paths", () => {
		// The two sentences composed eight lines apart in one prompt. #430 made the technicality
		// slider reach an agent with repos for the first time (`plainSpeech` was
		// `!codingContext && !technical`), and `indexedReposPrompt` was unconditional, so the
		// moment plain speech became reachable the two blocks started contradicting each other.
		const CITE = "cite the repository + file path";
		const NEVER = "Never mention filenames, paths";
		const composed = (lowTechnicality: boolean) =>
			assemblePrompt(REPO_CHAT, {
				technicalSeed: true, // migration 0032 seeds guardrails.responseStyle: "technical"
				hasRepos: false,
				runnerOnline: false,
				activeSession: false,
				indexedRepos: true,
				lowTechnicality,
			});

		const plain = composed(true);
		expect(plain).toContain(NEVER);
		expect(plain).not.toContain(CITE);
		// The ACCURACY half survives plain speech — suppressing the whole block would have deleted
		// an anti-hallucination rule to fix a style clash.
		expect(plain).toContain("grounded in the retrieved code above");
		expect(plain).toContain("say it isn't indexed yet");

		// And the technical voice is untouched: still cites, still never plain-speech.
		const technical = composed(false);
		expect(technical).toContain(CITE);
		expect(technical).not.toContain(NEVER);
	});

	it("#453 — no condition in the whole sweep composes both sentences", () => {
		// The narrow assertion above is about Repo Chat. This is the invariant: whatever the agent,
		// whatever the branch, "cite the path" and "never name a path" never co-occur.
		for (const capabilities of FIRST_PARTY_AGENTS) {
			for (const cond of CONDITIONS) {
				const prompt = assemblePrompt(capabilities.capabilities, cond);
				const both = prompt.includes("cite the repository + file path") && prompt.includes("Never mention filenames, paths");
				expect(both, `${capabilities.name} ${JSON.stringify(cond)}`).toBe(false);
			}
		}
	});

	it("naming a tool the agent was not granted", () => {
		// Repo Chat has no `send_to_cli` — telling it to steer an engine describes a schema it will
		// never see, which is the failure `toolBlurbFor`'s comment describes.
		const v = promptClaimViolations("steer the engine with send_to_cli", REPO_CHAT);
		expect(v.map((x) => x.claim)).toEqual(["send_to_cli"]);
		expect(promptClaimViolations("steer the engine with send_to_cli", LEGACY_CODER)).toEqual([]);
	});
});

// ── 5. The ratchet ───────────────────────────────────────────────────────────────────────────

const SRC = new URL("../", import.meta.url).pathname;

/**
 * The modules whose string literals become an agent's system prompt.
 *
 * Scoped, not tree-wide, and the scan that established the scope is the argument for it: over all
 * of `workers/api/src` the same patterns report 105 hits, of which the overwhelming majority are
 * the tmux CONNECTOR (where tmux is the actual subject), and six are `"You can close this tab."`
 * in OAuth callback HTML — a browser tab, not a console tab. Those are not prompts and the guard
 * has nothing true to say about them. Tool descriptions ARE in scope (`tool-registry.ts`): the
 * model reads them in the same context, and a tool description naming a tab the agent lacks is
 * the same bug in a different string.
 */
const PROMPT_MODULES = [
	"agent-think.ts",
	"agent-do-prompt.ts",
	"agent-do-tools.ts",
	"lib/agent-self-description.ts",
	"lib/agent-style-prompt.ts",
	"lib/agent-clock.ts",
	"lib/agent-behaviour.ts",
	// Added when #337 moved the `## Active Tasks` block out of `agent-think.ts` into a pure module.
	// It names no capability today, and that is worth pinning rather than assuming: the block now
	// carries provenance and withholding prose, which is the kind of text that grows a tab or tool
	// name later.
	"lib/agent-tasks.ts",
	// #395. The correction handed back to a model that wrote its own tool result is prompt text the
	// model acts on, so it belongs in the scan. It names no capability today and that is the point
	// of pinning it: the honest wording of "here is what actually ran" is one edit away from naming
	// a tool or a surface the agent does not have.
	"lib/invented-results.ts",
	"lib/instance-settings.ts",
	"lib/stats-schema.ts",
	"lib/tool-registry.ts",
	"lib/work-report.ts",
];

/**
 * Every capability-naming literal in those modules, reviewed, with the reason it is honest.
 *
 * Compared EXACTLY, like `security-invariants.test.ts`: removing a claim fails too, so the list
 * can only change deliberately. Counts are part of the key — a SECOND hardcoded "Coding tab" in a
 * file that already has one is exactly the seventeenth-call-site case this exists for.
 *
 * A new entry here is a decision. The alternative to adding one is almost always to derive the
 * clause instead — `tabClause(model, "Coding", …)` emits nothing when the tab is not there.
 */
const ALLOWED_CLAIMS: Record<string, number> = {
	// Derived: emitted through `tabClause`, so it disappears for an agent without the tab.
	"lib/agent-style-prompt.ts — tab:Coding": 1,
	// Derived: `readOnlyClause` / `actionClause` / the no-executor branch, each gated on the
	// resolved SelfModel. These are the #254 sentences, now conditional.
	"lib/agent-style-prompt.ts — denial:cannot-act": 3,
	// #340 — "you do not control the microphone or voice mode" / "You cannot start, stop, mute…".
	// True for every agent: voice is a client feature and `VOICE_CONTROL_TOOLS` is empty, so
	// `controlsVoice` is false everywhere. Pinned at 2 so DELETING the line fails this test, which is
	// the acceptance criterion — the reply it prevents ("Got it. Stopped.") is a confirmation that
	// fires only when the stop failed, and the last thing it should do is quietly disappear again.
	"lib/agent-style-prompt.ts — denial:no-voice-control": 2,
	// The Coder branch, which genuinely has no vector index (its code is in live sessions).
	"lib/agent-style-prompt.ts — denial:no-code-index": 2,
	// The Repo Chat branch, which genuinely does have one.
	"lib/agent-style-prompt.ts — runtime:code-index": 2,
	// Gated on `SelfModel.hasRunner`; a cloud-only agent is never sent to the CLI.
	"lib/agent-style-prompt.ts — runtime:local-runner": 2,
	// "the subscriber sets it in the Settings tab" — Settings is universal in `tabsFor`.
	"lib/agent-self-description.ts — tab:Settings": 1,
	// The no-executor branch of `executionAuthorityPrompt`, gated on all three predicates.
	"lib/agent-self-description.ts — denial:cannot-act": 1,
	// "You cannot add one yourself" — emitted only under `singleRepo`.
	"lib/agent-self-description.ts — denial:cannot-add-repo": 1,
	// Same universal Settings tab, in the settings block.
	"lib/instance-settings.ts — tab:Settings": 1,
	// `get_behaviour` / `set_behaviour` descriptions. Behaviour is universal in `tabsFor`.
	"lib/tool-registry.ts — tab:Behaviour": 2,
	// `get_stats` description. Stats is universal in `tabsFor` — it was NOT, until this guard's
	// first run found the console had shipped the tab (#311) and the table had not been updated.
	"lib/tool-registry.ts — tab:Stats": 1,
};

describe("hardcoded capability claims in the prompt modules", () => {
	const found: Record<string, number> = {};
	for (const rel of PROMPT_MODULES) {
		for (const c of findSourceClaims(readFileSync(join(SRC, rel), "utf8"))) {
			const key = `${rel} — ${c.kind}:${c.claim}`;
			found[key] = (found[key] ?? 0) + 1;
		}
	}

	it("are exactly the reviewed set", () => {
		expect(
			found,
			"A prompt literal names a tab, a tool, a denial or a runtime feature that is not in the reviewed list.\n" +
				"Derive it instead — `tabClause(model, tab, clause)` emits nothing when the agent lacks the tab,\n" +
				"and `SelfModel` answers every other question. Add an entry ONLY if the claim is unconditionally true.",
		).toEqual(ALLOWED_CLAIMS);
	});

	it("agent-think.ts hardcodes no capability claim at all", () => {
		// The point of the #315 extraction. `runAgentThink` cannot be called from a unit test, so a
		// claim written there is a claim nothing can check; all of them now live in the pure modules
		// above. This is the assertion that keeps it that way.
		expect(findSourceClaims(readFileSync(join(SRC, "agent-think.ts"), "utf8"))).toEqual([]);
	});
});
