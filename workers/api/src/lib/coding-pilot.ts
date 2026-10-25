/**
 * The coding Pilot: the Claude-backed brain that reads the pane and decides the next instruction (#1359).
 *
 * Moved verbatim out of `coding-loop.ts`, which keeps the loop that drives it. The loop's own types
 * (`CodingGoal`, `CodingDecision`, …) stay there and are imported here as TYPES only, so there is no runtime cycle.
 * `coding-loop.ts` re-exports everything below, so every existing importer is unchanged.
 */
import { askOwnerDecision } from "./coding-ask.js";
import { systemPromptSections, systemPromptText, type StreamDeadlines, type SystemPromptBlock } from "./user-ai.js";
import { DEFAULT_PILOT_MODEL } from "./pilot-model.js";
import { runPilotInference } from "./pilot-routing.js";
import { hitOutputCap } from "./reply-truncation.js";
import { authorityInstruction } from "./coding-authority.js";
import { renderPaneForPilot, PILOT_PANE_CHARS } from "./coding-repetition.js";
import { clockLine } from "./coding-wait.js";
import type { UsageContext } from "./usage.js";
import type { Env } from "../types.js";
import { ownerDirectivesBlock } from "./coding-owner-directives.js";
import { activeConstraints, constraintSources, constraintsBlock } from "./coding-scope-constraints.js";
import type { CapSummary, CodingDecision, CodingGoal, CodingPaneSnapshot } from "./coding-loop-types.js";

// ── The Claude-backed decision (the actual "brain") ─────────────────────────

/**
 * Output ceiling for one Pilot decision (#504).
 *
 * This call inherited `runAnthropic`'s 1024-token fallback — the number #397's own docstring says
 * is "picked for nothing in particular" and lists every other caller as having replaced. The Pilot
 * is a caller that legitimately writes long: a `send_message` argument routinely carries a shell
 * script or a multi-file plan, and a tool call cut off at the cap is the empty instruction this
 * issue is about.
 *
 * 2048 tokens ≈ 8,000 characters of instruction, which fits a script comfortably, and
 * `generationBudgetMs(2048)` is 88s — inside both `AI_TOTAL_TIMEOUT_MS` (180s) and the decide
 * step's 3-minute Workflow timeout, which 4096 (156s) would leave almost no margin under. The
 * ceiling is the one that is affordable to WAIT for, not the largest one the model would accept.
 */
const PILOT_MAX_TOKENS = 2048;

/** Ceiling on one `learned` entry: ten steps of them still cost less than one terminal window. */
export const LEARNED_MAX = 300;

/**
 * How a `learned` entry is marked in the step log AND on its `brain` timeline row. Exported because
 * the row outlives the run: the resume note (#806) finds a stopped run's notes by this prefix, and
 * a second spelling of it there would silently find nothing the day this one changed.
 */
export const LEARNED_PREFIX = "[learned] ";

/** Exported for the contract test below: every advertised tool must have a `toDecision` case. */
export const CODING_TOOLS = [
	{
		name: "send_message",
		description: "Send a natural-language instruction to the coding CLI — a whole task where you can; it keeps its own memory of the session and you do not.",
		parameters: {
			type: "object",
			properties: {
				text: { type: "string" },
				learned: {
					type: "string",
					description: `Optional, at most ${LEARNED_MAX} characters: what the terminal just told you that you will still need at a later decision (what an issue asks for, which file holds what, what already landed). It is added to your step log, which is the ONLY thing you keep between decisions.`,
				},
			},
			required: ["text"],
		},
	},
	// NO press_keys. `HeadlessSession.key()` is an unconditional no-op — correct, because a
	// headless engine has no TTY to receive keystrokes — but the tool was still advertised, mapped
	// to `{kind:"keys"}`, routed into `key()` and answered with a normal snapshot, indistinguishable
	// from success. So a menu ("1) Sign in with…") produced: brain calls press_keys("Enter") →
	// nothing sent → unchanged pane → `waitIdle` is skipped for non-message actions → the next
	// decision sees the identical pane and repeats. The run burned all 40 decisions of BYOK Claude
	// and ended `max_steps` having done nothing. A menu is now a `request_human`, which is true.
	// #448 finished the job at the HTTP boundary: `POST …/message {keys}` answers 409 instead of
	// 200-with-a-snapshot, and `{kind:"keys"}` is gone from `CodingActionKind` entirely.
	{
		name: "finish",
		description: "The objective is complete (status 'done') or cannot be completed (status 'failed').",
		parameters: { type: "object", properties: { status: { type: "string", enum: ["done", "failed"] }, detail: { type: "string" } }, required: ["status", "detail"] },
	},
	{
		name: "request_human",
		description: "You are stuck and a human must take over the live session (e.g. an interactive auth prompt you can't answer).",
		parameters: { type: "object", properties: { why: { type: "string" } }, required: ["why"] },
	},
	{
		name: "request_user_info",
		description: "Ask the user for a specific value you do not have and must not invent (ask-and-hold).",
		parameters: { type: "object", properties: { field: { type: "string" }, why: { type: "string" } }, required: ["field"] },
	},
	// THE DECISION VERB (#960). Before it, a choice that was the owner's to make had only two exits:
	// decide it anyway (the CLI's "the user chose…" problem, #505), or `request_human`, which parks
	// as a hands-on takeover nobody can answer from a phone. This one parks as `decision` and the
	// owner answers it from a conversation — the console card, or answer_instance_input.
	{
		name: "ask_owner",
		description:
			"Ask the OWNER to choose, when the next step depends on a decision that is theirs to make and nothing in the objective, the rules or the repo settles it. Give one short question and 2–6 short options; the run pauses until they answer from chat or the console, and their answer comes back to you. When the owner must make SEVERAL separate decisions, give `parts` instead of `options` — one { question, options } per decision — and they answer each with a tap.",
		parameters: {
			type: "object",
			properties: {
				question: { type: "string", description: "One short question, answerable by picking an option. With `parts`, the one line that introduces them." },
				options: { type: "array", items: { type: "string" }, description: "2–6 short, distinct answers." },
				parts: {
					type: "array",
					description: "2–4 separate decisions, each answered on its own. Use instead of `options` when one question holds several choices.",
					items: {
						type: "object",
						properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
						required: ["question", "options"],
					},
				},
				why: { type: "string", description: "What depends on it — one line." },
			},
			required: ["question"],
		},
	},
	// THE VERB THAT DID NOT EXIST (#541). Without it, "the CLI is rate-limited until 22:30" had only
	// `request_human` to come out as — which binds the run to a 15-minute human deadline and killed
	// three real runs 41 minutes before the resource they were waiting for came back.
	{
		name: "wait_for_reset",
		description:
			"The coding CLI has hit ITS OWN usage/rate limit and cannot work until its window resets. Use this instead of request_human: no human can resolve a usage window, and the platform will sleep and resume you at the same step.",
		parameters: {
			type: "object",
			properties: {
				resetsAt: {
					type: "string",
					description:
						"When the CLI says its limit resets, as an absolute ISO-8601 instant WITH an explicit offset or Z (e.g. 2026-08-12T22:30:00+10:00). Convert the time the terminal states using the current time you were given. Omit this if the terminal states no reset time — never guess one.",
				},
				why: { type: "string", description: "Quote what the CLI actually said." },
			},
			required: ["why"],
		},
	},
] as const;

/**
 * The ONLY tool offered on the one cap decision (#1261) — never mixed into {@link CODING_TOOLS},
 * so a normal round can never reach for it and the cap round can never send another instruction.
 */
export const CAP_SUMMARY_TOOL = {
	name: "report_cap_status",
	description:
		"You have reached your step cap without finishing the objective. Report it honestly instead of sending another instruction: exactly what you did, your exact blocker, your concrete plan, and how many more steps you want and why.",
	parameters: {
		type: "object",
		properties: {
			did: {
				type: "string",
				description: "Concrete actions you took in the capped steps: files changed, commands run, commits you made — cite SHAs when you have them.",
			},
			blocker: { type: "string", description: "The exact error or blocker you are stuck on. Quote it in full — never summarize or shorten it." },
			plan: {
				type: "string",
				description:
					"A specific, concrete plan for what you would do in the next steps. If you genuinely have no concrete plan, say so plainly (e.g. 'No concrete plan: I am stuck repeating X') instead of inventing one.",
			},
			steps: { type: "number", description: "How many more steps you are asking for — the number YOU think you need, not a round default." },
			reason: { type: "string", description: "Why that many: say why you think you can finish in that many, and whether you might still need more." },
		},
		required: ["did", "blocker", "plan", "steps", "reason"],
	},
} as const;

/** The cap tool call → {@link CapSummary}. `null` when the brain did not call it (falls back to the generic ending). */
export function toCapSummary(call: { name: string; arguments: Record<string, unknown> } | undefined): CapSummary | null {
	if (!call || call.name !== CAP_SUMMARY_TOOL.name) return null;
	const a = call.arguments ?? {};
	const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
	const n = Number(a.steps);
	return { did: str(a.did), blocker: str(a.blocker), plan: str(a.plan), steps: Number.isFinite(n) && n > 0 ? Math.round(n) : 0, reason: str(a.reason) };
}

/**
 * Exported for its test. The two rules below are the Pilot-side half of #505 and they are prose, so
 * the only thing that can hold them is an assertion that they are still in the prompt.
 */
export function systemPrompt(goal: CodingGoal): string {
	return systemPromptText(systemPromptBlocks(goal));
}

/**
 * The Pilot's system prompt as cache blocks (#914, #1317).
 * Shared platform rules precede all run-specific content, so a new objective can reuse their cache.
 * Owner rules, engine, repo, objective and merge authority follow in a separate run block; the
 * latest directives and constraints remain last. Both stable prefixes use 1 hour because engine
 * turns routinely outlast the default 5-minute cache; the changing round tail stays uncached.
 */
export function systemPromptBlocks(goal: CodingGoal): SystemPromptBlock[] {
	const lines: string[] = [];
	lines.push(
		"You orchestrate a local AI coding CLI. Its run context follows these platform rules.",
		// #1319. A gate that refuses a stale checkout runs BEFORE any brief is read, so this cannot be the only defence (the platform
		// fast-forwards a behind checkout itself); it is the instruction for the case the platform could not settle, and for a run
		// that continues an old checkout.
		"FIRST STEP, before any change: have the CLI run `git pull --ff-only` on the repo's configured branch (main). If git refuses, stop and report exactly what it said (call request_human) — never merge, rebase, stash or reset your way past it.",
		"",
		"You see the terminal pane. Decide the SINGLE next step and call exactly one tool.",
		"- Drive the CLI with natural-language instructions via send_message; it does the editing/running.",
		"- You CANNOT send keystrokes: the CLI runs headless with no terminal attached. If it is waiting on a menu or a y/n prompt, phrase the answer as an instruction via send_message when the objective or rules settle it; when the choice is the OWNER's to make, call ask_owner with the options.",
		"- When the objective is satisfied, call finish(status:'done'). If it's impossible, finish(status:'failed').",
		"- If a value is required that only the user has, call request_user_info — NEVER invent secrets, tokens, or personal data.",
		"- If you hit something a human must handle live (interactive login, captcha), call request_human.",
		// #960. The three asks, told apart by WHAT the owner has to do — a value, a choice, or hands.
		"- If the next step needs a CHOICE that is the owner's (which of two approaches, whether to proceed with something irreversible or out of scope, which of several candidates) and the objective, rules and repo do not settle it, call ask_owner with one short question and 2–6 options — do NOT decide it yourself and do NOT use request_human, which needs someone at the machine. Never use ask_owner for something you can decide from the objective, for a value (request_user_info), or for hands-on work (request_human).",
		// #541. Stated as the DIFFERENCE between the two, because the three runs this comes from
		// escalated correctly under the old vocabulary — `request_human` was the only honest move
		// they had. The rule that matters is which of the two a usage window is, and why.
		"- If the CLI reports ITS OWN usage or rate limit (a subscription window that resets), call wait_for_reset — NOT request_human. A human cannot resolve a usage window by taking over the session; the platform will sleep until it resets and resume you at the same step. Convert the reset time the terminal states into an absolute instant WITH an offset, using the current time given to you below; if the terminal states no reset time, omit it rather than guessing.",
		"",
		// WHO IS WHO (#505). The runner writes your instruction to the CLI as `role: "user"`, so the
		// CLI's transcript calls YOU "the user" — and a Pilot that reads that back reported to the
		// owner that HE had been warned and had chosen, about a version bump he was never asked
		// about and which broke his deploy. The platform stamps a report that does this
		// (lib/run-attribution.ts); this is the rule that should mean it never has to.
		"WHO IS WHO: your instructions reach the CLI as a user turn, so when the terminal says \"the user\" — asked, was warned, chose, approved — it means YOU, not the human. The human is not watching this run and has not been asked anything.",
		"- NEVER report a decision as the human's. If you decided it, say that you decided it, and say why.",
		"- If the CLI objects to an instruction on grounds of correctness or safety, you may NOT simply repeat it. Either follow its recommendation, or call request_human quoting the objection — the human is the only one who can overrule the CLI on a judgement like that.",
		// A STALE BASE IS NOT A BASE (#785). Run 97903fb3 pushed to `main`; the checkout the next
		// run planned in had never fetched it. The platform now says so in the rules above this
		// prompt (UPSTREAM SYNC) — this is the standing rule for what to do about it, and for the
		// push at the end, which the Engine does and the platform cannot see until it has happened.
		"- STALE BASE: if the run context says the checkout is BEHIND its upstream and the tree is clean, your FIRST instruction is to fast-forward it (`git pull --ff-only`) — never plan a change against a base that is missing commits. If it is dirty or has diverged, do not merge or rebase on your own initiative: report it and call request_human.",
		"- BEFORE ANY PUSH: have the CLI `git fetch` and rebase (or merge) onto the upstream first, then push. If that brought in commits, name them in your finish detail — what landed upstream while you worked is a fact the owner must read, never a silent merge.",
		// WHAT YOU CAN SEE (#522, cause B). The Pilot was never told the size of its own window, so an
		// answer whose start had scrolled past read as an answer that never came — and the only move
		// that reading suggests is to ask again, which pushes it further out. This states the
		// measurement; renderPaneForPilot states the per-decision number on the pane itself.
		`- You see only the LAST ~${PILOT_PANE_CHARS} characters of the terminal, never all of it, and re-sending an instruction hoping earlier output will come back does not work — it will not come back.`,
		// WHO REMEMBERS WHAT (#822). Runs 45660130 and 0d14e23e spent 11 of 20 steps asking for an
		// issue or a file they had already been shown, because nothing of an engine reply survives to
		// the next decision. The engine is the opposite: it implemented a whole feature in the one
		// step that merely let it. So the rule is the asymmetry, and the two moves it implies.
		"- MEMORY: the CLI remembers everything it has read and done this session. YOU DO NOT — between decisions you keep only the step log below, not what the CLI answered. So hand the CLI WHOLE TASKS (\"read issue #N, implement it, run the full suite, push, comment on the issue, then report what landed\") rather than one read at a time, and never ask it to show you an issue or a file merely so that you can plan: it plans better from what it already holds.",
		"- When the terminal tells you something you will need later, put it in send_message's `learned` — that is the only thing that carries it to your next decision. Never ask again for something the step log shows you already asked for; the CLI still has it.",
		// WHAT A TOOL RESULT COSTS (#700). The bullet above used to end "ask for a bounded slice (a
		// line range, a grep, head/tail) rather than a full dump", and on the runner of the day that
		// advice could not work: EVERY tool_result was cut to 240 characters with all whitespace
		// collapsed before the pane existed, so `cat`, `sed -n '1,50p'`, `head -60` and `grep`
		// arrived at identical size and identical shape. One live run spent twelve of its sixteen
		// decisions searching that empty space, and the twelfth concluded — reasonably, on the
		// evidence in front of it — that "the CLI is summarizing file contents". It was not.
		//
		// `transcript-lines.ts` now keeps line structure and gives a content tool 1,500 characters,
		// so a slice that FITS does arrive whole — but only from a machine running
		// RESULT_LINES_MIN_CLI or later, and the cloud cannot tell which machine this is. So the
		// prompt states the mechanism rather than one number: a cut result SAYS it was cut, and says
		// by how much, and that is the signal to act on. The untruncated reply channel is named
		// either way, because it is the one that works on every runner ever published.
		"- A tool's OUTPUT is CUT before it reaches you, and a cut result says so at the end: `…`, or `…[cut: 1,500 of 18,432 chars]` when the machine is recent enough to state the figures. Roughly 1,500 characters of a file read or a command's output survive, keeping their line structure; on an older machine it is 240 characters with every newline and indent collapsed to spaces, and there NO shell command can show you a file at all.",
		"- So: if a result was cut, ask for a slice that FITS (`sed -n '1,40p'`) — but only ONCE. If the next result is cut at the same size and shape, this machine is capping every result identically and re-asking in a different command is the same request with the same bound.",
		"- The engine's own REPLY text is NEVER truncated, on any machine. To learn what is in a file, ask the engine to answer you with it — \"quote lines 1-40 of src/x.ts verbatim in your reply\" — or ask it a question about the file and use its answer.",
		"",
		"Never output step-by-step thinking; just call one tool.",
	);
	const run = ["\n\nRUN CONTEXT:"];
	const rules = [goal.standingInstructions, goal.specialInstructions].filter(Boolean).join("\n\n");
	if (rules) run.push(`USER RULES (highest priority):\n${rules}\n`);
	run.push(`Engine: "${goal.clientType}". Repository: "${goal.repo}".`, `OBJECTIVE: ${goal.objective}`);
	// Owner-set merge authority still follows and overrides conflicting objective/rules (#314).
	const authority = authorityInstruction(goal.mergePolicy ?? "merge");
	if (authority) run.push(`\n${authority}`);
	if (goal.dryRun) run.push("\nTEST MODE: avoid destructive or irreversible instructions; prefer read-only/plan steps.");
	const round: string[] = [];
	// Attributed to the PLATFORM, never folded into `userHint` — see CodingGoal.resumeNote.
	if (goal.resumeNote) round.push(`\n${goal.resumeNote}`);
	if (goal.userHint) round.push(`\nThe user just told you: ${goal.userHint}`);
	// Every round, not one (#1015): the owner's latest words outrank the objective for the whole run.
	if (goal.ownerDirectives?.length) round.push(ownerDirectivesBlock(goal.ownerDirectives));
	const binding = constraintsBlock(goal.scopeConstraints ?? activeConstraints(constraintSources(goal)));
	if (binding) round.push(binding);
	return [
		{ text: lines.join("\n"), cache: true, ttl: "1h", label: "platform" },
		{ text: run.join("\n"), cache: true, ttl: "1h", label: "run" },
		{ text: round.map((r) => `\n${r}`).join(""), label: "round" },
	];
}

export async function decideCodingAction(
	env: Env,
	userId: string,
	params: { goal: CodingGoal; actionLog: string[]; snapshot: CodingPaneSnapshot; atCap?: boolean },
	usageCtx?: UsageContext,
	/** This attempt's stream deadlines from the controller recovery policy (#907). */
	streamDeadlines?: StreamDeadlines,
): Promise<CodingDecision> {
	// #1261: the cap decision is a different question (report, don't act) with its own single tool —
	// routed here, not folded into the branches below, so the normal action prompt stays untouched.
	if (params.atCap) return decideCapSummary(env, userId, params, usageCtx, streamDeadlines);
	const system = systemPromptBlocks(params.goal);
	const steps = params.actionLog.length ? params.actionLog.map((a, i) => `${i + 1}. ${a}`).join("\n") : "(none yet)";
	const terminal = renderPaneForPilot(params.snapshot.pane, undefined, params.snapshot.paneChars);
	const userMsg = pilotUserBlocks({ actionLog: params.actionLog, clock: clockLine(Date.now(), params.goal.timeZone), runState: params.snapshot.runState, terminal });

	const res = await runPilotInference(env, userId, params.goal.pilotModel ?? DEFAULT_PILOT_MODEL, {
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: userMsg },
		],
		tools: CODING_TOOLS,
		maxTokens: PILOT_MAX_TOKENS,
		...(streamDeadlines ? { streamDeadlines } : {}),
	}, usageCtx
		? {
				...usageCtx,
				promptSource: "coding",
				promptPhase: "pilot_decide",
				promptSections: [
					...systemPromptSections("pilot.system", system),
					// `pilot.steps` below is the steps part of `pilot.user`; listed apart, as it always was.
					{ label: "pilot.objective", value: params.goal.objective },
					{ label: "pilot.steps", value: steps },
					{ label: "pilot.terminal", value: terminal },
					{ label: "pilot.tools", value: CODING_TOOLS },
				],
			}
			: undefined);

	const truncated = hitOutputCap(res.stopReason);
	const call = res.tool_calls?.[0];
	if (!call) {
		// The two endings that used to read identically. "No action chosen" is a brain that replied
		// in prose; a cap stop is a brain whose tool call did not fit, which is a different problem
		// with a different remedy, and the owner is told which one happened.
		const unreadable = res.malformed_tool_calls?.[0];
		const why = truncated
			? "The decision was cut off at the model's output limit before it named an action."
			: unreadable
				? `The decision named ${unreadable.name}, but its arguments were not valid JSON (${unreadable.error}), so it was not acted on.`
				: res.response || "no action chosen";
		return { thought: res.response, stuck: { why }, usage: res.usage, truncated, pilotRouting: res.pilotRouting };
	}
	return { ...toDecision(call), usage: res.usage, thought: res.response, truncated, pilotRouting: res.pilotRouting };
}

/**
 * The one cap decision (#1261): same context as a normal round, one tool, and the brain is told
 * NOT to act. `toCapSummary` returning `null` (no call, or a different one) is read by the loop as
 * "the brain did not answer" and falls back to the old generic ending — never a crash.
 */
async function decideCapSummary(
	env: Env,
	userId: string,
	params: { goal: CodingGoal; actionLog: string[]; snapshot: CodingPaneSnapshot },
	usageCtx?: UsageContext,
	streamDeadlines?: StreamDeadlines,
): Promise<CodingDecision> {
	const system = systemPromptBlocks(params.goal);
	const steps = params.actionLog.length ? params.actionLog.map((a, i) => `${i + 1}. ${a}`).join("\n") : "(none yet)";
	const terminal = renderPaneForPilot(params.snapshot.pane, undefined, params.snapshot.paneChars);
	const userBlocks = pilotUserBlocks({ actionLog: params.actionLog, clock: clockLine(Date.now(), params.goal.timeZone), runState: params.snapshot.runState, terminal });
	// Appended to the LAST block rather than a new one, so the cache breakpoint `pilotUserBlocks`
	// already placed on the newest step is not pushed one block further out for this one-off call.
	const ask =
		"\n\nYou have reached your step cap without finishing. Call report_cap_status — do not send another instruction to the CLI. Report exactly what you did, your exact blocker quoted in full, a concrete plan (or say plainly you have none), and how many more steps you want and why.";
	userBlocks[userBlocks.length - 1] = { ...userBlocks[userBlocks.length - 1], text: `${userBlocks[userBlocks.length - 1].text}${ask}` };

	const res = await runPilotInference(
		env,
		userId,
		DEFAULT_PILOT_MODEL,
		{
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: userBlocks },
			],
			tools: [CAP_SUMMARY_TOOL],
			maxTokens: PILOT_MAX_TOKENS,
			...(streamDeadlines ? { streamDeadlines } : {}),
		},
		usageCtx
			? {
					...usageCtx,
					promptSource: "coding",
					promptPhase: "pilot_cap_summary",
					promptSections: [
						...systemPromptSections("pilot.system", system),
						{ label: "pilot.steps", value: steps },
						{ label: "pilot.terminal", value: terminal },
						{ label: "pilot.tools", value: [CAP_SUMMARY_TOOL] },
					],
				}
				: undefined,
	);

	const capSummary = toCapSummary(res.tool_calls?.[0]);
	const pilotRouting = res.pilotRouting;
	return capSummary ? { capSummary, usage: res.usage, thought: res.response, pilotRouting } : { thought: res.response, usage: res.usage, pilotRouting };
}

/**
 * The Pilot's per-decision message, as prompt blocks (#914).
 *
 * "Steps so far" is append-only within a round, so it comes FIRST, one block per step, with a 1-hour
 * breakpoint after the newest: the next decision's prefix extends this one by a step, and the provider
 * finds the previous entry at the earlier block boundary — so only the newest step is written, and the
 * rest is read at a tenth of the price. Before this the message opened with the clock, which changes
 * every call, so the whole list was paid in full on every decision (~2.4k uncached tokens a call).
 *
 * The clock, the terminal tail and the instruction change every call and follow the breakpoint. 1 hour
 * for the reason the system prefix is (#914): decisions are minutes apart, past a 5-minute entry. The
 * clock is still per decision rather than per run (#541): a run that parks for an hour must convert the
 * CLI's stated local reset time against the time it is NOW.
 */
export function pilotUserBlocks(input: { actionLog: readonly string[]; clock: string; runState: string; terminal: string }): SystemPromptBlock[] {
	const tail = [
		input.clock,
		`\nTERMINAL (run-state: ${input.runState}):`,
		// Not a bare `slice(-6000)`: the tail is labelled with what it is a tail OF (#522, cause B).
		input.terminal,
		"\nDecide the next move toward the objective. Call exactly one tool.",
	].join("\n");
	if (!input.actionLog.length) return [{ text: `Steps so far:\n(none yet)\n${tail}`, label: "turn" }];
	const steps = input.actionLog.map((a, i): SystemPromptBlock => ({ text: `${i === 0 ? "Steps so far:\n" : "\n"}${i + 1}. ${a}`, label: "step" }));
	steps[steps.length - 1] = { ...steps[steps.length - 1], cache: true, ttl: "1h" };
	return [...steps, { text: `\n${tail}`, label: "turn" }];
}

export function toDecision(call: { name: string; arguments: Record<string, unknown> }): CodingDecision {
	const a = call.arguments ?? {};
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	switch (call.name) {
		case "send_message":
			// `author` is set HERE, at the one place the Pilot's instruction is born, because it is
			// the only place the platform can honestly answer "who wrote this" (#505, criterion 3).
			// The Engine receives every turn as `role: "user"` and cannot tell the Pilot from the
			// human — which is how a run came to tell the owner he had "explicitly chosen" a change
			// he was never asked about. The other doors into `/coding/act` (the console's manual
			// `/message`, MCP, the Overseer) declare nothing, and the runner renders that as
			// nothing rather than as a claim; see `packages/browser-runner/src/coding/turn-author.ts`.
			return { action: { kind: "message", text: str(a.text), author: "pilot" }, learned: str(a.learned).trim().slice(0, LEARNED_MAX) || undefined };
		case "press_keys":
			// No longer offered; if an older/cached tool list produces one, say so honestly rather
			// than routing it into a no-op that reads as success.
			return { stuck: { why: "Tried to press a key, but this session has no terminal attached — a human needs to answer the prompt." } };
		case "finish":
			return { finish: { status: str(a.status) === "failed" ? "failed" : "done", detail: str(a.detail) } };
		case "request_human":
			return { stuck: { why: str(a.why) || "needs a human" } };
		case "request_user_info":
			return { needsInput: { field: str(a.field) || "a value", why: str(a.why) } };
		case "ask_owner":
			return askOwnerDecision(a);
		case "wait_for_reset":
			// `at` is passed through UNVALIDATED. Judging it here would put the timezone rule in two
			// places, and the planner is the one that knows the run's remaining budget.
			return { waitUntil: { at: str(a.resetsAt) || undefined, why: str(a.why) || "the coding CLI reported its own usage limit" } };
		default:
			return { stuck: { why: `unknown tool ${call.name}` } };
	}
}
