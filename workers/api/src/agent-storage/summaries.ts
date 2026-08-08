/**
 * Conversation summarization — periodic rollup of message history into a
 * summary + extracted facts (persisted to memory) + a message vector.
 */
import type { ActivityEvent, ConversationSummary, ExtractedFact, VectorMeta } from "../agent-storage-types.js";
import type { AgentMessage, MemoryEntry } from "../agent-types.js";
import { approxTokens } from "../lib/ai-pricing.js";
import { redactFabricatedHistory } from "../lib/fabricated-history.js";
import { recordPlatformUsage } from "../lib/usage.js";
import { type AgentStorageBaseCtor, SUMMARY_CF_MODEL, SUMMARY_THRESHOLD } from "./base.js";

/** Sibling methods this group relies on (provided by earlier layers). */
interface SummaryDeps {
	logEvent(type: ActivityEvent["type"], userId?: string, data?: Record<string, unknown>, channel?: string): Promise<ActivityEvent>;
	vectorizeStore(sourceType: VectorMeta["sourceType"], sourceId: string, text: string): Promise<string[]>;
}

// biome-ignore lint/suspicious/noExplicitAny: mixin constructor helper
type GConstructorWith<T> = new (...args: any[]) => T;

/** The most recently CREATED summary in a listing, or undefined. Key order is not creation
 *  order for the legacy `sum:{uuid}` rows, and those still exist in live instances. */
function latestByCreatedAt(entries: Map<string, ConversationSummary>): ConversationSummary | undefined {
	let best: ConversationSummary | undefined;
	for (const v of entries.values()) {
		if (!v) continue;
		if (!best || String(v.createdAt ?? "") > String(best.createdAt ?? "")) best = v;
	}
	return best;
}

export function withSummaries<TBase extends AgentStorageBaseCtor & GConstructorWith<SummaryDeps>>(Base: TBase) {
	return class extends Base {
		// ── Conversation Summarization ────────────────────────────────────────────

		/**
		 * Check if conversation needs summarization and generate if so.
		 * Returns the summary if generated, null otherwise.
		 */
		async maybeSummarize(model: string): Promise<ConversationSummary | null> {
			if (!this.ai) return null;

			// Count messages since last summary.
			//
			// Picked by createdAt, NOT by key order. Summaries were keyed `sum:{randomUUID}`, and
			// DO `list` orders lexicographically — so `reverse:true limit:1` returned the summary
			// with the highest UUID, which is the newest only by luck. The resume point therefore
			// jumped backwards at random: at message 60 it could return S1 (boundary = msg 20), so
			// a 40-message window (≥ the 20 threshold) generated ANOTHER summary fully overlapping
			// S2 — and the max-UUID key never advances, so every 20 further messages produced an
			// ever-larger overlapping summary, re-extracted the same `fact:*` memories, and spent
			// platform AI on all of it, forever.
			// BOUNDED. This runs after every assistant reply, so an unbounded list deserialized
			// every summary the instance has ever made, on the hot chat path inside the DO. The
			// new time-ordered key makes a reverse window correct for new rows, and the legacy
			// `sum:{uuid}` keys sort below `sum:2…` so they lose to any new row anyway.
			const lastSummary = latestByCreatedAt(
				await this.doStorage.list<ConversationSummary>({ prefix: "sum:", reverse: true, limit: 32 }),
			);
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

			// Redacted first (#406). This is the reader where a stored fabrication does the most
			// damage and it is the least obvious one: the chat window ages an invented turn out after
			// ten messages, whereas a summary distils it into `fact:*` memory entries that are
			// injected into EVERY future prompt and outlive the conversation that produced them. A
			// fabrication that reaches this function stops being a message and becomes a belief.
			const transcript = redactFabricatedHistory(messages)
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

				// TIME-ORDERED key, like `msg:`/`evt:` — so a plain reverse list is correct too, and
				// the reader above degrades gracefully across the legacy `sum:{uuid}` rows.
				await this.doStorage.put(`sum:${summary.createdAt}:${sessionId}`, summary);

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
			// Sorted by createdAt for the same reason as above: a lexicographic reverse list over
			// `sum:{uuid}` keys handed `buildRAGContext` an ARBITRARY 5 summaries and labelled them
			// with dates, presenting a random subset to the model as the recent history.
			const all = await this.doStorage.list<ConversationSummary>({ prefix: "sum:", reverse: true, limit: Math.max(limit, 32) });
			return [...all.values()]
				.sort((a, b) => String(b?.createdAt ?? "").localeCompare(String(a?.createdAt ?? "")))
				.slice(0, limit);
		}
	};
}
