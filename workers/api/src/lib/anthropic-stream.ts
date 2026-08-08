/**
 * Reassembling a streamed Anthropic reply into the body the non-streaming endpoint would have
 * returned (#427).
 *
 * ── Why the seam is here
 *
 * #427's regression note asks for streaming BEHIND `runAnthropic`'s existing signature: collect the
 * stream server-side, keep handing callers one whole message, and let only the timeout semantics
 * change. Chat, loop-decide, the co-pilot, the overseer and both workflows then need no edit at all.
 * That works precisely because this module's output is byte-for-byte the shape `runAnthropic`
 * already reads — `{ content, usage, stop_reason }` — so the sixty lines below it (tool_use
 * extraction, the usage ledger, `stopReason`) are untouched.
 *
 * The parsing is pure and lives here rather than inline in `user-ai.ts` for the ordinary reason: a
 * frame parser and a state machine are exactly the code that deserves tests and exactly the code
 * that is untestable once it is welded to a `fetch`.
 *
 * ── What it refuses to do
 *
 * Return a partial message. A stream that ends without `message_stop` produced SOME text, and
 * handing that back would recreate #397 with a new cause: a reply cut off mid-sentence, stored and
 * displayed as though it were the whole answer. The platform knows it is incomplete, so it says so
 * and fails the turn instead. Same reasoning for a `tool_use` whose accumulated arguments do not
 * parse — a half-built call is worse than no call, because the loop would act on it.
 */

/** A stream that did not deliver a well-formed message. Distinct so the caller can label it. */
export class AnthropicStreamError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnthropicStreamError";
	}
}

export interface AnthropicContentBlock {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
	[key: string]: unknown;
}

/** Exactly what `POST /v1/messages` returns without `stream: true`, for the fields we read. */
export interface AnthropicMessageBody {
	content: AnthropicContentBlock[];
	usage: Record<string, number>;
	stop_reason?: string;
}

/**
 * Pull whole SSE frames out of a growing buffer, returning the leftover partial frame.
 *
 * A chunk boundary lands wherever TCP puts it — routinely mid-frame, and (on a long `input_json`
 * delta) mid-JSON — so the remainder has to be carried forward rather than parsed and dropped. Only
 * `data:` lines matter: the `event:` line duplicates the `type` inside the JSON, and `:` comment
 * lines are keep-alives.
 */
export function parseSseEvents(buffer: string): { events: Record<string, unknown>[]; rest: string } {
	const normalized = buffer.replace(/\r\n/g, "\n");
	const parts = normalized.split("\n\n");
	// The last element is either an incomplete frame or "" after a trailing separator. Either way it
	// is not yet ours to parse.
	const rest = parts.pop() ?? "";
	const events: Record<string, unknown>[] = [];
	for (const frame of parts) {
		const data = frame
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") continue;
		try {
			const parsed = JSON.parse(data) as unknown;
			if (parsed && typeof parsed === "object") events.push(parsed as Record<string, unknown>);
		} catch {
			throw new AnthropicStreamError("the provider sent a frame that is not JSON");
		}
	}
	return { events, rest };
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Folds the event sequence into one message.
 *
 * Incremental rather than a fold over a collected array because the reader needs two facts WHILE it
 * reads: whether anything has arrived (the first-token deadline stops applying) and whether the
 * message has ended (stop reading rather than wait for the socket to close).
 */
export class AnthropicStreamAssembler {
	private readonly blocks = new Map<number, AnthropicContentBlock>();
	/** Accumulated `input_json_delta` text per block index; a tool's arguments arrive as fragments. */
	private readonly partialJson = new Map<number, string>();
	private readonly usageAcc: Record<string, number> = {};
	private stopReason: string | undefined;
	/** `message_stop` seen — the ONLY evidence that the reply is whole. */
	private complete = false;

	get done(): boolean {
		return this.complete;
	}

	push(event: Record<string, unknown>): void {
		const type = typeof event.type === "string" ? event.type : "";
		switch (type) {
			case "error": {
				const err = event.error as { message?: string; type?: string } | undefined;
				throw new AnthropicStreamError(err?.message || err?.type || "the provider reported an error mid-stream");
			}
			case "message_start": {
				const message = event.message as { usage?: Record<string, unknown> } | undefined;
				this.mergeUsage(message?.usage);
				break;
			}
			case "content_block_start": {
				const index = num(event.index);
				const block = event.content_block as AnthropicContentBlock | undefined;
				if (index === undefined || !block || typeof block !== "object") break;
				const started: AnthropicContentBlock = { ...block };
				if (started.type === "text" && typeof started.text !== "string") started.text = "";
				if (started.type === "tool_use") this.partialJson.set(index, "");
				this.blocks.set(index, started);
				break;
			}
			case "content_block_delta": {
				const index = num(event.index);
				const delta = event.delta as { type?: string; text?: string; partial_json?: string } | undefined;
				if (index === undefined || !delta) break;
				const block = this.blocks.get(index);
				if (!block) {
					// A delta with no opening block means frames were lost or reordered. Ignoring it would
					// silently drop model output, which is the one outcome this module exists to prevent.
					throw new AnthropicStreamError(`a content delta arrived for block ${index}, which never started`);
				}
				if (delta.type === "text_delta" && typeof delta.text === "string") {
					block.text = `${block.text ?? ""}${delta.text}`;
				} else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
					this.partialJson.set(index, `${this.partialJson.get(index) ?? ""}${delta.partial_json}`);
				}
				// `thinking_delta` / `signature_delta` are deliberately dropped: the platform never asks
				// for extended thinking, and a block type we did not request is not a block we can render.
				break;
			}
			case "content_block_stop": {
				const index = num(event.index);
				if (index === undefined) break;
				const block = this.blocks.get(index);
				if (block?.type === "tool_use") {
					const raw = (this.partialJson.get(index) ?? "").trim();
					if (!raw) {
						block.input = {};
					} else {
						try {
							block.input = JSON.parse(raw);
						} catch {
							throw new AnthropicStreamError(
								`the arguments for tool \`${block.name ?? "?"}\` arrived incomplete and could not be read`,
							);
						}
					}
				}
				break;
			}
			case "message_delta": {
				const delta = event.delta as { stop_reason?: unknown } | undefined;
				if (typeof delta?.stop_reason === "string") this.stopReason = delta.stop_reason;
				// Output tokens are reported here, cumulative and final; input/cache counts came with
				// `message_start`. Merged rather than replaced so neither half is lost (#212 keeps cache
				// reads and writes SEPARATE from input, and the ledger downstream still expects all four).
				this.mergeUsage(event.usage as Record<string, unknown> | undefined);
				break;
			}
			case "message_stop":
				this.complete = true;
				break;
			default:
				break;
		}
	}

	private mergeUsage(usage: Record<string, unknown> | undefined): void {
		if (!usage || typeof usage !== "object") return;
		for (const [key, value] of Object.entries(usage)) {
			const n = num(value);
			if (n !== undefined) this.usageAcc[key] = n;
		}
	}

	/**
	 * The whole message, or an error explaining why there isn't one.
	 *
	 * Blocks come back in index order — the provider emits them in order, but the map makes that a
	 * guarantee rather than an assumption, and `content[0]` being the text block is load-bearing for
	 * every caller that reads `textParts`.
	 */
	finish(): AnthropicMessageBody {
		if (!this.complete) {
			throw new AnthropicStreamError("the reply ended mid-stream, so it is not the whole answer");
		}
		const content = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
		return { content, usage: this.usageAcc, ...(this.stopReason ? { stop_reason: this.stopReason } : {}) };
	}
}

/** Fold a complete event sequence in one call. Used by tests and by nothing else. */
export function assembleAnthropicStream(events: Record<string, unknown>[]): AnthropicMessageBody {
	const assembler = new AnthropicStreamAssembler();
	for (const event of events) assembler.push(event);
	return assembler.finish();
}
