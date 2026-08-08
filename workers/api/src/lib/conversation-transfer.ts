/**
 * Agent-mediated transfer (#279) — the destination an agent hands back when the PERSON asks to be
 * moved to another of their agents.
 *
 * ── Why this rides on the chat RESPONSE, and why that is the whole design
 *
 * A transfer is the first case where an agent acts on the CLIENT rather than on the world, and the
 * platform spent a commit (`2532f00`, #386) closing the accidental version of exactly that: the
 * agent's own voice reaching the control listener and issuing a client command with the user
 * silent. Re-opening that class deliberately means the design bar is "why is this channel safe
 * when the accidental one was not", and the answer cannot be "we ask the model nicely".
 *
 * So the answer is the CHANNEL, not a rule the model is trusted to follow. A destination travels
 * on the response to a chat turn the browser is already awaiting. Three properties fall out, and
 * none of them is enforced anywhere — they are what a response IS:
 *
 *   - idempotent: a response is consumed once, so there is no replay on reload, no consumed flag,
 *     no acknowledgement endpoint, and nothing sitting in the data plane;
 *   - immediate: it is the same round trip the user's sentence was already making, so the poll
 *     interval never applies;
 *   - **structurally incapable of carrying a spontaneous transfer**: there is no response to ride
 *     on unless the user just spoke. An agent mid-loop that decides you should be elsewhere has
 *     `notifyUser` + the `next` command — an OFFER, already shipped, already gated on the user
 *     saying a word.
 *
 * That last property is why no "is this user-requested?" classification exists here. A model
 * cannot reliably judge its own initiative, so the channel is chosen such that the question does
 * not arise. What the channel does NOT bound is intent WITHIN a turn — the user spoke, so a
 * response exists, and a model could still misread "what does the FWS coder think?" as "take me
 * there". Two things cover that residual and both are load-bearing rather than decorative: the
 * arrival is ANNOUNCED by name and cannot be silenced, and "go back" ships in the same change.
 *
 * ── What crosses the isolation boundary
 *
 * The `note` — and only as words SPOKEN TO THE USER on arrival. Nothing is written into the
 * destination instance: no transcript entry, no memory, no context. That is deliberate and it is
 * narrower than the design assessment asked for. Summarisation is fire-and-forget after every
 * turn (`agent-do.ts`) and extracts facts into that instance's durable memory, and deleting a
 * turn explicitly does NOT remove what was derived from it — so agent-authored text written into
 * a second instance's transcript is absorbed irreversibly on the first turn taken there. Handing
 * the note to the PERSON instead is strictly safer and strictly more correct: the note is one
 * agent's CLAIM about what the user wants, and the user is the only party able to correct it.
 *
 * Pure, no imports: this is a shape and three string transforms, and it is tested as such.
 */

/** Where the conversation is being moved to, as it travels on the chat response. */
export interface ConversationTransfer {
	/** The destination instance. Always an id resolved server-side against the supervision graph —
	 *  never a name the client resolves, which would widen the destination set to everything the
	 *  user owns rather than the subset the owner wired up. */
	instanceId: string;
	/** Its display name, so the announcement can say where you are going before you get there. */
	name: string;
	/** The handing agent's one-sentence reason, spoken on arrival. Empty is fine — a transfer with
	 *  no reason still announces the destination, which is the part that cannot be dropped. */
	note: string;
}

/**
 * How much of a note survives. It is SPOKEN, so the ceiling is a sentence a person will sit
 * through, not a field width — and a model handed an unbounded string will write a paragraph.
 */
export const MAX_TRANSFER_NOTE = 200;

/**
 * Reduce a model-authored note to one speakable line.
 *
 * Control characters and newlines go because the destination for this string is a TTS utterance
 * and an announcement banner, neither of which has a use for them; runs of whitespace collapse so
 * a note that was formatted as a list does not arrive as a stutter.
 */
export function sanitizeTransferNote(raw: unknown): string {
	if (typeof raw !== "string") return "";
	return (
		raw
			// Control characters first, then whitespace runs: `\s` already covers newlines and tabs,
			// so what this arm is for is the invisible rest (NUL, escape, the C1 block) that a model can
			// emit and that would travel intact into a spoken line and an aria-label. Matched by the
			// Unicode category rather than a codepoint range — the range spelling is the shape biome
			// rejects, and `\p{Cc}` says what is meant besides.
			.replace(/\p{Cc}+/gu, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, MAX_TRANSFER_NOTE)
	);
}

/** Build the destination from a resolved subordinate row plus whatever the model wrote. */
export function buildTransfer(row: { instanceId: string; name: string }, note: unknown): ConversationTransfer {
	return { instanceId: row.instanceId, name: row.name, note: sanitizeTransferNote(note) };
}

/**
 * What the tool returns to the MODEL — which is also what lands in the turn's tool log, and
 * therefore the human-readable audit line in the transcript of the agent being left.
 *
 * It is narration, never a directive: nothing reads this string back and acts on it. Clearing the
 * chat therefore loses the record that a transfer happened and not the ability to perform one,
 * which is the property a typed directive-message in the transcript could not have.
 *
 * The wording tells the model the move has ALREADY happened, because it has: by the time this
 * result is read, the destination is on its way out with the response. A model that thinks it
 * still has to do something will keep talking to a user who is no longer there.
 */
export function describeTransfer(t: ConversationTransfer): string {
	return (
		`Handing the conversation to ${t.name} (${t.instanceId}) now${t.note ? `: ${t.note}` : ""}. ` +
		"The user is being moved and will hear where they have gone. Say nothing further — they are no longer reading this conversation."
	);
}

/**
 * Pick the destination out of a turn's executed tool results.
 *
 * The LAST one wins, for the same reason the last write to a key wins: if a model called the tool
 * twice in one turn it has changed its mind, and the browser can only go to one place. No tool
 * call means no transfer — which is the assertion that keeps the response channel honest, since
 * every other way a chat response can be produced (an error, a loop step, a turn with no tools)
 * goes through here and gets `null`.
 */
export function transferFromToolResults(results: readonly { success: boolean; transfer?: ConversationTransfer }[]): ConversationTransfer | null {
	let found: ConversationTransfer | null = null;
	// A FAILED call carries nothing: a refusal ("you do not supervise that agent") must not move
	// anybody, and reading the field without checking success is how that would happen quietly.
	for (const r of results) if (r.success && r.transfer) found = r.transfer;
	return found;
}
