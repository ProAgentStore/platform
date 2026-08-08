/**
 * One chat turn at a time, per agent — and the messages that arrive during one are answered
 * TOGETHER by the next (#429).
 *
 * ── The defect this exists to make impossible
 *
 * Nothing serialised a turn. `handleChat` awaited `think()` and returned inline; the DO's input
 * gate opens at every non-storage await (the model call is the long one), so a second message
 * arriving mid-turn started a SECOND turn against the same DO. Both were then true about different
 * instants and false about each other. Observed live on 2026-08-08:
 *
 *     06:11:14.671  assistant  "Still running — it's at step 1/40 … actively working"
 *     06:11:16.483  assistant  "The run is still at step 0/40 — initialising, no output yet"
 *
 * Progress ran BACKWARDS on screen, 1.8 seconds apart, because turn B started earlier than turn A
 * finished and sampled the run before step 1 was recorded. Worse, each turn built its context from
 * history at its own start, so turn B could not see turn A's not-yet-written reply: in the Language
 * Buddy transcript both turns answered the FIRST message and the second was never replied to at
 * all. That is not an edge case in hands-free voice — the mic reopens while the reply is still
 * being written, so speaking again before it lands is the interface working as designed.
 *
 * `lib/chat-inflight.ts` is NOT this. Its marker records that a turn STARTED so an interrupted one
 * can be named (#251); its own comment says concurrent turns "can't clobber", i.e. concurrency was
 * accommodated, not prevented.
 *
 * ── Why COALESCE rather than queue-one-turn-per-message
 *
 * Queueing a turn per message answers each in isolation and still spends two full BYOK turns on one
 * exchange. Coalescing is what a human interlocutor does: everything said while you were talking is
 * answered in one breath. It works here because the DO appends every user message to the transcript
 * the moment it arrives, and `think()` builds its context from that transcript — so a single
 * follow-up turn, started after the running one finishes, sees BOTH messages as the most recent
 * things the user said and answers them together. Nothing is dropped and nothing is answered twice.
 *
 * The cut-off is explicit: a message that arrives after the running turn has begun generating
 * cannot join THAT turn, so it joins the next one. That is the boundary #429 asked to have decided
 * rather than discovered.
 *
 * ── What it is not
 *
 * It is not a lock over storage, so it cannot deadlock a write. It holds no `await` of its own: a
 * turn either runs or is queued, `drain()` is called from the running turn's `finally`, and a turn
 * that throws drains exactly like one that succeeds. It is per-DO-instance in-memory state, like
 * `summarizing` and `liveTurns` beside it — if the object restarts, the gate opens, which is the
 * safe direction (a lost gate costs one concurrent turn; a stuck gate would cost every turn).
 *
 * Pure and unit-tested here; the DO owns the messages and the turn itself.
 */

interface Waiter<T> {
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
}

const noop = (): void => undefined;

export class ChatTurnGate<T> {
	/** The turn running right now, or null. Set BEFORE the runner is invoked. */
	private active: Promise<unknown> | null = null;

	/** Callers whose message arrived mid-turn. They all get the ONE follow-up turn's answer. */
	private waiting: Array<Waiter<T>> = [];

	/** The follow-up turn to run when the active one finishes. The latest arrival's, deliberately:
	 *  it carries the freshest caller context, and the transcript — not this closure — is what the
	 *  turn actually reads, so every queued message is answered regardless of whose runner runs. */
	private queuedRun: (() => Promise<T>) | null = null;

	/**
	 * @param fork Called for every waiter after the first, because a `Response` body can be read
	 *   once. Without it two coalesced callers would share one object and the second would return a
	 *   used body. Omitted (tests, plain values) means the value is shared as-is.
	 */
	constructor(private readonly fork: (value: T) => T = (v) => v) {}

	/** Is a turn running right now? */
	get busy(): boolean {
		return this.active !== null;
	}

	/** How many arrivals are folded into the pending follow-up turn. */
	get queued(): number {
		return this.waiting.length;
	}

	/**
	 * Run `run` as this agent's next turn.
	 *
	 * Free gate → it runs now. Busy gate → this arrival joins the follow-up turn, and the promise
	 * returned resolves with THAT turn's result. The caller is never told "try later": from its
	 * point of view it asked a question and got an answer, which is the whole point.
	 */
	submit(run: () => Promise<T>): Promise<T> {
		if (this.active === null) return this.start(run);
		this.queuedRun = run;
		return new Promise<T>((resolve, reject) => {
			this.waiting.push({ resolve, reject });
		});
	}

	/** Begin a turn, marking the gate busy BEFORE the runner can do anything. */
	private start(run: () => Promise<T>): Promise<T> {
		let settle: (value: T) => void = noop;
		let fail: (err: unknown) => void = noop;
		const result = new Promise<T>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		// Assigned first, and to a promise that can never reject: `active` is a busy FLAG, and an
		// unhandled rejection here would be a rejection nobody asked for. The caller's copy of
		// `result` carries the real outcome.
		this.active = result.then(noop, noop);
		this.launch(run, settle, fail);
		return result;
	}

	/** The turn's lifecycle. Never rethrows — the caller's promise carries the failure. */
	private async launch(run: () => Promise<T>, settle: (v: T) => void, fail: (e: unknown) => void): Promise<void> {
		try {
			settle(await run());
		} catch (err) {
			fail(err);
		} finally {
			// Order matters: clear the flag, THEN drain, so the follow-up turn's own `start` sees a
			// free gate. A failed turn drains identically — a queued message must not be stranded by
			// someone else's error.
			this.active = null;
			this.drain();
		}
	}

	/** Start the ONE follow-up turn covering everything that arrived while the last one ran. */
	private drain(): void {
		if (this.active !== null) return;
		const waiters = this.waiting;
		const run = this.queuedRun;
		this.waiting = [];
		this.queuedRun = null;
		if (waiters.length === 0 || run === null) return;
		this.start(run).then(
			(value) => {
				// The first waiter gets the value; the rest get forks, because a Response body is
				// single-use and two callers reading the same one is a runtime error, not a subtlety.
				waiters.forEach((w, i) => {
					w.resolve(i === 0 ? value : this.fork(value));
				});
			},
			(err) => {
				for (const w of waiters) w.reject(err);
			},
		);
	}
}
