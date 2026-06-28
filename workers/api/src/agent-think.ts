import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { AgentStorageEngine } from "./agent-storage.js";
import type { AgentMessage, AgentState, AgentTask, MemoryEntry } from "./agent-types.js";
import { TOOL_CAPABLE_MODELS } from "./agent-do-prompt.js";
import { buildAgentToolDefinitions, storageToolNameSet } from "./agent-do-tools.js";
import { executeStorageTool } from "./lib/storage-tools.js";
import { executeTool, type ToolCallRequest, type ToolCallResult } from "./lib/tools.js";
import { normalizeToolCalls, parseToolCallsFromText } from "./lib/parse-tool-calls.js";
import { runUserWorkersAi } from "./lib/user-ai.js";
import { listRepos, listSessions } from "./lib/coding-store.js";
import type { Env } from "./types.js";

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
}): Promise<{ response: string; toolCalls: string[] }> {
	const { state, engine, messages, memory, tasks, userId, env, doStorage, broadcast } = opts;
	const lastUserMessage = messages.filter((m) => m.role === "user").pop()?.content || "";

	let systemPrompt = state.systemPrompt;

	const ragContext = await engine.buildRAGContext(lastUserMessage);
	if (ragContext) systemPrompt += `\n\n${ragContext}`;

	if (memory.length > 0) {
		systemPrompt += "\n\n## Your Memory\n";
		for (const m of memory) {
			systemPrompt += `- [${m.type}] ${m.key}: ${m.content}\n`;
		}
	}

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

	// Coding repos & sessions context (Coder instances)
	if (userId && state.agentId) {
		try {
			const repos = await listRepos(env, state.agentId, userId);
			if (repos.length > 0) {
				systemPrompt += "\n\n## Attached Repositories\n";
				for (const r of repos) {
					systemPrompt += `- ${r.name}${r.githubRepo ? ` (${r.githubRepo})` : ""}\n`;
				}
				const sessions = await listSessions(env, state.agentId, userId);
				const active = sessions.filter((s) => s.status === "active");
				if (active.length > 0) {
					systemPrompt += "\n## Active Coding Sessions\n";
					for (const s of active) {
						const repo = repos.find((r) => r.id === s.repoId);
						systemPrompt += `- ${repo?.name || s.repoId} — engine: ${s.launchCommand || s.clientType || "claude"}\n`;
					}
				}
			}
		} catch {}
	}

	const useTools = TOOL_CAPABLE_MODELS.has(state.model);
	if (useTools) {
		systemPrompt +=
			"\n\nYou have tools available. Use them to manage your memory, tasks, files, collections (structured data), and search your knowledge.";
	}

	systemPrompt += "\n\nIMPORTANT: Never output step-by-step thinking. Never say 'Step 1' or 'Step 2'. Just execute and report the result concisely." +
		"\n\nSTYLE: Talk to a NON-TECHNICAL user by default. Say WHAT you did and WHETHER it worked — never list filenames, code, or commands unless the user explicitly asks for details. Keep answers to 1-3 sentences.";

	const aiMessages: { role: string; content: string }[] = [
		{ role: "system", content: systemPrompt },
		...messages.map((m) => ({ role: m.role, content: m.content })),
	];

	if (!useTools) {
		const result = (await runUserWorkersAi(
			env,
			userId,
			state.model,
			{ messages: aiMessages },
		)) as { response?: string };
		return { response: result.response || "", toolCalls: [] };
	}

	const tools = buildAgentToolDefinitions({
		emailEnabled: state.permissions?.email === true,
	});
	const allToolLog: string[] = [];
	const storageToolNames = storageToolNameSet();
	// Multi-step tasks (e.g. read goal + list files + fetch job page, THEN
	// submit the application) need headroom; 3 rounds ran out before acting.
	const maxToolRounds = 8;
	// Guard against the model re-issuing the same tool call across rounds, which
	// otherwise creates duplicate side effects (e.g. three identical job tasks).
	const executedCalls = new Set<string>();

	for (let round = 0; round < maxToolRounds; round++) {
		const rawResult = (await runUserWorkersAi(
			env,
			userId,
			state.model,
			{ messages: aiMessages, tools },
		)) as Record<string, unknown>;

		let toolCalls = normalizeToolCalls((rawResult.tool_calls as unknown[]) || []);
		if (toolCalls.length === 0 && rawResult.response) {
			toolCalls = parseToolCallsFromText(rawResult.response as string);
		}

		if (toolCalls.length === 0) {
			return { response: (rawResult.response as string) || "", toolCalls: allToolLog };
		}

		const toolResults: string[] = [];
		let executedThisRound = 0;
		for (const tc of toolCalls) {
			const signature = `${tc.name}:${JSON.stringify(tc.arguments ?? {})}`;
			if (executedCalls.has(signature)) {
				toolResults.push(
					`[${tc.name}]: Already executed this exact call this turn — not repeating. Use the earlier result.`,
				);
				continue;
			}
			executedCalls.add(signature);
			executedThisRound++;
			let toolResult: ToolCallResult;
			if (storageToolNames.has(tc.name)) {
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
		aiMessages.push({ role: "user", content: "Continue based on the tool results above." });
		// The model only re-requested calls it already made — nothing new will
		// happen in another round, so stop and let it write the final response.
		if (executedThisRound === 0) break;
	}

	const final = (await runUserWorkersAi(
		env,
		userId,
		state.model,
		{ messages: aiMessages },
	)) as { response?: string };
	const response = final.response || "";
	return { response, toolCalls: allToolLog };
}
