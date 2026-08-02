/**
 * Conversation summarization — periodic rollup of message history into a
 * summary + extracted facts (persisted to memory) + a message vector.
 */
import type { ActivityEvent, ConversationSummary, ExtractedFact, VectorMeta } from "../agent-storage-types.js";
import type { AgentMessage, MemoryEntry } from "../agent-types.js";
import { approxTokens } from "../lib/ai-pricing.js";
import { recordPlatformUsage } from "../lib/usage.js";
import { type AgentStorageBaseCtor, SUMMARY_CF_MODEL, SUMMARY_THRESHOLD } from "./base.js";

/** Sibling methods this group relies on (provided by earlier layers). */
interface SummaryDeps {
	logEvent(type: ActivityEvent["type"], userId?: string, data?: Record<string, unknown>, channel?: string): Promise<ActivityEvent>;
	vectorizeStore(sourceType: VectorMeta["sourceType"], sourceId: string, text: string): Promise<string[]>;
}

// biome-ignore lint/suspicious/noExplicitAny: mixin constructor helper
type GConstructorWith<T> = new (...args: any[]) => T;

export function withSummaries<TBase extends AgentStorageBaseCtor & GConstructorWith<SummaryDeps>>(Base: TBase) {
	return class extends Base {
		// ── Conversation Summarization ────────────────────────────────────────────

		/**
		 * Check if conversation needs summarization and generate if so.
		 * Returns the summary if generated, null otherwise.
		 */
		async maybeSummarize(model: string): Promise<ConversationSummary | null> {
			if (!this.ai) return null;

			// Count messages since last summary
			const summaries = await this.doStorage.list<ConversationSummary>({
				prefix: "sum:",
				reverse: true,
				limit: 1,
			});
			const lastSummary = [...summaries.values()][0];
			// Resume STRICTLY after the last summarized message. Prefer its full key; fall
			// back to the timestamp boundary for legacy summaries without boundaryKey (that
			// path re-includes one boundary message, but only once, at the transition).
			const startAfter = lastSummary?.boundaryKey ?? `msg:${lastSummary?.messageRange.to || "0"}`;

			// Get messages since last summary
			const messages = await this.doStorage.list<AgentMessage>({
				prefix: "msg:",
				startAfter,
			});

			if (messages.size < SUMMARY_THRESHOLD) return null;

			const boundaryKey = [...messages.keys()].pop();
			return this.generateSummary([...messages.values()], model, boundaryKey);
		}

		/**
		 * Force generate a summary for given messages.
		 */
		async generateSummary(
			messages: AgentMessage[],
			model: string,
			boundaryKey?: string,
		): Promise<ConversationSummary | null> {
			if (!this.ai || messages.length === 0) return null;

			const transcript = messages
				.map((m) => `[${m.role}]: ${m.content}`)
				.join("\n")
				.slice(0, 8_000);

			const summaryModel = model.startsWith("@cf/") ? model : SUMMARY_CF_MODEL;
			try {
				const result = (await this.ai.run(summaryModel as Parameters<Ai["run"]>[0], {
					messages: [
						{
							role: "system",
							content: `Summarize this conversation segment. Output JSON:
{
  "summary": "2-3 sentence summary of what was discussed and decided",
  "facts": [{"subject":"...", "predicate":"...", "object":"...", "confidence": 0.9}]
}
Extract key facts about the user, their preferences, decisions made, and information shared. Only include facts with high confidence.`,
						},
						{ role: "user", content: transcript },
					],
				})) as { response?: string };

				const text = result.response || "";
				// Platform-paid: ledger the summary LLM call (issue #44). Tokens estimated
				// from transcript in / response out (Workers AI returns no usage here).
				if (this.meter?.userId) {
					await recordPlatformUsage(
						{ DB: this.meter.db },
						{ userId: this.meter.userId, agentId: this.meter.agentId, instanceId: this.meter.instanceId, model, kind: "summary" },
						{ input: approxTokens(transcript.length), output: approxTokens(text.length) },
					);
				}
				const jsonMatch = text.match(/\{[\s\S]*\}/);
				if (!jsonMatch) return null;

				const parsed = JSON.parse(jsonMatch[0]) as {
					summary: string;
					facts: ExtractedFact[];
				};

				const sessionId = crypto.randomUUID();
				const summary: ConversationSummary = {
					id: sessionId,
					sessionId,
					messageRange: {
						from: messages[0].createdAt,
						to: messages[messages.length - 1].createdAt,
						count: messages.length,
					},
					boundaryKey,
					summary: parsed.summary || "",
					facts: Array.isArray(parsed.facts) ? parsed.facts.slice(0, 20) : [],
					createdAt: new Date().toISOString(),
				};

				await this.doStorage.put(`sum:${sessionId}`, summary);

				// Store extracted facts as memory entries. Never clobber a user-authored entry —
				// the console Memory tab allows arbitrary keys (a user could set one literally named
				// `fact:subject:predicate`), and unlike the guarded write_memory tool this path writes
				// `mem:` directly, so it must re-check provenance itself.
				for (const fact of summary.facts) {
					if (fact.confidence >= 0.8) {
						const key = `fact:${fact.subject}:${fact.predicate}`.slice(0, 100);
						const existing = await this.doStorage.get<MemoryEntry>(`mem:${key}`);
						if (existing?.source === "user") continue;
						const entry: MemoryEntry = {
							key,
							type: "knowledge",
							content: `${fact.subject} ${fact.predicate} ${fact.object}`,
							updatedAt: new Date().toISOString(),
							source: "summary",
						};
						await this.doStorage.put(`mem:${key}`, entry);
					}
				}

				// Vectorize the summary for future retrieval (best-effort — a failure here must
				// not abort summarization; the summary itself is already persisted).
				try {
					await this.vectorizeStore("message", sessionId, summary.summary);
				} catch (err) {
					console.error(`[storage] summary ${sessionId} stored but not vectorized:`, err);
				}

				await this.logEvent("summary.generated", undefined, {
					sessionId,
					messageCount: messages.length,
					factsExtracted: summary.facts.length,
				});

				return summary;
			} catch {
				return null;
			}
		}

		/**
		 * Get all conversation summaries.
		 */
		async getSummaries(limit = 20): Promise<ConversationSummary[]> {
			const all = await this.doStorage.list<ConversationSummary>({
				prefix: "sum:",
				reverse: true,
				limit,
			});
			return [...all.values()];
		}
	};
}
