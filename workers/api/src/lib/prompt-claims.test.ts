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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
	promptModulesReachedBy,
	promptTextOf,
} from "./prompt-claims.js";
import { describeFacts } from "./runner-availability.js";
import type { AttachmentDiagnosis, AttachmentState } from "./runtime-attachment.js";
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
		/** The runner block's diagnosis, or `null` for "the connectivity read failed" (#530). */
		runner: AttachmentDiagnosis | null;
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
		opts.hasRepos ? runnerStatusPrompt(model, opts.runner) : "",
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

/**
 * One set of facts per attachment state, swept as STATES rather than as online/offline (#530).
 *
 * The runner block used to take a boolean, so this axis had two values and the sentence that
 * mattered — "you are pinned to a machine that is off; the other one is up" — was never built by
 * any condition, and therefore never adjudicated. It carries the phrase "start the runner on X",
 * which is a `local-runner` claim, so an ungated version of it is exactly what this guard is for.
 *
 * Typed as a full `Record<AttachmentState, …>`: adding a sixth state to the union is a compile
 * error here until the sweep covers it.
 */
const heartbeat = (agoMs: number) => new Date(Date.now() - agoMs).toISOString().slice(0, 19).replace("T", " ");
const RUNNER_FACTS: Record<AttachmentState, Parameters<typeof describeFacts>[0]> = {
	attached: { hasRuntimeRow: true, relayConnected: true, node: "RLs-MacBook-Air", runnerVersion: null, lastSeenAt: heartbeat(5_000) },
	"never-registered": { hasRuntimeRow: false, relayConnected: false, node: null, runnerVersion: null, lastSeenAt: null },
	"runner-offline": { hasRuntimeRow: true, relayConnected: false, node: "RLs-MacBook-Air", runnerVersion: null, lastSeenAt: heartbeat(600_000) },
	"machine-online-agent-detached": {
		hasRuntimeRow: true,
		relayConnected: false,
		node: "RLs-MacBook-Air",
		runnerVersion: null,
		lastSeenAt: heartbeat(5_000),
	},
	"pinned-machine-offline": {
		hasRuntimeRow: true,
		relayConnected: false,
		node: "Sergeys-Mac-mini.local",
		runnerVersion: null,
		lastSeenAt: heartbeat(5_000),
		pinnedNode: "Sergeys-Mac-mini.local",
		liveNodeExcludedByPin: "RLs-MacBook-Air",
	},
};

/** Every diagnosis the block can carry, plus the unread case. */
const RUNNER_STATES: (AttachmentDiagnosis | null)[] = [null, ...Object.values(RUNNER_FACTS).map((f) => describeFacts(f))];

/** Every runtime shape a prompt can be built in — the branches are what drift. */
const CONDITIONS = [true, false].flatMap((technicalSeed) =>
	[true, false].flatMap((hasRepos) =>
		RUNNER_STATES.flatMap((runner) =>
			[true, false].flatMap((activeSession) =>
				[true, false].flatMap((indexedRepos) =>
					[true, false].map((lowTechnicality) => ({
						technicalSeed,
						hasRepos,
						runner,
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
				runner: null,
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

	it("#530 — the pinned sentence is built by the sweep, and is a claim only an agent with a runner may make", () => {
		// Two ways this could pass while testing nothing: the fixtures could diagnose something
		// other than what they are filed under, or the pinned diagnosis could never reach a prompt.
		for (const [state, f] of Object.entries(RUNNER_FACTS)) expect(describeFacts(f).state, state).toBe(state);
		const pinned = RUNNER_STATES.find((d) => d?.state === "pinned-machine-offline");
		expect(pinned?.remedy).toBeNull();

		const coder = assemblePrompt(CODER_REPO, {
			technicalSeed: false,
			hasRepos: true,
			runner: pinned ?? null,
			// An active session, so the only block that could contribute a `pags up` is the runner one.
			activeSession: true,
			indexedRepos: false,
			lowTechnicality: false,
		});
		expect(coder).toContain("pinned to Sergeys-Mac-mini.local");
		expect(coder).toContain("RLs-MacBook-Air is connected");
		expect(coder).not.toContain("pags up");

		// And the reason the block gates the diagnosis on `hasRunner` rather than always emitting it:
		// the same sentence handed to a cloud-only agent IS a claim about a runner it has not got.
		expect(promptClaimViolations(`## Runner status: OFFLINE — ${pinned?.message}`, PLAIN_CHAT).map((v) => v.claim)).toEqual(["local-runner"]);
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
 * The modules whose string literals become an agent's system prompt — DERIVED, not typed (#557).
 *
 * Scoped, not tree-wide, and the scan that established the scope is the argument for it: over all
 * of `workers/api/src` the same patterns report 105 hits, of which the overwhelming majority are
 * the tmux CONNECTOR (where tmux is the actual subject), and six are `"You can close this tab."`
 * in OAuth callback HTML — a browser tab, not a console tab. Those are not prompts and the guard
 * has nothing true to say about them. Tool descriptions ARE in scope (`tool-registry.ts`): the
 * model reads them in the same context, and a tool description naming a tab the agent lacks is
 * the same bug in a different string.
 *
 * ── Why the list is no longer a list
 *
 * It was thirteen file names someone had to remember, and four modules had already fallen out of
 * it: `memory-prompt`, `repo-status-prompt`, `deployment-prompt` and `connector-tool-prompt` are
 * each concatenated straight onto `systemPrompt` in `agent-think.ts` and none was scanned. Nothing
 * could have reported that, because a hand-typed denominator cannot fail — it can only be short,
 * and a short one prints the same green tick as a complete one (ADR 0002).
 *
 * So the set now comes from `promptModulesReachedBy`, which reads the assembly site itself: the
 * modules whose exports appear in a `systemPrompt +=` statement, one hop through a local. The five
 * below are the ones that derivation genuinely cannot see, each with the reason it is prompt text
 * anyway — and a reason is required precisely because "this one is different" is the judgement that
 * goes stale.
 */
const PROMPT_MODULES_BY_HAND: Record<string, string> = {
	"agent-think.ts":
		"the assembly site itself. It is the source the derivation reads, so it can never be in the derived output; the test below asserts separately that it hardcodes no claim at all.",
	"agent-do-prompt.ts": "the base prompt and the model defaults — read by the model, assembled outside `runAgentThink`.",
	"agent-do-tools.ts": "the tool catalog's own descriptions, which the model reads in the same context as the prompt.",
	// #395. The correction handed back to a model that wrote its own tool result is prompt text the
	// model acts on, so it belongs in the scan. It names no capability today and that is the point
	// of pinning it: the honest wording of "here is what actually ran" is one edit away from naming
	// a tool or a surface the agent does not have.
	"lib/invented-results.ts":
		"#395 — the correction handed back to a model that invented its own tool result is text the model acts on. It reaches the conversation, not `systemPrompt`, so no derivation over the assembly site can find it.",
	// #557 step 4. The one file the audit found holding a claim outside the old list, decided
	// deliberately rather than left as the only file that was neither in scope nor excused.
	"lib/storage-tools.ts":
		"#557 — storage tool DESCRIPTIONS and their results, on exactly the reasoning the entries above make for `agent-do-tools.ts` and `invented-results.ts`: the model reads them in the same context. Reached only through the tool dispatcher, never through `systemPrompt +=`.",
};

/**
 * Modules that LOOK like prompt text and are not, each with the reason — the same exact-set-plus-
 * reason discipline `security-invariants.test.ts` uses for `NON_AUTHORIZING`, staleness check
 * included: an entry naming a file that no longer exists, or that has since joined the scan, fails.
 */
const NOT_PROMPT_TEXT: Record<string, string> = {
	"lib/engine-auth-prompt.ts":
		"named `-prompt` but it is not one: it builds the ENGINE's environment (which credential a CLI signs in with), and is imported by `routes/coding.ts`, not by the chat prompt builder. Nothing it returns is read by a model.",
};

const REACH = promptModulesReachedBy(readFileSync(join(SRC, "agent-think.ts"), "utf8"));

const PROMPT_MODULES = [...new Set([...Object.keys(PROMPT_MODULES_BY_HAND), ...REACH.modules])].sort();

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
	// #557 — the ONE entry the widened scan added, and the reason it is honest rather than a pin
	// bumped to make a number pass: `send_to_cli`'s failure path, "Runner offline — cannot send.
	// Start it with `pags up`.". It is reached only after `getBoundRunnerConn` has returned null
	// for a tool that only a `runtime`-declaring agent is granted, so `pags up` is advice its owner
	// can act on. Every other module the scan gained holds zero claims and moved nothing.
	"lib/storage-tools.ts — runtime:local-runner": 1,
};

describe("hardcoded capability claims in the prompt modules", () => {
	const found: Record<string, number> = {};
	const unreadable: string[] = [];
	for (const rel of PROMPT_MODULES) {
		// G3: a module the scan resolves but cannot READ is reported, never skipped. Skipping it
		// turns a bug in the resolver into a quietly smaller measurement, which is the whole
		// failure mode this guard was widened to close.
		let source: string;
		try {
			source = readFileSync(join(SRC, rel), "utf8");
		} catch {
			unreadable.push(rel);
			continue;
		}
		for (const c of findSourceClaims(source)) {
			const key = `${rel} — ${c.kind}:${c.claim}`;
			found[key] = (found[key] ?? 0) + 1;
		}
	}

	it("were all readable — an unreadable module is an unscanned module", () => {
		expect(
			unreadable,
			"`promptModulesReachedBy` resolved an import to a path that is not a file. Either the resolver's\n" +
				"`.js`→`.ts` rewrite has met a case it does not handle, or a module moved. Fix the resolver —\n" +
				"do not drop the entry, because a dropped entry is a file nobody scans and nothing reports.",
		).toEqual([]);
	});

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

// ── 6. The denominator (#557, ADR 0002) ──────────────────────────────────────────────────────

/**
 * What the ratchet above MEASURED, asserted rather than assumed.
 *
 * The ratchet's own output cannot distinguish "no module holds an unreviewed claim" from "the set
 * of modules is a third of what it should be", and for four modules it was the second. These are
 * the assertions that make the two look different.
 */
describe("the modules the ratchet reads", () => {
	it("reads every module `agent-think.ts` appends to the prompt", () => {
		// The rule the four missing modules broke. Stated as containment, not equality, because
		// `PROMPT_MODULES_BY_HAND` legitimately adds paths the assembly site cannot show.
		const missing = REACH.modules.filter((m) => !PROMPT_MODULES.includes(m));
		expect(missing, "a module whose text reaches `systemPrompt` is not being scanned").toEqual([]);
	});

	it("found the assembly it claims to have read", () => {
		// G1. `agent-think.ts` builds the prompt with 42 `systemPrompt +=` statements over 91
		// imported names. The bound is not those numbers — it is the shape: a move to a `parts`
		// array or a builder helper takes the site count to near zero, and the derivation would
		// then return a small, confident, wrong set. 25 is comfortably below honest churn and
		// far above what any other assembly shape would leave behind.
		expect(
			REACH.appendSites,
			"fewer than 25 `systemPrompt +=` statements in agent-think.ts. The prompt is no longer assembled\n" +
				"the way this derivation reads it, so the module set below is measuring almost nothing.\n" +
				"Teach `promptModulesReachedBy` the new shape before trusting another green run.",
		).toBeGreaterThanOrEqual(25);
		expect(
			REACH.importedNames,
			"agent-think.ts resolved fewer than 40 named imports. The import scan has stopped matching,\n" +
				"so every identifier in the prompt assembly now resolves to nothing and the set is empty by\n" +
				"construction rather than by cleanliness.",
		).toBeGreaterThanOrEqual(40);
		// The sharpest form of the same question: the derivation must find the module that carries
		// most of the reviewed claims. If it cannot see `agent-style-prompt.ts`, it sees nothing.
		expect(REACH.modules).toContain("lib/agent-style-prompt.ts");
		expect(REACH.modules).toContain("lib/memory-prompt.ts");
		expect(REACH.modules.length).toBeGreaterThanOrEqual(15);
	});

	it("scans every *-prompt.ts module, or says why not", () => {
		// The name rule, which catches what the derivation cannot: a module written and named as
		// prompt text but not yet wired in, or wired in through a shape the resolver misses.
		const promptFiles = readdirSync(join(SRC, "lib"))
			.filter((f) => f.endsWith("-prompt.ts"))
			.map((f) => `lib/${f}`)
			.sort();
		// G1 again: this glob is an input set too, and an empty one would pass silently.
		expect(
			promptFiles.length,
			"fewer than 5 `lib/*-prompt.ts` modules. The naming convention moved or the glob broke;\n" +
				"either way this rule has stopped measuring rather than found a clean tree.",
		).toBeGreaterThanOrEqual(5);
		const unaccounted = promptFiles.filter((f) => !PROMPT_MODULES.includes(f) && !(f in NOT_PROMPT_TEXT));
		expect(
			unaccounted,
			"a module named `*-prompt.ts` is neither scanned nor excused. Add it to the scan (it costs nothing\n" +
				"if it holds no claim) or give it a NOT_PROMPT_TEXT entry saying why its text never reaches a model.",
		).toEqual([]);
	});

	it("keeps NOT_PROMPT_TEXT honest — a stale excuse fails", () => {
		// The same staleness check `security-invariants.test.ts` gives its exception maps. An excuse
		// that outlives its subject is worse than no excuse: it reads as a reviewed decision.
		for (const [rel, why] of Object.entries(NOT_PROMPT_TEXT)) {
			expect(existsSync(join(SRC, rel)), `NOT_PROMPT_TEXT names ${rel}, which no longer exists`).toBe(true);
			expect(why.length, `NOT_PROMPT_TEXT[${rel}] needs a reason, not a placeholder`).toBeGreaterThan(40);
			expect(PROMPT_MODULES, `${rel} is excused AND scanned — delete the excuse`).not.toContain(rel);
			expect(
				REACH.modules,
				`${rel} is excused as unreachable from the prompt, but the assembly site now appends it. The reason is false.`,
			).not.toContain(rel);
		}
		for (const rel of Object.keys(PROMPT_MODULES_BY_HAND)) {
			expect(existsSync(join(SRC, rel)), `PROMPT_MODULES_BY_HAND names ${rel}, which no longer exists`).toBe(true);
		}
	});

	it("resolves a one-hop local, and stops at one — the limit, tested", () => {
		// ADR 0002's obligation on a hand-rolled source scanner: G1 plus a test naming what it does
		// NOT handle. Each of these is a real shape in `agent-think.ts` or a real way to escape it.
		const of = (src: string) => promptModulesReachedBy(src).modules;

		// Direct: the four modules #557 was filed about are all this shape.
		expect(of(`import { memoryPrompt } from "./lib/memory-prompt.js";\nsystemPrompt += memoryPrompt(m);`)).toEqual(["lib/memory-prompt.ts"]);
		// Through a template interpolation, which is how `settingsBlock` and `statsBlock` arrive.
		// Spelled in halves for the same reason the lexer test above does it — the lint rule that
		// objects to a placeholder inside a plain string would otherwise fire on the syntax under test.
		const interpolated = `$${"{b}"}`;
		expect(of(`import { p } from "./lib/a-prompt.js";\nconst b = p(x);\nsystemPrompt += \`\\n\\n${interpolated}\`;`)).toEqual([
			"lib/a-prompt.ts",
		]);
		// NOT handled — two hops. Recorded so nobody reads a green run as coverage of it.
		expect(of('import { p } from "./lib/a-prompt.js";\nconst b = p(x);\nconst c = b;\nsystemPrompt += c;')).toEqual([]);
		// NOT handled — an assembly that does not go through `systemPrompt +=`.
		expect(of('import { p } from "./lib/a-prompt.js";\nparts.push(p(x));')).toEqual([]);
		// Comments are blanked before the append scan, so prose about the assembly cannot widen it.
		expect(of('import { p } from "./lib/a-prompt.js";\n// systemPrompt += p(x)\n')).toEqual([]);
		// A string that mentions the assembly is not the assembly.
		expect(of('import { p } from "./lib/a-prompt.js";\nconst s = "systemPrompt += p(x)";')).toEqual([]);
		// A property access is not a reference to an import of the same name.
		expect(of('import { p } from "./lib/a-prompt.js";\nsystemPrompt += ctx.p;')).toEqual([]);
		// Bare packages are not modules of ours; only relative specifiers resolve.
		expect(of('import { p } from "hono";\nsystemPrompt += p(x);')).toEqual([]);
	});
});

// ── 7. The #459 failure-honesty block (#620) ─────────────────────────────────────────────────

/**
 * The failure-honesty sentences added by 8f5afaa sit in `agent-think.ts` (which cannot be called
 * from a unit test), not in a pure module. They are the one link in the not-stalled chain that
 * had no assertion behind it: `RUN_HEALTH_LEGEND` is pinned in `work-report.test.ts:256`, the
 * "NOT stalled" wording is pinned at `work-report.test.ts:92-93`, but the prompt that tells the
 * model to QUOTE the verdict and not to form its own view was readable only by a live turn.
 *
 * This section reads the source file directly (per ADR 0002 G1: assert the size, so a parse
 * failure reports "stopped measuring" rather than passing silently) and asserts the load-bearing
 * clauses. It pins the meaning — what the three sub-rules SAY — not the exact wording, so a
 * rewording that preserves intent does not fail.
 */
describe("#459 — failure-honesty prompt block is present in agent-think.ts (#620)", () => {
	const src = readFileSync(join(SRC, "agent-think.ts"), "utf8");
	const text = promptTextOf(src);

	it("read a plausible source file — G1 guard so a parse failure is not a silent pass", () => {
		// The real file is over 1 000 lines. 700 is comfortably below honest churn and far above
		// what an empty parse or an empty file would produce.
		expect(
			src.split("\n").length,
			"agent-think.ts has fewer than 700 lines — the file moved, was replaced, or the path is wrong;\n" +
				"the clauses below are measuring nothing. Investigate before trusting a green run.",
		).toBeGreaterThanOrEqual(700);
	});

	it("forbids asserting stalled / blocked / stuck / dead without a tool result", () => {
		// The prohibition introduced by #459. The exact wording is "never assert a run is stalled,
		// blocked, stuck or dead unless a tool result says so". Asserting the key terms rather than
		// the whole sentence so a rewording that keeps the rule intact does not fail.
		expect(text).toMatch(/stalled.*blocked.*stuck/);
		expect(text).toContain("tool result");
	});

	it("tells the model to quote the report's verdict rather than form its own view", () => {
		// The core of the fix: the platform computes NOT_STALLED correctly; the *prompt* must tell
		// the model to cite it. The defect in #459 was the model filling a silence — it was not
		// told to quote, so it reasoned from the counter instead.
		expect(text).toMatch(/quote it|states that verdict explicitly/);
	});

	it("explains that one instruction is a whole engine turn, so long = not stalled", () => {
		// Why the counter alone cannot diagnose a stall: each iteration is one instruction to the
		// engine, which may legitimately run for many minutes. Without this the model re-derives
		// "slow = stuck" the moment its memory of the rule fades.
		//
		// The phrase spans a `+` join in the source, so `promptTextOf` inserts a space at the
		// boundary; the regex allows one or two spaces between "whole" and "engine".
		expect(text).toMatch(/one instruction is a whole\s+engine turn/);
	});
});
