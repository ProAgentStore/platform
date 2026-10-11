/**
 * The owner's scope constraints, enforced on what the Pilot actually sends (#1019).
 *
 * #1015 made the owner's standing rules and mid-run directives reach EVERY Pilot decision, and said in
 * the prompt that they override the objective. That is propagation, not enforcement: nothing checked
 * that the instruction the model then produced respected them. A run told "read-only" could still be
 * handed "fix the bug and push" by a decision that leaned on the original objective, and the engine
 * would do it — the prompt is a request to the model, and the model is the thing being constrained.
 *
 * So this module does two things, both pure:
 *
 *   1. {@link activeConstraints} folds the owner's words — standing rules first, then every directive
 *      of the run in the order it was sent — into the set of constraints in force NOW. A later
 *      restriction binds over the objective and over anything earlier; a later explicit lift ends one.
 *      The objective itself is never a source: an original broad goal cannot supersede a later
 *      "read-only", which is the defect this exists for. One platform rule is always on: no unscoped
 *      process termination (`killall`, `pkill`, pattern- or pipeline-selected kills) unless the owner
 *      explicitly grants it — advice about capacity ("the machine is low on memory") is not a grant.
 *
 *   2. {@link screenScopedInstruction} checks ONE generated instruction against them, before it reaches
 *      the transport. It is the same kind of screen as the merge-authority one in `coding-authority.ts`
 *      and is wired beside it in `runCodingLoop`: a refused instruction never reaches `deps.act`, the
 *      refusal goes into the step log the next decision reads, and an in-scope instruction passes
 *      untouched.
 *
 * The detection is a heuristic over natural language and shell text, so it is deliberately NARROW:
 * each rule fires on a command or a phrase that unambiguously does the forbidden thing, a clause that
 * negates it ("do not edit anything") is ignored, and a false refusal costs one step-log line the Pilot
 * reads and rephrases around (bounded in the loop), where a false pass is the original defect.
 *
 * Refusals name the constraint and WHERE it came from ("owner directive 3"), never the directive's
 * text: the refusal is posted to the owner's chat and the timeline, and the owner's private wording
 * stays in the prompt that already holds it.
 */

export type ScopeKind =
	| "read_only"
	| "no_push"
	| "focused_tests"
	| "worker_limit"
	| "finish_after_push"
	| "no_process_inspection"
	| "no_recursive_collection"
	| "no_unscoped_termination";

export interface ScopeConstraint {
	kind: ScopeKind;
	/** Where it came from, for a refusal a reader can trace: "your standing rules", "owner directive 3". */
	source: string;
	/** `worker_limit` only: the most test workers allowed. */
	limit?: number;
}

/** One place an owner constraint can come from, in the order it was given. */
export interface ConstraintSource {
	text: string;
	label: string;
}

/** What each kind is called in a refusal and in the prompt's constraint list. */
export const SCOPE_LABEL: Record<ScopeKind, string> = {
	read_only: "read-only: no file changes, commits or pushes",
	no_push: "no push",
	focused_tests: "focused tests only: no full-suite run",
	worker_limit: "test worker limit",
	finish_after_push: "finish after the push: do not wait for or poll CI/deploy",
	no_process_inspection: "no collection of process arguments, environment or private logs",
	no_recursive_collection: "no recursive collection",
	no_unscoped_termination: "no unscoped process termination",
};

/** Any negation — used to keep a clause that negates something from reading as a LIFT. */
const NEGATION = /\b(?:do not|don't|dont|never|no|not|without|avoid)\b/i;
/**
 * A quoted span the instruction presents as DATA — a fixture, a probe string, the input a test asserts
 * is refused — rather than as something to run (#1019). Quotes alone are not that: "run `pkill node`"
 * quotes a command it asks for. Only a span whose own clause frames it as data, and asks for nothing
 * to be executed, is set aside; every unquoted command in the same instruction is still screened.
 */
const QUOTED = /"[^"\n]*"|(?<![\w])'[^'\n]*'(?![\w])|`[^`\n]*`/g;
const DATA_FRAME =
	/\b(?:fixtures?|literals?|test (?:data|inputs?|strings?|cases?|vectors?)|probes?(?: strings?)?|sample (?:inputs?|strings?|text)|as (?:data|a string|text|input)|asserts?|asserting|expects?|expecting|refuses?|rejects?|blocks?|flags?)\b/i;
const EXEC_VERB = /\b(?:run|runs|running|execute[sd]?|exec|invoke[sd]?|call|eval|type|enter|paste|send|use|try|do)\b|\$\(|\|\s*(?:sh|bash|zsh)\b/i;
const CLAUSE_EDGE = /\n|[.;!?](?=\s|$)|,\s+|\s+(?:then|and then)\s+|\s+—\s+/;

function inertData(text: string): string {
	return text.replace(QUOTED, (span, offset: number) => {
		const before = text.slice(0, offset).split(CLAUSE_EDGE).pop() ?? "";
		const after = text.slice(offset + span.length).split(CLAUSE_EDGE)[0] ?? "";
		const frame = `${before} ${after}`.replace(QUOTED, " ");
		return DATA_FRAME.test(frame) && !EXEC_VERB.test(frame) ? " (quoted data) " : span;
	});
}

/** The negations that make a clause of an INSTRUCTION a prohibition rather than a request. */
const PROHIBITION = /\b(?:do not|don't|dont|never|avoid|without|no need to)\b/i;

/**
 * Clauses: a sentence, a line, a comma-separated part, or the half of "X and do not Y" that negates.
 * A full stop splits only when followed by whitespace, so `x.ts` and `./...` stay whole.
 */
function clauses(text: string): string[] {
	return text
		.split(/\n+|[.;!?](?=\s|$)|,\s+|\s+—\s+|\s+-\s+|\s+(?:and|but)\s+(?=(?:do not|don't|never|no)\b)/i)
		.map((c) => c.replace(/^(?:and|but|then|so)\s+/i, "").trim())
		.filter(Boolean);
}

/** A restriction: the clause SETS the constraint. Each is phrased so that it already carries its negation. */
const RESTRICT: Array<{ kind: ScopeKind; re: RegExp }> = [
	// Read-only is about the RUN, not a path: "vendor/ is read-only" or "do not edit the generated
	// files" scopes a rule to something, and must not freeze the whole run. Each form below either
	// names the run as the subject or stands alone at the end of its clause.
	{
		kind: "read_only",
		re: /\b(?:this|it|everything|the run|this run|the task|this task|this session|you)\s+(?:is|are|stays?|remains?|must be|should be|will be)\s+read[- ]only\b|\b(?:be|stay|remain|keep (?:it|this)|work|operate|strictly|go)\s+read[- ]only\b|^read[- ]only\b(?!\s+(?:mirror|copy|directory|dir|folder|files?|fs|filesystem|mount|view|access|replica|clone|volume|token|key|user|database|db)\b)|\bread[- ]only\s+(?:mode|run|session|task|investigation|audit|review)\b|\bno (?:mutations?|changes|edits|file changes|writes)\s*$|\b(?:do not|don't|never)\s+(?:modify|edit|change|mutate|touch|write to|alter)(?:\s+(?:anything|any(?:\s+\w+)?\s+files?|files|(?:the\s+)?(?:repo(?:sitory)?|code(?:base)?|checkout|working tree|tree|source)))?\s*$/i,
	},
	{ kind: "no_push", re: /\b(?:do not|don't|never|no)\s+(?:git\s+)?push(?:es|ing)?(?:\s+(?:anything|yet|it|this|the changes|until\b.*))?\s*$/i },
	{ kind: "focused_tests", re: /\bfocused tests?\b|\b(?:do not|don't|never|no)\b[^,]{0,20}\b(?:full|whole|entire|complete)\s+(?:test\s+)?suite\b|\bonly (?:run )?(?:the )?(?:focused|targeted|specific|relevant|affected) tests?\b/i },
	{ kind: "finish_after_push", re: /\b(?:stop|finish|end|done)\s+(?:right\s+)?after\s+(?:the\s+)?push\b|\b(?:do not|don't|never|no)\s+(?:wait(?:ing)?\s+for|poll(?:ing)?|watch(?:ing)?|monitor(?:ing)?)\s+(?:the\s+)?(?:ci|checks|deploy(?:ment)?s?|actions|workflows?)\b/i },
	{ kind: "no_process_inspection", re: /\b(?:do not|don't|never|no)\b[^,]{0,40}\b(?:process(?:es)?\s+(?:arguments|args|command[- ]?lines?|list)|environment(?:\s+variables)?|env\s+vars?|private\s+logs?|ps\s+aux)\b/i },
	{ kind: "no_recursive_collection", re: /\b(?:do not|don't|never|no)\b[^,]{0,30}\brecursive(?:ly)?\b/i },
];

/** An explicit lift: the clause ENDS a constraint. Read only from a clause with no negation in it. */
const LIFT: Array<{ kind: ScopeKind; re: RegExp }> = [
	{ kind: "read_only", re: /\b(?:you\s+(?:may|can)\s+(?:now\s+)?(?:edit|modify|change|make changes|implement|fix)|read[- ]only\s+(?:is\s+)?(?:lifted|over)|go ahead and (?:edit|implement|fix|make the change))\b/i },
	{ kind: "no_push", re: /\b(?:you\s+(?:may|can)\s+(?:now\s+)?push|go ahead and push)\b/i },
	{ kind: "focused_tests", re: /\b(?:(?:you\s+(?:may|can)\s+(?:now\s+)?)?run\s+the\s+(?:full|whole|entire)\s+(?:test\s+)?suite|full\s+suite\s+is\s+(?:fine|ok|okay))\b/i },
	{ kind: "worker_limit", re: /\bno\s+(?:worker|thread)\s+limit\b|\bany number of workers\b/i },
	{ kind: "finish_after_push", re: /\b(?:you\s+(?:may|can)\s+(?:now\s+)?)?(?:wait for|watch)\s+(?:the\s+)?(?:ci|deploy)\b/i },
	// A grant names WHAT may be terminated (#1019). "You may stop after the push" is permission to FINISH,
	// and it used to lift this prohibition because "stop" matched with nothing after it.
	{
		kind: "no_unscoped_termination",
		re: /\b(?:you\s+(?:may|can)|ok(?:ay)?\s+to|allowed\s+to|go ahead and)\s+(?:(?:kill|terminate|stop)\s+(?:[\w-]+\s+){0,3}(?:process(?:es)?|pids?)\b|(?:use\s+)?(?:pkill|killall)\b)/i,
	},
];

const WORKER_LIMIT = /\b(?:at most|max(?:imum)?(?: of)?|no more than|limit(?: it| tests?)? to|only)\s+(\d{1,3})\s+(?:test\s+)?(?:workers?|threads?|jobs?|forks?|processes)\b/i;

/**
 * The constraints in force after reading every source in order. Standing rules go first (they are the
 * oldest), then the run's directives oldest to newest, so the owner's latest word on a kind wins.
 */
export function activeConstraints(sources: readonly ConstraintSource[]): ScopeConstraint[] {
	const state = new Map<ScopeKind, ScopeConstraint>();
	state.set("no_unscoped_termination", { kind: "no_unscoped_termination", source: "platform rule" });
	for (const src of sources) {
		for (const clause of clauses(src.text)) {
			const limit = WORKER_LIMIT.exec(clause);
			if (limit) state.set("worker_limit", { kind: "worker_limit", source: src.label, limit: Number(limit[1]) });
			const restricted = new Set<ScopeKind>();
			for (const r of RESTRICT) {
				if (r.re.test(clause)) {
					state.set(r.kind, { kind: r.kind, source: src.label });
					restricted.add(r.kind);
				}
			}
			if (NEGATION.test(clause)) continue;
			for (const l of LIFT) if (!restricted.has(l.kind) && l.re.test(clause)) state.delete(l.kind);
		}
	}
	return [...state.values()];
}

/** The goal's owner words as ordered sources. The objective is deliberately not one of them. */
export function constraintSources(goal: { standingInstructions?: string; ownerDirectives?: ReadonlyArray<{ text: string; at: number }> }): ConstraintSource[] {
	const out: ConstraintSource[] = [];
	if (goal.standingInstructions) out.push({ text: goal.standingInstructions, label: "your standing rules" });
	for (const [i, d] of (goal.ownerDirectives ?? []).entries()) out.push({ text: d.text, label: `owner directive ${i + 1} (${new Date(d.at).toISOString().slice(11, 16)} UTC)` });
	return out;
}

// ── The screen ──────────────────────────────────────────────────────────────

/**
 * The instruction with every NEGATED clause removed. "Read x.ts and report — do not edit anything" must
 * not be refused under read-only for containing "edit"; the clause that says not to is not a request.
 */
function affirmative(text: string): string {
	// Negation is read from the PROSE of a clause: `--no-coverage` or a quoted `git diff --no-index`
	// is not the instruction saying "no".
	const prose = (c: string) => c.replace(/`[^`]*`/g, " ").replace(/(^|\s)-{1,2}[\w.-]+/g, " ");
	return clauses(text)
		.filter((c) => !PROHIBITION.test(prose(c)))
		.join("\n");
}

const MUTATING_COMMAND =
	/\bgit\s+(?:commit|push|merge|rebase|reset|checkout\s+-b|switch\s+-c|stash|apply|am|cherry-pick|revert|tag|restore)\b|\b(?:sed|perl)\s+-i\b|(?:^|[`;&|(]\s*)(?:rm|mv|cp|mkdir|touch|chmod|tee)\s|\s>>?\s*(?!\/dev\/null|&)[\w./~-]+|\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|rm|publish|version|update|up)\b|\bgh\s+(?:pr\s+(?:create|merge|close|edit|comment)|issue\s+(?:create|close|edit|comment)|release\s+create)\b|\bapply_patch\b|\bpatch\s+-p/im;
/** A change asked for in prose — the verb in IMPERATIVE position, so "report the last commit" is not one. */
const MUTATING_PROSE =
	/(?:^|\b(?:and|then|&)\s+)(?:please\s+)?(?:edit|modify|rewrite|refactor|implement|fix|patch|delete|remove|rename|commit|push|merge)\b|(?:^|\b(?:and|then)\s+)(?:write|create|add)\s+(?:a\s+|an\s+|the\s+|new\s+)?(?:file|test|tests|function|method|module|commit|branch|migration|component|endpoint|route|class)\b|(?:^|\b(?:and|then)\s+)(?:make|apply)\s+(?:the\s+|these\s+|those\s+)?changes?\b/im;
const PUSH = /\bgit\s+push\b|(?:^|\b(?:and|then)\s+)push\b/im;
const CI_WAIT =
	/\bgh\s+(?:run\s+(?:watch|view|list)|pr\s+checks)\b|\b(?:wait|poll|watch|monitor)\b[^.\n]{0,40}\b(?:ci|checks?|workflows?|deploy(?:ment)?s?|pipelines?|actions)\b/i;
const PROCESS_INSPECTION =
	/\bps\s+(?:-[a-zA-Z]*[efwx][a-zA-Z]*|aux|ax|auxww)\b|\bps\b[^\n|;]*-o\s*\S*(?:args|cmd|command)|\/proc\/[^\s/]+\/(?:cmdline|environ)\b|\bprintenv\b|(?:^|[`;&|(]\s*)env\s*(?:$|[|;`&)])|\bpgrep\s+-[a-zA-Z]*[al]\b|\bjournalctl\b|\/var\/log\b|~\/\.claude\b|\b(?:collect|dump|list|capture|show)\s+(?:all\s+)?(?:the\s+)?(?:process(?:es)?\s+(?:arguments|args|command[- ]?lines?)|environment\s+variables|private\s+logs?)\b/im;
const RECURSIVE_COLLECTION =
	/\bgrep\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b|(?:^|[`;&|(]\s*)rg\s|\bfind\s+(?:[./~$]|\/)|\bls\s+-[a-zA-Z]*R|(?:^|[`;&|(]\s*)tree(?:\s+[-./~]|\s*$|`)|\bdu\s+-[a-zA-Z]*a|\brecursive(?:ly)?\s+(?:list|search|grep|collect|scan|walk|read|copy)|\brecursive\s+(?:search|grep|listing|scan|collection|walk)\b/im;
const UNSCOPED_KILL =
	/\b(?:killall|pkill)\b|\bkill\s+(?:-\S+\s+)*(?:-1|0)\b|\bkill\b[^\n;]*\$\(|\|\s*xargs\s+(?:-\S+\s+)*kill\b|\bfuser\s+-[a-zA-Z]*k|\b(?:kill|terminate|stop)\s+(?:all|every|the other|other)\s+(?:\w+\s+)?process(?:es)?\b/i;

/** Test runner invocations, with the argument text that follows each. */
const TEST_RUNNER =
	/\b(?:(?:pnpm|npm|yarn|bun)\s+(?:(?:--filter[=\s]\S+|-F\s+\S+|-C\s+\S+|--dir[=\s]\S+)\s+)*(?:run\s+)?test(?::[\w-]+)?|npx\s+vitest(?:\s+run)?|vitest(?:\s+run)?|npx\s+jest|jest|pytest|go\s+test|cargo\s+test|(?:npx\s+)?playwright\s+test|node\s+--test)(?![\w:-])([^\n`;&|]*)/gi;
/** Where an unquoted command in prose ends and the sentence resumes: "run pnpm test and report". */
const PROSE_WORD = /^(?:and|then|to|for|with|so|but|or|again|now|first|after|before|until|once|which|that|report|show|tell|see|check|fix|on|in|it|the|a|an|pass|passes|passed|passing|fails?|failed|failing|green|is|are|was|were)$/i;

export interface TestInvocation {
	command: string;
	/** `full` runs everything; `focused` names a file, a pattern or a package; `unknown` cannot be read. */
	scope: "full" | "focused" | "unknown";
	/** Workers asked for by a flag — a REQUEST in the command string, not the selection that ran. */
	requestedWorkers: number | null;
	/** Options written after a bare `--` that a package-manager script may forward verbatim or drop. */
	forwardedAfterDashDash: boolean;
	/** Where the invocation starts in the text it was read from — orders it against other work in one command. */
	at: number;
}

/** Options that take a NUMBER and select nothing: `--maxWorkers 4` is a worker cap, never a test called "4". */
const NUMERIC_OPTION = /^(?:--max-?workers|--maxWorkers|--min-?workers|--minWorkers|--workers|-j|--jobs|-n|--numprocesses|--parallel|--bail|--retry|--test-?[tT]imeout|--hook-?[tT]imeout|--timeout|--seed)$/;
/** Options that take a word and select nothing (`--reporter dot`, `-c vitest.config.ts`). */
const WORD_OPTION = /^(?:--reporter|--pool|--config|-c|--environment|--outputFile|--output-file|--root|-r|--dir|--color|--log-?level|--loglevel|-p|--(?:poolOptions|coverage)\.[\w.]+)$/;
/** Options whose value SELECTS tests: a name pattern, a project, a shard. */
const SELECTOR_OPTION = /^(?:-t|--testNamePattern|--test-name-pattern|-k|--grep|-g|-run|--filter|--project|--shard|--testPathPattern|--test-path-pattern|--selectProjects)$/;

/** Shell-ish words: a quoted run stays one token, so `-t "export flow"` is one option and its value. */
function shellTokens(text: string): string[] {
	return [...text.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((m) => m[0]);
}

/** Every test invocation in a piece of shell or instruction text. */
export function testInvocations(text: string): TestInvocation[] {
	const out: TestInvocation[] = [];
	for (const m of text.matchAll(TEST_RUNNER)) {
		const head = m[0].slice(0, m[0].length - (m[1]?.length ?? 0)).trim();
		const all = shellTokens((m[1] ?? "").trim());
		const stop = all.findIndex((t) => !/^["']/.test(t) && PROSE_WORD.test(t.replace(/[,.:)]+$/, "")));
		const tokens = (stop < 0 ? all : all.slice(0, stop)).map((t) => (/^["']/.test(t) ? t : t.replace(/[,.)]+$/, "")));
		const args = tokens.join(" ");
		const full = /:full\b/.test(head) || /\.\/\.\.\./.test(args);
		const pkgFilter = /--filter|-F\s|-C\s|--dir/.test(head);
		// Walk the arguments as the runner would read them (#1019): an option's VALUE is consumed with it,
		// so it is never mistaken for a positional selector; the bare `--` a package script forwards
		// past is a delimiter, not an argument. Only a positional or a selecting option narrows the run.
		let selected = false;
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i];
			if (t === "--" || t === "run") continue;
			if (t.startsWith("-")) {
				const [name, inline] = t.split(/=(.*)/s, 2);
				if (SELECTOR_OPTION.test(name)) {
					selected = true;
					if (inline === undefined) i++;
				} else if (inline === undefined && NUMERIC_OPTION.test(name)) {
					if (/^\d+%?$/.test(tokens[i + 1] ?? "")) i++;
				} else if (inline === undefined && WORD_OPTION.test(name)) {
					if (tokens[i + 1] !== undefined && !tokens[i + 1].startsWith("-")) i++;
				}
				continue;
			}
			// A bare number is an option's stray value, never a test file.
			if (!/^\d+%?$/.test(t)) selected = true;
		}
		const scope: TestInvocation["scope"] = full ? "full" : selected || pkgFilter ? "focused" : "full";
		out.push({ command: `${head}${args ? ` ${args}` : ""}`, scope, requestedWorkers: requestedWorkers(args), forwardedAfterDashDash: /(?:pnpm|npm|yarn)\b/.test(head) && tokens.includes("--"), at: m.index ?? 0 });
	}
	return out;
}

function requestedWorkers(args: string): number | null {
	if (/--runInBand\b|(?:^|\s)-i(?:\s|$)|--no-file-parallelism\b|--pool[= ]forks\s+--poolOptions\.forks\.singleFork\b/.test(args)) return 1;
	const m = /--max-?workers[=\s](\d+)|--poolOptions\.\w+\.max(?:Threads|Forks)[=\s](\d+)|--workers[=\s](\d+)|(?:^|\s)-j\s*(\d+)|(?:^|\s)-n\s+(\d+)/i.exec(args);
	if (!m) return null;
	return Number(m.slice(1).find((g) => g !== undefined));
}

/** Words that say the instruction asks for a whole-suite run without naming a command. */
const FULL_SUITE_PROSE = /\b(?:full|whole|entire|complete)\s+(?:test\s+)?suite\b|\ball (?:the )?tests\b(?!\s+(?:in|of|under|for|from|that|which))|\btest:full\b/i;

/**
 * Why one generated instruction breaks an active constraint, or null when it does not. The first
 * broken constraint is named; the reason says what the instruction would do, not what the owner wrote.
 */
export function screenScopedInstruction(constraints: readonly ScopeConstraint[], text: string): { constraint: ScopeConstraint; reason: string } | null {
	const said = affirmative(inertData(text));
	for (const c of constraints) {
		const reason = breaks(c, said);
		if (reason) return { constraint: c, reason };
	}
	return null;
}

function breaks(c: ScopeConstraint, said: string): string | null {
	switch (c.kind) {
		case "read_only":
			if (MUTATING_COMMAND.test(said)) return "it runs a command that changes the repository or the machine";
			if (MUTATING_PROSE.test(said)) return "it asks the engine to change, commit or push";
			return null;
		case "no_push":
			return PUSH.test(said) ? "it asks for a push" : null;
		case "finish_after_push":
			return CI_WAIT.test(said) ? "it waits for or polls CI/deploy after the push" : null;
		case "focused_tests": {
			if (testInvocations(said).some((t) => t.scope === "full")) return "it runs the full test suite rather than a focused subset";
			return FULL_SUITE_PROSE.test(said) ? "it asks for the whole test suite" : null;
		}
		case "worker_limit": {
			const over = testInvocations(said).find((t) => t.requestedWorkers === null || t.requestedWorkers > (c.limit ?? 1));
			if (!over) return null;
			return over.requestedWorkers === null
				? `it runs tests without a worker limit (at most ${c.limit} allowed — pass e.g. --maxWorkers=${c.limit})`
				: `it asks for ${over.requestedWorkers} test workers (at most ${c.limit} allowed)`;
		}
		case "no_process_inspection":
			return PROCESS_INSPECTION.test(said) ? "it collects process arguments, environment or private logs" : null;
		case "no_recursive_collection":
			return RECURSIVE_COLLECTION.test(said) ? "it collects recursively" : null;
		case "no_unscoped_termination":
			return UNSCOPED_KILL.test(said) ? "it terminates processes selected by name or pattern, not a process this run started" : null;
	}
}

/** The refusal line for the step log and the owner's chat: the constraint and its source, never its text. */
export function scopeRefusalNote(r: { constraint: ScopeConstraint; reason: string }): string {
	const what = r.constraint.kind === "worker_limit" ? `${SCOPE_LABEL.worker_limit} (${r.constraint.limit})` : SCOPE_LABEL[r.constraint.kind];
	return `${what} — set by ${r.constraint.source}; ${r.reason}. Send an instruction inside it, or ask the owner (ask_owner) if the objective cannot be met within it.`;
}

/** The prompt's list of what binds, so a constraint survives however many directives came after it. */
export function constraintsBlock(constraints: readonly ScopeConstraint[]): string {
	const owner = constraints.filter((c) => c.source !== "platform rule");
	if (!owner.length) return "";
	const lines = owner.map((c) => `- ${c.kind === "worker_limit" ? `${SCOPE_LABEL.worker_limit}: at most ${c.limit}` : SCOPE_LABEL[c.kind]} (${c.source})`);
	return `\nCONSTRAINTS IN FORCE — derived from every owner rule and directive of this run, however old. The platform REFUSES any instruction that breaks one before it reaches the engine:\n${lines.join("\n")}`;
}
