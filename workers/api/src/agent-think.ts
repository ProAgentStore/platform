import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { AgentStorageEngine } from "./agent-storage.js";
import type { AgentMessage, AgentState, AgentTask, MemoryEntry } from "./agent-types.js";
import { TOOL_CAPABLE_MODELS, resolveModelForTools } from "./agent-do-prompt.js";
import { buildAgentToolDefinitions, storageToolNameSet, toolNamesFor } from "./agent-do-tools.js";
import { registryToolNameSet, registryTools, runRegistryTool } from "./lib/tool-registry.js";
import { configureBoardForAgent } from "./lib/board.js";
import { agentCapabilities, type AgentCapabilities } from "./lib/agent-capabilities.js";
import { readDisabledTools } from "./lib/instance-tool-policy.js";
import { readInstanceConfigPairForDurableObject } from "./lib/instance-config.js";
import { stableStringify } from "./lib/stable-json.js";
import { fenceUntrusted } from "./lib/untrusted-fence.js";
import { loadImportedMcpTools } from "./lib/mcp-tool-catalog.js";
import { resolveSettingsValues, settingsPromptBlock } from "./lib/instance-settings.js";
import { resolveStatsCards, statsPromptBlock } from "./lib/stats-schema.js";
import { executeStorageTool } from "./lib/storage-tools.js";
import { executeTool, type ToolCallRequest, type ToolCallResult } from "./lib/tools.js";
import { normalizeToolCalls, parseToolCallsFromText } from "./lib/parse-tool-calls.js";
import { runUserWorkersAi } from "./lib/user-ai.js";
import { listRepos, listSessions } from "./lib/coding-store.js";
import { lastTerminal } from "./lib/coding-timeline.js";
import { describeTerminal, renderTerminalLine } from "./lib/terminal-label.js";
import { callRunner, getBoundRunnerConn, relayConnected, READ_TIMEOUT_MS } from "./lib/runner-client.js";
import { executionAuthorityPrompt, resolveSelfModel, selfDescriptionPrompt } from "./lib/agent-self-description.js";
import { indexedReposPrompt, noActiveSessionPrompt, runnerStatusPrompt, styleGuidance } from "./lib/agent-style-prompt.js";
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
 */
async function resolveAgentCapabilities(env: Env, id: string): Promise<AgentCapabilities> {
	try {
		const inst = await env.DB.prepare(
			"SELECT a.slug AS slug, a.category AS category, a.config AS config FROM agent_instances i JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1",
		).bind(id).first<{ slug: string | null; category: string | null; config: string | null }>();
		if (inst) return agentCapabilities(inst);
		const agent = await env.DB.prepare(
			"SELECT slug, category, config FROM agents WHERE id = ?1",
		).bind(id).first<{ slug: string | null; category: string | null; config: string | null }>();
		if (agent) return agentCapabilities(agent);
	} catch {
		/* fall through to the permissive default */
	}
	return agentCapabilities({});
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
}): Promise<{ response: string; toolCalls: string[] }> {
	const { state, engine, messages, memory, tasks, userId, env, doStorage, broadcast, delegation } = opts;
	const lastUserMessage = messages.filter((m) => m.role === "user").pop()?.content || "";

	// Authoritative capabilities → gate tools to what this agent type can actually use
	// (e.g. a Coder never gets search_knowledge, so it can't hallucinate an empty index).
	const capabilities = await resolveAgentCapabilities(env, state.agentId);

	// Subscriber instance config (typed settings values + Rules & Tips). state.agentId
	// is the INSTANCE id for instance DOs; a template/preview DO has no row → stays
	// empty. Best-effort: a failed read must never block the turn.
	let instanceCfg: Record<string, unknown> = {};
	let agentCfg: Record<string, unknown> = {};
	try {
		// Joined rather than a second query: the agent row is only wanted for the creator's
		// behaviour default, which is not worth another round trip on every turn. The UNSCOPED
		// read, deliberately — a DO is addressed BY the instance id and has no session to scope
		// to; see the function's own note for why that is a named door rather than a flag.
		const pair = await readInstanceConfigPairForDurableObject(env, state.agentId);
		if (pair) {
			instanceCfg = pair.config;
			agentCfg = pair.agentConfig;
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

	// Retrieved RAG content is UNTRUSTED — it comes from documents, ingested URLs,
	// repo files, and public webhook payloads, any of which an attacker can author.
	// Fence it so the model treats it as data, not instructions: this is the front
	// line against prompt-injection that would otherwise chain read-tools + fetch_url
	// into an exfiltration of the owner's private data.
	//
	// The wording lives in lib/untrusted-fence.ts because the outbound MCP connector needs the
	// SAME fence for `resources/read` (#263) — remote text on the instruction path is the same
	// problem whether it arrived via RAG or via a server the agent named itself.
	const ragContext = await engine.buildRAGContext(lastUserMessage);
	if (ragContext) systemPrompt += `\n\n${fenceUntrusted(ragContext, "documents/URLs/repos/webhooks")}`;

	if (memory.length > 0) {
		systemPrompt += "\n\n## Your Memory\n";
		systemPrompt +=
			"To change a fact below, write_memory to its EXACT key; never add a new key for a fact that already has one. " +
			"Entries marked (user-set) were set directly by the user — never overwrite or delete them unless the user explicitly asks.\n";
		for (const m of memory) {
			const userSet = m.source === "user" ? " (user-set)" : "";
			systemPrompt += `- [${m.type}] ${m.key}${userSet}: ${m.content}\n`;
		}
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

	const activeTasks = tasks.filter((t) => t.status !== "complete");
	if (activeTasks.length > 0) {
		systemPrompt += "\n\n## Active Tasks\n";
		for (const t of activeTasks) {
			systemPrompt += `- [${t.status}] ${t.title}: ${t.description}\n`;
		}
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

	// ── What this agent IS (#255) ────────────────────────────────────────────────────────────
	//
	// Derived from the capability registry, not from memory. A Repo Coder's only sense of owning a
	// repository came from a seeded `goal` memory string, so the fact lived in the one place that
	// is narrative rather than authoritative — which is how an agent whose declared surfaces are
	// `["coding"]` told a user to "attach a repository in the Repo tab". It has no Repo tab.
	// `repos:"single"` was read ONLY by the console; nothing ever told the agent.
	const selfModel = resolveSelfModel(capabilities);
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
		systemPrompt += recentWorkPrompt(recentRuns, Date.now(), { delegated });
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
				systemPrompt += indexedReposPrompt(selfModel);
			}
		}
	} catch {}

	// Coding repos & sessions context (Coder instances). Inject the live registry
	// so the Chat tab can actually answer "what's happening in repo X" instead of
	// the old "I don't see any repos" — and flip to the technical style below,
	// since this is a developer-facing agent, not the plain-speech default.
	let hasCodingContext = false;
	if (userId && state.agentId) {
		try {
			const repos = attachedRepos;
			if (repos.length > 0) {
				hasCodingContext = true;
				// Resolve the runner honoring this instance's node binding (config.runnerNode),
				// then ask the RelayDO — on the SAME node-scoped relay the runner connects to —
				// whether it's actually live right now. DB session status can read "active" after
				// an unclean disconnect, so the relay is authoritative. This also fixes the gap
				// where a node-connected runner looked OFFLINE to a node-less check.
				const boundConn = await getBoundRunnerConn(env, state.agentId, userId).catch(() => null);
				const runnerOnline = boundConn ? await relayConnected(env, state.agentId, boundConn.runnerNode ?? null) : false;
				systemPrompt += runnerStatusPrompt(selfModel, runnerOnline);
				systemPrompt += "\n\n## Attached Repositories\n";
				for (const r of repos) {
					const status =
						r.cloneStatus === "ready"
							? "ready"
							: r.cloneStatus === "cloning"
								? "cloning…"
								: r.cloneStatus === "error"
									? `clone error${r.cloneError ? `: ${r.cloneError}` : ""}`
									: r.cloneStatus;
					systemPrompt += `- ${r.name}${r.githubRepo ? ` (${r.githubRepo})` : ""} — ${status}\n`;
				}
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
						const line = renderTerminalLine(terminals[idx]);
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
		} catch {}
	}

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
			systemPrompt +=
				"\n\nCONNECTED TOOLS — external actions you can take DIRECTLY by calling the tool" +
				" (never tell the user to do it themselves, and never route it through a terminal/CLI):\n" +
				connectorTools
					.map((t) => `- ${t.name}${t.scope === "write" ? " [write — needs the connector's consent]" : ""}: ${t.description}`)
					.join("\n");
		}
	}

	// A "technical" response style needs the opposite of the default plain-speech
	// rules — it must be free to cite real files, functions, and code. Two cases:
	// the explicit repo-chat explainer (responseStyle === "technical", read-only),
	// and any coding-capable instance (it has attached repos). Everything else
	// keeps the concise, read-aloud voice tuned for non-technical users.
	//
	// Response style: what the agent IS (grounding context) vs what its owner ASKED for (language
	// level). Pure + tested in lib/agent-behaviour.ts — conflating the two told a plain chat agent
	// it had repos and a terminal.
	const { codingContext, styleReminder, plainSpeech } = resolveResponseStyle({
		repoChatStyle: state.guardrails?.responseStyle === "technical",
		hasCodingContext,
		behaviour,
	});
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
		" you'll do next.";
	// STYLE — the four branches now live in lib/agent-style-prompt.ts (#315), pure and derived from
	// the resolved self-model, so every tab / runner / code-index claim in them is checkable by
	// `prompt-claims.ts`. The branch is chosen on `hasCodeIndex`, never on
	// `guardrails.responseStyle === "technical"`: that string was standing in for "is Repo Chat" and
	// is not — `coder-repo` and `coder-lead` both seed it (migration 0063), so every Repo Coder was
	// landing in the Repo Chat branch and being told it was READ-ONLY with a Repo tab. That is the
	// single strongest cause of both #254's denial and #255's invented tab.
	//
	// The 2-sentence cap is a LENGTH rule that happened to live inside the plain-speech block. A
	// subscriber who asked for thorough answers has already overruled it, so honour that rather than
	// telling the model both things in the same prompt.
	systemPrompt += styleGuidance({
		model: selfModel,
		codingContext,
		hasCodingContext,
		plainSpeech,
		lengthRule: behaviour.verbosity ? fieldPrompt(behaviourField("verbosity")!, behaviour.verbosity) : "MAXIMUM 2 sentences. Shorter is better.",
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

	const aiMessages: { role: string; content: string }[] = [
		{ role: "system", content: systemPrompt },
		...messages.map((m) => ({ role: m.role, content: m.content })),
	];

	// Strongest position of all: a note ON the last user message (request-only — never
	// stored). Both the mid-prompt rule and the end-of-prompt FINAL RULE lost to
	// conversational momentum on live replays once the history contained English
	// explanations invited by English questions; adjacent-to-the-ask wins.
	if (translationCfg?.enabled && aiMessages.length > 1) {
		const last = aiMessages[aiMessages.length - 1];
		if (last.role === "user") {
			last.content += `\n\n[Platform note: answer ENTIRELY in the conversation language, even though this message may be in another language — the platform shows a ${translationCfg.target || "English"} translation beneath your reply, so the user will understand you.]`;
		}
	}

	if (!useTools) {
		const result = (await runUserWorkersAi(
			env,
			userId,
			effectiveModel,
			{ messages: aiMessages },
			{ kind: "chat", instanceId: state.agentId },
		)) as { response?: string };
		return { response: result.response || "", toolCalls: [] };
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

	const allToolLog: string[] = [];
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
	const executedCalls = new Map<string, number>();
	let mutations = 0;

	for (let round = 0; round < maxToolRounds; round++) {
		let rawResult: Record<string, unknown>;
		try {
			rawResult = (await runUserWorkersAi(
				env,
				userId,
				effectiveModel,
				{ messages: aiMessages, tools },
				{ kind: "chat", instanceId: state.agentId },
			)) as Record<string, unknown>;
		} catch (err) {
			throw withPartialToolLog(err, allToolLog);
		}

		let toolCalls = normalizeToolCalls((rawResult.tool_calls as unknown[]) || []);
		if (toolCalls.length === 0 && rawResult.response) {
			// Scoped to the allowlist: an object in the reply that merely HAS a `name` key (a
			// package.json, a lead record) is prose, not a tool call, and treating it as one
			// discarded the model's real answer. See parse-tool-calls.ts.
			toolCalls = parseToolCallsFromText(rawResult.response as string, allowedToolNames);
		}

		if (toolCalls.length === 0) {
			return { response: (rawResult.response as string) || "", toolCalls: allToolLog };
		}

		const toolResults: string[] = [];
		let executedThisRound = 0;
		for (const tc of toolCalls) {
			// Enforce the capability allow-list. A withheld tool (e.g. search_knowledge on a
			// Coder) is refused with feedback so the model answers directly instead — it is
			// never executed. Not counted as work, so a run of only-refused calls ends the loop.
			if (!allowedToolNames.has(tc.name)) {
				toolResults.push(`[${tc.name}]: This tool isn't available to this agent — do not call it; answer directly or use an available tool.`);
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
				toolResults.push(
					`[${tc.name}]: Already executed this exact call this turn — not repeating. Use the earlier result.`,
				);
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
					toolResult = await runRegistryTool(
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
				} else if (storageToolNames.has(tc.name)) {
				toolResult = await executeStorageTool(
					{ name: tc.name, input: tc.arguments },
					engine,
					{ env, agentId: state.agentId, userId, emailPermitted: state.permissions?.email === true },
				);
			} else {
				const callReq: ToolCallRequest = { name: tc.name, input: tc.arguments };
				toolResult = await executeTool(
					callReq,
					doStorage,
					env.STORAGE,
					state.agentId,
				);
			}
			const icon = toolResult.success ? "\u2705" : "\u274c";
			const shortContent = toolResult.content.slice(0, 120);
			allToolLog.push(`${icon} **${tc.name}** ${shortContent}`);
			toolResults.push(`[${tc.name}]: ${toolResult.content}`);
			broadcast({ type: "tool_call", tool: tc.name, result: toolResult });
			await engine.logEvent("tool.called", userId, { tool: tc.name, success: toolResult.success });
		}

		aiMessages.push({ role: "assistant", content: `I called tools:\n${toolResults.join("\n")}` });
		aiMessages.push({ role: "user", content: `Continue based on the tool results above. REMEMBER: ${styleReminder}` });
		// The model only re-requested calls it already made — nothing new will
		// happen in another round, so stop and let it write the final response.
		if (executedThisRound === 0) break;
	}

	// Final reminder before generating the response
	if (allToolLog.length > 0) {
		aiMessages.push({ role: "user", content: `Now give your final answer. ${styleReminder}` });
	}
	let final: { response?: string };
	try {
		final = (await runUserWorkersAi(
			env,
			userId,
			effectiveModel,
			{ messages: aiMessages },
			{ kind: "chat", instanceId: state.agentId },
		)) as { response?: string };
	} catch (err) {
		throw withPartialToolLog(err, allToolLog);
	}
	const response = final.response || "";
	return { response, toolCalls: allToolLog };
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
