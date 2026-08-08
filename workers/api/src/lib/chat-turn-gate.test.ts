import { describe, expect, it } from "vitest";
import { ChatTurnGate } from "./chat-turn-gate.js";

/** A deferred, so a test can hold a turn open exactly as a model call does. */
function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * A transcript + a gate, wired the way the DO wires them: every arrival appends its user message
 * immediately, and a turn answers everything said since the last reply. That is what makes
 * coalescing correct rather than lossy, so the tests assert it rather than mock around it.
 */
function harness() {
	const transcript: string[] = [];
	const overlaps: string[] = [];
	let running = 0;
	const replies: Array<{ answered: string[] }> = [];
	const gate = new ChatTurnGate<{ answered: string[] }>();
	let pending: ReturnType<typeof deferred<void>> | null = null;

	function say(message: string): Promise<{ answered: string[] }> {
		transcript.push(message);
		return gate.submit(async () => {
			running += 1;
			if (running > 1) overlaps.push(message);
			// Context is built when the turn STARTS, exactly as `think()` calls `getRecentMessages()`
			// on entry. That is why a second turn could not see the first one's not-yet-written
			// reply — and why serialising, not just ordering the replies, is the fix.
			const seen = [...transcript];
			const hold = deferred<void>();
			pending = hold;
			try {
				await hold.promise;
				const alreadyAnswered = replies.flatMap((r) => r.answered);
				const reply = { answered: seen.filter((m) => !alreadyAnswered.includes(m)) };
				replies.push(reply);
				return reply;
			} finally {
				running -= 1;
			}
		});
	}

	/** Let the currently-running turn finish. */
	async function finishTurn() {
		// One microtask so a just-drained follow-up turn has reached its `await`.
		await Promise.resolve();
		if (!pending) throw new Error("no turn is running");
		const p = pending;
		pending = null;
		p.resolve();
		await Promise.resolve();
		await Promise.resolve();
	}

	return { gate, say, finishTurn, replies, overlaps, transcript };
}

describe("ChatTurnGate — two turns never overlap (#429)", () => {
	it("a second message mid-turn does not start a second turn", async () => {
		const h = harness();
		const a = h.say("retry now");
		expect(h.gate.busy).toBe(true);
		const b = h.say("https://www.youtube.com");
		// THE invariant. Before this gate both ran, sampled the same run 1.8s apart, and reported
		// step 1/40 then step 0/40 — progress running backwards on screen.
		expect(h.gate.queued).toBe(1);

		await h.finishTurn();
		await expect(a).resolves.toEqual({ answered: ["retry now"] });
		await h.finishTurn();
		await b;
		expect(h.overlaps).toEqual([]);
	});

	it("the follow-up turn answers the message that started it — nothing goes unanswered", async () => {
		const h = harness();
		const a = h.say("我现在想不Fairview Park往前走。");
		const b = h.say("你好！今天我们练习什么？");
		await h.finishTurn();
		await h.finishTurn();

		expect(await a).toEqual({ answered: ["我现在想不Fairview Park往前走。"] });
		// The live failure: this message got NO reply, while the first got two.
		expect(await b).toEqual({ answered: ["你好！今天我们练习什么？"] });
		expect(h.replies).toHaveLength(2);
	});

	it("no message is answered twice", async () => {
		const h = harness();
		const a = h.say("one");
		const b = h.say("two");
		await h.finishTurn();
		await h.finishTurn();
		await Promise.all([a, b]);
		const answered = h.replies.flatMap((r) => r.answered);
		expect(answered).toEqual(["one", "two"]);
		expect(new Set(answered).size).toBe(answered.length);
	});
});

describe("ChatTurnGate — arrivals during one turn COALESCE into one follow-up (#429)", () => {
	it("three messages sent mid-turn are answered by a SINGLE turn, together", async () => {
		const h = harness();
		const a = h.say("first");
		const b = h.say("second");
		const c = h.say("third");
		const d = h.say("fourth");
		expect(h.gate.queued).toBe(3);

		await h.finishTurn(); // the first turn
		await h.finishTurn(); // the ONE follow-up
		await Promise.all([a, b, c, d]);

		// Two turns for four messages — not four. That is the cost saving #429 names (two full BYOK
		// turns and five tool calls were spent producing one answer the user wanted).
		expect(h.replies).toHaveLength(2);
		expect(h.replies[0].answered).toEqual(["first"]);
		expect(h.replies[1].answered).toEqual(["second", "third", "fourth"]);
	});

	it("every coalesced caller gets the same answer", async () => {
		const h = harness();
		const a = h.say("a");
		const b = h.say("b");
		const c = h.say("c");
		await h.finishTurn();
		await h.finishTurn();
		expect(await a).toEqual({ answered: ["a"] });
		expect(await b).toEqual({ answered: ["b", "c"] });
		expect(await c).toEqual({ answered: ["b", "c"] });
	});

	it("`fork` is applied to every caller after the first — a Response body is single-use", async () => {
		const forked: string[] = [];
		const gate = new ChatTurnGate<string>((v) => {
			forked.push(v);
			return `${v}#copy`;
		});
		const hold = deferred<string>();
		const first = gate.submit(() => hold.promise);
		const b = gate.submit(async () => "reply");
		const c = gate.submit(async () => "reply");
		hold.resolve("first reply");
		await first;
		expect(await b).toBe("reply");
		expect(await c).toBe("reply#copy");
		expect(forked).toEqual(["reply"]);
	});
});

describe("ChatTurnGate — it opens again whatever happens (#429)", () => {
	it("a turn that throws still drains the queue", async () => {
		const gate = new ChatTurnGate<string>();
		const hold = deferred<string>();
		const failing = gate.submit(() => hold.promise);
		const queued = gate.submit(async () => "the follow-up ran anyway");
		hold.reject(new Error("model exploded"));
		await expect(failing).rejects.toThrow("model exploded");
		expect(await queued).toBe("the follow-up ran anyway");
		expect(gate.busy).toBe(false);
	});

	it("a follow-up that throws rejects every coalesced caller, and leaves the gate open", async () => {
		const gate = new ChatTurnGate<string>();
		const hold = deferred<string>();
		const first = gate.submit(() => hold.promise);
		const b = gate.submit(async () => {
			throw new Error("no API key");
		});
		const c = gate.submit(async () => {
			throw new Error("no API key");
		});
		hold.resolve("ok");
		await first;
		await expect(b).rejects.toThrow("no API key");
		await expect(c).rejects.toThrow("no API key");
		expect(gate.busy).toBe(false);
		// And the very next message runs immediately rather than being wedged behind the failure.
		expect(await gate.submit(async () => "still working")).toBe("still working");
	});

	it("a runner that throws SYNCHRONOUSLY does not leave the gate stuck busy", async () => {
		const gate = new ChatTurnGate<string>();
		await expect(
			gate.submit(() => {
				throw new Error("thrown before any await");
			}),
		).rejects.toThrow("thrown before any await");
		expect(gate.busy).toBe(false);
		expect(await gate.submit(async () => "fine")).toBe("fine");
	});

	it("sequential messages are untouched — the common case must not pay for the rare one", async () => {
		const gate = new ChatTurnGate<number>();
		expect(await gate.submit(async () => 1)).toBe(1);
		expect(gate.busy).toBe(false);
		expect(gate.queued).toBe(0);
		expect(await gate.submit(async () => 2)).toBe(2);
	});

	it("a message arriving during the FOLLOW-UP turn queues behind it, not into it", async () => {
		const h = harness();
		const a = h.say("one");
		const b = h.say("two");
		await h.finishTurn(); // first turn done, follow-up starts
		const c = h.say("three");
		expect(h.gate.queued).toBe(1);
		await h.finishTurn(); // the follow-up
		await h.finishTurn(); // the turn for "three"
		await Promise.all([a, b, c]);
		expect(h.replies.map((r) => r.answered)).toEqual([["one"], ["two"], ["three"]]);
		expect(h.overlaps).toEqual([]);
	});
});
