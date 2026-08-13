/**
 * Prompt-drift guard (#315) — a prompt may not tell an agent something its own capabilities
 * contradict.
 *
 * ── The class, and why care did not close it
 *
 * Four incidents, one shape: a prompt string asserting something about the agent that its
 * RESOLVED capabilities say is false. Each was fixed on its own; the class stayed open.
 *
 *   #254  "NEVER claim you personally ran commands… you do not drive the engine"
 *         — `start_work` was in BASE and the agent had just used it. Challenged, it retracted
 *           TRUE work and told the user to redo it by hand.
 *   #255  "attach a repository in the Repo tab"
 *         — the agent declares `surfaces: ["coding"]`. It has no Repo tab.
 *   #247  the Coder docs described a tmux pane
 *         — the engine is a child process; tmux left in June.
 *   #318  `executionAuthorityPrompt` told a Coder Lead it "cannot run shell commands… never claim
 *         you fixed a bug" — false for the only thing a Lead does, which is delegate. It recanted
 *         a true statement to the user.
 *
 * Every one was written by someone who understood the system, and #254's was written AS a
 * correctness fix. They went stale because capability MOVED — a tool joined BASE, a surface was
 * declared, a runtime was replaced — not because anyone was careless. Capability is data
 * (`toolNamesFor`, `capabilities.surfaces`, `capabilities.runtime`); claims about capability were
 * hardcoded English, and English cannot be type-checked. That gap is what this closes.
 *
 * ── What is mechanically checkable, and what is not
 *
 * A prompt sentence is prose. The honest boundary is: **a claim keyed to a NAMED capability can be
 * cross-checked; free-text advice cannot.** This guard covers exactly four such keys and claims
 * nothing beyond them:
 *
 *   1. TAB    — "the <X> tab" ⇒ `X ∈ tabsFor(capabilities)`.                            (#255)
 *   2. TOOL   — a tool name from the platform catalog ⇒ it is in `toolNamesFor(capabilities)`.
 *   3. DENIAL — a sentence asserting the agent CANNOT do something ⇒ the matching predicate over
 *               the resolved `SelfModel` must actually be false. This is the inverse direction,
 *               and the one nobody thinks to check.                                (#254, #318)
 *   4. RUNTIME— "`pags up`" / "tmux" ⇒ `capabilities.runtime` / the `tmux` surface exists. (#247)
 *
 * WHAT IT CANNOT SEE, stated so nobody mistakes its silence for coverage:
 *
 *   • Any claim not keyed to a name in the capability data. "Be concise", "cite file paths",
 *     "the user is non-technical" are unfalsifiable here and are not looked at.
 *   • Whether a tab the agent DOES have is the RIGHT tab for what the sentence is about.
 *   • Sub-locations that are not tabs (KB sub-tabs, console sections, modal names). An invented
 *     one is reported by the source ratchet as unadjudicated, never as a violation.
 *   • Anything assembled at runtime from D1/DO rows — repo names, terminal snapshots, settings
 *     values. The guard reads the FIXED text around them, which is where claims live.
 *   • Prompts built outside the modules the test scans (workflow brains, connector descriptions).
 *   • Whether a true claim is USEFUL. A prompt can be perfectly consistent and still bad advice.
 *
 * ── The inverse lexing problem
 *
 * `source-guard.ts` (#306) blanks comments and string literals before matching, because in this
 * codebase the identifiers a guard looks for appear far more often in prose ABOUT the rule than in
 * code that breaks it. Here the SUBJECT IS the string literals: the prompt is what is inside the
 * quotes, and the comments around it are the prose that explains why. So this module needs the
 * exact inverse — `promptTextOf` keeps literal text and blanks code AND comments — and it matters
 * as much in this direction: of the ~14 mentions of "Repo tab" / "Coding tab" in
 * `workers/api/src`, nearly all are in comments explaining these very incidents. A guard reading
 * them would report its own documentation and be muted within a week.
 *
 * Template-literal `${…}` interpolations are blanked too: they are code, and their VALUE is the
 * runtime data the guard already declares it cannot see.
 */
import { BASE, TOOL_CATALOG, toolNamesFor } from "../agent-do-tools.js";
import type { AgentCapabilities } from "./agent-capabilities.js";
import { resolveSelfModel, tabsFor, type SelfModel } from "./agent-self-description.js";
import { stripCommentsAndLiterals } from "./source-guard.js";

// ── The vocabularies, all derived ────────────────────────────────────────────────────────────

/**
 * Every tab any agent can have — the union of `tabsFor` over the whole surface vocabulary.
 *
 * Derived rather than listed so a new surface's tab enters the guard's vocabulary the moment it
 * exists. A tab name outside this set cannot be adjudicated (it may be a KB sub-tab or a section),
 * and is reported as `known: false` rather than as a violation.
 */
export const KNOWN_TABS: ReadonlySet<string> = new Set([
	...tabsFor({ surfaces: ["apply", "coding", "insurance", "repo", "tmux"], runtime: null, workflow: null, boardColumns: [] }),
	...tabsFor({ surfaces: [], runtime: null, workflow: null, boardColumns: [] }),
]);

/**
 * Every tool name the platform knows, from the same data the gate uses.
 *
 * `toolNamesFor({})` is the FULL default set; the catalog adds the creator-selectable and
 * connector groups; BASE is included explicitly because a declared allowlist keeps it. A name
 * outside this set is not a tool claim — it is some other snake_case word — and is ignored.
 */
export const KNOWN_TOOLS: ReadonlySet<string> = new Set([
	...toolNamesFor({ surfaces: [], runtime: null, workflow: null, boardColumns: [] }),
	...toolNamesFor({ surfaces: ["repo"], runtime: null, workflow: null, boardColumns: [] }),
	...toolNamesFor({ surfaces: ["coding"], runtime: "coding", workflow: null, boardColumns: [], surfaceOptions: { coding: { drive: true } } }),
	...BASE,
	...TOOL_CATALOG.flatMap((g) => g.tools),
]);

/**
 * Tools a prompt may name without the capability set granting them.
 *
 * `find_confirmation_link` is granted by a USER PERMISSION at request time (`permissions.email`),
 * not by capabilities, so `toolNamesFor` legitimately does not contain it. Listing the exception
 * is the point: the alternative is loosening the tool check for everything.
 */
const TOOL_EXEMPT: ReadonlySet<string> = new Set(["find_confirmation_link"]);

// ── Claim detection ──────────────────────────────────────────────────────────────────────────

export type ClaimKind = "tab" | "tool" | "denial" | "runtime";

export interface ClaimViolation {
	kind: ClaimKind;
	/** The capability named — a tab, a tool, a denial id, a runtime feature. */
	claim: string;
	/** The sentence fragment that made the claim, for the failure message. */
	evidence: string;
	/** Why it is false for these capabilities, and what to do instead. */
	why: string;
}

export interface TabMention {
	tab: string;
	/** Is this a tab the console can actually render? Unknown ones cannot be adjudicated. */
	known: boolean;
	evidence: string;
}

/** Snippet around a match, for a failure message that names the offending sentence. */
function around(text: string, index: number, length: number): string {
	const from = Math.max(0, index - 60);
	const to = Math.min(text.length, index + length + 60);
	return text.slice(from, to).replace(/\s+/g, " ").trim();
}

/**
 * Every "<Name> tab" in the text.
 *
 * Case-sensitive on the leading capital: tabs are proper nouns in this UI ("the Coding tab"), and
 * matching lowercase would sweep in ordinary prose about tab characters and tab stops.
 */
export function findTabMentions(text: string): TabMention[] {
	const out: TabMention[] = [];
	for (const m of text.matchAll(/\b([A-Z][A-Za-z&' ]{1,20}?) tabs?\b/g)) {
		const tab = m[1].trim();
		out.push({ tab, known: KNOWN_TABS.has(tab), evidence: around(text, m.index ?? 0, m[0].length) });
	}
	return out;
}

/** Every platform tool name mentioned in the text. */
export function findToolMentions(text: string): { tool: string; evidence: string }[] {
	const out: { tool: string; evidence: string }[] = [];
	for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
		if (!KNOWN_TOOLS.has(m[0])) continue;
		out.push({ tool: m[0], evidence: around(text, m.index ?? 0, m[0].length) });
	}
	return out;
}

/**
 * Sentences that DENY a capability, each with the predicate that must hold for the denial to be
 * true.
 *
 * This is the half that #254 and #318 needed and that no reviewer looks for: everyone checks that
 * a prompt does not over-promise, and the damaging direction turned out to be the opposite. A
 * denial the tools contradict does not merely mislead the model — it makes an honest agent tell
 * the user it lied, because faced with its own tool results contradicting its own instructions,
 * the model believes the instructions.
 *
 * Patterns are deliberately narrow: they match ASSERTIONS OF INCAPACITY ("you cannot run shell
 * commands"), never instructions about honesty ("never claim you ran a command"), which are true
 * for every agent and must stay legal.
 */
interface DenialRule {
	id: string;
	re: RegExp;
	/** True when the denial is honest for this agent. */
	holds: (m: SelfModel) => boolean;
	why: string;
}

export const DENIAL_RULES: readonly DenialRule[] = [
	{
		id: "cannot-act",
		// "you cannot run shell commands", "you have no ability to change code", "You are READ-ONLY".
		re: /\b(?:you )?(?:cannot|can't|are unable to|have no ability to)\s+(?:run shell commands|run commands|change code|modify (?:it|the code|code)|drive the (?:coding )?engine)|\bYou are READ-ONLY\b/gi,
		holds: (m) => !m.canStartWork && !m.canDrive && !m.canDelegate,
		why: "this agent CAN cause work to happen (start_work / send_to_cli / delegate_goal). #254 and #318 are both this sentence surviving the arrival of an executor — the model believes it over its own tool results and retracts real work.",
	},
	{
		id: "does-not-drive",
		re: /\byou do not drive the (?:coding )?engine\b|\byou never drive the (?:coding )?engine\b/gi,
		holds: (m) => !m.canDrive,
		why: "this agent has `send_to_cli` — it really does type into the engine.",
	},
	{
		id: "no-code-index",
		re: /\byou do NOT have a searchable code index\b|\bno searchable code index\b/gi,
		holds: (m) => !m.hasCodeIndex,
		why: "this agent declares the `repo` surface, so it genuinely has a vector index of code.",
	},
	{
		id: "no-voice-control",
		// "you do not control the microphone or voice mode"; "You cannot start, stop, mute, unmute or
		// switch it". Narrow to the voice channel — an agent saying it cannot stop a RUN is a different
		// sentence and must stay legal.
		re: /\byou do not control the (?:microphone|mic|voice mode)\b|\byou cannot start, stop, mute\b/gi,
		holds: (m) => !m.controlsVoice,
		why: "this agent has a tool that operates the voice channel, so denying it is the #254 shape — a denial that survived the arrival of the tool contradicting it. Rewrite the line to describe what it CAN do, and check whether the client still matches exit phrases before the model sees them.",
	},
	{
		id: "cannot-add-repo",
		re: /\byou cannot add (?:one|a repository)\b/gi,
		holds: (m) => m.singleRepo,
		why: "only a `repos: \"single\"` agent owns exactly one repository; anything else can hold more.",
	},
];

/** Positive claims about a mechanism, keyed to a named capability. */
interface MechanismRule {
	id: string;
	re: RegExp;
	holds: (c: AgentCapabilities, m: SelfModel) => boolean;
	why: string;
}

const MECHANISM_RULES: readonly MechanismRule[] = [
	{
		id: "local-runner",
		re: /`pags up`|\bstart the runner\b/g,
		holds: (_c, m) => m.hasRunner,
		why: "this agent declares no local runtime, so there is no runner to start — `pags up` skips it entirely (\"None of your agents need a local runner\"). Sending its owner to the CLI is advice they cannot act on.",
	},
	{
		id: "tmux",
		re: /\btmux\b/g,
		holds: (c) => (c.surfaces ?? []).includes("tmux"),
		why: "the coding engine is a child process, not a tmux pane — tmux was removed in June and belongs only to the terminal connector (#247).",
	},
	{
		id: "code-index",
		re: /\bthe indexed code\b|\byour indexed knowledge\b/g,
		holds: (_c, m) => m.hasCodeIndex,
		why: "this agent has no vector index of code. Telling it to ground answers in 'the indexed code' is what made a Coder search an empty store and report the code 'isn't indexed' — a hallucinated failure.",
	},
];

/**
 * Every claim in `prompt` that these capabilities contradict.
 *
 * `prompt` is the SYSTEM PROMPT as the model receives it, not source. Callers assemble it from the
 * real builders (see `prompt-claims.test.ts`), so the guard checks the shipped wording rather than
 * a paraphrase of it.
 */
export function promptClaimViolations(prompt: string, capabilities: AgentCapabilities): ClaimViolation[] {
	const model = resolveSelfModel(capabilities);
	const tabs = new Set(model.tabs);
	const tools = toolNamesFor(capabilities);
	const out: ClaimViolation[] = [];

	for (const mention of findTabMentions(prompt)) {
		if (!mention.known || tabs.has(mention.tab)) continue;
		out.push({
			kind: "tab",
			claim: mention.tab,
			evidence: mention.evidence,
			why: `this agent's console has exactly: ${model.tabs.join(", ")}. Naming another tab sends the user somewhere that does not exist for them (#255). Derive the clause from \`SelfModel.tabs\` (see \`tabClause\`).`,
		});
	}

	for (const mention of findToolMentions(prompt)) {
		if (tools.has(mention.tool) || TOOL_EXEMPT.has(mention.tool)) continue;
		out.push({
			kind: "tool",
			claim: mention.tool,
			evidence: mention.evidence,
			why: `\`toolNamesFor\` did not grant \`${mention.tool}\` to this agent, so the model is being told about a tool it will never see a schema for.`,
		});
	}

	for (const rule of DENIAL_RULES) {
		if (rule.holds(model)) continue;
		for (const m of prompt.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
			out.push({ kind: "denial", claim: rule.id, evidence: around(prompt, m.index ?? 0, m[0].length), why: rule.why });
		}
	}

	for (const rule of MECHANISM_RULES) {
		if (rule.holds(capabilities, model)) continue;
		for (const m of prompt.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
			out.push({ kind: "runtime", claim: rule.id, evidence: around(prompt, m.index ?? 0, m[0].length), why: rule.why });
		}
	}

	return out;
}

/** One violation, rendered for a test failure that says what to change. */
export function describeViolation(v: ClaimViolation): string {
	return `[${v.kind}: ${v.claim}] …${v.evidence}…\n    → ${v.why}`;
}

// ── The inverse lexer: keep the strings, blank the code ──────────────────────────────────────

/**
 * The PROMPT TEXT of a source file: string and template literals kept, everything else blanked.
 *
 * The exact inverse of `source-guard.ts`'s `stripCommentsAndLiterals`, for the exact inverse
 * reason. Line breaks and length are preserved so a hit's line number still points at the real
 * line.
 *
 * Two deliberate details:
 *   • `${…}` interpolations are blanked. They are code, and a guard that read them would be
 *     reporting identifiers rather than prose — the very thing the other lexer exists to avoid.
 *   • Comments are blanked, not kept. This codebase documents its incidents at length, and the
 *     paragraphs about "the Repo tab" outnumber the prompt lines naming it roughly ten to one.
 */
export function promptTextOf(source: string): string {
	const out = source.split("");
	const keep = new Set<number>();
	let i = 0;
	let prev = "";

	/**
	 * Keep a literal — unless it is a single token.
	 *
	 * `"tmux"`, `"coding"`, `"Settings"` are IDENTIFIERS spelled as strings: surface ids, table
	 * names, switch cases. They are the string-literal equivalent of the prose problem the other
	 * lexer solves, and without this the ratchet reports `if (s.includes("tmux"))` as a claim about
	 * a tmux pane. A prompt sentence has spaces in it; a discriminant does not. Deliberately an
	 * under-report — a one-word prompt is not a thing this guard needs to adjudicate.
	 */
	const markKept = (from: number, to: number) => {
		if (!/\s|\\n/.test(source.slice(from, to))) return;
		for (let k = from; k < to && k < out.length; k++) keep.add(k);
	};

	while (i < source.length) {
		const c = source[i];
		const next = source[i + 1];
		if (c === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 2;
			continue;
		}
		if (c === '"' || c === "'") {
			const j = skipQuoted(source, i, c);
			markKept(i + 1, j - 1);
			i = j;
			prev = c;
			continue;
		}
		if (c === "`") {
			i = walkTemplate(source, i, markKept);
			prev = "`";
			continue;
		}
		if (c === "/" && opensRegex(prev)) {
			const j = skipRegex(source, i);
			if (!source.slice(i, j).includes("\n")) {
				i = j;
				prev = "/";
				continue;
			}
		}
		if (!/\s/.test(c)) prev = c;
		i++;
	}

	for (let k = 0; k < out.length; k++) {
		if (keep.has(k) || out[k] === "\n") continue;
		out[k] = " ";
	}
	// `"a" + "b"` is one prompt sentence split across two literals; without a separator the words
	// either side of the join would fuse ("…startedYou have…") and hide a match.
	return out.join("").replace(/\\n/g, " ");
}

/** Index just past the closing quote. */
function skipQuoted(src: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < src.length) {
		if (src[i] === "\\") {
			i += 2;
			continue;
		}
		if (src[i] === quote) return i + 1;
		if (src[i] === "\n") return i;
		i++;
	}
	return src.length;
}

/** Keep a template literal's text, skip its `${…}` code. Returns the index past the closing backtick. */
function walkTemplate(src: string, start: number, markKept: (a: number, b: number) => void): number {
	let i = start + 1;
	let textFrom = i;
	while (i < src.length) {
		if (src[i] === "\\") {
			i += 2;
			continue;
		}
		if (src[i] === "`") {
			markKept(textFrom, i);
			return i + 1;
		}
		if (src[i] === "$" && src[i + 1] === "{") {
			markKept(textFrom, i);
			let depth = 1;
			let j = i + 2;
			while (j < src.length && depth > 0) {
				if (src[j] === "`") {
					j = walkTemplate(src, j, markKept);
					continue;
				}
				if (src[j] === '"' || src[j] === "'") {
					j = skipQuoted(src, j, src[j]);
					continue;
				}
				if (src[j] === "{") depth++;
				else if (src[j] === "}") depth--;
				j++;
			}
			i = j;
			textFrom = i;
			continue;
		}
		i++;
	}
	markKept(textFrom, src.length);
	return src.length;
}

/** After these, a `/` starts a regex literal rather than a division. */
function opensRegex(prev: string): boolean {
	return prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev);
}

/** Index just past the closing `/` (plus flags). */
function skipRegex(src: string, start: number): number {
	let i = start + 1;
	let inClass = false;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "\n") return i;
		if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) {
			i++;
			while (i < src.length && /[a-z]/.test(src[i])) i++;
			return i;
		}
		i++;
	}
	return src.length;
}

/** A hardcoded claim found in source, for the ratchet. */
export interface SourceClaim {
	/** 1-based line of the literal. */
	line: number;
	kind: ClaimKind;
	claim: string;
}

/**
 * Every claim hardcoded in a source file's STRING LITERALS.
 *
 * The semantic check above can only see prompts a test can assemble. This is the other half: it
 * reports every capability-naming literal in the tree so a new one lands in review, whether or not
 * a fixture reaches it. It cannot tell whether the branch around the literal is correctly gated —
 * that is what the fixture check is for — so it is a RATCHET, not a verdict.
 */
export function findSourceClaims(source: string): SourceClaim[] {
	const text = promptTextOf(source);
	const lineAt = (index: number) => source.slice(0, index).split("\n").length;
	const out: SourceClaim[] = [];
	for (const m of text.matchAll(/\b([A-Z][A-Za-z&' ]{1,20}?) tabs?\b/g)) {
		out.push({ line: lineAt(m.index ?? 0), kind: "tab", claim: m[1].trim() });
	}
	for (const rule of DENIAL_RULES) {
		for (const m of text.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
			out.push({ line: lineAt(m.index ?? 0), kind: "denial", claim: rule.id });
		}
	}
	for (const rule of MECHANISM_RULES) {
		for (const m of text.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
			out.push({ line: lineAt(m.index ?? 0), kind: "runtime", claim: rule.id });
		}
	}
	return out;
}

// ── Which modules the ratchet must read (#557) ────────────────────────────────────────────────

/**
 * What a scan of the prompt ASSEMBLY site found, sizes included.
 *
 * The ratchet above is only as wide as the list of files handed to it, and until #557 that list was
 * typed by hand: four modules whose text `agent-think.ts` concatenates straight onto `systemPrompt`
 * were outside it, and #395 and #337 had both had to be REMEMBERED into it. A hand list cannot fail
 * — it can only be short — which is the shape ADR 0002 exists to forbid.
 *
 * So the guard derives the set instead, and the sizes are returned rather than logged because
 * ADR 0002 G1 makes the denominator an assertion: `appendSites` collapsing to a handful is what a
 * move to a `parts.push(…)` assembly looks like from here, and it would otherwise present as a
 * clean tree.
 */
export interface PromptReach {
	/** Module paths relative to `workers/api/src`, e.g. `lib/memory-prompt.ts`. Sorted, unique. */
	modules: string[];
	/** `systemPrompt +=` statements parsed. */
	appendSites: number;
	/** Names the import map resolved to a relative module. */
	importedNames: number;
	/** RHS identifiers resolved to neither an import nor a one-hop local — see the limits below. */
	unresolved: string[];
}

/**
 * Every module whose exports reach `systemPrompt` in the given source.
 *
 * WHAT IT DOES NOT HANDLE, stated because a scanner's silence is otherwise read as coverage
 * (ADR 0002 G3), and asserted one-by-one in `prompt-claims.test.ts`:
 *
 *   • TWO hops. `const a = fooPrompt(); const b = a; systemPrompt += b;` resolves `b` to `a` and
 *     stops. One hop is what the real assembly needs (`settingsBlock`, `statsBlock`) and every
 *     extra hop widens the false-positive surface for no case that exists.
 *   • Anything not written as a `systemPrompt +=` statement — a `parts` array, a helper that takes
 *     the prompt and returns it. `appendSites` is the assertion that this has not happened.
 *   • Re-exports. A module that re-exports another's prompt text resolves to the barrel, not the
 *     origin; the origin's claims would go unscanned.
 *   • A local function defined in the same file (`toolBlurbFor`) — it is not an import, so it lands
 *     in `unresolved`. That is correct here: the file is scanned anyway, by name.
 *   • Default and namespace imports. Named imports only, which is what this file uses.
 *
 * Comments are blanked by the reference stripper (`source-guard.ts`) before the append scan, so the
 * prose ABOUT the assembly does not enter it. The IMPORT scan runs over raw source, because that
 * same stripper blanks the module specifier the scan is trying to read.
 */
export function promptModulesReachedBy(source: string): PromptReach {
	const code = stripCommentsAndLiterals(source);
	const imports = new Map<string, string>();
	for (const m of source.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(\.[^"]*)"/gm)) {
		const mod = m[2].replace(/^\.\//, "").replace(/\.js$/, ".ts");
		for (const raw of m[1].split(",")) {
			const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
			if (name) imports.set(name, mod);
		}
	}

	const modules = new Set<string>();
	const unresolved = new Set<string>();
	const sites = statementsAfter(code, /systemPrompt\s*\+=/g);
	for (const site of sites) {
		for (const id of identifiersIn(site)) {
			const direct = imports.get(id);
			if (direct) {
				modules.add(direct);
				continue;
			}
			// One hop: the local the statement names may be the result of a prompt builder.
			const init = statementsAfter(code, new RegExp(`\\b(?:const|let|var)\\s+${id}\\b[^=;()]*=`, "g"))[0];
			const hopped = init ? identifiersIn(init).filter((n) => imports.has(n)) : [];
			if (hopped.length) for (const n of hopped) modules.add(imports.get(n) as string);
			else unresolved.add(id);
		}
	}
	return {
		modules: [...modules].sort(),
		appendSites: sites.length,
		importedNames: imports.size,
		unresolved: [...unresolved].sort(),
	};
}

/** The text between each match of `re` and the `;` that ends its statement, at bracket depth 0. */
function statementsAfter(code: string, re: RegExp): string[] {
	const out: string[] = [];
	for (const m of code.matchAll(re)) {
		let i = (m.index ?? 0) + m[0].length;
		const start = i;
		let depth = 0;
		for (; i < code.length; i++) {
			const c = code[i];
			if (c === "(" || c === "[" || c === "{") depth++;
			else if (c === ")" || c === "]" || c === "}") {
				if (depth === 0) break;
				depth--;
			} else if (c === ";" && depth === 0) break;
		}
		out.push(code.slice(start, i));
	}
	return out;
}

/** Identifiers in already-stripped code, excluding property accesses (`x.foo` yields only `x`). */
function identifiersIn(code: string): string[] {
	const out = new Set<string>();
	for (const m of code.matchAll(/(\.)?\b([A-Za-z_$][\w$]*)\b/g)) {
		if (!m[1]) out.add(m[2]);
	}
	return [...out];
}
