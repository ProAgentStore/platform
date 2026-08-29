import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { AgentStorageEngine } from "./agent-storage.js";
import type { AgentMessage, AgentState, AgentTask, MemoryEntry } from "./agent-types.js";
import { TOOL_CAPABLE_MODELS, resolveModelForTools } from "./agent-do-prompt.js";
import { buildAgentToolDefinitions, storageToolNameSet, toolNamesFor } from "./agent-do-tools.js";
import { registryToolNameSet, registryTools, runRegistryTool } from "./lib/tool-registry.js";
import { configureBoardForAgent } from "./lib/board.js";
import { agentCapabilities, type AgentCapabilities } from "./lib/agent-capabilities.js";
import { renderActiveTasks } from "./lib/agent-tasks.js";
import { renderDirections } from "./lib/agent-direction.js";
import { directionRosterFor } from "./lib/supervision.js";
import { readDisabledTools } from "./lib/instance-tool-policy.js";
import { connectorToolsPrompt } from "./lib/connector-tool-prompt.js";
import { deploymentContext } from "./lib/deployment-prompt.js";
import { memoryPrompt } from "./lib/memory-prompt.js";
import { listConsents } from "./lib/connector-consent.js";
import { readInstanceConfigPairForDurableObject } from "./lib/instance-config.js";
import { parseAccountPreferences } from "./lib/preferences.js";
import { clockPrompt } from "./lib/agent-clock.js";
import { stableStringify } from "./lib/stable-json.js";
import { buildResumableRound, type ResumableRound, withResumableRound } from "./lib/resumable-round.js";
import { ragContextOrNotice } from "./lib/retrieval.js";
import { transferFromToolResults, type ConversationTransfer } from "./lib/conversation-transfer.js";
import { loadImportedMcpTools } from "./lib/mcp-tool-catalog.js";
import { resolveSettingsValues, settingsPromptBlock } from "./lib/instance-settings.js";
import { resolveStatsCards, statsPromptBlock } from "./lib/stats-schema.js";
import { executeStorageTool } from "./lib/storage-tools.js";
import { executeTool, type ToolCallRequest, type ToolCallResult } from "./lib/tools.js";
import { normalizeToolCalls, parseToolCallsFromText } from "./lib/parse-tool-calls.js";
import { redactFabricatedHistory } from "./lib/fabricated-history.js";
import { honestReply, toolLogWithNotices, type ParsedReply } from "./lib/invented-results.js";
import { logEvent, logToolFailure } from "./lib/events.js";
import { runUserWorkersAi } from "./lib/user-ai.js";
import { CHAT_MAX_TOKENS, hitOutputCap, truncationNotice } from "./lib/reply-truncation.js";
import { templatePreviewNote, withholdConstrainedConnectorTools, type TemplatePreviewCapabilities } from "./lib/template-preview-tools.js";
import { capToolResult, toolLogLine } from "./lib/tool-result-cap.js";
import { corroborateToolPaths, createPathLedger } from "./lib/path-corroboration.js";
import { hasToolBlocks, toolResultTurn, toolUseIdsOf, type ToolOutcome } from "./lib/anthropic-tool-turns.js";
import { listRepos, listSessions } from "./lib/coding-store.js";
import { lastTerminal } from "./lib/coding-timeline.js";
import { attachedReposPrompt } from "./lib/repo-status-prompt.js";
import { describeTerminal, renderTerminalLine } from "./lib/terminal-label.js";
import { callRunner, READ_TIMEOUT_MS } from "./lib/runner-client.js";
import { runtimeConnectivityWithConn } from "./lib/instance-connectivity.js";
import { describeFacts } from "./lib/runner-availability.js";
import { chatSurfaceForDoKey, executionAuthorityPrompt, resolveSelfModel, selfDescriptionPrompt } from "./lib/agent-self-description.js";
import { indexedReposPrompt, noActiveSessionPrompt, runnerStatusPrompt, styleGuidance, voiceControlPrompt } from "./lib/agent-style-prompt.js";
import { listDelegatedRuns, listLoopRuns } from "./lib/agent-loop-store.js";
import { recentWorkPrompt } from "./lib/work-report.js";
import {
	behaviourField,
	behaviourPrompt,
	behaviourStrayPrompt,
	fieldPrompt,
	resolveBehaviour,
	resolveResponseStyle,
} from "./lib/agent-behaviour.js";
import type { Env } from "./types.js";

/**
 * Resolve an agent's capabilities from the registry so tools can be gated to what the
 * agent type can actually use. Inside the DO, `id` is the INSTANCE id for instances
 * (see `/init` at subscribe) — join to its template agent; fall back to the agent row
 * for a template preview DO. Any failure returns the default (full toolset), never
 * fewer — a lookup miss must not silently strip an agent's tools.
 *
 * WHICH join matched is returned, not discarded (#517): the second one IS the agent-template
 * surface, where a constrained connector's tools are refused by decision on every call, so they
 * are withheld there rather than offered and explained (lib/template-preview-tools.ts) — and it is what picks WHICH CONSOLE the prompt may describe (#519, lib/agent-self-description.ts).
 */
async function resolveAgentCapabilities(env: Env, id: string): Promise<TemplatePreviewCapabilities> {
	try {
		const inst = await env.DB.prepare(
			"SELECT a.slug AS slug, a.category AS category, a.config AS config FROM agent_instances i JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1",
		).bind(id).first<{ slug: string | null; category: string | null; config: string | null }>();
		if (inst) return { capabilities: agentCapabilities(inst), previewWithheld: [], surface: "instance" };
		const agent = await env.DB.prepare(
			"SELECT slug, category, config FROM agents WHERE id = ?1",
		).bind(id).first<{ slug: string | null; category: string | null; config: string | null }>();
		if (agent) return withholdConstrainedConnectorTools(agentCapabilities(agent));
	} catch {
		/* fall through to the permissive default */
	}
	return { capabilities: agentCapabilities({}), previewWithheld: [], surface: chatSurfaceForDoKey(id) };
}

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
 * Tools with NO side effect, exempt from the cross-round dedup.
 *
 * The dedup exists to stop duplicate side effects; a pure read repeated after a mutation is the
 * agent OBSERVING what it just did, which is the opposite of a duplicate. Listing the safe names
 * rather than inferring is deliberate — a tool wrongly listed here can be re-run in a loop, so
 * this stays an explicit, reviewable set.
 */
const READ_ONLY_TOOLS = new Set([
	// Re-checking a run after acting is the agent OBSERVING what it just did — the exact case the
	// dedup exemption exists for, and the one #256 is about. Deduping it would mean a challenged
	// agent gets one look per conversation.
	"check_work",
	"read_terminal",
	"list_coding_repos",
	"get_tasks",
	"read_memory",
	"get_activity",
	"list_knowledge",
	"read_knowledge",
	"search_knowledge",
	"list_files",
	"read_file",
	"list_collections",
	"query_records",
	"get_context",
	"check_delegation",
	"list_subordinates",
	"subordinate_status",
]);

/**
 * One provider completion, in the Workers-AI-shaped form `runUserWorkersAi` normalizes to.
 *
 * `stopReason` is the provider's own verdict on why generation ended (#397) — the field that tells
 * a reply cut off at the output cap from one that finished, which the platform had in the response
 * body and threw away.
 */
type ChatCompletion = {
	response?: string;
	tool_calls?: unknown[];
	stopReason?: string;
	/**
	 * The provider's own assistant turn, blocks intact (#398) — present only for a provider that
	 * speaks the structured tool protocol. Its absence is what selects the prose fallback, so the
	 * loop never needs to know which provider ran.
	 */
	contentBlocks?: unknown;
};

export async function runAgentThink(opts: {
	state: AgentState;
	engine: AgentStorageEngine;
	messages: AgentMessage[];
	memory: MemoryEntry[];
	tasks: AgentTask[];
	userId?: string;
	env: Env;
	doStorage: DurableObjectStorage;
	broadcast: (data: Record<string, unknown>) => void;
	/**
	 * Delegation context, when this turn is being driven by a supervisor's run (#183/#184/#185).
	 *
	 * All three were written and never read on this path, which is the ONLY path an agent's own
	 * brain invokes a registry tool through:
	 *
	 *  • `budgetId` — `delegate_goal` falls back to `openBudget(...)` when it has none, so every
	 *    agent-initiated delegation opened a FRESH pool. The tree's real ceiling became
	 *    allowance × (number of delegation edges) rather than one shared allowance — precisely
	 *    the fanout^depth blowup #184 exists to prevent. The per-tree bound was inert on the only
	 *    path an agent can actually use; the "INHERITS the parent's budget" test passes because
	 *    it hand-injects a budgetId that no production caller supplied.
	 *  • `onBehalfOf` — AUDIT ONLY (never an authority; see lib/execution-authority.ts). Without
	 *    it `isDelegated()` was always false, so the `delegated_tool_call` audit event was never
	 *    written for ANY delegated run and /trace could never answer "who asked for this?".
	 *  • `traceId` — `delegate_goal` passes `parentTraceId: ctx.traceId`, so a null here meant a
	 *    Lead → Repo Coder → sub-delegation chain logged each hop under its own run id and never
	 *    rendered as one tree.
	 */
	delegation?: { budgetId?: string | null; onBehalfOf?: string | null; traceId?: string | null };
	/** A previous attempt's completed tool rounds, to continue from instead of re-running (#442).
	 *  Validated by the CALLER (`isResumableFor`), so by the time it arrives it is a fact, not a
	 *  candidate. Absent ⇒ byte-identical behaviour, which is what every failure mode falls back to. */
	resume?: ResumableRound;
	// Returns `transfer` (#279) only on a turn where `transfer_conversation` ran — which is the
	// whole safety argument: there is no response to put it on unless the user just spoke, so this
	// field cannot carry a move nobody asked for. See lib/conversation-transfer.ts.
}): Promise<{ response: string; toolCalls: string[]; transfer?: ConversationTransfer }> {
	const { state, engine, messages, memory, tasks, userId, env, doStorage, broadcast, delegation, resume } = opts;
	const lastUserMessage = messages.filter((m) => m.role === "user").pop()?.content || "";

	// ONE instant for the whole turn. The clock block and the "N minutes ago" work report are read
	// together by the model, and two separate `Date.now()` calls seconds apart make them disagree —
	// a small inconsistency, but this prompt's entire job on the timestamp question is to be the
	// thing the model can quote instead of compute.
	const turnStartedAt = Date.now();

	// Authoritative capabilities → gate tools to what this agent type can actually use
	// (e.g. a Coder never gets search_knowledge, so it can't hallucinate an empty index).
	const { capabilities, previewWithheld, surface } = await resolveAgentCapabilities(env, state.agentId);

	// Subscriber instance config (typed settings values + Rules & Tips). state.agentId
	// is the INSTANCE id for instance DOs; a template/preview DO has no row → stays
	// empty. Best-effort: a failed read must never block the turn.
	let instanceCfg: Record<string, unknown> = {};
	let agentCfg: Record<string, unknown> = {};
	/** The owner's account preferences (#211), raw — read on the same join, parsed below for #329. */
	let ownerPreferences: string | null = null;
	try {
		// Joined rather than a second query: the agent row is only wanted for the creator's
		// behaviour default, which is not worth another round trip on every turn. The UNSCOPED
		// read, deliberately — a DO is addressed BY the instance id and has no session to scope
		// to; see the function's own note for why that is a named door rather than a flag.
		const pair = await readInstanceConfigPairForDurableObject(env, state.agentId);
		if (pair) {
			instanceCfg = pair.config;
			agentCfg = pair.agentConfig;
			ownerPreferences = pair.ownerPreferences;
		} else {
			// A TEMPLATE preview DO is keyed by the AGENT id, so the join above finds nothing and
			// the creator previewing their own agent saw none of the behaviour they declared on it
			// — the preview answered in a different voice from the published agent. Same fallback
			// resolveAgentCapabilities already makes for exactly this case.
			const agent = await env.DB.prepare("SELECT config FROM agents WHERE id = ?1")
				.bind(state.agentId)
				.first<{ config: string | null }>();
			if (agent?.config) agentCfg = JSON.parse(agent.config) as Record<string, unknown>;
		}
	} catch { /* skip silently */ }

	// Moved up from beside `clockPrompt`: the memory block dates its entries in this zone (#495).
	const ownerTimeZone = parseAccountPreferences(ownerPreferences).timezone;

	// Behaviour (#223) — the subscriber's declared character, replacing three hardcoded
	// heuristics further down (the technical/plain guess, the no-step-by-step rule, and the
	// 2-sentence cap). Sparse: an agent that has configured nothing resolves to `{}` and every
	// one of those heuristics stays exactly as it was.
	const behaviour = resolveBehaviour(agentCfg.behaviour, instanceCfg.behaviour);

	let systemPrompt = state.systemPrompt;

	// Placed BEFORE the honesty/safety text below, not after. `persona` is free subscriber text;
	// it configures manner, and must not be positioned to outrank "never claim an action
	// succeeded when it failed".
	systemPrompt += behaviourPrompt(behaviour);

	// Rules & Tips (specialInstructions) — the subscriber's standing free-text rules.
	// Injected right after the base prompt so they take precedence; previously these
	// only reached the workflow brains (apply/coding), never the Assistant chat.
	const subscriberRules =
		typeof instanceCfg.specialInstructions === "string" ? instanceCfg.specialInstructions.trim() : "";
	if (subscriberRules) {
		systemPrompt += `\n\n## Subscriber Rules\nStanding rules your subscriber set for you — follow them:\n${subscriberRules}`;
	}

	// Configured declarative pipelines (config.pipelines, #97). Without this block the agent
	// has a `run_pipeline` tool but is never told which pipelines exist or their names, so on
	// "run it" it asks the user for a pipeline name it was never given. List them + params so
	// the model can dispatch run_pipeline itself.
	const pipelinesCfg = (instanceCfg.pipelines && typeof instanceCfg.pipelines === "object"
		? instanceCfg.pipelines
		: {}) as Record<string, { params?: Record<string, { description?: string }>; sink?: { collection?: string } }>;
	const pipelineNames = Object.keys(pipelinesCfg);
	if (pipelineNames.length) {
		let block =
			"\n\n## Available Pipelines\nYou can RUN these end-to-end with the `run_pipeline` tool — pass the exact `name` plus a `params` object. When the user asks you to run / sweep / find new data, pick the matching pipeline and call it yourself; do NOT ask them which pipeline or invent a name.";
		for (const name of pipelineNames) {
			const p = pipelinesCfg[name];
			const params =
				p?.params && typeof p.params === "object"
					? Object.entries(p.params)
							.map(([k, v]) => (v?.description ? `${k} (${v.description})` : k))
							.join(", ")
					: "";
			block += `\n- **${name}** → writes results to the \`${p?.sink?.collection ?? "?"}\` collection. Params: ${params || "none"}.`;
		}
		systemPrompt += block;
	}

	// Retrieved RAG content is UNTRUSTED — documents, ingested URLs, repo files and public
	// webhook payloads, any of which an attacker can author. Fence it so the model treats it as
	// data, not instructions: the front line against prompt-injection that would otherwise chain
	// read-tools + fetch_url into an exfiltration of the owner's private data. The wording lives
	// in lib/untrusted-fence.ts because the outbound MCP connector needs the SAME fence for
	// `resources/read` (#263) — remote text on the instruction path is one problem either way.
	//
	// ragContextOrNotice applies that fence AND turns a retrieval OUTAGE into an explicit notice
	// rather than omitting the block (#628), an omission the model reads as "there are no docs".
	const ragContext = await ragContextOrNotice(engine, lastUserMessage, { env, agentId: state.agentId, userId });
	if (ragContext) systemPrompt += `\n\n${ragContext}`;

	if (memory.length > 0) {
		// Provenance and AGE for every summary-derived entry (#495): one instance carried a false
		// "write access is not enabled" in the same prompt as "[write — consent GRANTED]", with no
		// date on either to break the tie. Why, and the wording, in lib/memory-prompt.ts.
		systemPrompt += memoryPrompt(memory, { now: turnStartedAt, timeZone: ownerTimeZone });
		// Self-heal the entries written before there was anywhere else to put them (#226). These
		// exist on live agents and can't be reached by a D1 migration — memory lives in the DO — so
		// the agent moves its own, once, the next time it is asked about them. A user-set stray is
		// migrated but never marked for deletion (#230) — see behaviourStrayPrompt.
		systemPrompt += behaviourStrayPrompt(memory);
	}

	// Emitted unconditionally, NOT inside the memory block above — an agent with no memory yet is
	// precisely the one about to write the first preference into the wrong place. write_memory is
	// the tool the model already knows; without being told otherwise it keeps reaching for it, and
	// a stored `preference:response_style` reads back correctly enough to look like it worked.
	systemPrompt +=
		"\n\nMEMORY vs BEHAVIOUR: memory is for facts about the SUBJECT you work on. How you" +
		" COMMUNICATE — technicality, length, tone, formatting, persona, what to call the user — is" +
		" not memory. If the user asks you to change how you answer, call set_behaviour; to tell them" +
		" your current manner, call get_behaviour. Never store a communication preference with write_memory.";

	// The third destination, emitted for the same reason and in the same voice (#514). The two
	// paragraphs together are a table: subject → memory, manner → behaviour, standing rule → Rules
	// & Tips, "the platform got this wrong" → feedback. Without this, a complaint reaches for
	// write_memory — #506 is the live instance, where "file a bug about this" became
	// `fact:pending issue:…` and nothing ever read it again. Feedback is never read back into a
	// prompt (nothing in this file loads it), so an agent cannot answer its own complaints.
	systemPrompt +=
		"\n\nFEEDBACK vs MEMORY vs BEHAVIOUR: when the user tells you that YOU got something wrong" +
		" — a wrong answer, an action you claimed but did not take, a step that failed silently —" +
		" call record_feedback. That is a report about the platform, kept for the people who improve" +
		" it; it is not a fact to remember and not a manner to adopt. Do not write it to memory, do" +
		" not add it to your behaviour, and do not promise to remember it for next time. Record it," +
		" say you have, and carry on with the task.";

	// Provenance, the staleness cutoff and the injection cap live in lib/agent-tasks.ts (#337) —
	// this block is agent-WRITABLE durable state on the instruction path, so what reaches the
	// prompt is a decision worth testing rather than an inline filter.
	systemPrompt += renderActiveTasks(tasks);

	// ## Your Agents (#330) — the standing DIRECTION this supervisor holds for each subordinate.
	//
	// On the prompt rather than only in `list_subordinates` because that is what "durable" has to
	// mean here: asked what FWS should be working on, the Lead previously answered from recent runs
	// and board items, which are HISTORY, not intent. Direction that lives only in a chat is lost
	// when the thread rolls over and re-stated by the user every session.
	//
	// Derived from the record on every turn, never copied into memory or a system prompt (#315): a
	// direction the owner changes in Settings must change what the agent believes on its very next
	// turn. Gated on the agent declaring a supervision tool, so the two-statement cost is paid only
	// by an agent that supervises somebody, and best-effort — a failed read must never take a turn
	// down.
	const supervisionTools = toolNamesFor(capabilities);
	if (userId && (supervisionTools.has("delegate_goal") || supervisionTools.has("list_subordinates"))) {
		const roster = await directionRosterFor(env, userId, state.agentId).catch(() => []);
		systemPrompt += renderDirections(roster);
	}

	if (userId) {
		const userCtx = await engine.getUserContext(userId);
		await engine.touchUserContext(userId);
		if (Object.keys(userCtx.preferences).length > 0) {
			systemPrompt += "\n\n## User Preferences\n";
			for (const [key, value] of Object.entries(userCtx.preferences)) {
				systemPrompt += `- ${key}: ${value}\n`;
			}
		}
	}

	// Typed agent settings (declared settingsSchema + subscriber's values) — the
	// deterministic home for durable config like a tutor's target language, so it
	// never depends on the model remembering (or memorizing) it.
	const settingsSchema = capabilities.settingsSchema ?? [];
	const settingsValues = resolveSettingsValues(settingsSchema, instanceCfg.settings);
	if (settingsSchema.length) {
		const settingsBlock = settingsPromptBlock(settingsSchema, settingsValues);
		if (settingsBlock) systemPrompt += `\n\n${settingsBlock}`;
	}

	// Stats cards (#312) — DERIVED from the resolved schema, never hardcoded prose, and costing no
	// extra query: `instanceCfg`/`agentCfg` are already in hand from the join above. An agent that
	// can answer "how many leads this week" but is never told it has the tool will not use it;
	// an agent with no cards is told nothing at all, so it cannot claim a dashboard it lacks.
	const statsBlock = statsPromptBlock(resolveStatsCards(agentCfg.statsSchema, instanceCfg.stats));
	if (statsBlock) systemPrompt += `\n\n${statsBlock}`;

	// A clock, and whose clock it is (#329). Nothing in this builder had ever told an agent what time
	// it was, so every timestamp it read was an ISO string it could only label UTC — which is a
	// different claim from the one the reader hears, not merely a different format. The zone comes
	// from the owner's account preferences, already in hand from the join above; UNSET is honest and
	// keeps the block in UTC rather than inventing a locale. See `lib/agent-clock.ts`.
	// (`ownerTimeZone` is resolved with the config read above — earlier blocks need it too.)
	systemPrompt += clockPrompt(turnStartedAt, ownerTimeZone);

	// The voice channel the agent is heard through and does not own (#340). Unconditional: voice is a
	// client feature of every agent's chat, so the denial is true for all of them. The wording lives
	// in the pure module because a claim written HERE is a claim nothing can check (#315).
	systemPrompt += voiceControlPrompt;

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
		systemPrompt += recentWorkPrompt(recentRuns, turnStartedAt, { delegated, timeZone: ownerTimeZone });
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
				systemPrompt += "\n\n## Indexed repositories";
				if (ready.length) systemPrompt += `\nReady: ${ready.join("; ")}.`;
				if (pending.length) systemPrompt += `\nStill indexing (ask again shortly): ${pending.join(", ")}.`;
				systemPrompt += indexedReposPrompt(selfModel, plainSpeech);
			}
		}
	} catch {
		// Omitting this block is NOT the neutral outcome (#291). It is the one thing that makes
		// the agent's repo awareness authoritative, and without it the model answers "I don't see
		// any repositories" — a confident claim about the account, manufactured from a DO read
		// that failed. Said in the same vocabulary the terminal block below uses for exactly this
		// problem: an unreadable thing is reported as unreadable, never as absent.
		systemPrompt +=
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
				systemPrompt += runnerStatusPrompt(selfModel, facts ? describeFacts(facts) : null);
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
				systemPrompt += attachedReposPrompt(repos);
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
					systemPrompt += "\n## Active Coding Sessions\n";
					active.forEach((s, idx) => {
						const repo = repos.find((r) => r.id === s.repoId);
						systemPrompt += `- ${repo?.name || s.repoId} — engine: ${s.launchCommand || s.clientType || "claude"}\n`;
						const line = renderTerminalLine(terminals[idx], ownerTimeZone);
						if (line) systemPrompt += `${line}\n`;
					});
				} else {
					systemPrompt += noActiveSessionPrompt(selfModel);
				}
				systemPrompt +=
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
			systemPrompt +=
				"\n\n## Attached repositories\nUNAVAILABLE this turn — the repo and session registry could not be read. You ARE attached to repositories; their names and live state simply could not be fetched. Do NOT say you have no repos, and do NOT describe any session state.";
		}
	}

	// The repo the subscriber saved in the console Deployment card, and its latest build (#494).
	// Console-only state is invisible to the agent otherwise (#255's rule, reproduced by #488):
	// an Operator answered "which repo?" from memory and "was it deployed?" from a scraped pane
	// while the platform held both. Wording, timeout and the three lookup outcomes are in the
	// module, which never throws.
	systemPrompt += await deploymentContext(env, userId, instanceCfg, { now: turnStartedAt, timeZone: ownerTimeZone });

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
		systemPrompt += "\n\nIMPORTANT: Never output step-by-step thinking. Never say 'Step 1' or 'Step 2'.";
	}

	// HONESTY / grounding. Real chats showed an agent tell the user a post was
	// "successfully queued" when the tool had returned a 500, and another address the
	// user by an invented name. Ground every claim in actual results — a false success
	// is worse than a reported failure.
	systemPrompt +=
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
	systemPrompt += styleGuidance({
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
		systemPrompt +=
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
		{ role: "system", content: systemPrompt },
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

	/**
	 * EVERY chat completion in this function goes through here (#397).
	 *
	 * Chat was the one caller of `runUserWorkersAi` that never named a `maxTokens`, so it inherited
	 * the 1024 default and each reply a human reads end to end was cut at ~4,000 characters — a Repo
	 * Coder answer in the wild stops mid-file on the bare word `import`. A wrapper rather than four
	 * more argument lists: there are four completions on this path (tool-less, per round, the #395
	 * correction round, the final answer), and a fifth added later must not be able to skip the cap
	 * or the stop-reason read. `agent-think.test.ts` asserts that over the source.
	 */
	let truncated = false;
	const chatComplete = async (body: { messages: { role: string; content: unknown }[]; tools?: unknown[]; toolChoice?: "auto" | "none" }): Promise<ChatCompletion> => {
		const r = (await runUserWorkersAi(
			env,
			userId,
			effectiveModel,
			{ ...body, maxTokens: CHAT_MAX_TOKENS },
			{ kind: "chat", instanceId: state.agentId },
		)) as ChatCompletion;
		if (!truncated && hitOutputCap(r.stopReason)) {
			truncated = true;
			// Durable, because "the agent stopped mid-sentence" is otherwise only ever a user's
			// impression — the fact was in the provider's response body and nothing recorded it.
			await logEvent(env, {
				source: "chat",
				event: "chat.truncated",
				level: "warn",
				message: `Reply hit the ${CHAT_MAX_TOKENS}-token output cap and was cut off.`,
				userId: userId ?? null,
				instanceId: state.agentId,
				traceId: delegation?.traceId ?? null,
			});
		}
		return r;
	};
	/** Platform notices for the tool log. Truncation goes last so a #395 correction still leads. */
	const withTruncation = (notices: readonly string[]): string[] =>
		truncated ? [...notices, truncationNotice(CHAT_MAX_TOKENS)] : [...notices];

	if (!useTools) {
		const result = await chatComplete({ messages: aiMessages });
		// A turn on a model that cannot call a tool executes nothing, so a tool RESULT written here
		// is invention with no ambiguity left in it — and there is no correction round worth buying
		// from a model that could not have called the tool in the first place (#395).
		const honest = await honestReply({ reply: { text: result.response || "", calls: [] }, executed: [], log: [] });
		return { response: honest.text, toolCalls: toolLogWithNotices([], withTruncation(honest.notices)) };
	}

	// The owner's per-tool off-switches (config.disabledTools). Applied to BOTH the
	// definitions handed to the model and the execution allow-list below — a control that
	// covers only one of those isn't control, it's a suggestion.
	const disabledTools = readDisabledTools(JSON.stringify(instanceCfg));
	const tools = buildAgentToolDefinitions({
		emailEnabled: state.permissions?.email === true,
		capabilities,
		disabledTools,
	});
	// The same allow-list, enforced at EXECUTION too: a non-tool model can emit a
	// withheld tool as text (parseToolCallsFromText), which would otherwise bypass the
	// definition-level gate. Belt and suspenders.
	const allowedToolNames = toolNamesFor(capabilities);
	if (state.permissions?.email === true) allowedToolNames.add("find_confirmation_link");
	for (const name of disabledTools) allowedToolNames.delete(name);

	// Imported remote MCP tools (#261). A granted tool on a connected server becomes a REAL
	// function tool — the server's own name, description and input schema — instead of the model
	// having to remember a tool name and hand-build an `args` blob for the generic passthrough.
	//
	// Gated on `mcp_call_tool` being available to this agent, because that is exactly what these
	// dispatch through: an imported tool is a nicer way to TYPE a call, never a second way to
	// authorize one. If the creator did not declare the MCP connector, or the owner switched the
	// tool off, there is nothing to import — the same verdict the connection test reports as
	// `callToolEnabled`. Reads are skipped entirely for agents without it, so the D1 query is paid
	// only by agents that can actually use the result.
	const importedMcp = allowedToolNames.has("mcp_call_tool") && userId ? await loadImportedMcpTools(env, state.agentId, userId) : [];
	const importedByName = new Map(importedMcp.map((t) => [t.name, t]));
	for (const t of importedMcp) {
		tools.push({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.jsonSchema } });
		allowedToolNames.add(t.name);
	}

	/**
	 * What a completion meant to produce PROSE must send once the transcript is in the structured
	 * protocol (#398).
	 *
	 * The final answer and #395's correction round deliberately send no tools, which is how they
	 * discourage another round. That stops being legal the moment a tool round has appended
	 * `tool_use`/`tool_result` blocks: the provider requires `tools` to be DEFINED whenever the
	 * messages contain either, and answers a request that omits them with a 400 on the whole turn —
	 * so the chat would fail outright rather than degrade. Declaring them with `tool_choice:"none"`
	 * keeps both facts true: the tools the transcript refers to exist, and this turn may not call
	 * one. Nothing extra is sent on the prose fallback, where there are no blocks to explain.
	 */
	const proseOnly = (): { tools?: unknown[]; toolChoice?: "none" } =>
		hasToolBlocks(aiMessages) ? { tools, toolChoice: "none" } : {};

	const allToolLog: string[] = [...(resume?.toolLog ?? [])];
	// The failed attempt's completed rounds, replayed into this transcript (#442). Appended AFTER
	// the history — whose last entry is the user's retry, the same question — so the model reads
	// "here are your results", not "here is the question", and the tools are never called again.
	const roundMessages: { role: string; content: unknown }[] = [...(resume?.messages ?? [])];
	for (const m of roundMessages) aiMessages.push({ role: m.role, content: m.content });
	// Every registry result this turn produced, kept only so the destination can be read back out
	// of them at each exit. A transfer set in round 2 must still travel when round 3 calls no
	// tools and returns early — an accumulator, not a flag set at the last place it was seen.
	const registryResults: { success: boolean; transfer?: ConversationTransfer }[] = [];
	const storageToolNames = storageToolNameSet();
	const registryToolNames = registryToolNameSet();
	// Multi-step tasks (e.g. read goal + list files + fetch job page, THEN
	// submit the application) need headroom; 3 rounds ran out before acting.
	const maxToolRounds = 8;
	// Guard against the model re-issuing the same tool call across rounds, which
	// otherwise creates duplicate side effects (e.g. three identical job tasks).
	//
	// Keyed to the MUTATION COUNT at the time of execution, not a bare set. Exempting reads
	// unconditionally was too coarse: with nothing to stop it, the model re-ran the same pure read
	// every round until the round cap, which also removed the loop's natural stopping condition
	// (a round that executes nothing breaks). Seen live on the Coder Lead — `list_subordinates`
	// with identical args ran once, then twice, then three times in a single turn, each time
	// returning the same three rows. A read is only worth repeating when something CHANGED since
	// the last identical call, which is exactly what this counter answers.
	// Seeded from a resumed round (#442) so the dedup spans the two REQUESTS, not just two rounds:
	// without it the retry re-issues the write the failed attempt already committed — the duplicate
	// this map exists to prevent, reached through the one door it cannot see.
	const executedCalls = new Map<string, number>(resume?.executed ?? []);
	let mutations = resume?.mutations ?? 0;
	// What this turn ACTUALLY ran, in order — the ground truth `honestReply` audits the model's
	// text against (#395). Kept beside `allToolLog` rather than derived from it: the log is a
	// display string, and a check that has to re-parse its own evidence is one rename from
	// silently passing everything.
	const executedTools: string[] = [...(resume?.executedTools ?? [])];
	// The path-shaped strings this turn's tool RESULTS contained (#528), read back when the model
	// writes one into a filed issue or a run objective. Turn-scoped and declared here, beside the
	// other accumulators, because the read and the write are usually different rounds.
	const pathLedger = createPathLedger();

	/**
	 * The ONE way a model-authored reply leaves this function (#395).
	 *
	 * Both exits used to hand back raw text — the early return when a round asks for no tools, and
	 * the final answer after the loop, which is never parsed at all. That second one is where a
	 * Repo Coder's invented `<tool_response>` blocks reached the transcript: three GitHub issues
	 * quoted by number and title from a tool that never ran, which the user then acted on.
	 */
	const deliver = async (reply: ParsedReply): Promise<{ response: string; toolCalls: string[]; transfer?: ConversationTransfer }> => {
		const honest = await honestReply({
			reply,
			executed: executedTools,
			log: allToolLog,
			regenerate: async (correction) => {
				aiMessages.push({ role: "assistant", content: reply.text });
				aiMessages.push({ role: "user", content: correction });
				const retry = await chatComplete({ messages: aiMessages, ...proseOnly() });
				const parsed = parseToolCallsFromText(retry.response || "", allowedToolNames);
				return { text: parsed.text, calls: parsed.calls.map((c) => c.name) };
			},
		});
		if (honest.notices.length > 0) {
			// Durable, because the platform correcting its own agent is exactly what the next
			// investigator looks for — #395 was reconstructed entirely from `agent_events`, and the
			// one thing it could not show was that anything had objected.
			await logEvent(env, {
				source: "chat",
				event: "chat.invented_result",
				level: "warn",
				message: honest.notices.join(" ").slice(0, 500),
				userId: userId ?? null,
				instanceId: state.agentId,
				traceId: delegation?.traceId ?? null,
			});
		}
		// #279: the destination the user asked to be moved to, read back out of the turn's registry
		// results at the ONE exit — so a transfer resolved in round 2 still travels when a later
		// round calls no tools and returns early. Null for every turn that did not run the tool,
		// which is the property that keeps the response channel honest.
		const transfer = transferFromToolResults(registryResults);
		return { response: honest.text, toolCalls: toolLogWithNotices(allToolLog, withTruncation(honest.notices)), ...(transfer ? { transfer } : {}) };
	};

	/** What to hand a retry, evaluated at the moment of failure. Null when nothing ran. */
	const resumableNow = (): ResumableRound | null =>
		buildResumableRound(
			{
				prompt: lastUserMessage,
				roundsUsed: roundMessages.length / 2,
				executed: [...executedCalls],
				mutations,
				executedTools: [...executedTools],
				toolLog: [...allToolLog],
				messages: [...roundMessages],
			},
			Date.now(),
		);

	// A resumed turn does NOT get a fresh budget: `maxToolRounds` bounds the work done for ONE
	// question, and restarting the count buys eight more rounds on top of those already paid for.
	for (let round = resume?.roundsUsed ?? 0; round < maxToolRounds; round++) {
		let rawResult: ChatCompletion;
		try {
			rawResult = await chatComplete({ messages: aiMessages, tools });
		} catch (err) {
			throw withResumableRound(withPartialToolLog(err, allToolLog), resumableNow());
		}

		let toolCalls = normalizeToolCalls(rawResult.tool_calls || []);
		// Scoped to the allowlist: an object in the reply that merely HAS a `name` key (a
		// package.json, a lead record) is prose, not a tool call, and treating it as one
		// discarded the model's real answer. See parse-tool-calls.ts. Parsed unconditionally now,
		// because the walker also RETURNS the text with those spans removed (#395) and this reply
		// is a candidate answer whichever path produced the calls.
		const parsed = parseToolCallsFromText(rawResult.response || "", allowedToolNames);
		if (toolCalls.length === 0) toolCalls = parsed.calls;

		if (toolCalls.length === 0) {
			return deliver({ text: parsed.text, calls: parsed.calls.map((c) => c.name) });
		}

		const toolResults: string[] = [];
		// The same outcomes keyed by the provider's `tool_use` id, for the structured protocol
		// (#398). Recorded beside the prose list rather than derived from it: the prose is a display
		// string, and the id is the ONLY thing that says which of two calls to the same tool a
		// result answers.
		const outcomeById = new Map<string, ToolOutcome>();
		// Capped HERE, at the one seam where a result re-enters the prompt (#427). Both branches take
		// the same capped string, because both are read by the model on the next round and a cap on
		// one of them is not a cap. Well above every deliberate per-tool cap, so it can only fire on a
		// tool that bounded nothing; see lib/tool-result-cap.ts for why it truncates visibly.
		const record = (tc: { name: string; id?: string }, content: string, isError: boolean) => {
			const capped = capToolResult(content);
			toolResults.push(`[${tc.name}]: ${capped}`);
			if (tc.id) outcomeById.set(tc.id, { content: capped, isError });
		};
		let executedThisRound = 0;
		for (const tc of toolCalls) {
			// Enforce the capability allow-list. A withheld tool (e.g. search_knowledge on a
			// Coder) is refused with feedback so the model answers directly instead — it is
			// never executed. Not counted as work, so a run of only-refused calls ends the loop.
			if (!allowedToolNames.has(tc.name)) {
				// `is_error` on a refusal and on a de-duplicated repeat below: neither produced what
				// was asked for, and a refusal delivered as a successful result is a sentence the
				// model can quote as an outcome.
				record(tc, "This tool isn't available to this agent — do not call it; answer directly or use an available tool.", true);
				continue;
			}
			// stableStringify, not JSON.stringify: the raw form is KEY-ORDER dependent, so the same
			// logical call emitted with its fields in a different order hashed differently and
			// slipped straight past the dedup. That is how `write_memory` ran four times against
			// one key in a single turn (#226) — nothing was deduplicating identical intent, only
			// identical byte-order. The pump's delivery idempotency key already learned this.
			const signature = `${tc.name}:${stableStringify(tc.arguments ?? {})}`;
			// The dedup exists to stop DUPLICATE SIDE EFFECTS (three identical job tasks), so it
			// applies only to calls that have one. Applied to pure reads it produced the opposite
			// of its purpose: round 1 `read_terminal` (idle), `send_to_cli "run the tests"`; round
			// 2 `read_terminal` again to see the result — identical signature, refused, never
			// reaching /coding/capture — so the model described the PRE-send idle pane as the
			// outcome. Same for `get_tasks` before and after `create_task`: the agent tells you it
			// has no tasks immediately after creating one. A read's whole job is to observe a
			// change something else made.
			const isRead = READ_ONLY_TOOLS.has(tc.name);
			const ranAt = executedCalls.get(signature);
			// Repeat allowed only for a READ, and only when a mutating tool has run since.
			if (ranAt !== undefined && !(isRead && mutations > ranAt)) {
				record(tc, "Already executed this exact call this turn — not repeating. Use the earlier result.", true);
				continue;
			}
			executedCalls.set(signature, mutations);
			if (!isRead) mutations++;
			executedThisRound++;
			let toolResult: ToolCallResult;
			if (tc.name === "configure_board") {
				// The agent reshaping its OWN board (columns/view). Needs D1 + the owner's
				// uid — the instance DO is keyed per instance, so state.agentId IS the
				// instance id here (see the chat context above). No uid = no owner to scope to.
				const r = userId
					? await configureBoardForAgent(env, state.agentId, userId, (tc.arguments ?? {}) as Record<string, unknown>)
					: { content: "Board can only be customized for a signed-in owner.", success: false };
				toolResult = { name: tc.name, content: r.content, success: r.success };
			} else if (importedByName.has(tc.name)) {
				// #261 — resolve the SYNTHETIC label back to (endpoint, remote tool name) and run the
				// ordinary `mcp_call_tool`. The label is never a permission key: consent (#262) is
				// checked on the remote name, `isDestructiveToolName` runs on the name we put on the
				// wire, and the credential resolves on the normalized endpoint (#286). Dispatching on
				// the label instead would break the grant lookup and the destructive-name test in
				// silence — the two failure modes that look like nothing at all until they matter.
				const imported = importedByName.get(tc.name)!;
				const r = await runRegistryTool(
					"mcp_call_tool",
					{
						env,
						userId,
						agentId: state.agentId,
						instanceId: state.agentId,
						budgetId: delegation?.budgetId ?? undefined,
						onBehalfOf: delegation?.onBehalfOf ?? undefined,
						traceId: delegation?.traceId ?? undefined,
					},
					{ url: imported.endpoint, tool: imported.tool, args: (tc.arguments ?? {}) as Record<string, unknown> },
				);
				// Reported under the label the model called, not under `mcp_call_tool` — a transcript
				// where the request and the result name different tools is unreadable.
				toolResult = { name: tc.name, content: r.content, success: r.success };
			} else if (registryToolNames.has(tc.name)) {
					const registry = await runRegistryTool(
						tc.name,
						{
							env,
							userId,
							agentId: state.agentId,
							instanceId: state.agentId,
							// Carried, not invented: consent and token-minting still resolve against
							// `instanceId` (the EXECUTOR), so this never widens what the tool may do.
							budgetId: delegation?.budgetId ?? undefined,
							onBehalfOf: delegation?.onBehalfOf ?? undefined,
							traceId: delegation?.traceId ?? undefined,
						},
						(tc.arguments ?? {}) as Record<string, unknown>,
					);
					// The two halves of a registry result are kept APART on purpose (#279). What the
					// model reads is text and goes on to the transcript and the `tool_call` broadcast;
					// a destination for the browser is neither, and passing the whole object through
					// would put it on that broadcast — a push channel, which is exactly the shape this
					// design declined to build. The `toolResult` below is rebuilt field by field so a
					// client directive cannot ride out on it by accident.
					registryResults.push({ success: registry.success, ...(registry.transfer ? { transfer: registry.transfer } : {}) });
					toolResult = { name: registry.name, content: registry.content, success: registry.success };
				} else if (storageToolNames.has(tc.name)) {
				toolResult = await executeStorageTool(
					{ name: tc.name, input: tc.arguments },
					engine,
					{ env, agentId: state.agentId, userId, emailPermitted: state.permissions?.email === true },
				);
			} else {
				const callReq: ToolCallRequest = { name: tc.name, input: tc.arguments };
				// What lets `fetch_url` explain its own failure rather than leave the model to invent a
				// cause (#494/#493). Both already in hand; the reasoning is in lib/fetch-url-diagnosis.ts.
				toolResult = await executeTool(callReq, doStorage, env.STORAGE, state.agentId, {
					toolNames: allowedToolNames,
					configuredRepo: instanceCfg.githubRepo,
				});
			}
			// Evidence, not a rule (#528): a path written into a durable artifact — a filed issue, a run
			// objective — against the paths this turn's results actually contained. Checks then absorbs
			// in one call, so a result can never corroborate itself; `success` is untouched, and the
			// note lands before both the model's copy and the owner's pill. lib/path-corroboration.ts.
			toolResult = corroborateToolPaths(pathLedger, toolResult, tc.name, tc.arguments);
			// The pill the OWNER reads — not the copy `record` hands the model. A FAILURE gets a wider
			// budget there: its remedy is its last clause, and a flat 120 cut into that word (#517).
			allToolLog.push(toolLogLine(tc.name, toolResult.content, toolResult.success));
			executedTools.push(tc.name);
			record(tc, toolResult.content, !toolResult.success);
			broadcast({ type: "tool_call", tool: tc.name, result: toolResult });
			await engine.logEvent("tool.called", userId, { tool: tc.name, success: toolResult.success });
			// The same fact, in the TRACE (#564). It has to be written here because here is the only
			// place `success` still exists as a boolean: one line below, the outcome is a `✅`/`❌`
			// inside a string, and the route that logs that string cannot classify what it was
			// handed. Failures only — see logToolFailure for why not one row per tool.
			if (!toolResult.success) await logToolFailure(env, { tool: tc.name, content: toolResult.content, round, userId, instanceId: state.agentId, traceId: delegation?.traceId ?? null });
		}

		// The round, in the protocol the provider actually offers (#398).
		//
		// What this replaced pushed the results back inside an ASSISTANT message that narrated them,
		// and never appended the model's `tool_use` turn at all — so the exchange the
		// provider saw was: a request with `tools`, a response with `tool_use`, then a request in
		// which that never happened plus an assistant paragraph narrating results. Ground truth sat
		// in the one role that means "the model's own words", and after the merge in
		// `normalizeForAnthropic` a real tool output and something the model asserted were the same
		// paragraph. That is the format #395's fabrication imitated: the model reproduced the
		// convention it was shown every turn.
		//
		// The ids come from the assistant turn itself, not from the normalized call list, because
		// `normalizeToolCalls` skips a call with malformed arguments and the provider rejects the
		// WHOLE request for a `tool_use` left unanswered.
		const toolUseIds = toolUseIdsOf(rawResult.contentBlocks);
		const continueText = `Continue based on the tool results above. REMEMBER: ${styleReminder}`;
		if (toolUseIds.length > 0) {
			aiMessages.push({ role: "assistant", content: rawResult.contentBlocks });
			aiMessages.push({ role: "user", content: toolResultTurn(toolUseIds, outcomeById, continueText) });
			// Recorded only on the structured path and only once the round has settled (#442). Read
			// back off `aiMessages` so a resume replays exactly what this turn sent. The prose
			// fallback is deliberately NOT resumable — replaying it re-enters the narrated shape
			// #398 removed, and it is the Workers-AI fallback, not the provider chats run on.
			roundMessages.push(aiMessages[aiMessages.length - 2], aiMessages[aiMessages.length - 1]);
		} else {
			// The Workers-AI fallback and the text-embedded path: no ids to answer, so the prose
			// shape stays. Branching on whether the completion CARRIED blocks keeps this
			// self-describing — a provider enum here would be a second thing to keep in sync, and
			// the fallback's limitation must not set the protocol for the provider almost every chat
			// actually runs on.
			aiMessages.push({ role: "assistant", content: `I called tools:\n${toolResults.join("\n")}` });
			aiMessages.push({ role: "user", content: continueText });
		}
		// The model only re-requested calls it already made — nothing new will
		// happen in another round, so stop and let it write the final response.
		if (executedThisRound === 0) break;
	}

	// Final reminder before generating the response
	if (allToolLog.length > 0) {
		aiMessages.push({ role: "user", content: `Now give your final answer. ${styleReminder}` });
	}
	let final: ChatCompletion;
	try {
		final = await chatComplete({ messages: aiMessages, ...proseOnly() });
	} catch (err) {
		// The most valuable place to be resumable: every tool has run and only the generation
		// failed, so a retry re-pays for the whole turn to produce one paragraph.
		throw withResumableRound(withPartialToolLog(err, allToolLog), resumableNow());
	}
	// A call written into the FINAL answer can never execute — the loop is over — so it is reported
	// as named-but-never-run rather than left on screen as if it had.
	const parsedFinal = parseToolCallsFromText(final.response || "", allowedToolNames);
	return deliver({ text: parsedFinal.text, calls: parsedFinal.calls.map((c) => c.name) });
}

/**
 * #24: when a late provider call throws, side effects committed in earlier tool rounds
 * (memory writes, created tasks, inserted records) have already persisted. Attach the
 * completed tool log to the error so the caller can surface what succeeded instead of
 * discarding it behind a bare "Error:…". Errors keep their type/status (creds/provider
 * errors still propagate), so this only ADDS the partial log.
 */
export function withPartialToolLog(err: unknown, toolLog: string[]): unknown {
	if (toolLog.length > 0 && err && typeof err === "object") {
		(err as { partialToolLog?: string[] }).partialToolLog = toolLog;
	}
	return err;
}
