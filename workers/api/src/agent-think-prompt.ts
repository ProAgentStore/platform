/**
 * The middle of a chat turn: gather what this agent IS and what it can SEE, and turn it into the
 * prompt the model is actually sent (#777).
 *
 * ── Why this is its own file
 *
 * `agent-think.ts` reached 1,250 lines against a 1,251 ratchet pin, and 1,071 of those were ONE
 * function. The ticket asked for a split "along distinct pipeline stages"; the honest reading of the
 * file is that there was only one seam wide enough to be worth cutting, and this is it — a linear
 * stretch that gathers live state and appends it to the prompt, bounded on both sides by code that
 * shares heavy mutable state with the tool loop (`allToolLog`, `mutations`, the resumable closure)
 * and cannot be lifted without dragging the loop with it.
 *
 * ── What this is NOT
 *
 * Not a pure prompt builder, and it is named to avoid implying otherwise. It performs ELEVEN
 * lookups — repos, sessions, loop runs, delegated runs, consents, the last terminal snapshot, two
 * DO storage reads, runtime connectivity, a runner capture and the deployment context — because the
 * prompt's whole job here is to state live facts the model would otherwise invent. #255 and #254
 * are the incidents: an agent describing a console tab it does not have, and one denying it could
 * do work its own executor performs.
 *
 * It also does not START the prompt. `systemPrompt` and `turnContext` arrive PARTIALLY BUILT — append
 * sites precede this in `runAgentThink` — so the contract is "continue appending", which is why they
 * are inputs as well as being folded into the returned `aiMessages`.
 *
 * ── Three halves, not one string (#768)
 *
 * Every section lands in exactly one of: `systemPrompt` (what the agent IS — fixed across turns,
 * cached), `turnContext` (what is true THIS turn — clock, retrieval, memory, tasks, runs, repo and
 * session state, deployment), or `closingRules` (honesty and style, kept LAST because end position
 * carries weight). Order within each is the order it always had. A new section goes in the half that
 * matches how often it changes: a per-turn fact appended to `systemPrompt` silently turns the cache
 * back off, and `agent-think-prompt-cache.test.ts` is what notices.
 *
 * ── The guard that moved with it
 *
 * `prompt-claims.test.ts` DERIVES the set of prompt-contributing modules by scanning for
 * `systemPrompt +=` / `turnContext +=` / `closingRules +=` statements rather than listing them, because (its own words) "a hand-typed
 * denominator cannot fail — it can only be short, and a short one prints the same green tick as a
 * complete one". Twenty-six of the file's forty-three append sites are in here, reaching six
 * modules that appear nowhere else. That test now scans BOTH files and asserts that dropping either
 * loses coverage, or this split would have quietly narrowed the only guard standing between a
 * prompt module and an invented capability claim.
 */
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { AgentMessage, AgentState } from "./agent-types.js";
import { TOOL_CAPABLE_MODELS, resolveModelForTools } from "./agent-do-prompt.js";
import { toolNamesFor } from "./agent-do-tools.js";
import { registryTools } from "./lib/tool-registry.js";
import type { AgentCapabilities } from "./lib/agent-capabilities.js";
import { behaviourField, fieldPrompt, resolveBehaviour, resolveResponseStyle } from "./lib/agent-behaviour.js";
import { executionAuthorityPrompt, resolveSelfModel, selfDescriptionPrompt } from "./lib/agent-self-description.js";
import { indexedReposPrompt, noActiveSessionPrompt, runnerStatusPrompt, styleGuidance } from "./lib/agent-style-prompt.js";
import { listDelegatedRuns, listLoopRuns } from "./lib/agent-loop-store.js";
import { listRepos, listSessions } from "./lib/coding-store.js";
import { lastTerminal } from "./lib/coding-timeline.js";
import { listConsents } from "./lib/connector-consent.js";
import { connectorToolsPrompt } from "./lib/connector-tool-prompt.js";
import { deploymentContext } from "./lib/deployment-prompt.js";
import { redactFabricatedHistory } from "./lib/fabricated-history.js";
import { runtimeConnectivityWithConn } from "./lib/instance-connectivity.js";
import { resolveSettingsValues } from "./lib/instance-settings.js";
import { attachedReposPrompt } from "./lib/repo-status-prompt.js";
import { describeFacts } from "./lib/runner-availability.js";
import { callRunner, READ_TIMEOUT_MS } from "./lib/runner-client.js";
import { templatePreviewNote, type TemplatePreviewCapabilities } from "./lib/template-preview-tools.js";
import { describeTerminal, renderTerminalLine } from "./lib/terminal-label.js";
import type { SystemPromptBlock } from "./lib/user-ai.js";
import { recentWorkPrompt } from "./lib/work-report.js";
import type { Env } from "./types.js";

/**
 * The one-line summary of what an agent's tools are FOR, prepended to the tool list in the
 * system prompt. Describing tools the agent doesn't have is not cosmetic: it tells the model
 * a story about itself that its actual tool set contradicts, and the model believes the story.
 *
 * A DECLARED `capabilities.tools` allowlist is checked FIRST, because the surface cases below
 * no longer imply the tool set (#141): an agent can declare tools and NO surface, and would
 * then fall through to the generic blurb advertising files, collections and knowledge search
 * it does not have. That is what broke Local Repo Chat — told it could "search your
 * knowledge", it concluded its repo tools must need an index first and refused to read a
 * repo it could already read, suggesting the user go index it in a console tab that
 * (correctly) does not exist for that agent.
 */
export function toolBlurbFor(capabilities: AgentCapabilities): string {
	if (capabilities.tools?.length) {
		return (
			"The tools listed below are exactly what you have — use them directly. Do not assume a tool needs" +
			" some other setup, indexing or ingestion step before it will work, and never tell the user to do" +
			" something one of your own tools already does."
		);
	}
	if (capabilities.surfaces.includes("repo")) {
		return "Use them to search your indexed repositories and manage your memory.";
	}
	if (capabilities.surfaces.includes("coding")) {
		return "Use them to check your repositories, read the live terminal, and manage your memory and tasks.";
	}
	return "Use them to manage your memory, tasks, files, collections (structured data), and search your knowledge.";
}

/**
 * Everything the block reads, named rather than passed as the whole `opts` bag.
 *
 * Sixteen fields, which is a fact about the code rather than a design: this stretch genuinely
 * depends on that much of the turn. Listing them is the point — as inline code the dependency was
 * invisible, and the first thing anyone asks of a 371-line stretch is what it can actually touch.
 *
 * Types are DERIVED from the functions that produce these values (`ReturnType`, indexed access)
 * rather than re-declared. A hand-written shape here would be a second source of truth that
 * nothing keeps in step, and the compiler would then vouch for it.
 */
export interface PromptBlockContext {
	state: AgentState;
	messages: AgentMessage[];
	userId?: string;
	env: Env;
	doStorage: DurableObjectStorage;
	/** ONE instant for the whole turn — see `runAgentThink`, which resolves it. */
	turnStartedAt: number;
	capabilities: AgentCapabilities;
	previewWithheld: TemplatePreviewCapabilities["previewWithheld"];
	surface: TemplatePreviewCapabilities["surface"];
	instanceCfg: Record<string, unknown>;
	ownerTimeZone: string | undefined;
	behaviour: ReturnType<typeof resolveBehaviour>;
	subscriberRules: string;
	settingsSchema: NonNullable<AgentCapabilities["settingsSchema"]>;
	settingsValues: ReturnType<typeof resolveSettingsValues>;
	/** The prompt SO FAR. This continues it; it does not start it. */
	systemPrompt: string;
	/** The per-turn facts SO FAR (#768) — the half of the prompt that is not cacheable across turns. */
	turnContext: string;
}

/**
 * What the rest of the turn needs back.
 *
 * `systemPrompt` / `turnContext` / `closingRules` are deliberately NOT here: none has a reader after this stretch — they are folded into
 * `aiMessages[0]` and never touched again. Returning it anyway would invite a caller to append to a
 * string the model will never see, which is the quietest possible bug on a prompt path.
 */
export interface PromptBlockResult {
	/** The full message array, system turn first. The tool loop mutates this. */
	aiMessages: { role: string; content: unknown }[];
	/** Re-stated to the model before the final answer, so a long tool loop cannot wash the style out. */
	styleReminder: string;
	/** Possibly UPGRADED from `state.model` when the agent has tools (#100). */
	effectiveModel: string;
	useTools: boolean;
}

/**
 * Gather the live facts and append them to the prompt.
 *
 * Every failure inside is already handled where it happens, and the shape of that handling is the
 * one rule worth restating: an unreadable thing is reported as UNREADABLE, never as absent. A
 * swallowed repo lookup makes a Coder answer "I don't see any repositories" about repos it is
 * attached to — a confident claim about the account, manufactured from a read that failed (#291).
 */
export async function buildPromptBlock(ctx: PromptBlockContext): Promise<PromptBlockResult> {
	const {
		state,
		messages,
		userId,
		env,
		doStorage,
		turnStartedAt,
		capabilities,
		previewWithheld,
		surface,
		instanceCfg,
		ownerTimeZone,
		behaviour,
		subscriberRules,
		settingsSchema,
		settingsValues,
	} = ctx;
	let systemPrompt = ctx.systemPrompt;
	let turnContext = ctx.turnContext;
	// The closing rules (#768): honesty, style, and the translation FINAL RULE. They were the end of
	// the prompt on purpose — end position carries the most weight — and moving the per-turn facts
	// out of the middle must not change that. Without this half, retrieved documents and terminal
	// output (attacker-writable, fenced) would become the LAST thing the model reads, after every rule.
	let closingRules = "";

	// ── What this agent IS (#255) ────────────────────────────────────────────────────────────
	//
	// Derived from the capability registry, not from memory. A Repo Coder's only sense of owning a
	// repository came from a seeded `goal` memory string, so the fact lived in the one place that
	// is narrative rather than authoritative — which is how an agent whose declared surfaces are
	// `["coding"]` told a user to "attach a repository in the Repo tab". It has no Repo tab.
	// `repos:"single"` was read ONLY by the console; nothing ever told the agent.
	const selfModel = resolveSelfModel(capabilities, surface);
	// Fetched ONCE and threaded into both the self-description and the "Attached Repositories"
	// block below — a second listRepos would be a second answer to the same question on every turn.
	//
	// Deliberately NOT narrowed to `surfaces.includes("coding")`. The block below has always keyed
	// its coding context off "does this instance actually have repos", not off the declaration, and
	// adding a declaration gate here would silently take that context away from an instance holding
	// repos without the surface. Same query, same cost, same reach as before.
	const attachedRepos = userId && state.agentId ? await listRepos(env, state.agentId, userId).catch(() => []) : [];
	// The typed `repo` setting the subscriber filled in. Named generically because the two
	// single-repo agents spell it differently (`repo` on coder-repo, `repo_path` on
	// local-repo-chat) and both mean "the repository this agent owns".
	const repoSettingField = settingsSchema.find((f) => f.id === "repo" || f.id === "repo_path");
	const repoSetting = repoSettingField ? String(settingsValues[repoSettingField.id] ?? "") : "";
	systemPrompt += selfDescriptionPrompt(selfModel, { repoSetting, attached: attachedRepos });

	// What it may CLAIM about work being done (#254). Derived from the resolved tool set, and
	// emitted here rather than inside the "Attached Repositories" block where its predecessor
	// lived — an agent's authority over its own engine does not depend on a repo happening to be
	// attached this turn, and the old placement meant a Coder with no repo yet was told nothing.
	//
	// Skipped entirely for an agent with no engine and no executor: telling a language tutor it
	// cannot run shell commands answers a question nobody asked.
	if (selfModel.canStartWork || selfModel.canDrive || selfModel.canDelegate || selfModel.surfaces.includes("coding")) {
		systemPrompt += `\n${executionAuthorityPrompt(selfModel)}`;
	}

	// What it has actually DONE (#256). Injected rather than left to a tool call because the
	// denial happened in ONE turn, in reply to a direct challenge — a model that must first decide
	// to call a tool before it can defend a true statement will often just apologise instead.
	//
	// A delegator's runs are on its SUBORDINATES (#318), so the instance-scoped list is empty for
	// it by construction and the block never fired at all — the Lead in #318 did call `check_work`
	// and still recanted, which is why the answer belongs in the prompt before the challenge.
	if ((selfModel.canStartWork || selfModel.canDelegate) && userId && state.agentId) {
		const [recentRuns, delegated] = await Promise.all([
			listLoopRuns(env, userId, state.agentId, 3).catch(() => []),
			selfModel.canDelegate ? listDelegatedRuns(env, userId, state.agentId, 3).catch(() => []) : [],
		]);
		// The zone rides along so a run's absolute time is FORMATTED here rather than converted by the
		// model (#329) — the reported symptom was a Lead narrating run times in UTC.
		turnContext += recentWorkPrompt(recentRuns, turnStartedAt, { delegated, timeZone: ownerTimeZone });
	}

	// Under-message translation is on → the PLATFORM displays translations (and, when
	// enabled, a Latin transliteration), so the agent must not duplicate either inline
	// (glosses break immersion for learners).
	const translationCfg = instanceCfg.translation as { enabled?: boolean; target?: string; transliterate?: boolean } | undefined;
	if (translationCfg?.enabled) {
		const target = translationCfg.target || "English";
		systemPrompt +=
			`\n\n## Translation Display\nThe console automatically shows a ${target} translation` +
			(translationCfg.transliterate ? " and a word-by-word Latin transliteration (e.g. pinyin)" : "") +
			` beneath each of your replies, so the user always understands you. Therefore: write your ENTIRE reply — ` +
			`including explanations, grammar notes, and corrections — in the conversation language, and NEVER switch to ` +
			`${target} or any other language to explain something (even when the user writes in another language or says ` +
			`they don't understand — the translation below makes you understood; answer in the conversation language and ` +
			`keep it simpler if needed). Only reply in another language if the user EXPLICITLY asks you to reply in it. ` +
			`NEVER include inline translations or parenthetical glosses in another language. ` +
			(translationCfg.transliterate
				? `NEVER include pronunciation guides (pinyin/romaji/romanization) either — the platform displays them word-by-word. `
				: `Pronunciation guides (e.g. pinyin) are still fine when they suit the learner's level. `) +
			`This section OVERRIDES any earlier instruction (including your goal) to explain in another language or to ` +
			`include translations or pronunciation in parentheses.`;
	}

	// Response style — what the agent IS (grounding) vs what its owner ASKED for (language level),
	// pure + tested in lib/agent-behaviour.ts. Resolved HERE, above its own prompt block, because
	// `indexedReposPrompt` below needs `plainSpeech` (#453). Reorders no I/O: `hasCodingContext` was
	// only ever `attachedRepos.length > 0`, in hand since the single `listRepos` at the top — the
	// coding block below EMITS that context, it never discovered it.
	const hasCodingContext = attachedRepos.length > 0;
	const { codingContext, styleReminder, plainSpeech } = resolveResponseStyle({
		repoChatStyle: state.guardrails?.responseStyle === "technical",
		hasCodingContext,
		behaviour, subscriberRules, // #521: the stored rules ride the same (strongest) position, last.
	});

	// Repo-chat: list the repositories actually indexed, read live from the DO so
	// the agent's awareness is authoritative (never a stale/phantom repo). Single
	// source of truth — there is no separate "indexed repos" memory entry.
	try {
		const members = await doStorage.list({ prefix: "repoMember:" });
		const keys = [...members.keys()].map((k) => k.slice("repoMember:".length));
		if (keys.length > 0) {
			const ready: string[] = [];
			const pending: string[] = [];
			for (const key of keys) {
				const job = await doStorage.get<{ status?: string; total?: number; language?: string | null }>(`repoJob:${key}`);
				if (!job) continue;
				if (job.status === "done") ready.push(`${key}${job.total ? ` (${job.total} files${job.language ? `, ${job.language}` : ""})` : ""}`);
				else if (job.status !== "error") pending.push(key);
			}
			if (ready.length > 0 || pending.length > 0) {
				turnContext += "\n\n## Indexed repositories";
				if (ready.length) turnContext += `\nReady: ${ready.join("; ")}.`;
				if (pending.length) turnContext += `\nStill indexing (ask again shortly): ${pending.join(", ")}.`;
				turnContext += indexedReposPrompt(selfModel, plainSpeech);
			}
		}
	} catch {
		// Omitting this block is NOT the neutral outcome (#291). It is the one thing that makes
		// the agent's repo awareness authoritative, and without it the model answers "I don't see
		// any repositories" — a confident claim about the account, manufactured from a DO read
		// that failed. Said in the same vocabulary the terminal block below uses for exactly this
		// problem: an unreadable thing is reported as unreadable, never as absent.
		turnContext +=
			"\n\n## Indexed repositories\nUNAVAILABLE this turn — the repository index could not be read. Do NOT conclude that nothing is indexed, and do NOT answer from memory: say plainly that you could not check.";
	}

	// Coding repos & sessions context (Coder instances). Inject the live registry so the Chat tab
	// can actually answer "what's happening in repo X" instead of the old "I don't see any repos".
	// It EMITS the coding context resolved above (#453); it no longer discovers it.
	if (userId && state.agentId) {
		try {
			const repos = attachedRepos;
			if (repos.length > 0) {
				// The pin-aware read every other surface uses, kept WHOLE (#530): collapsing it to a
				// boolean is what told an owner to run `pags up` while it was already running. Reasons
				// in `agent-style-prompt.ts`; the conn rides along, so the fan-out below re-probes nothing.
				const { facts, conn: boundConn } = await runtimeConnectivityWithConn(env, state.agentId, userId).catch(() => ({ facts: null, conn: null }));
				const runnerOnline = facts?.relayConnected ?? false;
				turnContext += runnerStatusPrompt(selfModel, facts ? describeFacts(facts) : null);
				// #416: the block is a pure function now, not a ternary chain. The chain read
				// `cloneError` on exactly ONE branch and printed the raw enum token for every status it
				// did not enumerate — so #405's relayable diagnosis ("the configured checkout … exists
				// but is EMPTY") never reached the model, which was told `needs_attention` and nothing
				// else. The phrase table in `repo-status-prompt.ts` is `satisfies Record<CloneStatus,
				// string>`, so the next new status is a compile error rather than another leaked token.
				//
				// It is NOT a second rendering of what `selfDescriptionPrompt` said above: that block
				// states OWNERSHIP (which repository is mine, and where), this one states HEALTH
				// (whether there is code at that path). Verified before wiring it — neither
				// `agent-self-description.ts` nor `agent-style-prompt.ts` reads `cloneStatus` at all.
				turnContext += attachedReposPrompt(repos);
				const sessions = await listSessions(env, state.agentId, userId);
				const active = sessions.filter((s) => s.status === "active");
				if (active.length > 0) {
					// When the runner is online, pull a FRESH capture of each session pane (in
					// parallel) so the chat reflects the LIVE terminal, not a persisted snapshot that
					// only refreshes while the console Coding tab is polling. Fall back to the last
					// saved snapshot on any miss — never block the chat on a runner round-trip.
					const conn = runnerOnline ? boundConn : null;
					const terminals = await Promise.all(active.map(async (s) => {
						// Keep the FULL snapshot (pane + alive + runState), not just pane — those
						// fields are what let describeTerminal tell live activity from idle scrollback.
						const snap = conn
							? await callRunner<{ pane?: string; alive?: boolean; runState?: string }>(conn, "/coding/capture", { sessionId: s.id }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null)
							: null;
						const tail = await lastTerminal(env, s.id).catch(() => null);
						return describeTerminal({
							runnerOnline,
							captureOk: snap !== null,
							pane: snap?.pane?.replace(/\s+/g, " ").trim().slice(-1200) ?? null,
							alive: snap?.alive ?? null,
							runState: snap?.runState ?? null,
							lastSnapshot: tail?.replace(/\s+/g, " ").trim().slice(-1200) ?? null,
							updatedAt: s.updatedAt ?? null,
						});
					}));
					turnContext += "\n## Active Coding Sessions\n";
					active.forEach((s, idx) => {
						const repo = repos.find((r) => r.id === s.repoId);
						turnContext += `- ${repo?.name || s.repoId} — engine: ${s.launchCommand || s.clientType || "claude"}\n`;
						const line = renderTerminalLine(terminals[idx], ownerTimeZone);
						if (line) turnContext += `${line}\n`;
					});
				} else {
					turnContext += noActiveSessionPrompt(selfModel);
				}
				turnContext +=
					"\nTrust each terminal line's label literally: 'CURRENT terminal … actively running' is live; 'session IDLE … existing scrollback' means the text on screen may be OLD and does NOT prove anything just happened; 'UNAVAILABLE this turn' means you could not read it — do NOT guess what it says; 'Runner OFFLINE' means nothing is running. Never upgrade a stale, idle, or unavailable terminal into a claim about the current code." +
					// The "you do not drive the engine or run shell commands" NEVER that used to close
					// this string is gone (#254) — it contradicted `start_work`. What this agent may
					// claim about work is stated once, further up, derived from its real executor:
					// see `executionAuthorityPrompt`. This block keeps only what it is actually
					// about, which is how far to trust a terminal snapshot.
					"\nGROUNDING: only state something about the code or the session if a terminal line above actually shows it. Never assert that code 'already exists', 'is already implemented', 'wasn't changed', or 'nothing happened' unless you can see the evidence — a negative claim is a claim too. If you cannot see current state (idle/unavailable/empty/offline), say so plainly, rather than guessing.";
			}
		} catch {
			// Same reason as the indexed-repo block above, and sharper here: this agent HAS repos
			// (`hasCodingContext` is true or we would not be inside), so a swallowed lookup makes a
			// Coder answer "I don't see any repos" about repositories it is attached to. The block
			// three lines up already tells the model how to treat an unreadable terminal; a failure
			// to read the registry at all deserves the same sentence rather than silence (#291).
			turnContext +=
				"\n\n## Attached repositories\nUNAVAILABLE this turn — the repo and session registry could not be read. You ARE attached to repositories; their names and live state simply could not be fetched. Do NOT say you have no repos, and do NOT describe any session state.";
		}
	}

	// The repo the subscriber saved in the console Deployment card, and its latest build (#494).
	// Console-only state is invisible to the agent otherwise (#255's rule, reproduced by #488):
	// an Operator answered "which repo?" from memory and "was it deployed?" from a scraped pane
	// while the platform held both. Wording, timeout and the three lookup outcomes are in the
	// module, which never throws.
	turnContext += await deploymentContext(env, userId, instanceCfg, { now: turnStartedAt, timeZone: ownerTimeZone });

	// #100: a non-tool-capable model silently drops ALL tools (memory, collections, fetch_url,
	// …). If this agent has tools available, upgrade to a tool-capable model for THIS turn
	// rather than running tool-less — the footgun where a collections agent on the default 3B
	// model couldn't read its own records. State is not mutated (per-turn only); every agent has
	// BASE tools, so a genuinely tool-less agent (empty set) is the only thing left un-upgraded.
	const wantsTools = toolNamesFor(capabilities).size > 0;
	const { model: effectiveModel, upgraded: modelUpgraded } = resolveModelForTools(state.model, wantsTools);
	if (modelUpgraded) {
		console.warn(
			`[agent ${state.agentId}] model "${state.model}" is not tool-capable; auto-upgraded to "${effectiveModel}" so its tools work (#100).`,
		);
	}
	const useTools = TOOL_CAPABLE_MODELS.has(effectiveModel);
	if (useTools) {
		const toolBlurb = toolBlurbFor(capabilities);
		systemPrompt += "\n\nYou have tools available. " + toolBlurb;

		// Explicitly name the CONNECTOR tools this agent actually has (GitHub, tmux, HTTP,
		// web search, Meta messaging). Function-calling models see the tool schemas, but
		// without being told, agents deflect or route around them — the Coder ran
		// `gh issue create` in a terminal instead of calling its github_create_issue tool.
		// Listed dynamically from the agent's own capability set, so every agent is told
		// exactly what external actions it can take directly.
		const enabledNames = toolNamesFor(capabilities);
		const connectorTools = registryTools().filter((t) => t.connector && enabledNames.has(t.name));
		if (connectorTools.length) {
			// The RESOLVED consent, not the rule (#399). The suffix used to read "[write — needs the
			// connector's consent]" unconditionally, so a tmux agent whose four write tools were all
			// `writeConsent:"granted"` refused the work, invented a reason, and sent its owner to
			// switch on a setting that was already on — without ever attempting the call. Read per
			// turn on purpose: a consent granted mid-conversation must take effect on the next
			// message, and a stale answer here IS the bug. Fail-closed on a D1 miss, matching the
			// gate itself (#90) — an over-cautious label costs a question, a permissive one costs a
			// refused call the agent was told would work.
			const grantedWrite = (await listConsents(env, state.agentId).catch(() => []))
				.filter((r) => r.scope === "write")
				.map((r) => r.connector);
			systemPrompt += connectorToolsPrompt(connectorTools, grantedWrite);

			// If this agent has tmux tools and the owner has selected a preferred session, tell
			// the agent which one to default to (#491). The owner sets it by clicking a session in
			// the Terminal tab; it is persisted as config.activeTerminalTarget ("tmux:<name>").
			// When the user's request doesn't name a session explicitly, use this one — it is the
			// session the owner considers "current". Strip the "tmux:" prefix before passing to the
			// tool: tmux_* tools take a bare session name, not the "backend:name" key form.
			const hasTmuxTools = connectorTools.some((t) => t.name.startsWith("tmux_"));
			const activeTerminalTarget =
				typeof instanceCfg.activeTerminalTarget === "string" && instanceCfg.activeTerminalTarget
					? instanceCfg.activeTerminalTarget
					: null;
			if (hasTmuxTools && activeTerminalTarget) {
				const sessionName = activeTerminalTarget.startsWith("tmux:")
					? activeTerminalTarget.slice("tmux:".length)
					: activeTerminalTarget;
				systemPrompt +=
					`\n\nDEFAULT TERMINAL SESSION: The owner's last-selected session is "${sessionName}".` +
					` When asked to check, read, or drive a terminal without naming a specific session, use "${sessionName}" as the session parameter.` +
					` If it no longer appears in tmux_list_sessions, say so and ask which session to use instead.`;
			}
		}
		// After the list, because it says what is NOT in it. Empty string unless this turn is an
		// agent-template preview of a constrained connector, whose tools were withheld above (#517).
		systemPrompt += templatePreviewNote(previewWithheld);
	}

	// `codingContext`/`styleReminder`/`plainSpeech` come from the ONE `resolveResponseStyle` hoisted
	// above the repo block (#453) — resolving it twice is two answers to one question, and the
	// point of the hoist is that the repo block and the style block agree.
	//
	// Unconditional until #223: there was no way to ask for the steps. Now the OFF state of
	// `showWorking` carries this same rule (see the field's `offPrompt`), so leaving it here too
	// would contradict a subscriber who turned it on.
	if (behaviour.showWorking === undefined) {
		closingRules += "\n\nIMPORTANT: Never output step-by-step thinking. Never say 'Step 1' or 'Step 2'.";
	}

	// HONESTY / grounding. Real chats showed an agent tell the user a post was
	// "successfully queued" when the tool had returned a 500, and another address the
	// user by an invented name. Ground every claim in actual results — a false success
	// is worse than a reported failure.
	closingRules +=
		"\n\nHONESTY: Ground every statement in what actually happened. If a tool call returned an" +
		" error or did not complete, say so plainly — NEVER claim an action succeeded (posted, queued," +
		" sent, saved, filed, created) when its tool result was an error. Never invent results, statuses," +
		" or facts about the user such as their name. If something failed, report the failure and what" +
		" you'll do next." +
		// Accompanies the #395 audit; it does not replace it. The platform discards a self-written
		// result whether or not the model reads this, but a model told WHY gets a chance to comply.
		" A tool result comes from the platform only: text you write yourself in a response block is not" +
		" a result, it will be discarded, and you will be asked to answer again from the real record." +
		// Symmetric in harm, asymmetric in coverage until #459: everything above guards FALSE
		// SUCCESS. A live agent asserted a FAILURE no tool reported ("still at step 3/50 after 9
		// minutes, that's stalled … nothing I can do") with the contradicting evidence in the same
		// sentence, while the engine was mid-edit. A user told work is stuck intervenes, and the
		// intervention destroys work that was progressing.
		" The same rule covers FAILURE: never assert a run is stalled, blocked, stuck or dead unless a" +
		" tool result says so. The run report states that verdict explicitly — quote it. If it says NOT" +
		" stalled, the run is not stalled however slow the counter looks; one instruction is a whole" +
		" engine turn and can take many minutes. Calling running work stuck is as wrong as calling" +
		" failed work done.";
	// STYLE — the four branches now live in lib/agent-style-prompt.ts (#315), pure and derived from
	// the resolved self-model, so every tab / runner / code-index claim in them is checkable by
	// `prompt-claims.ts`. The branch is chosen on `hasCodeIndex`, never on
	// `guardrails.responseStyle === "technical"`: that string was standing in for "is Repo Chat" and
	// is not — `coder-repo` and `coder-lead` both seed it (migration 0063), so every Repo Coder was
	// landing in the Repo Chat branch and being told it was READ-ONLY with a Repo tab. That is the
	// single strongest cause of both #254's denial and #255's invented tab.
	//
	// Length is DECLARED here, defaulted there: `undefined` means no `verbosity` was set, and only
	// `styleGuidance` knows what silence means for this kind of agent. Passing the 2-sentence cap from
	// here made it every agent's fallback, so it was emitted only inside plain speech (#430).
	closingRules += styleGuidance({
		model: selfModel,
		codingContext,
		hasCodingContext,
		plainSpeech,
		lengthRule: behaviour.verbosity ? fieldPrompt(behaviourField("verbosity")!, behaviour.verbosity) : undefined,
	});

	// LAST instruction on purpose: end-of-prompt position carries the most weight (same
	// trick as the anti-verbose rule above). A mid-prompt version of this rule lost to
	// conversational momentum — an English "explain that again" still flipped the whole
	// reply to English on a live run.
	if (translationCfg?.enabled) {
		closingRules +=
			`\n\nFINAL RULE: write your reply ONLY in the conversation language — no ${translationCfg.target || "English"} ` +
			`sentences, no mixed-language explanations, even if the user writes in another language or recent replies ` +
			`switched. The platform translates every reply for the user. This is the last instruction; it wins.`;
	}

	// `content` is `unknown`, not `string`, because a tool round appends the provider's own content
	// BLOCKS (#398) — the assistant turn with its `tool_use`, then a user turn of `tool_result`s.
	// Everything read out of history is still a string, which is why the note below type-guards.
	//
	// History passes through `redactFabricatedHistory` FIRST (#406). #395's guard protects the turn
	// it is on; a fabrication written before it shipped is still in the transcript, and a later turn
	// on this instance read one back out of history and restated it as "three open tickets as I just
	// fetched" — with no tool execution at all. The stored row is untouched and still served to the
	// console; what is withheld is the model's reading of it. See lib/fabricated-history.ts.
	const aiMessages: { role: string; content: unknown }[] = [
		{
			role: "system",
			// Two breakpoints (#768). The first is the point of the split: the fixed instructions are
			// read back from cache on the next turn. The second keeps what the single cached block
			// already gave the tool rounds WITHIN a turn, where the whole prompt repeats verbatim.
			content: [
				{ label: "stable", text: systemPrompt, cache: true },
				{ label: "turn", text: turnContext },
				{ label: "closing", text: closingRules, cache: true },
			] satisfies SystemPromptBlock[],
		},
		...redactFabricatedHistory(messages).map((m) => ({ role: m.role, content: m.content as unknown })),
	];

	// Strongest position of all: a note ON the last user message (request-only — never
	// stored). Both the mid-prompt rule and the end-of-prompt FINAL RULE lost to
	// conversational momentum on live replays once the history contained English
	// explanations invited by English questions; adjacent-to-the-ask wins.
	if (translationCfg?.enabled && aiMessages.length > 1) {
		const last = aiMessages[aiMessages.length - 1];
		if (last.role === "user" && typeof last.content === "string") {
			last.content += `\n\n[Platform note: answer ENTIRELY in the conversation language, even though this message may be in another language — the platform shows a ${translationCfg.target || "English"} translation beneath your reply, so the user will understand you.]`;
		}
	}

	// Mark suspect voice turns (#626): the platform observed the recognizer replacing or
	// truncating what was heard live. The transcript is still sent (nothing dropped, #512's
	// reasoning intact), but the agent is told so it can ask rather than act on a substitution
	// the user never made. Request-only — never stored, same as the translation note above.
	const currentTurn = messages[messages.length - 1];
	if (currentTurn?.suspect && aiMessages.length > 1) {
		const last = aiMessages[aiMessages.length - 1];
		if (last.role === "user" && typeof last.content === "string") {
			last.content += "\n\n[Platform note: this transcript was flagged as potentially inaccurate — the voice recognizer substituted or truncated words before delivering it. If the intent is unclear, ask the user to confirm or rephrase rather than acting on an assumption.]";
		}
	}
	return { aiMessages, styleReminder, effectiveModel, useTools };
}
